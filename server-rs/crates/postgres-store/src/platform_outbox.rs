//! Bounded, writer-fenced platform outbox delivery lifecycle.

#![allow(
    dead_code,
    reason = "private enqueue kernel is consumed by the first migrated aggregate adapter"
)]

use std::{error::Error, fmt, time::Duration};

use converact_event_log::{EventReadPolicy, PlatformEvent, decode_platform_event};
use converact_migration_store::WriterFenceBinding;
use deadpool_postgres::{
    Transaction,
    tokio_postgres::{Row, types::ToSql},
};
use serde_json::{Map, Value, json};

use super::{
    DeliveryLeaseToken, PlatformStoreError, PlatformStorePolicy, PostgresRuntime, TransactionError,
    platform_event::{
        FenceValues, bounded_identifier, map_database_error, optional_text, safe_i64, text,
    },
};

const MAX_TRANSITION_RETRY_DELAY: Duration = Duration::from_secs(86_400);

const OUTBOX_LOCK_SQL: &str = concat!(
    "SELECT pg_advisory_xact_lock(hashtextextended(",
    "concat_ws(E'\\x1f', 'platform-outbox', $1::text, $2::text), 0))"
);
const OUTBOX_EXACT_SQL: &str = r"
SELECT id, event_id, idempotency_key, event_envelope, max_attempts,
       route_authority_kind, route_partition_key, route_generation::text,
       route_owner_epoch::text, route_object_scope,
       route_object_starting_generation::text
FROM converact_platform_outbox
WHERE tenant_id = $1 AND (id = $2 OR event_id = $3 OR idempotency_key = $4)
";
const OUTBOX_ENQUEUE_SQL: &str = concat!(
    "SELECT inserted_outbox_id FROM converact_platform_outbox_enqueue(",
    "$1, $2, $3, $4::text::numeric, $5::text::numeric, $6, $7, ",
    "$8::text::numeric, $9, $10, $11, $12, $13, $14, $15, $16, $17, ",
    "$18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, ",
    "$29::text::timestamptz, $30::text::timestamptz)"
);
const CLAIM_OPERATION_LOCK_SQL: &str = concat!(
    "SELECT pg_advisory_xact_lock(hashtextextended(",
    "concat_ws(E'\\x1f', 'platform-outbox-claim', $1::text, $2::text), 0))"
);
const CLAIM_OPERATION_MATCH_SQL: &str = r"
SELECT claim_operation_id
FROM converact_platform_outbox_claim_operations
WHERE tenant_id = $1 AND claim_operation_id = $8 AND worker_id = $9
  AND delivery_token_hash = encode(sha256(convert_to($10, 'UTF8')), 'hex')
  AND delivery_lease_ms = $11 AND batch_limit = $12
  AND route_authority_kind = $2 AND route_partition_key = $3
  AND route_generation = $4::text::numeric
  AND route_owner_epoch = $5::text::numeric
  AND route_object_scope = $6
  AND route_object_starting_generation IS NOT DISTINCT FROM $7::text::numeric
  AND command_digest = encode(sha256(convert_to(concat_ws(E'\x1f',
    $8::text, $9::text,
    encode(sha256(convert_to($10, 'UTF8')), 'hex'),
    $11::text, $12::text, $2::text, $3::text, $4::text, $5::text,
    $6::text, coalesce($7::text, '')
  ), 'UTF8')), 'hex')
";
const CLAIM_OPERATION_ID_SQL: &str = concat!(
    "SELECT claim_operation_id FROM converact_platform_outbox_claim_operations ",
    "WHERE tenant_id = $1 AND claim_operation_id = $2"
);
const OUTBOX_CLAIM_SQL: &str = r#"
SELECT claim.outbox_id AS id, claim.event_envelope, claim.attempt_count,
       claim.max_attempts, claim.transition_revision,
       to_char(claim.lease_until AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS lease_until
FROM converact_platform_outbox_claim(
  $1, $2, $3, $4::text::numeric, $5::text::numeric, $6, $7,
  $8::text::numeric, $9, $10, $11, $12::bigint, $13::integer
) AS claim
ORDER BY claim.outbox_id
"#;
const OUTBOX_CLAIM_RECEIPTS_SQL: &str = r#"
SELECT receipt.outbox_id AS id, outbox.event_envelope,
       receipt.attempt_count, receipt.max_attempts,
       receipt.claim_revision AS transition_revision,
       to_char(receipt.lease_until AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS lease_until
FROM converact_platform_outbox_claim_receipts AS receipt
JOIN converact_platform_outbox AS outbox
  ON outbox.tenant_id = receipt.tenant_id AND outbox.id = receipt.outbox_id
WHERE receipt.tenant_id = $1 AND receipt.claim_operation_id = $2
ORDER BY receipt.outbox_id
"#;
const OUTBOX_QUERY_SQL: &str = r#"
SELECT id, event_envelope, status, attempt_count, max_attempts,
       transition_revision, last_error_code,
       to_char(next_attempt_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS next_attempt_at,
       CASE WHEN lease_until IS NULL THEN NULL ELSE
         to_char(lease_until AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS lease_until,
       CASE WHEN delivered_at IS NULL THEN NULL ELSE
         to_char(delivered_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS delivered_at,
       CASE WHEN dead_lettered_at IS NULL THEN NULL ELSE
         to_char(dead_lettered_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS dead_lettered_at
FROM converact_platform_outbox
WHERE tenant_id = $1 AND id = $2
  AND route_authority_kind = $3 AND route_partition_key = $4
  AND route_generation = $5::text::numeric
  AND route_owner_epoch = $6::text::numeric
"#;
const TRANSITION_MATCH_SQL: &str = r"
SELECT transition_id
FROM converact_platform_outbox_transitions
WHERE tenant_id = $1 AND transition_id = $6 AND outbox_id = $7
  AND transition_kind = $12 AND from_revision = $9
  AND outcome_status = $13 AND error_code = $11
  AND retry_delay_ms = $14
  AND route_authority_kind = $2 AND route_partition_key = $3
  AND route_generation = $4::text::numeric
  AND route_owner_epoch = $5::text::numeric
  AND route_object_scope = $15
  AND route_object_starting_generation IS NOT DISTINCT FROM $16::text::numeric
  AND command_digest = encode(sha256(convert_to(concat_ws(E'\x1f',
    $6::text, $7::text, $8::text, $9::text,
    encode(sha256(convert_to($10, 'UTF8')), 'hex'), $11::text, $12::text,
    $13::text, $14::text, $2::text, $3::text, $4::text, $5::text,
    $15::text, coalesce($16::text, '')
  ), 'UTF8')), 'hex')
";
const TRANSITION_LOCK_SQL: &str = concat!(
    "SELECT pg_advisory_xact_lock(hashtextextended(",
    "concat_ws(E'\\x1f', 'platform-outbox-transition', $1::text, $2::text), 0))"
);
const TRANSITION_ID_SQL: &str = concat!(
    "SELECT transition_id FROM converact_platform_outbox_transitions ",
    "WHERE tenant_id = $1 AND transition_id = $2"
);
const TRANSITION_APPLY_SQL: &str = concat!(
    "SELECT applied_outbox_id FROM converact_platform_outbox_transition_apply(",
    "$1, $2, $3, $4::text::numeric, $5::text::numeric, $6, $7, ",
    "$8::text::numeric, $9, $10, $11, $12, $13, $14, $15, $16, $17)"
);

/// Durable delivery state. A claimed row is always protected by a database
/// expiry and the digest of an opaque delivery capability.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutboxStatus {
    Pending,
    Claimed,
    Delivered,
    DeadLetter,
}

impl OutboxStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Claimed => "claimed",
            Self::Delivered => "delivered",
            Self::DeadLetter => "dead_letter",
        }
    }
}

/// Closed worker transition set.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutboxTransitionKind {
    Complete,
    Retry,
    DeadLetter,
}

impl OutboxTransitionKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::Retry => "retry",
            Self::DeadLetter => "dead_letter",
        }
    }

    const fn outcome(self) -> OutboxStatus {
        match self {
            Self::Complete => OutboxStatus::Delivered,
            Self::Retry => OutboxStatus::Pending,
            Self::DeadLetter => OutboxStatus::DeadLetter,
        }
    }
}

/// Invalid transition command category without input values.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutboxTransitionCommandError {
    InvalidIdentifier,
    InvalidRevision,
    InvalidErrorCode,
    InvalidRetryDelay,
}

impl fmt::Display for OutboxTransitionCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidIdentifier => "platform_outbox_transition_identity_invalid",
            Self::InvalidRevision => "platform_outbox_transition_revision_invalid",
            Self::InvalidErrorCode => "platform_outbox_transition_error_code_invalid",
            Self::InvalidRetryDelay => "platform_outbox_transition_retry_delay_invalid",
        })
    }
}

impl Error for OutboxTransitionCommandError {}

/// One idempotent worker transition command. Debug output is entirely
/// redacted because the command owns the raw delivery capability.
pub struct OutboxTransitionCommand {
    transition_id: Box<str>,
    outbox_id: Box<str>,
    worker_id: Box<str>,
    claim_revision: u64,
    lease_token: DeliveryLeaseToken,
    kind: OutboxTransitionKind,
    error_code: Option<Box<str>>,
    retry_delay: Duration,
}

struct OutboxTransitionIdentity<'a> {
    transition_id: &'a str,
    outbox_id: &'a str,
    worker_id: &'a str,
    claim_revision: u64,
    lease_token: DeliveryLeaseToken,
}

