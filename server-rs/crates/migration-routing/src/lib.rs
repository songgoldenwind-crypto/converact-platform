//! Durable `AuthorityRoute` domain model.

use std::{error::Error, fmt};

use converact_kernel_ids::{CellId, Generation, OwnerEpoch, TenantId};

const MAX_IDENTIFIER_BYTES: usize = 255;

/// A stable route transition failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RouteError {
    InvalidIdentifier,
    InvalidRequestHash,
    InvalidNumber,
    GenerationExhausted,
    RevisionExhausted,
    InvalidState,
    RouteRetired,
    StaleGeneration,
    StaleRevision,
    PrepareOperationMismatch,
    PredecessorMismatch,
    GenerationNotQuiescent,
    RollbackWindowOpen,
    RouteKeyMismatch,
    StaleOwnerEpoch,
    LeaseMismatch,
    ObjectGenerationMismatch,
    GenerationNotWritable,
    IdempotencyConflict,
    ReceiptMismatch,
}

impl fmt::Display for RouteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidIdentifier => "authority_route_identifier_invalid",
            Self::InvalidRequestHash => "authority_route_request_hash_invalid",
            Self::InvalidNumber => "authority_route_number_invalid",
            Self::GenerationExhausted => "authority_route_generation_exhausted",
            Self::RevisionExhausted => "authority_route_revision_exhausted",
            Self::InvalidState => "authority_route_state_invalid",
            Self::RouteRetired => "authority_route_retired",
            Self::StaleGeneration => "authority_route_generation_stale",
            Self::StaleRevision => "authority_route_revision_stale",
            Self::PrepareOperationMismatch => "authority_route_prepare_operation_mismatch",
            Self::PredecessorMismatch => "authority_route_predecessor_mismatch",
            Self::GenerationNotQuiescent => "authority_route_generation_not_quiescent",
            Self::RollbackWindowOpen => "authority_route_rollback_window_open",
            Self::RouteKeyMismatch => "authority_route_key_mismatch",
            Self::StaleOwnerEpoch => "authority_route_owner_epoch_stale",
            Self::LeaseMismatch => "authority_route_lease_mismatch",
            Self::ObjectGenerationMismatch => "authority_route_object_generation_mismatch",
            Self::GenerationNotWritable => "authority_route_generation_not_writable",
            Self::IdempotencyConflict => "authority_route_idempotency_conflict",
            Self::ReceiptMismatch => "authority_route_receipt_mismatch",
        })
    }
}

impl Error for RouteError {}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct RouteIdentifier(Box<str>);

impl RouteIdentifier {
    fn parse(value: &str) -> Result<Self, RouteError> {
        let bytes = value.as_bytes();
        let Some((&first, remainder)) = bytes.split_first() else {
            return Err(RouteError::InvalidIdentifier);
        };
        if bytes.len() > MAX_IDENTIFIER_BYTES
            || !first.is_ascii_alphanumeric()
            || !remainder.iter().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
        {
            return Err(RouteError::InvalidIdentifier);
        }
        Ok(Self(value.into()))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

macro_rules! route_identifier {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(RouteIdentifier);

        impl $name {
            /// Parses the frozen bounded route-identifier grammar.
            ///
            /// # Errors
            ///
            /// Returns [`RouteError::InvalidIdentifier`] for malformed input.
            pub fn parse(value: &str) -> Result<Self, RouteError> {
                RouteIdentifier::parse(value).map(Self)
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                self.0.as_str()
            }
        }
    };
}

route_identifier!(AuthorityKind);
route_identifier!(PartitionKey);
route_identifier!(OperationId);

/// Exact lowercase SHA-256 of one canonical command request.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RequestHash(Box<str>);

impl RequestHash {
    /// Parses exactly 64 lowercase hexadecimal characters.
    ///
    /// # Errors
    ///
    /// Returns [`RouteError::InvalidRequestHash`] for non-canonical input.
    pub fn parse(value: &str) -> Result<Self, RouteError> {
        if value.len() != 64
            || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
            || value.bytes().any(|byte| byte.is_ascii_uppercase())
        {
            return Err(RouteError::InvalidRequestHash);
        }
        Ok(Self(value.into()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Opaque lease token whose value is never included in a stable error.
#[derive(Clone, Eq, Hash, PartialEq)]
pub struct LeaseToken(Box<str>);

impl fmt::Debug for LeaseToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LeaseToken([REDACTED])")
    }
}

impl LeaseToken {
    /// Parses exactly 64 lowercase hexadecimal characters.
    ///
    /// # Errors
    ///
    /// Returns [`RouteError::InvalidRequestHash`] for non-canonical input.
    pub fn parse(value: &str) -> Result<Self, RouteError> {
        RequestHash::parse(value).map(|hash| Self(hash.0))
    }
}

macro_rules! positive_number {
    ($name:ident) => {
        #[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(u64);

        impl $name {
            /// Creates a positive value.
            ///
            /// # Errors
            ///
            /// Returns [`RouteError::InvalidNumber`] for zero.
            pub const fn new(value: u64) -> Result<Self, RouteError> {
                if value == 0 {
                    Err(RouteError::InvalidNumber)
                } else {
                    Ok(Self(value))
                }
            }

            #[must_use]
            pub const fn get(self) -> u64 {
                self.0
            }
        }
    };
}

positive_number!(RouteRevision);
positive_number!(SchemaRevision);

impl RouteRevision {
    fn next(self) -> Result<Self, RouteError> {
        self.0
            .checked_add(1)
            .map(Self)
            .ok_or(RouteError::RevisionExhausted)
    }
}

/// Runtime implementation selected for one generation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Implementation {
    TypeScript,
    Rust,
    External,
}

impl Implementation {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TypeScript => "typescript",
            Self::Rust => "rust",
            Self::External => "external",
        }
    }

