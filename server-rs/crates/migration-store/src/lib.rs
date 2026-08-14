//! Atomic `PostgreSQL` adapter for the migration-routing domain.

use std::{error::Error, fmt};

use converact_contracts::canonical_sha256;
use converact_kernel_ids::{CellId, Generation, OwnerEpoch, TenantId};
use converact_migration_routing::{
    AuthorityKind, AuthorityRoute, Implementation, OperationId, PartitionKey, PreparedBinding,
    RouteCommand, RouteKey, RouteRevision, RouteState, SchemaRevision, WriterBinding,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

mod postgres;

pub use postgres::{DurableRouteCommand, PostgresRouteStore, StoreError};

const MAX_LEASE_TTL_MS: u64 = 86_400_000;
const MAX_ROLLBACK_WINDOW_MS: u64 = 2_592_000_000;

/// SQL predicate to embed in the same mutation statement it authorizes.
///
/// Calling this function in an earlier transaction and then mutating later is
/// forbidden because it would release the row locks before the effect.
pub const WRITER_FENCE_PREDICATE_SQL: &str = concat!(
    "converact_authority_writer_fence(",
    "$1, $2, $3, $4::text::numeric, $5::text::numeric, $6, $7, ",
    "$8::text::numeric",
    ")"
);

/// Exact database-clock lease renewal statement for a tenant transaction.
pub const LEASE_RENEWAL_SQL: &str = concat!(
    "SELECT converact_authority_renew_lease(",
    "$1, $2, $3, $4::text::numeric, $5::text::numeric, $6, $7::bigint",
    ")"
);

/// Idempotently claims one active object/effect under the same writer fence.
pub const CLAIM_GENERATION_WORK_SQL: &str = concat!(
    "SELECT converact_authority_claim_generation_work(",
    "$1, $2, $3, $4::text::numeric, $5::text::numeric, $6, $7, ",
    "$8::text::numeric, $9, $10",
    ")"
);

/// Idempotently releases one active object/effect under the writer fence.
pub const RELEASE_GENERATION_WORK_SQL: &str = concat!(
    "SELECT converact_authority_release_generation_work(",
    "$1, $2, $3, $4::text::numeric, $5::text::numeric, $6, $7, $8",
    ")"
);

/// Nonterminal predecessor state in the independent generation ledger.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PredecessorState {
    Draining,
    ActiveZero,
}

/// One bounded predecessor returned independently of the route's latest
/// handoff pointer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PredecessorGeneration {
    generation: Generation,
    state: PredecessorState,
}

/// One fixed-size generation-ordered predecessor page.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PredecessorPage {
    items: Box<[PredecessorGeneration]>,
    next_after: Option<Generation>,
}

impl PredecessorPage {
    pub(crate) fn new(items: Box<[PredecessorGeneration]>, next_after: Option<Generation>) -> Self {
        Self { items, next_after }
    }

    #[must_use]
    pub fn items(&self) -> &[PredecessorGeneration] {
        &self.items
    }

    /// Cursor to pass to the next query. `None` means enumeration is complete.
    #[must_use]
    pub const fn next_after(&self) -> Option<Generation> {
        self.next_after
    }
}

impl PredecessorGeneration {
    pub(crate) const fn new(generation: Generation, state: PredecessorState) -> Self {
        Self { generation, state }
    }

    #[must_use]
    pub const fn generation(self) -> Generation {
        self.generation
    }

    #[must_use]
    pub const fn state(self) -> PredecessorState {
        self.state
    }
}

/// Bounded database-clock windows used by route transactions.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StoreConfig {
    lease_ttl_ms: i64,
    rollback_window_ms: i64,
}

/// Stable invalid store configuration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreConfigError {
    InvalidLeaseTtl,
    InvalidRollbackWindow,
}

impl fmt::Display for StoreConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidLeaseTtl => "authority_route_lease_ttl_invalid",
            Self::InvalidRollbackWindow => "authority_route_rollback_window_invalid",
        })
    }
}

impl Error for StoreConfigError {}