impl<'a> OutboxTransitionIdentity<'a> {
    const fn new(
        transition_id: &'a str,
        outbox_id: &'a str,
        worker_id: &'a str,
        claim_revision: u64,
        lease_token: DeliveryLeaseToken,
    ) -> Self {
        Self {
            transition_id,
            outbox_id,
            worker_id,
            claim_revision,
            lease_token,
        }
    }
}

impl fmt::Debug for OutboxTransitionCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OutboxTransitionCommand([REDACTED])")
    }
}

impl OutboxTransitionCommand {
    /// Creates a successful terminal transition.
    ///
    /// # Errors
    ///
    /// Rejects malformed identifiers or a zero claim revision.
    pub fn complete(
        transition_id: &str,
        outbox_id: &str,
        worker_id: &str,
        claim_revision: u64,
        lease_token: DeliveryLeaseToken,
    ) -> Result<Self, OutboxTransitionCommandError> {
        Self::new(
            OutboxTransitionIdentity::new(
                transition_id,
                outbox_id,
                worker_id,
                claim_revision,
                lease_token,
            ),
            OutboxTransitionKind::Complete,
            None,
            Duration::ZERO,
        )
    }

    /// Creates a bounded retry transition.
    ///
    /// # Errors
    ///
    /// Rejects malformed identifiers, zero revision or a non-stable error
    /// code.
    pub fn retry(
        transition_id: &str,
        outbox_id: &str,
        worker_id: &str,
        claim_revision: u64,
        lease_token: DeliveryLeaseToken,
        error_code: &str,
        retry_delay: Duration,
    ) -> Result<Self, OutboxTransitionCommandError> {
        Self::new(
            OutboxTransitionIdentity::new(
                transition_id,
                outbox_id,
                worker_id,
                claim_revision,
                lease_token,
            ),
            OutboxTransitionKind::Retry,
            Some(error_code),
            retry_delay,
        )
    }

    /// Creates a terminal dead-letter transition.
    ///
    /// # Errors
    ///
    /// Rejects malformed identifiers, zero revision or a non-stable error
    /// code.
    pub fn dead_letter(
        transition_id: &str,
        outbox_id: &str,
        worker_id: &str,
        claim_revision: u64,
        lease_token: DeliveryLeaseToken,
        error_code: &str,
    ) -> Result<Self, OutboxTransitionCommandError> {
        Self::new(
            OutboxTransitionIdentity::new(
                transition_id,
                outbox_id,
                worker_id,
                claim_revision,
                lease_token,
            ),
            OutboxTransitionKind::DeadLetter,
            Some(error_code),
            Duration::ZERO,
        )
    }

    fn new(
        identity: OutboxTransitionIdentity<'_>,
        kind: OutboxTransitionKind,
        error_code: Option<&str>,
        retry_delay: Duration,
    ) -> Result<Self, OutboxTransitionCommandError> {
        if !super::platform_event::bounded_identifier(identity.transition_id)
            || !super::platform_event::bounded_identifier(identity.outbox_id)
            || !super::platform_event::bounded_identifier(identity.worker_id)
        {
            return Err(OutboxTransitionCommandError::InvalidIdentifier);
        }
        if identity.claim_revision == 0
            || identity.claim_revision > super::platform_event::MAX_SAFE_INTEGER
        {
            return Err(OutboxTransitionCommandError::InvalidRevision);
        }
        if error_code.is_some_and(|value| !stable_error_code(value))
            || (kind == OutboxTransitionKind::Complete && error_code.is_some())
            || (kind != OutboxTransitionKind::Complete && error_code.is_none())
        {
            return Err(OutboxTransitionCommandError::InvalidErrorCode);
        }
        if retry_delay > MAX_TRANSITION_RETRY_DELAY
            || !retry_delay.subsec_nanos().is_multiple_of(1_000_000)
            || (kind != OutboxTransitionKind::Retry && !retry_delay.is_zero())
        {
            return Err(OutboxTransitionCommandError::InvalidRetryDelay);
        }
        Ok(Self {
            transition_id: identity.transition_id.into(),
            outbox_id: identity.outbox_id.into(),
            worker_id: identity.worker_id.into(),
            claim_revision: identity.claim_revision,
            lease_token: identity.lease_token,
            kind,
            error_code: error_code.map(Into::into),
            retry_delay,
        })
    }

    #[must_use]
    pub fn transition_id(&self) -> &str {
        &self.transition_id
    }

    #[must_use]
    pub fn outbox_id(&self) -> &str {
        &self.outbox_id
    }

    #[must_use]
    pub fn worker_id(&self) -> &str {
        &self.worker_id
    }

    #[must_use]
    pub const fn claim_revision(&self) -> u64 {
        self.claim_revision
    }

    #[must_use]
    pub const fn kind(&self) -> OutboxTransitionKind {
        self.kind
    }

    #[must_use]
    pub fn error_code(&self) -> Option<&str> {
        self.error_code.as_deref()
    }

    #[must_use]
    pub const fn retry_delay(&self) -> Duration {
        self.retry_delay
    }

    fn error_code_or_empty(&self) -> &str {
        self.error_code.as_deref().unwrap_or("")
    }

    fn lease_token(&self) -> &DeliveryLeaseToken {
        &self.lease_token
    }
}

/// Stable invalid claim command without identity or capability values.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutboxClaimCommandError {
    InvalidIdentifier,
}

impl fmt::Display for OutboxClaimCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("platform_outbox_claim_identity_invalid")
    }
}

impl Error for OutboxClaimCommandError {}

/// One immutable claim-batch command. The operation id and delivery
/// capability are one-use identities recorded by digest in `PostgreSQL`.
pub struct OutboxClaimCommand {
    operation_id: Box<str>,
    worker_id: Box<str>,
    delivery_token: DeliveryLeaseToken,
}

impl fmt::Debug for OutboxClaimCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OutboxClaimCommand([REDACTED])")
    }
}

impl OutboxClaimCommand {
    /// Creates one bounded, exact claim operation.
    ///
    /// # Errors
    ///
    /// Rejects malformed operation or worker identifiers.
    pub fn new(
        operation_id: &str,
        worker_id: &str,
        delivery_token: DeliveryLeaseToken,
    ) -> Result<Self, OutboxClaimCommandError> {
        if !bounded_identifier(operation_id) || !bounded_identifier(worker_id) {
            return Err(OutboxClaimCommandError::InvalidIdentifier);
        }
        Ok(Self {
            operation_id: operation_id.into(),
            worker_id: worker_id.into(),
            delivery_token,
        })
    }

    #[must_use]
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    #[must_use]
    pub fn worker_id(&self) -> &str {
        &self.worker_id
    }

    /// Consumes a successfully applied claim command and transfers the raw
    /// delivery capability to the transition command. Callers retain the
    /// command instead when the claim commit is unknown so they can reconcile
    /// the exact immutable operation first.
    #[must_use]
    pub fn into_delivery_token(self) -> DeliveryLeaseToken {
        self.delivery_token
    }

    fn delivery_token(&self) -> &DeliveryLeaseToken {
        &self.delivery_token
    }
}