    /// Parses the durable implementation vocabulary.
    ///
    /// # Errors
    ///
    /// Returns [`RouteError::InvalidState`] for an unknown value.
    pub fn parse(value: &str) -> Result<Self, RouteError> {
        match value {
            "typescript" => Ok(Self::TypeScript),
            "rust" => Ok(Self::Rust),
            "external" => Ok(Self::External),
            _ => Err(RouteError::InvalidState),
        }
    }
}

/// Durable route migration state.
///
/// `Retired` seals migration metadata; it does not retire the current domain
/// writer or stop new domain work.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RouteState {
    Shadow,
    Prepare,
    Committed,
    Draining,
    ActiveZero,
    Retired,
}

impl RouteState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Shadow => "shadow",
            Self::Prepare => "prepare",
            Self::Committed => "committed",
            Self::Draining => "draining",
            Self::ActiveZero => "active_zero",
            Self::Retired => "retired",
        }
    }

    /// Parses the durable route-state vocabulary.
    ///
    /// # Errors
    ///
    /// Returns [`RouteError::InvalidState`] for an unknown value.
    pub fn parse(value: &str) -> Result<Self, RouteError> {
        match value {
            "shadow" => Ok(Self::Shadow),
            "prepare" => Ok(Self::Prepare),
            "committed" => Ok(Self::Committed),
            "draining" => Ok(Self::Draining),
            "active_zero" => Ok(Self::ActiveZero),
            "retired" => Ok(Self::Retired),
            _ => Err(RouteError::InvalidState),
        }
    }
}

/// Durable lifecycle state for one writer generation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GenerationState {
    Prepared,
    AcceptingNewWork,
    Draining,
    ActiveZero,
    Retired,
}

/// Exact tenant/authority/partition route key.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct RouteKey {
    tenant_id: TenantId,
    authority_kind: AuthorityKind,
    partition_key: PartitionKey,
}

impl RouteKey {
    #[must_use]
    pub const fn new(
        tenant_id: TenantId,
        authority_kind: AuthorityKind,
        partition_key: PartitionKey,
    ) -> Self {
        Self {
            tenant_id,
            authority_kind,
            partition_key,
        }
    }

    #[must_use]
    pub const fn tenant_id(&self) -> &TenantId {
        &self.tenant_id
    }

    #[must_use]
    pub const fn authority_kind(&self) -> &AuthorityKind {
        &self.authority_kind
    }

    #[must_use]
    pub const fn partition_key(&self) -> &PartitionKey {
        &self.partition_key
    }
}

/// Complete writer fence binding for one generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WriterBinding {
    cell_id: CellId,
    implementation: Implementation,
    owner_epoch: OwnerEpoch,
    generation: Generation,
    schema_revision: SchemaRevision,
}