impl StoreConfig {
    /// Creates bounded intervals that fit `PostgreSQL`'s signed millisecond
    /// parameter and prevent an effectively immortal writer lease.
    ///
    /// # Errors
    ///
    /// Rejects a zero or over-policy lease/rollback interval.
    pub fn new(lease_ttl_ms: u64, rollback_window_ms: u64) -> Result<Self, StoreConfigError> {
        if !(1..=MAX_LEASE_TTL_MS).contains(&lease_ttl_ms) {
            return Err(StoreConfigError::InvalidLeaseTtl);
        }
        if !(1..=MAX_ROLLBACK_WINDOW_MS).contains(&rollback_window_ms) {
            return Err(StoreConfigError::InvalidRollbackWindow);
        }
        Ok(Self {
            lease_ttl_ms: i64::try_from(lease_ttl_ms)
                .map_err(|_| StoreConfigError::InvalidLeaseTtl)?,
            rollback_window_ms: i64::try_from(rollback_window_ms)
                .map_err(|_| StoreConfigError::InvalidRollbackWindow)?,
        })
    }
}

/// Lowercase SHA-256 of an opaque lease capability.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeaseDigest(Box<str>);

/// Opaque 256-bit lease capability encoded as lowercase hexadecimal.
///
/// The raw value is never persisted and its debug representation is redacted.
#[derive(Eq, PartialEq)]
pub struct LeaseToken(Box<str>);

/// Stable invalid lease digest without the rejected value.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LeaseDigestError;

impl fmt::Display for LeaseDigestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("authority_route_lease_digest_invalid")
    }
}

impl Error for LeaseDigestError {}

/// Stable invalid lease token without the rejected value.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LeaseTokenError;

impl fmt::Display for LeaseTokenError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("authority_route_lease_token_invalid")
    }
}

impl Error for LeaseTokenError {}

impl fmt::Debug for LeaseToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LeaseToken([REDACTED])")
    }
}

impl LeaseToken {
    /// Parses exactly 32 bytes encoded as 64 lowercase hexadecimal characters.
    ///
    /// # Errors
    ///
    /// Returns a value-free error for malformed input.
    pub fn parse(value: &str) -> Result<Self, LeaseTokenError> {
        if !is_lower_hex_sha256(value) {
            return Err(LeaseTokenError);
        }
        Ok(Self(value.into()))
    }

    fn digest(&self) -> LeaseDigest {
        LeaseDigest(hex::encode(Sha256::digest(self.0.as_bytes())).into())
    }
}

impl LeaseDigest {
    /// Parses exactly 64 lowercase hexadecimal characters.
    ///
    /// # Errors
    ///
    /// Returns a value-free error for malformed input.
    pub fn parse(value: &str) -> Result<Self, LeaseDigestError> {
        if !is_lower_hex_sha256(value) {
            return Err(LeaseDigestError);
        }
        Ok(Self(value.into()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Ordered generation mutation within one route transaction.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GenerationStep {
    InsertPrepared(Generation),
    BeginDrain(Generation),
    ActivatePrepared(Generation),
    AbortPrepared(Generation),
    MarkActiveZero(Generation),
    RetirePredecessor(Generation),
}

/// Bounded mutation plan used by both dry-run tooling and `PostgreSQL` writes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RouteMutationPlan {
    generation_steps: Box<[GenerationStep]>,
}

impl RouteMutationPlan {
    #[must_use]
    pub fn generation_steps(&self) -> &[GenerationStep] {
        &self.generation_steps
    }
}

/// The supplied route result is not the output of the declared command.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PlanError;

impl fmt::Display for PlanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("authority_route_persistence_plan_invalid")
    }
}

impl Error for PlanError {}

/// Produces the exact, bounded database mutation order for one pure result.
///
/// # Errors
///
/// Returns [`PlanError`] when the before/after shapes do not match the command
/// or do not advance exactly one revision.
pub fn plan_transition(
    before: &AuthorityRoute,
    command: &RouteCommand,
    after: &AuthorityRoute,
) -> Result<RouteMutationPlan, PlanError> {
    if before.key() != after.key()
        || before
            .revision()
            .get()
            .checked_add(1)
            .is_none_or(|revision| revision != after.revision().get())
    {
        return Err(PlanError);
    }
    let mut steps = Vec::with_capacity(2);
    match command {
        RouteCommand::Prepare(_) => {
            let prepared = after.prepared().ok_or(PlanError)?;
            if after.state() != RouteState::Prepare
                || after.current_writer() != before.current_writer()
            {
                return Err(PlanError);
            }
            steps.push(GenerationStep::InsertPrepared(
                prepared.writer().generation(),
            ));
        }
        RouteCommand::Commit(_) => {
            if before.state() != RouteState::Prepare
                || after.state() != RouteState::Committed
                || after.draining_generation() != Some(before.current_writer().generation())
                || after.prepared().is_some()
            {
                return Err(PlanError);
            }
            steps.push(GenerationStep::BeginDrain(
                before.current_writer().generation(),
            ));
            steps.push(GenerationStep::ActivatePrepared(
                after.current_writer().generation(),
            ));
        }
        RouteCommand::Abort(_) => {
            let prepared = before.prepared().ok_or(PlanError)?;
            if before.state() != RouteState::Prepare
                || after.state() != prepared.resume_state()
                || after.current_writer() != before.current_writer()
                || after.prepared().is_some()
            {
                return Err(PlanError);
            }
            steps.push(GenerationStep::AbortPrepared(
                prepared.writer().generation(),
            ));
        }
        RouteCommand::Drain(_) => {
            if before.state() != RouteState::Committed
                || after.state() != RouteState::Draining
                || after.current_writer() != before.current_writer()
                || after.draining_generation() != before.draining_generation()
            {
                return Err(PlanError);
            }
        }
        RouteCommand::MarkActiveZero(_) => {
            let predecessor = before.draining_generation().ok_or(PlanError)?;
            if before.state() != RouteState::Draining
                || after.state() != RouteState::ActiveZero
                || after.draining_generation() != Some(predecessor)
            {
                return Err(PlanError);
            }
            steps.push(GenerationStep::MarkActiveZero(predecessor));
        }
        RouteCommand::Retire(_) => {
            let predecessor = before.draining_generation().ok_or(PlanError)?;
            if before.state() != RouteState::ActiveZero
                || after.state() != RouteState::Retired
                || after.draining_generation().is_some()
            {
                return Err(PlanError);
            }
            steps.push(GenerationStep::RetirePredecessor(predecessor));
        }
    }
    Ok(RouteMutationPlan {
        generation_steps: steps.into_boxed_slice(),
    })
}

/// Stable failure while encoding or restoring one receipt snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SnapshotError {
    EncodingFailed,
    DigestMismatch,
    InvalidPayload,
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::EncodingFailed => "authority_route_snapshot_encoding_failed",
            Self::DigestMismatch => "authority_route_snapshot_digest_mismatch",
            Self::InvalidPayload => "authority_route_snapshot_invalid",
        })
    }
}