/// One database-clock claim returned to a delivery worker.
#[derive(Clone, Debug, PartialEq)]
pub struct OutboxClaim {
    id: Box<str>,
    event: PlatformEvent,
    attempt_count: u16,
    max_attempts: u16,
    transition_revision: u64,
    lease_until: Box<str>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutboxClaimApplyDisposition {
    Applied,
    Replay,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OutboxClaimBatch {
    disposition: OutboxClaimApplyDisposition,
    claims: Box<[OutboxClaim]>,
}

impl OutboxClaimBatch {
    #[must_use]
    pub const fn disposition(&self) -> OutboxClaimApplyDisposition {
        self.disposition
    }

    #[must_use]
    pub fn claims(&self) -> &[OutboxClaim] {
        &self.claims
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum OutboxClaimReconcileStatus {
    Applied(Box<[OutboxClaim]>),
    NotApplied,
    Conflict,
}

impl OutboxClaim {
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub const fn event(&self) -> &PlatformEvent {
        &self.event
    }

    #[must_use]
    pub const fn attempt_count(&self) -> u16 {
        self.attempt_count
    }

    #[must_use]
    pub const fn max_attempts(&self) -> u16 {
        self.max_attempts
    }

    #[must_use]
    pub const fn transition_revision(&self) -> u64 {
        self.transition_revision
    }

    #[must_use]
    pub fn lease_until(&self) -> &str {
        &self.lease_until
    }
}

/// Exact durable outbox state returned by a tenant/route-scoped query.
#[derive(Clone, Debug, PartialEq)]
pub struct OutboxSnapshot {
    id: Box<str>,
    event: PlatformEvent,
    status: OutboxStatus,
    attempt_count: u16,
    max_attempts: u16,
    transition_revision: u64,
    last_error_code: Option<Box<str>>,
    next_attempt_at: Box<str>,
    lease_until: Option<Box<str>>,
    delivered_at: Option<Box<str>>,
    dead_lettered_at: Option<Box<str>>,
}

impl OutboxSnapshot {
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub const fn event(&self) -> &PlatformEvent {
        &self.event
    }

    #[must_use]
    pub const fn status(&self) -> OutboxStatus {
        self.status
    }

    #[must_use]
    pub const fn attempt_count(&self) -> u16 {
        self.attempt_count
    }

    #[must_use]
    pub const fn max_attempts(&self) -> u16 {
        self.max_attempts
    }

    #[must_use]
    pub const fn transition_revision(&self) -> u64 {
        self.transition_revision
    }

    #[must_use]
    pub fn last_error_code(&self) -> Option<&str> {
        self.last_error_code.as_deref()
    }

    #[must_use]
    pub fn next_attempt_at(&self) -> &str {
        &self.next_attempt_at
    }

    #[must_use]
    pub fn lease_until(&self) -> Option<&str> {
        self.lease_until.as_deref()
    }

    #[must_use]
    pub fn delivered_at(&self) -> Option<&str> {
        self.delivered_at.as_deref()
    }

    #[must_use]
    pub fn dead_lettered_at(&self) -> Option<&str> {
        self.dead_lettered_at.as_deref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutboxEnqueueStatus {
    Inserted,
    Replay,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutboxTransitionApplyStatus {
    Applied,
    Replay,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutboxTransitionReconcileStatus {
    Applied,
    NotApplied,
    Conflict,
}

fn stable_error_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.split_first().is_some_and(|(first, rest)| {
        first.is_ascii_lowercase()
            && rest
                .iter()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
    }) && bytes.len() <= 255
}

struct TransitionValues {
    transition_id: String,
    outbox_id: String,
    worker_id: String,
    claim_revision: i64,
    delivery_token: String,
    error_code: String,
    retry_delay_ms: i64,
    kind: &'static str,
    outcome: &'static str,
}

impl TransitionValues {
    fn new(command: &OutboxTransitionCommand) -> Result<Self, PlatformStoreError> {
        Ok(Self {
            transition_id: command.transition_id().to_owned(),
            outbox_id: command.outbox_id().to_owned(),
            worker_id: command.worker_id().to_owned(),
            claim_revision: i64::try_from(command.claim_revision())
                .map_err(|_| PlatformStoreError::InvalidInput)?,
            delivery_token: command.lease_token().as_secret().to_owned(),
            error_code: command.error_code_or_empty().to_owned(),
            retry_delay_ms: i64::try_from(command.retry_delay().as_millis())
                .map_err(|_| PlatformStoreError::InvalidInput)?,
            kind: command.kind().as_str(),
            outcome: command.kind().outcome().as_str(),
        })
    }

    fn sql_params<'a>(&'a self, fence: &'a FenceValues) -> [&'a (dyn ToSql + Sync); 17] {
        [
            &fence.tenant,
            &fence.authority_kind,
            &fence.partition_key,
            &fence.generation,
            &fence.owner_epoch,
            &fence.lease_token,
            &fence.object_scope,
            &fence.starting_generation,
            &self.transition_id,
            &self.outbox_id,
            &self.worker_id,
            &self.claim_revision,
            &self.delivery_token,
            &self.error_code,
            &self.retry_delay_ms,
            &self.kind,
            &self.outcome,
        ]
    }

    fn match_params<'a>(&'a self, fence: &'a FenceValues) -> [&'a (dyn ToSql + Sync); 16] {
        [
            &fence.tenant,
            &fence.authority_kind,
            &fence.partition_key,
            &fence.generation,
            &fence.owner_epoch,
            &self.transition_id,
            &self.outbox_id,
            &self.worker_id,
            &self.claim_revision,
            &self.delivery_token,
            &self.error_code,
            &self.kind,
            &self.outcome,
            &self.retry_delay_ms,
            &fence.object_scope,
            &fence.starting_generation,
        ]
    }
}

// Implementations are kept in this private adapter module so aggregate crates
// cannot acquire a raw SQL transaction or bypass tenant and writer fencing.
impl PostgresRuntime {
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "called only by a private aggregate adapter introduced with its first migrated domain"
        )
    )]
    pub(super) async fn enqueue_platform_outbox(
        &self,
        fence: &WriterFenceBinding<'_>,
        outbox_id: &str,
        event: &PlatformEvent,
        policy: PlatformStorePolicy,
    ) -> Result<OutboxEnqueueStatus, TransactionError<PlatformStoreError>> {
        let fence = FenceValues::new(fence).map_err(TransactionError::Work)?;
        if !bounded_identifier(outbox_id) || event.tenant_id() != fence.tenant {
            return Err(TransactionError::Work(PlatformStoreError::InvalidInput));
        }
        let tenant_id = fence_tenant_id(event.tenant_id())?;
        let outbox_id = outbox_id.to_owned();
        let event = event.clone();
        let envelope = event_envelope(&event).map_err(TransactionError::Work)?;
        self.with_tenant_transaction(&tenant_id, move |transaction| {
            Box::pin(async move {
                enqueue_in_transaction(
                    transaction,
                    &fence,
                    &outbox_id,
                    &event,
                    &envelope,
                    policy.max_attempts(),
                )
                .await
            })
        })
        .await
    }

    /// Claims a bounded batch using the database clock and persists only the
    /// SHA-256 digest of the supplied delivery capability.
    ///
    /// # Errors
    ///
    /// Returns a stable transaction/store error for malformed identity,
    /// stale route ownership, unavailable storage or invalid persisted data.
    pub async fn claim_platform_outbox(
        &self,
        fence: &WriterFenceBinding<'_>,
        command: &OutboxClaimCommand,
        policy: PlatformStorePolicy,
    ) -> Result<OutboxClaimBatch, TransactionError<PlatformStoreError>> {
        let fence = FenceValues::new(fence).map_err(TransactionError::Work)?;
        let tenant_id = fence_tenant_id(fence.tenant.as_str())?;
        let operation_id = command.operation_id().to_owned();
        let worker_id = command.worker_id().to_owned();
        let delivery_token = command.delivery_token().as_secret().to_owned();
        self.with_tenant_transaction(&tenant_id, move |transaction| {
            Box::pin(async move {
                claim_in_transaction(
                    transaction,
                    &fence,
                    &operation_id,
                    &worker_id,
                    &delivery_token,
                    policy,
                )
                .await
            })
        })
        .await
    }

    /// Reads the exact rows produced by an ambiguous claim commit. This never
    /// renews or mutates a lease.
    ///
    /// # Errors
    ///
    /// Returns a stable transaction/store error for malformed identity,
    /// unavailable storage or invalid persisted data.
    pub async fn reconcile_platform_outbox_claims(
        &self,
        fence: &WriterFenceBinding<'_>,
        command: &OutboxClaimCommand,
        policy: PlatformStorePolicy,
    ) -> Result<OutboxClaimReconcileStatus, TransactionError<PlatformStoreError>> {
        let fence = FenceValues::new(fence).map_err(TransactionError::Work)?;
        let tenant_id = fence_tenant_id(fence.tenant.as_str())?;
        let operation_id = command.operation_id().to_owned();
        let worker_id = command.worker_id().to_owned();
        let delivery_token = command.delivery_token().as_secret().to_owned();
        self.with_tenant_transaction(&tenant_id, move |transaction| {
            Box::pin(async move {
                reconcile_claims_in_transaction(
                    transaction,
                    &fence,
                    &operation_id,
                    &worker_id,
                    &delivery_token,
                    policy,
                )
                .await
            })
        })
        .await
    }

    /// Queries one exact outbox row without renewing a route or delivery
    /// lease. The result never exposes worker or capability digests.
    ///
    /// # Errors
    ///
    /// Returns a stable transaction/store error for malformed identity,
    /// unavailable storage or invalid persisted lifecycle state.
    pub async fn query_platform_outbox(
        &self,
        fence: &WriterFenceBinding<'_>,
        outbox_id: &str,
    ) -> Result<Option<OutboxSnapshot>, TransactionError<PlatformStoreError>> {
        let fence = FenceValues::new(fence).map_err(TransactionError::Work)?;
        if !bounded_identifier(outbox_id) {
            return Err(TransactionError::Work(PlatformStoreError::InvalidInput));
        }
        let tenant_id = fence_tenant_id(fence.tenant.as_str())?;
        let outbox_id = outbox_id.to_owned();
        self.with_tenant_transaction(&tenant_id, move |transaction| {
            Box::pin(
                async move { query_outbox_in_transaction(transaction, &fence, &outbox_id).await },
            )
        })
        .await
    }

    /// Applies one idempotent claim transition and records its immutable
    /// receipt in the same tenant transaction.
    ///
    /// # Errors
    ///
    /// Returns a stable transaction/store error for stale ownership, expired
    /// claim capability, invalid transition or unavailable storage.
    pub async fn apply_platform_outbox_transition(
        &self,
        fence: &WriterFenceBinding<'_>,
        command: &OutboxTransitionCommand,
    ) -> Result<OutboxTransitionApplyStatus, TransactionError<PlatformStoreError>> {
        let fence = FenceValues::new(fence).map_err(TransactionError::Work)?;
        let command = TransitionValues::new(command).map_err(TransactionError::Work)?;
        let tenant_id = fence_tenant_id(fence.tenant.as_str())?;
        self.with_tenant_transaction(&tenant_id, move |transaction| {
            Box::pin(
                async move { apply_transition_in_transaction(transaction, &fence, &command).await },
            )
        })
        .await
    }

    /// Queries an immutable transition receipt after an ambiguous commit.
    /// The query binds the raw delivery capability through a database-side
    /// digest and never mutates the outbox row.
    ///
    /// # Errors
    ///
    /// Returns a stable transaction/store error when storage is unavailable
    /// or persisted data violates the closed contract.
    pub async fn reconcile_platform_outbox_transition(
        &self,
        fence: &WriterFenceBinding<'_>,
        command: &OutboxTransitionCommand,
    ) -> Result<OutboxTransitionReconcileStatus, TransactionError<PlatformStoreError>> {
        let fence = FenceValues::new(fence).map_err(TransactionError::Work)?;
        let command = TransitionValues::new(command).map_err(TransactionError::Work)?;
        let tenant_id = fence_tenant_id(fence.tenant.as_str())?;
        self.with_tenant_transaction(&tenant_id, move |transaction| {
            Box::pin(async move {
                reconcile_transition_in_transaction(transaction, &fence, &command).await
            })
        })
        .await
    }
}

fn fence_tenant_id(
    value: &str,
) -> Result<converact_kernel_ids::TenantId, TransactionError<PlatformStoreError>> {
    converact_kernel_ids::TenantId::parse(value)
        .map_err(|_| TransactionError::Work(PlatformStoreError::InvalidInput))
}

async fn enqueue_in_transaction(
    transaction: &Transaction<'_>,
    fence: &FenceValues,
    outbox_id: &str,
    event: &PlatformEvent,
    envelope: &Value,
    max_attempts: u16,
) -> Result<OutboxEnqueueStatus, PlatformStoreError> {
    transaction
        .query_one(OUTBOX_LOCK_SQL, &[&fence.tenant, &event.idempotency_key()])
        .await
        .map_err(map_database_error)?;
    let exact = query_outbox_identity(transaction, fence, outbox_id, event).await?;
    if let Some(row) = exact.first() {
        if exact.len() != 1
            || !outbox_identity_matches(row, fence, outbox_id, event, envelope, max_attempts)?
        {
            return Err(PlatformStoreError::Conflict);
        }
        execute_outbox_writer_fence(transaction, fence).await?;
        return Ok(OutboxEnqueueStatus::Replay);
    }

    let schema_version = i32::from(event.schema_version());
    let source_schema_version = i32::from(event.source_schema_version());
    let aggregate_revision =
        i64::try_from(event.aggregate_revision()).map_err(|_| PlatformStoreError::InvalidInput)?;
    let max_attempts = i32::from(max_attempts);
    let payload = event.data().clone();
    let correlation = Value::Object(event.correlation().clone());
    let event_id = event.event_id();
    let event_type = event.event_type();
    let producer_identity = event.producer_identity();
    let authority = event.authority();
    let aggregate_type = event.aggregate_type();
    let aggregate_id = event.aggregate_id();
    let ordering_key = event.ordering_key();
    let idempotency_key = event.idempotency_key();
    let payload_digest = event.payload_digest();
    let purpose = event.purpose();
    let region_policy = event.region_policy();
    let retention_policy = event.retention_policy();
    let occurred_at = event.occurred_at();
    let observed_at = event.observed_at();
    let mut params = fence.sql_params().to_vec();
    params.extend([
        &outbox_id as &(dyn ToSql + Sync),
        &event_id,
        &event_type,
        &schema_version,
        &source_schema_version,
        &producer_identity,
        &authority,
        &aggregate_type,
        &aggregate_id,
        &aggregate_revision,
        &ordering_key,
        &idempotency_key,
        &payload_digest,
        &payload,
        &correlation,
        &purpose,
        &region_policy,
        &retention_policy,
        envelope,
        &max_attempts,
        &occurred_at,
        &observed_at,
    ]);
    let inserted = transaction
        .query(OUTBOX_ENQUEUE_SQL, &params)
        .await
        .map_err(map_database_error)?;
    if inserted.len() > 1 {
        return Err(PlatformStoreError::StoreInvalid);
    }
    if inserted.len() == 1 {
        return Ok(OutboxEnqueueStatus::Inserted);
    }
    let replay = query_outbox_identity(transaction, fence, outbox_id, event).await?;
    if replay.len() == 1
        && outbox_identity_matches(
            &replay[0],
            fence,
            outbox_id,
            event,
            envelope,
            u16::try_from(max_attempts).map_err(|_| PlatformStoreError::InvalidInput)?,
        )?
    {
        return Ok(OutboxEnqueueStatus::Replay);
    }
    Err(PlatformStoreError::Conflict)
}

async fn query_outbox_identity(
    transaction: &Transaction<'_>,
    fence: &FenceValues,
    outbox_id: &str,
    event: &PlatformEvent,
) -> Result<Vec<Row>, PlatformStoreError> {
    let rows = transaction
        .query(
            OUTBOX_EXACT_SQL,
            &[
                &fence.tenant,
                &outbox_id,
                &event.event_id(),
                &event.idempotency_key(),
            ],
        )
        .await
        .map_err(map_database_error)?;
    if rows.len() > 1 {
        return Err(PlatformStoreError::Conflict);
    }
    Ok(rows)
}

fn outbox_identity_matches(
    row: &Row,
    fence: &FenceValues,
    outbox_id: &str,
    event: &PlatformEvent,
    envelope: &Value,
    max_attempts: u16,
) -> Result<bool, PlatformStoreError> {
    validate_outbox_row_fence(row, fence)?;
    let stored_envelope: Value = row
        .try_get("event_envelope")
        .map_err(|_| PlatformStoreError::StoreInvalid)?;
    let stored_attempts: i32 = row
        .try_get("max_attempts")
        .map_err(|_| PlatformStoreError::StoreInvalid)?;
    Ok(text(row, "id")? == outbox_id
        && text(row, "event_id")? == event.event_id()
        && text(row, "idempotency_key")? == event.idempotency_key()
        && stored_envelope == *envelope
        && stored_attempts == i32::from(max_attempts))
}

async fn execute_outbox_writer_fence(
    transaction: &Transaction<'_>,
    fence: &FenceValues,
) -> Result<(), PlatformStoreError> {
    const SQL: &str = concat!(
        "SELECT converact_authority_writer_fence(",
        "$1, $2, $3, $4::text::numeric, $5::text::numeric, $6, $7, ",
        "$8::text::numeric)"
    );
    transaction
        .query_one(SQL, &fence.sql_params())
        .await
        .map(|_| ())
        .map_err(map_database_error)
}

async fn claim_in_transaction(
    transaction: &Transaction<'_>,
    fence: &FenceValues,
    operation_id: &str,
    worker_id: &str,
    delivery_token: &str,
    policy: PlatformStorePolicy,
) -> Result<OutboxClaimBatch, PlatformStoreError> {
    transaction
        .query_one(CLAIM_OPERATION_LOCK_SQL, &[&fence.tenant, &operation_id])
        .await
        .map_err(map_database_error)?;
    let lease_ms = i64::try_from(policy.delivery_lease().as_millis())
        .map_err(|_| PlatformStoreError::InvalidInput)?;
    let limit = i32::from(policy.claim_batch_limit());
    let operation_params: [&(dyn ToSql + Sync); 12] = [
        &fence.tenant,
        &fence.authority_kind,
        &fence.partition_key,
        &fence.generation,
        &fence.owner_epoch,
        &fence.object_scope,
        &fence.starting_generation,
        &operation_id,
        &worker_id,
        &delivery_token,
        &lease_ms,
        &limit,
    ];
    let mut params = fence.sql_params().to_vec();
    params.extend([
        &operation_id as &(dyn ToSql + Sync),
        &worker_id as &(dyn ToSql + Sync),
        &delivery_token,
        &lease_ms,
        &limit,
    ]);
    let matching = transaction
        .query(CLAIM_OPERATION_MATCH_SQL, &operation_params)
        .await
        .map_err(map_database_error)?;
    if matching.len() > 1 {
        return Err(PlatformStoreError::StoreInvalid);
    }
    if matching.len() == 1 {
        let claims = read_claim_receipts(transaction, fence, operation_id, policy).await?;
        return Ok(OutboxClaimBatch {
            disposition: OutboxClaimApplyDisposition::Replay,
            claims: claims.into_boxed_slice(),
        });
    }
    let identity = transaction
        .query(CLAIM_OPERATION_ID_SQL, &[&fence.tenant, &operation_id])
        .await
        .map_err(map_database_error)?;
    if !identity.is_empty() {
        return Err(PlatformStoreError::Conflict);
    }
    let claimed = transaction
        .query(OUTBOX_CLAIM_SQL, &params)
        .await
        .map_err(map_database_error)?;
    if claimed.len() > usize::from(policy.claim_batch_limit()) {
        return Err(PlatformStoreError::StoreInvalid);
    }
    Ok(OutboxClaimBatch {
        disposition: OutboxClaimApplyDisposition::Applied,
        claims: claimed
            .iter()
            .map(decode_outbox_claim)
            .collect::<Result<Vec<_>, _>>()?
            .into_boxed_slice(),
    })
}

async fn reconcile_claims_in_transaction(
    transaction: &Transaction<'_>,
    fence: &FenceValues,
    operation_id: &str,
    worker_id: &str,
    delivery_token: &str,
    policy: PlatformStorePolicy,
) -> Result<OutboxClaimReconcileStatus, PlatformStoreError> {
    let lease_ms = i64::try_from(policy.delivery_lease().as_millis())
        .map_err(|_| PlatformStoreError::InvalidInput)?;
    let limit = i32::from(policy.claim_batch_limit());
    let params: [&(dyn ToSql + Sync); 12] = [
        &fence.tenant,
        &fence.authority_kind,
        &fence.partition_key,
        &fence.generation,
        &fence.owner_epoch,
        &fence.object_scope,
        &fence.starting_generation,
        &operation_id,
        &worker_id,
        &delivery_token,
        &lease_ms,
        &limit,
    ];
    let matching = transaction
        .query(CLAIM_OPERATION_MATCH_SQL, &params)
        .await
        .map_err(map_database_error)?;
    if matching.len() > 1 {
        return Err(PlatformStoreError::StoreInvalid);
    }
    if matching.len() == 1 {
        let claims = read_claim_receipts(transaction, fence, operation_id, policy).await?;
        return Ok(OutboxClaimReconcileStatus::Applied(
            claims.into_boxed_slice(),
        ));
    }
    let identity = transaction
        .query(CLAIM_OPERATION_ID_SQL, &[&fence.tenant, &operation_id])
        .await
        .map_err(map_database_error)?;
    Ok(if identity.is_empty() {
        OutboxClaimReconcileStatus::NotApplied
    } else {
        OutboxClaimReconcileStatus::Conflict
    })
}

async fn read_claim_receipts(
    transaction: &Transaction<'_>,
    fence: &FenceValues,
    operation_id: &str,
    policy: PlatformStorePolicy,
) -> Result<Vec<OutboxClaim>, PlatformStoreError> {
    let rows = transaction
        .query(OUTBOX_CLAIM_RECEIPTS_SQL, &[&fence.tenant, &operation_id])
        .await
        .map_err(map_database_error)?;
    if rows.len() > usize::from(policy.claim_batch_limit()) {
        return Err(PlatformStoreError::StoreInvalid);
    }
    rows.iter().map(decode_outbox_claim).collect()
}

async fn query_outbox_in_transaction(
    transaction: &Transaction<'_>,
    fence: &FenceValues,
    outbox_id: &str,
) -> Result<Option<OutboxSnapshot>, PlatformStoreError> {
    let rows = transaction
        .query(
            OUTBOX_QUERY_SQL,
            &[
                &fence.tenant,
                &outbox_id,
                &fence.authority_kind,
                &fence.partition_key,
                &fence.generation,
                &fence.owner_epoch,
            ],
        )
        .await
        .map_err(map_database_error)?;
    if rows.len() > 1 {
        return Err(PlatformStoreError::StoreInvalid);
    }
    rows.first().map(decode_outbox_snapshot).transpose()
}

fn decode_outbox_snapshot(row: &Row) -> Result<OutboxSnapshot, PlatformStoreError> {
    let envelope: Value = row
        .try_get("event_envelope")
        .map_err(|_| PlatformStoreError::StoreInvalid)?;
    let event = decode_platform_event(&envelope, EventReadPolicy::v2())
        .map_err(|_| PlatformStoreError::StoreInvalid)?;
    let status = match text(row, "status")?.as_str() {
        "pending" => OutboxStatus::Pending,
        "claimed" => OutboxStatus::Claimed,
        "delivered" => OutboxStatus::Delivered,
        "dead_letter" => OutboxStatus::DeadLetter,
        _ => return Err(PlatformStoreError::StoreInvalid),
    };
    let attempt_count: i32 = row
        .try_get("attempt_count")
        .map_err(|_| PlatformStoreError::StoreInvalid)?;
    let max_attempts: i32 = row
        .try_get("max_attempts")
        .map_err(|_| PlatformStoreError::StoreInvalid)?;
    let transition_revision = safe_i64(row, "transition_revision")?;
    let last_error_code = text(row, "last_error_code")?;
    if !last_error_code.is_empty() && !stable_error_code(&last_error_code) {
        return Err(PlatformStoreError::StoreInvalid);
    }
    let lease_until = optional_text(row, "lease_until")?;
    let delivered_at = optional_text(row, "delivered_at")?;
    let dead_lettered_at = optional_text(row, "dead_lettered_at")?;
    let valid_shape = match status {
        OutboxStatus::Pending => {
            lease_until.is_none() && delivered_at.is_none() && dead_lettered_at.is_none()
        }
        OutboxStatus::Claimed => {
            lease_until.is_some() && delivered_at.is_none() && dead_lettered_at.is_none()
        }
        OutboxStatus::Delivered => {
            lease_until.is_none() && delivered_at.is_some() && dead_lettered_at.is_none()
        }
        OutboxStatus::DeadLetter => {
            lease_until.is_none() && delivered_at.is_none() && dead_lettered_at.is_some()
        }
    };
    if !valid_shape {
        return Err(PlatformStoreError::StoreInvalid);
    }
    Ok(OutboxSnapshot {
        id: text(row, "id")?.into(),
        event,
        status,
        attempt_count: u16::try_from(attempt_count)
            .map_err(|_| PlatformStoreError::StoreInvalid)?,
        max_attempts: u16::try_from(max_attempts).map_err(|_| PlatformStoreError::StoreInvalid)?,
        transition_revision: u64::try_from(transition_revision)
            .map_err(|_| PlatformStoreError::StoreInvalid)?,
        last_error_code: (!last_error_code.is_empty()).then(|| last_error_code.into_boxed_str()),
        next_attempt_at: text(row, "next_attempt_at")?.into(),
        lease_until: lease_until.map(Into::into),
        delivered_at: delivered_at.map(Into::into),
        dead_lettered_at: dead_lettered_at.map(Into::into),
    })
}

fn decode_outbox_claim(row: &Row) -> Result<OutboxClaim, PlatformStoreError> {
    let envelope: Value = row
        .try_get("event_envelope")
        .map_err(|_| PlatformStoreError::StoreInvalid)?;
    let event = decode_platform_event(&envelope, EventReadPolicy::v2())
        .map_err(|_| PlatformStoreError::StoreInvalid)?;
    let attempt_count: i32 = row
        .try_get("attempt_count")
        .map_err(|_| PlatformStoreError::StoreInvalid)?;
    let max_attempts: i32 = row
        .try_get("max_attempts")
        .map_err(|_| PlatformStoreError::StoreInvalid)?;
    let transition_revision = safe_i64(row, "transition_revision")?;
    let lease_until = text(row, "lease_until")?;
    if lease_until.is_empty() {
        return Err(PlatformStoreError::StoreInvalid);
    }
    Ok(OutboxClaim {
        id: text(row, "id")?.into(),
        event,
        attempt_count: u16::try_from(attempt_count)
            .map_err(|_| PlatformStoreError::StoreInvalid)?,
        max_attempts: u16::try_from(max_attempts).map_err(|_| PlatformStoreError::StoreInvalid)?,
        transition_revision: u64::try_from(transition_revision)
            .map_err(|_| PlatformStoreError::StoreInvalid)?,
        lease_until: lease_until.into(),
    })
}

async fn apply_transition_in_transaction(
    transaction: &Transaction<'_>,
    fence: &FenceValues,
    command: &TransitionValues,
) -> Result<OutboxTransitionApplyStatus, PlatformStoreError> {
    transaction
        .query_one(
            TRANSITION_LOCK_SQL,
            &[&fence.tenant, &command.transition_id],
        )
        .await
        .map_err(map_database_error)?;
    match reconcile_transition_in_transaction(transaction, fence, command).await? {
        OutboxTransitionReconcileStatus::Applied => {
            return Ok(OutboxTransitionApplyStatus::Replay);
        }
        OutboxTransitionReconcileStatus::Conflict => {
            return Err(PlatformStoreError::Conflict);
        }
        OutboxTransitionReconcileStatus::NotApplied => {}
    }
    let rows = transaction
        .query(TRANSITION_APPLY_SQL, &command.sql_params(fence))
        .await
        .map_err(map_database_error)?;
    if rows.len() > 1 {
        return Err(PlatformStoreError::StoreInvalid);
    }
    if rows.len() == 1 {
        return Ok(OutboxTransitionApplyStatus::Applied);
    }
    match reconcile_transition_in_transaction(transaction, fence, command).await? {
        OutboxTransitionReconcileStatus::Applied => Ok(OutboxTransitionApplyStatus::Replay),
        OutboxTransitionReconcileStatus::Conflict => Err(PlatformStoreError::Conflict),
        OutboxTransitionReconcileStatus::NotApplied => Err(PlatformStoreError::InvalidTransition),
    }
}

async fn reconcile_transition_in_transaction(
    transaction: &Transaction<'_>,
    fence: &FenceValues,
    command: &TransitionValues,
) -> Result<OutboxTransitionReconcileStatus, PlatformStoreError> {
    let matching = transaction
        .query(TRANSITION_MATCH_SQL, &command.match_params(fence))
        .await
        .map_err(map_database_error)?;
    if matching.len() > 1 {
        return Err(PlatformStoreError::StoreInvalid);
    }
    if matching.len() == 1 {
        return Ok(OutboxTransitionReconcileStatus::Applied);
    }
    let identity = transaction
        .query(TRANSITION_ID_SQL, &[&fence.tenant, &command.transition_id])
        .await
        .map_err(map_database_error)?;
    if identity.len() > 1 {
        return Err(PlatformStoreError::StoreInvalid);
    }
    Ok(if identity.is_empty() {
        OutboxTransitionReconcileStatus::NotApplied
    } else {
        OutboxTransitionReconcileStatus::Conflict
    })
}

fn validate_outbox_row_fence(row: &Row, fence: &FenceValues) -> Result<(), PlatformStoreError> {
    if text(row, "route_authority_kind")? != fence.authority_kind
        || text(row, "route_partition_key")? != fence.partition_key
        || text(row, "route_generation")? != fence.generation
        || text(row, "route_owner_epoch")? != fence.owner_epoch
        || text(row, "route_object_scope")? != fence.object_scope
        || optional_text(row, "route_object_starting_generation")?.as_deref()
            != fence.starting_generation.as_deref()
    {
        return Err(PlatformStoreError::StoreInvalid);
    }
    Ok(())
}

fn event_envelope(event: &PlatformEvent) -> Result<Value, PlatformStoreError> {
    let mut envelope = Map::new();
    envelope.insert("schema_version".into(), json!(event.schema_version()));
    envelope.insert("event_id".into(), json!(event.event_id()));
    envelope.insert("event_type".into(), json!(event.event_type()));
    envelope.insert("tenant_id".into(), json!(event.tenant_id()));
    envelope.insert("producer_identity".into(), json!(event.producer_identity()));
    envelope.insert("authority".into(), json!(event.authority()));
    envelope.insert("aggregate_type".into(), json!(event.aggregate_type()));
    envelope.insert("aggregate_id".into(), json!(event.aggregate_id()));
    envelope.insert(
        "aggregate_revision".into(),
        json!(event.aggregate_revision()),
    );
    envelope.insert("ordering_key".into(), json!(event.ordering_key()));
    envelope.insert("idempotency_key".into(), json!(event.idempotency_key()));
    envelope.insert("payload_digest".into(), json!(event.payload_digest()));
    envelope.insert("occurred_at".into(), json!(event.occurred_at()));
    envelope.insert("observed_at".into(), json!(event.observed_at()));
    envelope.insert(
        "correlation".into(),
        Value::Object(event.correlation().clone()),
    );
    envelope.insert(
        "causation_event_id".into(),
        event
            .causation_event_id()
            .map_or(Value::Null, |value| json!(value)),
    );
    envelope.insert("purpose".into(), json!(event.purpose()));
    envelope.insert("region_policy".into(), json!(event.region_policy()));
    envelope.insert("retention_policy".into(), json!(event.retention_policy()));
    envelope.insert("data".into(), event.data().clone());
    if let Some(semantics) = event.effect_semantics() {
        envelope.insert(
            "effect_semantics".into(),
            serde_json::to_value(semantics).map_err(|_| PlatformStoreError::InvalidInput)?,
        );
    }
    for (key, value) in event.extensions() {
        if envelope.insert(key.clone(), value.clone()).is_some() {
            return Err(PlatformStoreError::InvalidInput);
        }
    }
    Ok(Value::Object(envelope))
}

#[cfg(test)]
mod physical_tests {
    use std::time::Duration;

    use converact_event_log::{EventReadPolicy, decode_platform_event};
    use converact_idempotency::EffectReceipt;
    use converact_kernel_ids::{Generation, OwnerEpoch, TenantId};
    use converact_migration_routing::{AuthorityKind, MutationScope, PartitionKey, RouteKey};
    use converact_migration_store::{LeaseToken, WriterFenceBinding};
    use deadpool_postgres::tokio_postgres::{NoTls, error::SqlState};
    use serde_json::json;
    use sha2::{Digest, Sha256};

    use crate::{
        DeliveryLeaseToken, EffectAppendStatus, InboxAppendStatus, OutboxClaimApplyDisposition,
        OutboxClaimCommand, OutboxClaimReconcileStatus, OutboxEnqueueStatus, OutboxStatus,
        OutboxTransitionApplyStatus, OutboxTransitionCommand, OutboxTransitionReconcileStatus,
        PlatformStoreError, PlatformStorePolicy, PostgresRuntime, PostgresRuntimeLimits,
        PostgresRuntimeSettings, TransactionError,
    };

    #[tokio::test]
    #[ignore = "requires an isolated PostgreSQL database migrated through 119"]
    async fn writer_fenced_event_and_outbox_lifecycle_is_physically_idempotent() {
        seed_route().await;
        assert_target_role_cannot_bypass_mutation_functions().await;
        let runtime = runtime();
        let route = route_key();
        let route_lease = LeaseToken::parse(&"a".repeat(64)).unwrap();
        let fence = WriterFenceBinding::new(
            &route,
            Generation::new(1).unwrap(),
            OwnerEpoch::parse("7").unwrap(),
            &route_lease,
            MutationScope::ExistingObject {
                starting_generation: Generation::new(1).unwrap(),
            },
        );
        let event = event();

        exercise_event_foundation(&runtime, &fence, &event).await;
        assert_stale_route_writer_rejected(&runtime, &event).await;
        exercise_outbox(&runtime, &fence, &event).await;
        exercise_dead_letters(&runtime, &fence).await;
        assert_terminal_database_state().await;
    }

    async fn exercise_event_foundation(
        runtime: &PostgresRuntime,
        fence: &WriterFenceBinding<'_>,
        event: &converact_event_log::PlatformEvent,
    ) {
        assert_eq!(
            runtime
                .append_platform_inbox(fence, "projection-a", event)
                .await
                .unwrap_or_else(|error| match error {
                    TransactionError::Work(error) => panic!("{error:?}"),
                    other => panic!("{other:?}"),
                }),
            InboxAppendStatus::Inserted
        );
        assert_eq!(
            runtime
                .append_platform_inbox(fence, "projection-a", event)
                .await
                .unwrap(),
            InboxAppendStatus::Replay
        );

        for (stage, digest, expected) in [
            ("accepted", 'a', EffectAppendStatus::Inserted),
            ("completed", 'b', EffectAppendStatus::Inserted),
            ("state_observed", 'c', EffectAppendStatus::Inserted),
        ] {
            assert_eq!(
                runtime
                    .append_platform_effect_receipt(fence, &effect_receipt(stage, digest))
                    .await
                    .unwrap_or_else(|error| match error {
                        TransactionError::Work(error) => panic!("{stage}: {error:?}"),
                        other => panic!("{stage}: {other:?}"),
                    }),
                expected
            );
        }
        for (stage, digest) in [
            ("accepted", 'd'),
            ("completed", 'e'),
            ("state_observed", 'f'),
        ] {
            assert_eq!(
                runtime
                    .append_platform_effect_receipt(
                        fence,
                        &effect_receipt_generation(5, stage, digest),
                    )
                    .await
                    .unwrap(),
                EffectAppendStatus::Inserted
            );
        }
    }

    async fn assert_stale_route_writer_rejected(
        runtime: &PostgresRuntime,
        event: &converact_event_log::PlatformEvent,
    ) {
        let route = route_key();
        let stale_lease = LeaseToken::parse(&"9".repeat(64)).unwrap();
        let stale = WriterFenceBinding::new(
            &route,
            Generation::new(1).unwrap(),
            OwnerEpoch::parse("7").unwrap(),
            &stale_lease,
            MutationScope::ExistingObject {
                starting_generation: Generation::new(1).unwrap(),
            },
        );
        assert_eq!(
            runtime
                .append_platform_inbox(&stale, "projection-a", event)
                .await,
            Err(TransactionError::Work(PlatformStoreError::StaleWriter))
        );
    }

    async fn exercise_outbox(
        runtime: &PostgresRuntime,
        fence: &WriterFenceBinding<'_>,
        event: &converact_event_log::PlatformEvent,
    ) {
        let policy =
            PlatformStorePolicy::new(Duration::from_secs(60), Duration::ZERO, 3, 20).unwrap();
        assert_eq!(
            runtime
                .enqueue_platform_outbox(fence, "outbox-a", event, policy)
                .await
                .unwrap(),
            OutboxEnqueueStatus::Inserted
        );
        assert_eq!(
            runtime
                .enqueue_platform_outbox(fence, "outbox-a", event, policy)
                .await
                .unwrap(),
            OutboxEnqueueStatus::Replay
        );
        assert_legacy_role_is_confined_to_null_provenance().await;

        exercise_retry(runtime, fence, event, policy).await;
        exercise_complete(runtime, fence, policy).await;
    }

    async fn exercise_retry(
        runtime: &PostgresRuntime,
        fence: &WriterFenceBinding<'_>,
        event: &converact_event_log::PlatformEvent,
        policy: PlatformStorePolicy,
    ) {
        let first_command = OutboxClaimCommand::new(
            "claim-operation-first",
            "worker-a",
            DeliveryLeaseToken::parse(&"b".repeat(64)).unwrap(),
        )
        .unwrap();
        let first_claims = runtime
            .claim_platform_outbox(fence, &first_command, policy)
            .await
            .unwrap();
        assert_eq!(
            first_claims.disposition(),
            OutboxClaimApplyDisposition::Applied
        );
        assert_eq!(first_claims.claims().len(), 1);
        assert_eq!(first_claims.claims()[0].attempt_count(), 1);
        assert_eq!(first_claims.claims()[0].transition_revision(), 1);
        assert_eq!(first_claims.claims()[0].event(), event);
        assert_eq!(
            runtime
                .reconcile_platform_outbox_claims(fence, &first_command, policy)
                .await
                .unwrap(),
            OutboxClaimReconcileStatus::Applied(first_claims.claims().to_vec().into_boxed_slice())
        );
        let reused_token = OutboxClaimCommand::new(
            "claim-operation-token-reuse",
            "worker-a",
            DeliveryLeaseToken::parse(&"b".repeat(64)).unwrap(),
        )
        .unwrap();
        assert_eq!(
            runtime
                .claim_platform_outbox(fence, &reused_token, policy)
                .await,
            Err(TransactionError::Work(PlatformStoreError::Conflict))
        );
        let first_token = first_command.into_delivery_token();

        let retry = OutboxTransitionCommand::retry(
            "transition-retry-a",
            "outbox-a",
            "worker-a",
            1,
            first_token,
            "temporary_delivery_failure",
            policy.retry_delay(),
        )
        .unwrap();
        assert_eq!(
            runtime
                .apply_platform_outbox_transition(fence, &retry)
                .await
                .unwrap(),
            OutboxTransitionApplyStatus::Applied
        );
        assert_eq!(
            runtime
                .reconcile_platform_outbox_transition(fence, &retry)
                .await
                .unwrap(),
            OutboxTransitionReconcileStatus::Applied
        );
        let changed_delay = OutboxTransitionCommand::retry(
            "transition-retry-a",
            "outbox-a",
            "worker-a",
            1,
            DeliveryLeaseToken::parse(&"b".repeat(64)).unwrap(),
            "temporary_delivery_failure",
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(
            runtime
                .reconcile_platform_outbox_transition(fence, &changed_delay)
                .await
                .unwrap(),
            OutboxTransitionReconcileStatus::Conflict
        );
    }

    async fn exercise_complete(
        runtime: &PostgresRuntime,
        fence: &WriterFenceBinding<'_>,
        policy: PlatformStorePolicy,
    ) {
        let second_command = OutboxClaimCommand::new(
            "claim-operation-second",
            "worker-a",
            DeliveryLeaseToken::parse(&"c".repeat(64)).unwrap(),
        )
        .unwrap();
        let second_claims = runtime
            .claim_platform_outbox(fence, &second_command, policy)
            .await
            .unwrap();
        assert_eq!(second_claims.claims().len(), 1);
        assert_eq!(second_claims.claims()[0].attempt_count(), 2);
        assert_eq!(second_claims.claims()[0].transition_revision(), 3);
        let wrong_token = OutboxTransitionCommand::complete(
            "transition-wrong-token-a",
            "outbox-a",
            "worker-a",
            3,
            DeliveryLeaseToken::parse(&"d".repeat(64)).unwrap(),
        )
        .unwrap();
        assert_eq!(
            runtime
                .apply_platform_outbox_transition(fence, &wrong_token)
                .await,
            Err(TransactionError::Work(
                PlatformStoreError::InvalidTransition
            ))
        );
        let complete = OutboxTransitionCommand::complete(
            "transition-complete-a",
            "outbox-a",
            "worker-a",
            3,
            second_command.into_delivery_token(),
        )
        .unwrap();
        let complete_duplicate = OutboxTransitionCommand::complete(
            "transition-complete-a",
            "outbox-a",
            "worker-a",
            3,
            DeliveryLeaseToken::parse(&"c".repeat(64)).unwrap(),
        )
        .unwrap();
        let (first_apply, second_apply) = tokio::join!(
            runtime.apply_platform_outbox_transition(fence, &complete),
            runtime.apply_platform_outbox_transition(fence, &complete_duplicate),
        );
        let outcomes = [first_apply.unwrap(), second_apply.unwrap()];
        assert!(outcomes.contains(&OutboxTransitionApplyStatus::Applied));
        assert!(outcomes.contains(&OutboxTransitionApplyStatus::Replay));
        assert_eq!(
            runtime
                .apply_platform_outbox_transition(fence, &complete)
                .await
                .unwrap(),
            OutboxTransitionApplyStatus::Replay
        );
        assert_eq!(
            runtime
                .reconcile_platform_outbox_transition(fence, &complete)
                .await
                .unwrap(),
            OutboxTransitionReconcileStatus::Applied
        );
        assert_completed_state_and_history(runtime, fence, policy).await;
    }

    async fn assert_completed_state_and_history(
        runtime: &PostgresRuntime,
        fence: &WriterFenceBinding<'_>,
        policy: PlatformStorePolicy,
    ) {
        let conflicting_reconcile = OutboxTransitionCommand::complete(
            "transition-complete-a",
            "outbox-a",
            "worker-a",
            3,
            DeliveryLeaseToken::parse(&"d".repeat(64)).unwrap(),
        )
        .unwrap();
        assert_eq!(
            runtime
                .reconcile_platform_outbox_transition(fence, &conflicting_reconcile)
                .await
                .unwrap(),
            OutboxTransitionReconcileStatus::Conflict
        );
        let original_claim = OutboxClaimCommand::new(
            "claim-operation-first",
            "worker-a",
            DeliveryLeaseToken::parse(&"b".repeat(64)).unwrap(),
        )
        .unwrap();
        match runtime
            .reconcile_platform_outbox_claims(fence, &original_claim, policy)
            .await
            .unwrap()
        {
            OutboxClaimReconcileStatus::Applied(claims) => {
                assert_eq!(claims.len(), 1);
                assert_eq!(claims[0].attempt_count(), 1);
                assert_eq!(claims[0].transition_revision(), 1);
            }
            other => panic!("unexpected immutable claim receipt: {other:?}"),
        }
        let snapshot = runtime
            .query_platform_outbox(fence, "outbox-a")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.status(), OutboxStatus::Delivered);
        assert_eq!(snapshot.transition_revision(), 4);
        assert!(snapshot.delivered_at().is_some());
        assert!(snapshot.lease_until().is_none());

        let stale = OutboxTransitionCommand::complete(
            "transition-stale-a",
            "outbox-a",
            "worker-a",
            3,
            DeliveryLeaseToken::parse(&"d".repeat(64)).unwrap(),
        )
        .unwrap();
        assert_eq!(
            runtime
                .apply_platform_outbox_transition(fence, &stale)
                .await,
            Err(TransactionError::Work(
                PlatformStoreError::InvalidTransition
            ))
        );
    }

    async fn exercise_dead_letters(runtime: &PostgresRuntime, fence: &WriterFenceBinding<'_>) {
        let policy =
            PlatformStorePolicy::new(Duration::from_secs(60), Duration::ZERO, 1, 20).unwrap();
        let dead_event = event_with("dead", 8);
        assert_eq!(
            runtime
                .enqueue_platform_outbox(fence, "outbox-dead", &dead_event, policy)
                .await
                .unwrap(),
            OutboxEnqueueStatus::Inserted
        );
        let dead_command = OutboxClaimCommand::new(
            "claim-operation-dead",
            "worker-a",
            DeliveryLeaseToken::parse(&"e".repeat(64)).unwrap(),
        )
        .unwrap();
        let dead_claims = runtime
            .claim_platform_outbox(fence, &dead_command, policy)
            .await
            .unwrap();
        assert_eq!(dead_claims.claims().len(), 1);
        let dead_letter = OutboxTransitionCommand::dead_letter(
            "transition-dead-a",
            "outbox-dead",
            "worker-a",
            dead_claims.claims()[0].transition_revision(),
            dead_command.into_delivery_token(),
            "permanent_delivery_failure",
        )
        .unwrap();
        assert_eq!(
            runtime
                .apply_platform_outbox_transition(fence, &dead_letter)
                .await
                .unwrap(),
            OutboxTransitionApplyStatus::Applied
        );

        let exhausted_event = event_with("exhausted", 9);
        assert_eq!(
            runtime
                .enqueue_platform_outbox(fence, "outbox-exhausted", &exhausted_event, policy)
                .await
                .unwrap(),
            OutboxEnqueueStatus::Inserted
        );
        let exhausted_command = OutboxClaimCommand::new(
            "claim-operation-exhausted",
            "worker-a",
            DeliveryLeaseToken::parse(&"f".repeat(64)).unwrap(),
        )
        .unwrap();
        let exhausted_claims = runtime
            .claim_platform_outbox(fence, &exhausted_command, policy)
            .await
            .unwrap();
        assert_eq!(exhausted_claims.claims().len(), 1);
        expire_outbox_lease("outbox-exhausted").await;
        let replacement = OutboxClaimCommand::new(
            "claim-operation-exhausted-reap",
            "worker-a",
            DeliveryLeaseToken::parse(&"1".repeat(64)).unwrap(),
        )
        .unwrap();
        let replacement_batch = runtime
            .claim_platform_outbox(fence, &replacement, policy)
            .await
            .unwrap();
        assert!(replacement_batch.claims().is_empty());
        assert_eq!(
            runtime
                .reconcile_platform_outbox_claims(fence, &replacement, policy)
                .await
                .unwrap(),
            OutboxClaimReconcileStatus::Applied(Box::default())
        );
        let never_applied = OutboxClaimCommand::new(
            "claim-operation-never-applied",
            "worker-a",
            DeliveryLeaseToken::parse(&"2".repeat(64)).unwrap(),
        )
        .unwrap();
        assert_eq!(
            runtime
                .reconcile_platform_outbox_claims(fence, &never_applied, policy)
                .await
                .unwrap(),
            OutboxClaimReconcileStatus::NotApplied
        );
    }

    fn route_key() -> RouteKey {
        RouteKey::new(
            TenantId::parse("tenant-event-a").unwrap(),
            AuthorityKind::parse("platform-event").unwrap(),
            PartitionKey::parse("partition-a").unwrap(),
        )
    }

    fn event() -> converact_event_log::PlatformEvent {
        event_with("a", 7)
    }

    fn event_with(suffix: &str, aggregate_revision: u64) -> converact_event_log::PlatformEvent {
        let data = json!({"state": "ready"});
        let payload_digest = hex::encode(Sha256::digest(br#"{"state":"ready"}"#));
        decode_platform_event(
            &json!({
                "schema_version": 2,
                "event_id": format!("event-{suffix}"),
                "event_type": "interaction.state.changed",
                "tenant_id": "tenant-event-a",
                "producer_identity": "interaction-worker-a",
                "authority": "Converact Interaction",
                "aggregate_type": "interaction",
                "aggregate_id": format!("interaction-{suffix}"),
                "aggregate_revision": aggregate_revision,
                "ordering_key": format!("tenant-event-a:interaction:{suffix}"),
                "idempotency_key": format!("interaction-{suffix}:{aggregate_revision}"),
                "payload_digest": payload_digest,
                "occurred_at": "2026-08-01T12:00:00.000Z",
                "observed_at": "2026-08-01T12:00:00.010Z",
                "correlation": {"correlation_id": "correlation-a"},
                "causation_event_id": null,
                "purpose": "state_projection",
                "region_policy": "tenant-primary",
                "retention_policy": "event-30d",
                "data": data,
                "effect_semantics": "state_projection_v1"
            }),
            EventReadPolicy::v2(),
        )
        .unwrap()
    }

    fn effect_receipt(stage: &str, digest: char) -> EffectReceipt {
        effect_receipt_generation(4, stage, digest)
    }

    fn effect_receipt_generation(generation: u64, stage: &str, digest: char) -> EffectReceipt {
        EffectReceipt::try_from(&json!({
            "receipt_id": format!("receipt-{generation}-{stage}"),
            "tenant_id": "tenant-event-a",
            "effect_id": "effect-a",
            "event_id": format!("event-{stage}"),
            "correlation_id": "correlation-a",
            "stage": stage,
            "generation": generation,
            "writer_id": "effect-worker-a",
            "owner_epoch": 8,
            "receipt_digest": digest.to_string().repeat(64),
            "observed_at": "2026-08-01T12:00:00.000Z"
        }))
        .unwrap()
    }

    async fn assert_target_role_cannot_bypass_mutation_functions() {
        let database_url = std::env::var("CONVERACT_TEST_POSTGRES_URL").unwrap();
        let (client, connection) = tokio_postgres::connect(&database_url, NoTls).await.unwrap();
        let task = tokio::spawn(connection);
        for statement in [
            "UPDATE converact_platform_outbox SET status = status WHERE false",
            "UPDATE converact_platform_inbox SET consumer_id = consumer_id WHERE false",
            "UPDATE converact_platform_effect_receipts SET stage = stage WHERE false",
        ] {
            let error = client.execute(statement, &[]).await.unwrap_err();
            assert_eq!(error.code(), Some(&SqlState::INSUFFICIENT_PRIVILEGE));
        }
        for statement in [
            "SELECT converact_authority_claim_generation_work(
               NULL::text, NULL::text, NULL::text, NULL::numeric,
               NULL::numeric, NULL::text, NULL::text, NULL::numeric,
               NULL::text, NULL::text
             )",
            "SELECT converact_authority_release_generation_work(
               NULL::text, NULL::text, NULL::text, NULL::numeric,
               NULL::numeric, NULL::text, NULL::text, NULL::text
             )",
        ] {
            let error = client.query_one(statement, &[]).await.unwrap_err();
            assert_eq!(error.code(), Some(&SqlState::INSUFFICIENT_PRIVILEGE));
        }
        drop(client);
        task.await.unwrap().unwrap();
    }

    async fn assert_legacy_role_is_confined_to_null_provenance() {
        let admin_url = std::env::var("CONVERACT_TEST_POSTGRES_ADMIN_URL").unwrap();
        let (mut admin, connection) = tokio_postgres::connect(&admin_url, NoTls).await.unwrap();
        let task = tokio::spawn(connection);

        let legacy_insert = admin.transaction().await.unwrap();
        legacy_insert
            .batch_execute("SET LOCAL ROLE opc_runtime")
            .await
            .unwrap();
        legacy_insert
            .query_one(
                "SELECT set_config('app.current_tenant', 'tenant-event-a', true)",
                &[],
            )
            .await
            .unwrap();
        legacy_insert
            .execute(
                "INSERT INTO converact_platform_inbox (
                   tenant_id, consumer_id, event_id, payload_digest,
                   aggregate_revision, ordering_key, received_at
                 ) VALUES (
                   'tenant-event-a', 'legacy-projection', 'legacy-event',
                   repeat('a', 64), 1, 'legacy-ordering', transaction_timestamp()
                 )",
                &[],
            )
            .await
            .unwrap();
        legacy_insert.commit().await.unwrap();

        let target_update = admin.transaction().await.unwrap();
        target_update
            .batch_execute("SET LOCAL ROLE opc_runtime")
            .await
            .unwrap();
        target_update
            .query_one(
                "SELECT set_config('app.current_tenant', 'tenant-event-a', true)",
                &[],
            )
            .await
            .unwrap();
        let error = target_update
            .execute(
                "UPDATE converact_platform_outbox SET status = status
                 WHERE tenant_id = 'tenant-event-a' AND id = 'outbox-a'",
                &[],
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), Some(&SqlState::INSUFFICIENT_PRIVILEGE));
        target_update.rollback().await.unwrap();

        drop(admin);
        task.await.unwrap().unwrap();
    }