impl WriterBinding {
    #[must_use]
    pub const fn new(
        cell_id: CellId,
        implementation: Implementation,
        owner_epoch: OwnerEpoch,
        generation: Generation,
        schema_revision: SchemaRevision,
    ) -> Self {
        Self {
            cell_id,
            implementation,
            owner_epoch,
            generation,
            schema_revision,
        }
    }

    #[must_use]
    pub const fn cell_id(&self) -> &CellId {
        &self.cell_id
    }

    #[must_use]
    pub const fn implementation(&self) -> Implementation {
        self.implementation
    }

    #[must_use]
    pub const fn owner_epoch(&self) -> OwnerEpoch {
        self.owner_epoch
    }

    #[must_use]
    pub const fn generation(&self) -> Generation {
        self.generation
    }

    #[must_use]
    pub const fn schema_revision(&self) -> SchemaRevision {
        self.schema_revision
    }
}

/// Prepared target before its generation is allowed to accept new work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WriterTarget {
    cell_id: CellId,
    implementation: Implementation,
    owner_epoch: OwnerEpoch,
    schema_revision: SchemaRevision,
}

/// Durable generation row used by the object-level writer fence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GenerationRecord {
    key: RouteKey,
    writer: WriterBinding,
    state: GenerationState,
    lease_token: LeaseToken,
}

impl GenerationRecord {
    /// Creates one generation record.
    ///
    /// # Errors
    ///
    /// Reserved for cross-field validation as the durable store is added.
    pub const fn new(
        key: RouteKey,
        writer: WriterBinding,
        state: GenerationState,
        lease_token: LeaseToken,
    ) -> Result<Self, RouteError> {
        Ok(Self {
            key,
            writer,
            state,
            lease_token,
        })
    }

    #[must_use]
    pub const fn key(&self) -> &RouteKey {
        &self.key
    }

    #[must_use]
    pub const fn writer(&self) -> &WriterBinding {
        &self.writer
    }

    #[must_use]
    pub const fn state(&self) -> GenerationState {
        self.state
    }
}

/// Exact mutation claim supplied by one writer process.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WriterClaim {
    key: RouteKey,
    generation: Generation,
    owner_epoch: OwnerEpoch,
    lease_token: LeaseToken,
}

impl WriterClaim {
    #[must_use]
    pub const fn new(
        key: RouteKey,
        generation: Generation,
        owner_epoch: OwnerEpoch,
        lease_token: LeaseToken,
    ) -> Self {
        Self {
            key,
            generation,
            owner_epoch,
            lease_token,
        }
    }
}

/// Whether a command creates new work or mutates a generation-bound object.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MutationScope {
    NewObject,
    ExistingObject { starting_generation: Generation },
}

/// Applies the pure portion of the object-level writer fence.
///
/// Lease expiry remains a `PostgreSQL` transaction-time predicate in the
/// durable adapter; this function validates identity and lifecycle only.
///
/// # Errors
///
/// Returns a stable error when any exact fence component is stale or the
/// generation is not writable for the requested scope.
pub fn authorize_mutation(
    route: &AuthorityRoute,
    generation: &GenerationRecord,
    claim: &WriterClaim,
    scope: MutationScope,
) -> Result<(), RouteError> {
    if route.key != generation.key || route.key != claim.key {
        return Err(RouteError::RouteKeyMismatch);
    }
    if generation.writer.generation() != claim.generation {
        return Err(RouteError::StaleGeneration);
    }
    if generation.writer.owner_epoch() != claim.owner_epoch {
        return Err(RouteError::StaleOwnerEpoch);
    }
    if generation.lease_token != claim.lease_token {
        return Err(RouteError::LeaseMismatch);
    }
    match scope {
        MutationScope::NewObject => {
            if route.current_writer.generation() != claim.generation {
                return Err(RouteError::StaleGeneration);
            }
            if route.current_writer.owner_epoch() != claim.owner_epoch {
                return Err(RouteError::StaleOwnerEpoch);
            }
            if generation.state != GenerationState::AcceptingNewWork {
                return Err(RouteError::GenerationNotWritable);
            }
        }
        MutationScope::ExistingObject {
            starting_generation,
        } => {
            if starting_generation != claim.generation {
                return Err(RouteError::ObjectGenerationMismatch);
            }
            if !matches!(
                generation.state,
                GenerationState::AcceptingNewWork | GenerationState::Draining
            ) {
                return Err(RouteError::GenerationNotWritable);
            }
        }
    }
    Ok(())
}

