use std::{error::Error, fmt};

use converact_kernel_ids::TenantId;
use converact_post_call_finalization_core::FinalizationJobState;
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, ConversationFinalizationJobId, ExecutionGeneration,
    InteractionId,
};

const MAX_LEASE_DURATION_MS: u64 = 300_000;
const MAX_CLAIM_BATCH: u16 = 1_000;
const MAX_IDENTIFIER_BYTES: usize = 255;

/// Bounded database-clock lease and claim policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FinalizationStoreConfig {
    lease_duration_ms: u64,
    max_claim_batch: u16,
}

impl FinalizationStoreConfig {
    /// Creates a bounded queue policy.
    ///
    /// # Errors
    ///
    /// Rejects zero or oversized lease durations and claim batches.
    pub const fn new(
        lease_duration_ms: u64,
        max_claim_batch: u16,
    ) -> Result<Self, FinalizationStoreError> {
        if lease_duration_ms == 0
            || lease_duration_ms > MAX_LEASE_DURATION_MS
            || max_claim_batch == 0
            || max_claim_batch > MAX_CLAIM_BATCH
        {
            return Err(FinalizationStoreError::InvalidInput);
        }
        Ok(Self {
            lease_duration_ms,
            max_claim_batch,
        })
    }

    pub(crate) const fn lease_duration_ms(self) -> u64 {
        self.lease_duration_ms
    }

    pub(crate) const fn max_claim_batch(self) -> u16 {
        self.max_claim_batch
    }
}

/// Validated worker lease authority. Debug never exposes the token hash.
#[derive(Clone, Eq, PartialEq)]
pub struct FinalizationLease {
    owner: Box<str>,
    token_hash: Box<str>,
}

impl FinalizationLease {
    /// Validates a bounded worker identity and lowercase SHA-256 token hash.
    ///
    /// # Errors
    ///
    /// Rejects malformed or unbounded authority values.
    pub fn try_new(
        owner: impl AsRef<str>,
        token_hash: impl AsRef<str>,
    ) -> Result<Self, FinalizationStoreError> {
        let owner = owner.as_ref();
        let token_hash = token_hash.as_ref();
        if !bounded_identifier(owner, MAX_IDENTIFIER_BYTES) || !lowercase_sha256(token_hash) {
            return Err(FinalizationStoreError::InvalidInput);
        }
        Ok(Self {
            owner: owner.into(),
            token_hash: token_hash.into(),
        })
    }

    pub(crate) fn owner(&self) -> &str {
        &self.owner
    }

    pub(crate) fn token_hash(&self) -> &str {
        &self.token_hash
    }
}

impl fmt::Debug for FinalizationLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FinalizationLease")
            .field("owner", &self.owner)
            .field("token_hash", &"[REDACTED]")
            .finish()
    }
}

/// Fenced state mutation for one claimed finalization job.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FinalizationLeaseCommand {
    pub tenant_id: TenantId,
    pub job_id: ConversationFinalizationJobId,
    pub expected_revision: u64,
    pub lease: FinalizationLease,
}

/// Fenced reconcile mutation with a bounded content-free machine reason.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FinalizationReconcileCommand {
    lease_command: FinalizationLeaseCommand,
    error_code: Box<str>,
}

impl FinalizationReconcileCommand {
    /// Binds one stable machine error to an exact claimed-job lease.
    ///
    /// # Errors
    ///
    /// Rejects prose, customer content and unbounded values outside the identifier grammar.
    pub fn try_new(
        lease_command: FinalizationLeaseCommand,
        error_code: impl AsRef<str>,
    ) -> Result<Self, FinalizationStoreError> {
        let error_code = error_code.as_ref();
        if lease_command.expected_revision == 0
            || !bounded_identifier(error_code, MAX_IDENTIFIER_BYTES)
        {
            return Err(FinalizationStoreError::InvalidInput);
        }
        Ok(Self {
            lease_command,
            error_code: error_code.into(),
        })
    }

    #[must_use]
    pub const fn lease_command(&self) -> &FinalizationLeaseCommand {
        &self.lease_command
    }

    #[must_use]
    pub fn error_code(&self) -> &str {
        &self.error_code
    }
}

/// Exact enqueue classification.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnqueueFinalizationDecision {
    Created,
    Replay,
}

/// One claimed content-free job projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimedFinalizationJob {
    id: ConversationFinalizationJobId,
    interaction_id: InteractionId,
    call_attempt_id: CallAttemptId,
    agent_release_id: AgentReleaseId,
    execution_generation: ExecutionGeneration,
    retention_policy_ref: Box<str>,
    payload_hash: Box<str>,
    state: FinalizationJobState,
    revision: u64,
}

impl ClaimedFinalizationJob {
    pub(crate) fn from_parts(parts: ClaimedFinalizationJobParts) -> Self {
        Self {
            id: parts.id,
            interaction_id: parts.interaction_id,
            call_attempt_id: parts.call_attempt_id,
            agent_release_id: parts.agent_release_id,
            execution_generation: parts.execution_generation,
            retention_policy_ref: parts.retention_policy_ref.into(),
            payload_hash: parts.payload_hash.into(),
            state: FinalizationJobState::Claimed,
            revision: parts.revision,
        }
    }

    #[must_use]
    pub const fn id(&self) -> &ConversationFinalizationJobId {
        &self.id
    }

    #[must_use]
    pub const fn interaction_id(&self) -> &InteractionId {
        &self.interaction_id
    }

    #[must_use]
    pub const fn call_attempt_id(&self) -> &CallAttemptId {
        &self.call_attempt_id
    }

    #[must_use]
    pub const fn agent_release_id(&self) -> &AgentReleaseId {
        &self.agent_release_id
    }

    #[must_use]
    pub const fn execution_generation(&self) -> ExecutionGeneration {
        self.execution_generation
    }

    #[must_use]
    pub fn retention_policy_ref(&self) -> &str {
        &self.retention_policy_ref
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }

    #[must_use]
    pub const fn state(&self) -> FinalizationJobState {
        self.state
    }

    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }
}

pub(crate) struct ClaimedFinalizationJobParts {
    pub id: ConversationFinalizationJobId,
    pub interaction_id: InteractionId,
    pub call_attempt_id: CallAttemptId,
    pub agent_release_id: AgentReleaseId,
    pub execution_generation: ExecutionGeneration,
    pub retention_policy_ref: String,
    pub payload_hash: String,
    pub revision: u64,
}

/// Low-cardinality durable queue failure without SQL, content or topology.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FinalizationStoreError {
    InvalidInput,
    DatabaseUnavailable,
    Conflict,
    LeaseStale,
    StoredRowInvalid,
    SerializationFailed,
}

impl FinalizationStoreError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidInput => "post_call_finalization_store_input_invalid",
            Self::DatabaseUnavailable => "post_call_finalization_store_unavailable",
            Self::Conflict => "post_call_finalization_store_conflict",
            Self::LeaseStale => "post_call_finalization_lease_stale",
            Self::StoredRowInvalid => "post_call_finalization_store_row_invalid",
            Self::SerializationFailed => "post_call_finalization_store_serialization_failed",
        }
    }
}

impl fmt::Display for FinalizationStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for FinalizationStoreError {}

fn bounded_identifier(value: &str, maximum: usize) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= maximum
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value.as_bytes().iter().all(u8::is_ascii_hexdigit)
        && value.bytes().all(|byte| !byte.is_ascii_uppercase())
}