    fn runtime() -> PostgresRuntime {
        let database_url = std::env::var("CONVERACT_TEST_POSTGRES_URL").unwrap();
        let settings = PostgresRuntimeSettings::new(PostgresRuntimeLimits {
            max_connections: 4,
            max_waiters: 8,
            pool_wait_timeout: Duration::from_secs(2),
            connect_timeout: Duration::from_secs(2),
            recycle_timeout: Duration::from_secs(2),
            statement_timeout: Duration::from_secs(2),
            lock_timeout: Duration::from_secs(1),
            transaction_timeout: Duration::from_secs(5),
            rollback_timeout: Duration::from_secs(1),
        })
        .unwrap();
        PostgresRuntime::build(database_url.parse().unwrap(), NoTls, settings).unwrap()
    }

    async fn seed_route() {
        let admin_url = std::env::var("CONVERACT_TEST_POSTGRES_ADMIN_URL").unwrap();
        let (mut admin, connection) = tokio_postgres::connect(&admin_url, NoTls).await.unwrap();
        let task = tokio::spawn(connection);
        let transaction = admin.transaction().await.unwrap();
        transaction
            .query_one(
                "SELECT set_config('app.current_tenant', 'tenant-event-a', true)",
                &[],
            )
            .await
            .unwrap();
        transaction
            .batch_execute(
                r"
                INSERT INTO tenants (id, name)
                VALUES ('tenant-event-a', 'Tenant Event A');
                INSERT INTO converact_authority_routes (
                  tenant_id, authority_kind, partition_key,
                  current_generation, route_revision, route_state
                ) VALUES (
                  'tenant-event-a', 'platform-event', 'partition-a',
                  1, 1, 'shadow'
                );
                INSERT INTO converact_authority_generations (
                  tenant_id, authority_kind, partition_key, generation,
                  cell_id, implementation, owner_epoch, schema_revision,
                  generation_state, lease_token_sha256, lease_expires_at
                ) VALUES (
                  'tenant-event-a', 'platform-event', 'partition-a', 1,
                  'cell-a', 'rust', 7, 1, 'accepting_new_work',
                  encode(sha256(convert_to(repeat('a', 64), 'UTF8')), 'hex'),
                  transaction_timestamp() + interval '1 hour'
                );
                ",
            )
            .await
            .unwrap();
        transaction.commit().await.unwrap();
        drop(admin);
        task.await.unwrap().unwrap();
    }