impl WriterTarget {
    #[must_use]
    pub const fn new(
        cell_id: CellId,
        implementation: Implementation,
        owner_epoch: OwnerEpoch,
        schema_revision: SchemaRevision,
    ) -> Self {
        Self {
            cell_id,
            implementation,
            owner_epoch,
            schema_revision,
        }
    }

    #[must_use]
    pub const fn cell_id(&self) -> &CellId {
        &self.cell_id
    }

    #[must_use]
    pub const fn implementation(&self) -> Implementation {
        self.implementation
    }

    #[must_use]
    pub const fn owner_epoch(&self) -> OwnerEpoch {
        self.owner_epoch
    }

    #[must_use]
    pub const fn schema_revision(&self) -> SchemaRevision {
        self.schema_revision
    }

    fn bind(self, generation: Generation) -> WriterBinding {
        WriterBinding::new(
            self.cell_id,
            self.implementation,
            self.owner_epoch,
            generation,
            self.schema_revision,
        )
    }
}

/// One uncommitted generation reservation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedBinding {
    writer: WriterBinding,
    operation_id: OperationId,
    resume_state: RouteState,
}

impl PreparedBinding {
    /// Restores one prepared binding from a validated durable row.
    ///
    /// # Errors
    ///
    /// Returns [`RouteError::InvalidState`] when the resume state cannot be a
    /// pre-prepare route state.
    pub fn restore(
        writer: WriterBinding,
        operation_id: OperationId,
        resume_state: RouteState,
    ) -> Result<Self, RouteError> {
        if !matches!(
            resume_state,
            RouteState::Shadow
                | RouteState::Committed
                | RouteState::Draining
                | RouteState::ActiveZero
        ) {
            return Err(RouteError::InvalidState);
        }
        Ok(Self {
            writer,
            operation_id,
            resume_state,
        })
    }

    #[must_use]
    pub const fn writer(&self) -> &WriterBinding {
        &self.writer
    }

    #[must_use]
    pub const fn operation_id(&self) -> &OperationId {
        &self.operation_id
    }

    #[must_use]
    pub const fn resume_state(&self) -> RouteState {
        self.resume_state
    }
}

/// One immutable route snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthorityRoute {
    key: RouteKey,
    current_writer: WriterBinding,
    prepared: Option<PreparedBinding>,
    draining_generation: Option<Generation>,
    state: RouteState,
    revision: RouteRevision,
}

impl AuthorityRoute {
    /// Creates a new shadow route around an existing writer.
    ///
    /// # Errors
    ///
    /// Reserved for cross-field validation as the model evolves.
    pub const fn new(
        key: RouteKey,
        current_writer: WriterBinding,
        revision: RouteRevision,
    ) -> Result<Self, RouteError> {
        Ok(Self {
            key,
            current_writer,
            prepared: None,
            draining_generation: None,
            state: RouteState::Shadow,
            revision,
        })
    }

    /// Restores an exact durable route snapshot while rechecking all
    /// cross-row lifecycle invariants.
    ///
    /// # Errors
    ///
    /// Returns [`RouteError::InvalidState`] for a missing, duplicated or
    /// non-consecutive writer generation.
    pub fn restore(
        key: RouteKey,
        current_writer: WriterBinding,
        prepared: Option<PreparedBinding>,
        draining_generation: Option<Generation>,
        state: RouteState,
        revision: RouteRevision,
    ) -> Result<Self, RouteError> {
        if draining_generation == Some(current_writer.generation()) {
            return Err(RouteError::InvalidState);
        }
        match state {
            RouteState::Shadow | RouteState::Retired => {
                if prepared.is_some() || draining_generation.is_some() {
                    return Err(RouteError::InvalidState);
                }
            }
            RouteState::Prepare => {
                let prepared = prepared.as_ref().ok_or(RouteError::InvalidState)?;
                let expected_generation = current_writer
                    .generation()
                    .next()
                    .map_err(|_| RouteError::InvalidState)?;
                if prepared.writer().generation() != expected_generation
                    || match prepared.resume_state() {
                        RouteState::Shadow => draining_generation.is_some(),
                        RouteState::Committed | RouteState::Draining | RouteState::ActiveZero => {
                            draining_generation.is_none()
                        }
                        RouteState::Prepare | RouteState::Retired => true,
                    }
                {
                    return Err(RouteError::InvalidState);
                }
            }
            RouteState::Committed | RouteState::Draining | RouteState::ActiveZero => {
                if prepared.is_some() || draining_generation.is_none() {
                    return Err(RouteError::InvalidState);
                }
            }
        }
        Ok(Self {
            key,
            current_writer,
            prepared,
            draining_generation,
            state,
            revision,
        })
    }