impl Error for SnapshotError {}

/// Canonical payload and digest stored together in one immutable receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EncodedRouteSnapshot {
    payload: Value,
    sha256: Box<str>,
}

impl EncodedRouteSnapshot {
    #[must_use]
    pub const fn payload(&self) -> &Value {
        &self.payload
    }

    #[must_use]
    pub const fn sha256(&self) -> &str {
        &self.sha256
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RouteSnapshotV1 {
    schema_version: u8,
    tenant_id: String,
    authority_kind: String,
    partition_key: String,
    current_writer: WriterSnapshotV1,
    prepared: Option<PreparedSnapshotV1>,
    draining_generation: Option<String>,
    state: String,
    revision: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WriterSnapshotV1 {
    cell_id: String,
    implementation: String,
    owner_epoch: String,
    generation: String,
    schema_revision: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PreparedSnapshotV1 {
    writer: WriterSnapshotV1,
    operation_id: String,
    resume_state: String,
}

/// Encodes the complete route result used for exact receipt replay.
///
/// # Errors
///
/// Returns [`SnapshotError::EncodingFailed`] if the bounded canonical JSON
/// encoder rejects the snapshot.
pub fn encode_route_snapshot(
    route: &AuthorityRoute,
) -> Result<EncodedRouteSnapshot, SnapshotError> {
    let snapshot = RouteSnapshotV1 {
        schema_version: 1,
        tenant_id: route.key().tenant_id().as_str().to_owned(),
        authority_kind: route.key().authority_kind().as_str().to_owned(),
        partition_key: route.key().partition_key().as_str().to_owned(),
        current_writer: writer_snapshot(route.current_writer()),
        prepared: route.prepared().map(|prepared| PreparedSnapshotV1 {
            writer: writer_snapshot(prepared.writer()),
            operation_id: prepared.operation_id().as_str().to_owned(),
            resume_state: prepared.resume_state().as_str().to_owned(),
        }),
        draining_generation: route
            .draining_generation()
            .map(|generation| generation.get().to_string()),
        state: route.state().as_str().to_owned(),
        revision: route.revision().get().to_string(),
    };
    let payload = serde_json::to_value(snapshot).map_err(|_| SnapshotError::EncodingFailed)?;
    let sha256 = canonical_sha256(&payload).map_err(|_| SnapshotError::EncodingFailed)?;
    Ok(EncodedRouteSnapshot {
        payload,
        sha256: sha256.into_boxed_str(),
    })
}

/// Restores one receipt result only after verifying its canonical digest.
///
/// # Errors
///
/// Returns a stable error for a changed digest, unknown field, malformed
/// identifier, invalid number or inconsistent route lifecycle.
pub fn decode_route_snapshot(
    payload: &Value,
    expected_sha256: &str,
) -> Result<AuthorityRoute, SnapshotError> {
    let actual_sha256 = canonical_sha256(payload).map_err(|_| SnapshotError::InvalidPayload)?;
    if actual_sha256 != expected_sha256 {
        return Err(SnapshotError::DigestMismatch);
    }
    let snapshot: RouteSnapshotV1 =
        serde_json::from_value(payload.clone()).map_err(|_| SnapshotError::InvalidPayload)?;
    if snapshot.schema_version != 1 {
        return Err(SnapshotError::InvalidPayload);
    }
    let key = RouteKey::new(
        TenantId::parse(snapshot.tenant_id).map_err(|_| SnapshotError::InvalidPayload)?,
        AuthorityKind::parse(&snapshot.authority_kind)
            .map_err(|_| SnapshotError::InvalidPayload)?,
        PartitionKey::parse(&snapshot.partition_key).map_err(|_| SnapshotError::InvalidPayload)?,
    );
    let current_writer = restore_writer(snapshot.current_writer)?;
    let prepared = snapshot
        .prepared
        .map(|prepared| {
            PreparedBinding::restore(
                restore_writer(prepared.writer)?,
                OperationId::parse(&prepared.operation_id)
                    .map_err(|_| SnapshotError::InvalidPayload)?,
                RouteState::parse(&prepared.resume_state)
                    .map_err(|_| SnapshotError::InvalidPayload)?,
            )
            .map_err(|_| SnapshotError::InvalidPayload)
        })
        .transpose()?;
    let draining_generation = snapshot
        .draining_generation
        .map(|value| parse_generation(&value))
        .transpose()?;
    let state = RouteState::parse(&snapshot.state).map_err(|_| SnapshotError::InvalidPayload)?;
    let revision = RouteRevision::new(parse_u64(&snapshot.revision)?)
        .map_err(|_| SnapshotError::InvalidPayload)?;
    AuthorityRoute::restore(
        key,
        current_writer,
        prepared,
        draining_generation,
        state,
        revision,
    )
    .map_err(|_| SnapshotError::InvalidPayload)
}

fn writer_snapshot(writer: &WriterBinding) -> WriterSnapshotV1 {
    WriterSnapshotV1 {
        cell_id: writer.cell_id().as_str().to_owned(),
        implementation: writer.implementation().as_str().to_owned(),
        owner_epoch: writer.owner_epoch().get().to_string(),
        generation: writer.generation().get().to_string(),
        schema_revision: writer.schema_revision().get().to_string(),
    }
}

fn restore_writer(snapshot: WriterSnapshotV1) -> Result<WriterBinding, SnapshotError> {
    Ok(WriterBinding::new(
        CellId::parse(snapshot.cell_id).map_err(|_| SnapshotError::InvalidPayload)?,
        Implementation::parse(&snapshot.implementation)
            .map_err(|_| SnapshotError::InvalidPayload)?,
        OwnerEpoch::parse(&snapshot.owner_epoch).map_err(|_| SnapshotError::InvalidPayload)?,
        parse_generation(&snapshot.generation)?,
        SchemaRevision::new(parse_u64(&snapshot.schema_revision)?)
            .map_err(|_| SnapshotError::InvalidPayload)?,
    ))
}

fn parse_generation(value: &str) -> Result<Generation, SnapshotError> {
    Generation::new(parse_u64(value)?).map_err(|_| SnapshotError::InvalidPayload)
}

fn parse_u64(value: &str) -> Result<u64, SnapshotError> {
    let canonical = value == "0"
        || (!value.starts_with('0') && value.bytes().all(|byte| byte.is_ascii_digit()));
    if !canonical {
        return Err(SnapshotError::InvalidPayload);
    }
    value.parse().map_err(|_| SnapshotError::InvalidPayload)
}