    async fn expire_outbox_lease(outbox_id: &str) {
        let admin_url = std::env::var("CONVERACT_TEST_POSTGRES_ADMIN_URL").unwrap();
        let (admin, connection) = tokio_postgres::connect(&admin_url, NoTls).await.unwrap();
        let task = tokio::spawn(connection);
        admin
            .execute(
                "UPDATE converact_platform_outbox
                 SET lease_until = transaction_timestamp() - interval '1 second'
                 WHERE tenant_id = 'tenant-event-a' AND id = $1",
                &[&outbox_id],
            )
            .await
            .unwrap();
        drop(admin);
        task.await.unwrap().unwrap();
    }

    async fn assert_terminal_database_state() {
        let admin_url = std::env::var("CONVERACT_TEST_POSTGRES_ADMIN_URL").unwrap();
        let (admin, connection) = tokio_postgres::connect(&admin_url, NoTls).await.unwrap();
        let task = tokio::spawn(connection);
        let row = admin
            .query_one(
                "SELECT status, worker_id, lease_token_hash, attempt_count,
                        transition_revision
                 FROM converact_platform_outbox
                 WHERE tenant_id = 'tenant-event-a' AND id = 'outbox-a'",
                &[],
            )
            .await
            .unwrap();
        assert_eq!(row.get::<_, String>("status"), "delivered");
        assert_eq!(row.get::<_, String>("worker_id"), "");
        assert_eq!(row.get::<_, String>("lease_token_hash"), "");
        assert_eq!(row.get::<_, i32>("attempt_count"), 2);
        assert_eq!(row.get::<_, i64>("transition_revision"), 4);
        let transitions: i64 = admin
            .query_one(
                "SELECT count(*) FROM converact_platform_outbox_transitions
                 WHERE tenant_id = 'tenant-event-a'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(transitions, 4);
        let terminal_rows: i64 = admin
            .query_one(
                "SELECT count(*) FROM converact_platform_outbox
                 WHERE tenant_id = 'tenant-event-a'
                   AND ((id = 'outbox-a' AND status = 'delivered') OR
                        (id IN ('outbox-dead', 'outbox-exhausted') AND
                         status = 'dead_letter'))
                   AND worker_id = '' AND lease_token_hash = ''
                   AND lease_until IS NULL",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(terminal_rows, 3);
        let nonterminal: i64 = admin
            .query_one(
                "SELECT nonterminal_claims::bigint
                 FROM converact_authority_generations
                 WHERE tenant_id = 'tenant-event-a'
                   AND authority_kind = 'platform-event'
                   AND partition_key = 'partition-a' AND generation = 1",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(nonterminal, 0);
        drop(admin);
        task.await.unwrap().unwrap();
    }
}