    #[must_use]
    pub const fn key(&self) -> &RouteKey {
        &self.key
    }

    #[must_use]
    pub const fn current_writer(&self) -> &WriterBinding {
        &self.current_writer
    }

    #[must_use]
    pub const fn prepared(&self) -> Option<&PreparedBinding> {
        self.prepared.as_ref()
    }

    #[must_use]
    pub const fn draining_generation(&self) -> Option<Generation> {
        self.draining_generation
    }

    #[must_use]
    pub const fn state(&self) -> RouteState {
        self.state
    }

    #[must_use]
    pub const fn revision(&self) -> RouteRevision {
        self.revision
    }
}

/// Fields shared by a mutating command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationMeta {
    pub operation_id: OperationId,
    pub request_hash: RequestHash,
    pub expected_generation: Generation,
    pub expected_revision: RouteRevision,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrepareCommand {
    pub operation_id: OperationId,
    pub request_hash: RequestHash,
    pub expected_generation: Generation,
    pub expected_revision: RouteRevision,
    pub target: WriterTarget,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitCommand {
    pub operation: OperationMeta,
    pub prepare_operation_id: OperationId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AbortCommand {
    pub operation: OperationMeta,
    pub prepare_operation_id: OperationId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DrainCommand {
    pub operation: OperationMeta,
    pub predecessor_generation: Generation,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveZeroCommand {
    pub operation: OperationMeta,
    pub predecessor_generation: Generation,
    pub durable_active_count: u64,
    pub nonterminal_claims: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RetireCommand {
    pub operation: OperationMeta,
    pub rollback_window_expired: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RouteCommand {
    Prepare(PrepareCommand),
    Commit(CommitCommand),
    Abort(AbortCommand),
    Drain(DrainCommand),
    MarkActiveZero(ActiveZeroCommand),
    Retire(RetireCommand),
}

/// Closed command identity persisted with every idempotency receipt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RouteCommandKind {
    Prepare,
    Commit,
    Abort,
    Drain,
    MarkActiveZero,
    Retire,
}

impl RouteCommandKind {
    /// Restores the exact durable wire value.
    ///
    /// # Errors
    ///
    /// Unknown values fail closed rather than being treated as a replay.
    pub fn parse(value: &str) -> Result<Self, RouteError> {
        match value {
            "prepare" => Ok(Self::Prepare),
            "commit" => Ok(Self::Commit),
            "abort" => Ok(Self::Abort),
            "drain" => Ok(Self::Drain),
            "mark_active_zero" => Ok(Self::MarkActiveZero),
            "retire" => Ok(Self::Retire),
            _ => Err(RouteError::ReceiptMismatch),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Prepare => "prepare",
            Self::Commit => "commit",
            Self::Abort => "abort",
            Self::Drain => "drain",
            Self::MarkActiveZero => "mark_active_zero",
            Self::Retire => "retire",
        }
    }
}

impl RouteCommand {
    #[must_use]
    pub fn operation_id(&self) -> &OperationId {
        match self {
            Self::Prepare(command) => &command.operation_id,
            Self::Commit(command) => &command.operation.operation_id,
            Self::Abort(command) => &command.operation.operation_id,
            Self::Drain(command) => &command.operation.operation_id,
            Self::MarkActiveZero(command) => &command.operation.operation_id,
            Self::Retire(command) => &command.operation.operation_id,
        }
    }

    #[must_use]
    pub fn request_hash(&self) -> &RequestHash {
        match self {
            Self::Prepare(command) => &command.request_hash,
            Self::Commit(command) => &command.operation.request_hash,
            Self::Abort(command) => &command.operation.request_hash,
            Self::Drain(command) => &command.operation.request_hash,
            Self::MarkActiveZero(command) => &command.operation.request_hash,
            Self::Retire(command) => &command.operation.request_hash,
        }
    }

    #[must_use]
    pub const fn kind(&self) -> &'static str {
        self.command_kind().as_str()
    }

    #[must_use]
    pub const fn command_kind(&self) -> RouteCommandKind {
        match self {
            Self::Prepare(_) => RouteCommandKind::Prepare,
            Self::Commit(_) => RouteCommandKind::Commit,
            Self::Abort(_) => RouteCommandKind::Abort,
            Self::Drain(_) => RouteCommandKind::Drain,
            Self::MarkActiveZero(_) => RouteCommandKind::MarkActiveZero,
            Self::Retire(_) => RouteCommandKind::Retire,
        }
    }
}

/// Durable result stored under the operation idempotency key.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RouteReceipt {
    operation_id: OperationId,
    request_hash: RequestHash,
    command_kind: RouteCommandKind,
    route: AuthorityRoute,
}

impl RouteReceipt {
    #[must_use]
    pub const fn restore(
        operation_id: OperationId,
        request_hash: RequestHash,
        command_kind: RouteCommandKind,
        route: AuthorityRoute,
    ) -> Self {
        Self {
            operation_id,
            request_hash,
            command_kind,
            route,
        }
    }

    #[must_use]
    pub const fn operation_id(&self) -> &OperationId {
        &self.operation_id
    }

    #[must_use]
    pub const fn request_hash(&self) -> &RequestHash {
        &self.request_hash
    }

    #[must_use]
    pub const fn command_kind(&self) -> RouteCommandKind {
        self.command_kind
    }

    #[must_use]
    pub const fn route(&self) -> &AuthorityRoute {
        &self.route
    }
}

/// Pure transition output; persistence must commit route and receipt atomically.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Transition {
    pub route: AuthorityRoute,
    pub receipt: RouteReceipt,
    pub replayed: bool,
}

/// Applies one pure transition or replays an exact durable receipt.
///
/// # Errors
///
/// Returns a stable fail-closed error for stale fences, invalid transitions or
/// idempotency conflicts.
pub fn apply(
    route: &AuthorityRoute,
    command: RouteCommand,
    prior_receipt: Option<&RouteReceipt>,
) -> Result<Transition, RouteError> {
    if let Some(receipt) = prior_receipt {
        if receipt.operation_id() != command.operation_id()
            || receipt.route().key() != route.key()
            || receipt.command_kind() != command.command_kind()
        {
            return Err(RouteError::ReceiptMismatch);
        }
        if receipt.request_hash() != command.request_hash() {
            return Err(RouteError::IdempotencyConflict);
        }
        return Ok(Transition {
            route: receipt.route.clone(),
            receipt: receipt.clone(),
            replayed: true,
        });
    }
    if route.state == RouteState::Retired {
        return Err(RouteError::RouteRetired);
    }

    let operation_id = command.operation_id().clone();
    let request_hash = command.request_hash().clone();
    let command_kind = command.command_kind();
    let next_route = match command {
        RouteCommand::Prepare(command) => prepare(route, command)?,
        RouteCommand::Commit(command) => commit(route, &command)?,
        RouteCommand::Abort(command) => abort(route, &command)?,
        RouteCommand::Drain(command) => drain(route, &command)?,
        RouteCommand::MarkActiveZero(command) => mark_active_zero(route, &command)?,
        RouteCommand::Retire(command) => retire(route, &command)?,
    };
    let receipt = RouteReceipt {
        operation_id,
        request_hash,
        command_kind,
        route: next_route.clone(),
    };
    Ok(Transition {
        route: next_route,
        receipt,
        replayed: false,
    })
}

fn prepare(route: &AuthorityRoute, command: PrepareCommand) -> Result<AuthorityRoute, RouteError> {
    verify_expected(
        route,
        command.expected_generation,
        command.expected_revision,
    )?;
    if route.state == RouteState::Retired {
        return Err(RouteError::RouteRetired);
    }
    if command.target.owner_epoch().get() <= route.current_writer.owner_epoch().get() {
        return Err(RouteError::StaleOwnerEpoch);
    }
    if !matches!(
        route.state,
        RouteState::Shadow | RouteState::Committed | RouteState::Draining | RouteState::ActiveZero
    ) {
        return Err(RouteError::InvalidState);
    }
    let prepared_generation = route
        .current_writer
        .generation()
        .next()
        .map_err(|_| RouteError::GenerationExhausted)?;
    let revision = route.revision.next()?;
    let mut next = route.clone();
    next.prepared = Some(PreparedBinding {
        writer: command.target.bind(prepared_generation),
        operation_id: command.operation_id,
        resume_state: route.state,
    });
    next.state = RouteState::Prepare;
    next.revision = revision;
    Ok(next)
}

fn commit(route: &AuthorityRoute, command: &CommitCommand) -> Result<AuthorityRoute, RouteError> {
    verify_expected(
        route,
        command.operation.expected_generation,
        command.operation.expected_revision,
    )?;
    if route.state != RouteState::Prepare {
        return Err(RouteError::InvalidState);
    }
    let prepared = route.prepared.as_ref().ok_or(RouteError::InvalidState)?;
    if prepared.operation_id != command.prepare_operation_id {
        return Err(RouteError::PrepareOperationMismatch);
    }
    let mut next = route.clone();
    next.current_writer = prepared.writer.clone();
    next.draining_generation = Some(route.current_writer.generation());
    next.prepared = None;
    next.state = RouteState::Committed;
    next.revision = route.revision.next()?;
    Ok(next)
}

fn abort(route: &AuthorityRoute, command: &AbortCommand) -> Result<AuthorityRoute, RouteError> {
    verify_expected(
        route,
        command.operation.expected_generation,
        command.operation.expected_revision,
    )?;
    if route.state != RouteState::Prepare {
        return Err(RouteError::InvalidState);
    }
    let prepared = route.prepared.as_ref().ok_or(RouteError::InvalidState)?;
    if prepared.operation_id != command.prepare_operation_id {
        return Err(RouteError::PrepareOperationMismatch);
    }
    let mut next = route.clone();
    next.state = prepared.resume_state;
    next.prepared = None;
    next.revision = route.revision.next()?;
    Ok(next)
}

fn drain(route: &AuthorityRoute, command: &DrainCommand) -> Result<AuthorityRoute, RouteError> {
    verify_expected(
        route,
        command.operation.expected_generation,
        command.operation.expected_revision,
    )?;
    if route.state != RouteState::Committed {
        return Err(RouteError::InvalidState);
    }
    verify_predecessor(route, command.predecessor_generation)?;
    let mut next = route.clone();
    next.state = RouteState::Draining;
    next.revision = route.revision.next()?;
    Ok(next)
}

fn mark_active_zero(
    route: &AuthorityRoute,
    command: &ActiveZeroCommand,
) -> Result<AuthorityRoute, RouteError> {
    verify_expected(
        route,
        command.operation.expected_generation,
        command.operation.expected_revision,
    )?;
    if route.state != RouteState::Draining {
        return Err(RouteError::InvalidState);
    }
    verify_predecessor(route, command.predecessor_generation)?;
    if command.durable_active_count != 0 || command.nonterminal_claims != 0 {
        return Err(RouteError::GenerationNotQuiescent);
    }
    let mut next = route.clone();
    next.state = RouteState::ActiveZero;
    next.revision = route.revision.next()?;
    Ok(next)
}

fn retire(route: &AuthorityRoute, command: &RetireCommand) -> Result<AuthorityRoute, RouteError> {
    verify_expected(
        route,
        command.operation.expected_generation,
        command.operation.expected_revision,
    )?;
    if route.state != RouteState::ActiveZero {
        return Err(RouteError::InvalidState);
    }
    if !command.rollback_window_expired {
        return Err(RouteError::RollbackWindowOpen);
    }
    let mut next = route.clone();
    next.state = RouteState::Retired;
    next.draining_generation = None;
    next.revision = route.revision.next()?;
    Ok(next)
}

fn verify_predecessor(route: &AuthorityRoute, generation: Generation) -> Result<(), RouteError> {
    if route.draining_generation != Some(generation) {
        return Err(RouteError::PredecessorMismatch);
    }
    Ok(())
}

fn verify_expected(
    route: &AuthorityRoute,
    generation: Generation,
    revision: RouteRevision,
) -> Result<(), RouteError> {
    if route.current_writer.generation() != generation {
        return Err(RouteError::StaleGeneration);
    }
    if route.revision != revision {
        return Err(RouteError::StaleRevision);
    }
    Ok(())
}
