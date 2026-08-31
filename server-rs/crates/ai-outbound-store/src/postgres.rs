use std::{error::Error, fmt};

use converact_ai_outbound_core::{
    CallAttempt, CallAttemptRestoreInput, EffectIntent, OutboundDialBinding,
    OutboundDialBindingInput,
};
use converact_contracts::canonical_sha256;
use converact_kernel_ids::TenantId;
use converact_voice_agent_contracts::{
    CallAttemptId, CallAttemptState, EventId, ExecutionGeneration, IdempotencyKey,
};
use serde_json::Value;
use tokio_postgres::{Row, Transaction};

const MAX_LEASE_DURATION_MS: u64 = 300_000;
const MAX_CLAIM_BATCH: u16 = 1_000;
const MAX_IDENTIFIER_BYTES: usize = 255;
const MAX_EVENT_TYPE_BYTES: usize = 128;
const SHA256_HEX_BYTES: usize = 64;
const MAX_EVENT_PAYLOAD_BYTES: usize = 131_072;
const MAX_ATTEMPTS: u8 = 20;

const APPEND_EFFECT_INTENT_SQL: &str = "
INSERT INTO converact_outbound_attempt_events (
  tenant_id, event_id, call_attempt_id, execution_generation,
  event_type, schema_version, idempotency_key, payload_hash,
  payload, occurred_at, received_at
)
SELECT attempt.tenant_id, $7, attempt.id, attempt.execution_generation,
       $8, 1, $9, $10, $11,
       transaction_timestamp(), transaction_timestamp()
FROM converact_outbound_call_attempts AS attempt
WHERE attempt.tenant_id = $1 AND attempt.id = $2 AND attempt.revision = $3
  AND attempt.execution_generation = $4 AND attempt.lease_owner = $5
  AND attempt.lease_token_hash = $6
  AND attempt.lease_expires_at > transaction_timestamp()
ON CONFLICT DO NOTHING
RETURNING event_id
";

const CLAIM_SQL: &str = "
WITH candidates AS (
  SELECT tenant_id, id
  FROM converact_outbound_call_attempts
  WHERE tenant_id = $1
    AND (
      (state = 'planned' AND scheduled_for <= transaction_timestamp()) OR
      (state = 'claimed' AND lease_expires_at <= transaction_timestamp())
    )
  ORDER BY scheduled_for, id
  FOR UPDATE SKIP LOCKED
  LIMIT $2
)
UPDATE converact_outbound_call_attempts AS attempt
SET state = 'claimed',
    lease_owner = $3,
    lease_token_hash = $4,
    lease_expires_at = transaction_timestamp() + ($5 * interval '1 millisecond'),
    revision = attempt.revision + 1,
    updated_at = transaction_timestamp()
FROM candidates
WHERE attempt.tenant_id = candidates.tenant_id
  AND attempt.id = candidates.id
RETURNING attempt.id, attempt.revision, attempt.execution_generation
";

const PLAN_RETRY_SQL: &str = "
WITH predecessor AS MATERIALIZED (
  SELECT attempt.campaign_id,
         attempt.campaign_contact_id,
         attempt.interaction_id,
         attempt.agent_release_id,
         attempt.consent_id,
         attempt.recording_mode,
         attempt.retention_until,
         attempt.dial_policy_revision,
         attempt.dial_policy_content_hash,
         attempt.dial_destination,
         attempt.dial_caller_id,
         attempt.dial_timeout_secs,
         attempt.dial_trunk,
         contact.id AS locked_contact_id
  FROM converact_outbound_call_attempts AS attempt
  JOIN converact_outbound_campaigns AS campaign
    ON campaign.tenant_id = attempt.tenant_id
   AND campaign.id = attempt.campaign_id
  JOIN converact_outbound_campaign_contacts AS contact
    ON contact.tenant_id = attempt.tenant_id
   AND contact.id = attempt.campaign_contact_id
  WHERE attempt.tenant_id = $1
    AND attempt.id = $2
    AND attempt.revision = $4
    AND attempt.execution_generation = $5
    AND attempt.attempt_number + 1 = $6
    AND attempt.state IN (
      'busy', 'no_answer', 'rejected', 'failed_before_answer', 'failed_after_answer'
    )
    AND (attempt.state <> 'failed_after_answer' OR $9)
    AND campaign.state = 'running'
    AND contact.state IN ('queued', 'active')
  FOR UPDATE OF attempt, contact, campaign
), inserted AS (
  INSERT INTO converact_outbound_call_attempts (
    tenant_id, id, campaign_id, campaign_contact_id, attempt_number,
    previous_attempt_id, interaction_id, call_id, channel_agent_session_id,
    agent_release_id, execution_generation, state, idempotency_key,
    compliance_reason, consent_id, recording_mode, retention_until,
    dial_policy_revision, dial_policy_content_hash, dial_destination,
    dial_caller_id, dial_timeout_secs, dial_trunk,
    scheduled_for
  )
  SELECT $1, $3, predecessor.campaign_id, predecessor.campaign_contact_id, $6,
         $2, predecessor.interaction_id, NULL, NULL,
         predecessor.agent_release_id, 1, 'planned', $8,
         NULL, predecessor.consent_id, predecessor.recording_mode,
         predecessor.retention_until,
         predecessor.dial_policy_revision, predecessor.dial_policy_content_hash,
         predecessor.dial_destination, predecessor.dial_caller_id,
         predecessor.dial_timeout_secs, predecessor.dial_trunk,
         to_timestamp($7::double precision / 1000.0)
  FROM predecessor
  ON CONFLICT DO NOTHING
  RETURNING tenant_id, campaign_contact_id, attempt_number, id
)
UPDATE converact_outbound_campaign_contacts AS contact
SET attempt_count = GREATEST(contact.attempt_count, inserted.attempt_number),
    state = 'queued',
    scheduled_for = to_timestamp($7::double precision / 1000.0),
    updated_at = transaction_timestamp()
FROM inserted
WHERE contact.tenant_id = inserted.tenant_id
  AND contact.id = inserted.campaign_contact_id
RETURNING inserted.id
";

const LOAD_RETRY_SQL: &str = "
SELECT id,
       previous_attempt_id,
       attempt_number,
       ROUND(EXTRACT(EPOCH FROM scheduled_for) * 1000)::BIGINT,
       idempotency_key
FROM converact_outbound_call_attempts
WHERE tenant_id = $1 AND (id = $2 OR idempotency_key = $3)
ORDER BY CASE WHEN id = $2 THEN 0 ELSE 1 END
LIMIT 1
";

/// Bounded database claim policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StoreConfig {
    lease_duration_ms: u64,
    max_claim_batch: u16,
}

impl StoreConfig {
    /// Creates a bounded lease and claim-batch policy.
    ///
    /// # Errors
    ///
    /// Rejects zero or oversized durations and batches.
    pub const fn new(lease_duration_ms: u64, max_claim_batch: u16) -> Result<Self, StoreError> {
        if lease_duration_ms == 0 || lease_duration_ms > MAX_LEASE_DURATION_MS {
            return Err(StoreError::InvalidInput);
        }
        if max_claim_batch == 0 || max_claim_batch > MAX_CLAIM_BATCH {
            return Err(StoreError::InvalidInput);
        }
        Ok(Self {
            lease_duration_ms,
            max_claim_batch,
        })
    }
}

/// Low-cardinality durable-store failure without SQL or topology details.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreError {
    InvalidInput,
    DatabaseUnavailable,
    LeaseStale,
    EventConflict,
    RetryConflict,
    RetryNotAllowed,
    AdminConflict,
    AdminNotFound,
    AdminStale,
    AdminNotAllowed,
    AttemptNotFound,
    StoredRowInvalid,
}

impl StoreError {
    /// Returns a stable error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidInput => "ai_outbound_store_input_invalid",
            Self::DatabaseUnavailable => "ai_outbound_store_unavailable",
            Self::LeaseStale => "ai_outbound_lease_stale",
            Self::EventConflict => "ai_outbound_event_conflict",
            Self::RetryConflict => "ai_outbound_retry_conflict",
            Self::RetryNotAllowed => "ai_outbound_retry_not_allowed",
            Self::AdminConflict => "ai_outbound_admin_conflict",
            Self::AdminNotFound => "ai_outbound_admin_not_found",
            Self::AdminStale => "ai_outbound_admin_stale",
            Self::AdminNotAllowed => "ai_outbound_admin_not_allowed",
            Self::AttemptNotFound => "ai_outbound_attempt_not_found",
            Self::StoredRowInvalid => "ai_outbound_stored_row_invalid",
        }
    }
}

/// Untrusted values for one already-authorized deterministic retry insert.
pub struct PlanRetryAttemptInput {
    pub tenant_id: TenantId,
    pub previous_attempt_id: CallAttemptId,
    pub next_attempt_id: CallAttemptId,
    pub expected_previous_revision: u64,
    pub expected_previous_generation: ExecutionGeneration,
    pub next_attempt_number: u8,
    pub scheduled_for_ms: u64,
    pub idempotency_key: IdempotencyKey,
    pub retry_failed_after_answer: bool,
}

/// Content-free, tenant-bound command for one new physical Attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanRetryAttempt {
    tenant_id: TenantId,
    previous_attempt_id: CallAttemptId,
    next_attempt_id: CallAttemptId,
    expected_previous_revision: u64,
    expected_previous_generation: ExecutionGeneration,
    next_attempt_number: u8,
    scheduled_for_ms: u64,
    idempotency_key: IdempotencyKey,
    retry_failed_after_answer: bool,
}

impl PlanRetryAttempt {
    /// Validates a retry insert command before SQL is reached.
    ///
    /// # Errors
    ///
    /// Rejects reused identities, invalid revision/numbering and zero scheduling time.
    pub fn try_new(input: PlanRetryAttemptInput) -> Result<Self, StoreError> {
        if input.previous_attempt_id == input.next_attempt_id
            || input.expected_previous_revision == 0
            || !(2..=MAX_ATTEMPTS).contains(&input.next_attempt_number)
            || input.scheduled_for_ms == 0
        {
            return Err(StoreError::InvalidInput);
        }
        Ok(Self {
            tenant_id: input.tenant_id,
            previous_attempt_id: input.previous_attempt_id,
            next_attempt_id: input.next_attempt_id,
            expected_previous_revision: input.expected_previous_revision,
            expected_previous_generation: input.expected_previous_generation,
            next_attempt_number: input.next_attempt_number,
            scheduled_for_ms: input.scheduled_for_ms,
            idempotency_key: input.idempotency_key,
            retry_failed_after_answer: input.retry_failed_after_answer,
        })
    }

    #[must_use]
    pub const fn tenant_id(&self) -> &TenantId {
        &self.tenant_id
    }

    #[must_use]
    pub const fn previous_attempt_id(&self) -> &CallAttemptId {
        &self.previous_attempt_id
    }

    #[must_use]
    pub const fn next_attempt_id(&self) -> &CallAttemptId {
        &self.next_attempt_id
    }

    #[must_use]
    pub const fn next_attempt_number(&self) -> u8 {
        self.next_attempt_number
    }

    #[must_use]
    pub const fn scheduled_for_ms(&self) -> u64 {
        self.scheduled_for_ms
    }
}

/// Exact durable retry insert outcome.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlanRetryStatus {
    Created,
    Replayed,
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for StoreError {}

/// One atomically claimed physical Attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimedAttempt {
    id: CallAttemptId,
    revision: u64,
    execution_generation: ExecutionGeneration,
}

/// Untrusted durable lease authority before bounded validation.
pub struct AttemptLeaseInput {
    pub tenant_id: TenantId,
    pub attempt_id: CallAttemptId,
    pub execution_generation: ExecutionGeneration,
    pub lease_owner: String,
    pub lease_token_hash: String,
}

/// Exact tenant/Attempt/generation/owner/token fence held by one worker execution.
#[derive(Clone, Eq, PartialEq)]
pub struct AttemptLease {
    tenant_id: TenantId,
    attempt_id: CallAttemptId,
    execution_generation: ExecutionGeneration,
    lease_owner: Box<str>,
    lease_token_hash: Box<str>,
}

impl AttemptLease {
    /// Validates one lease fence received from the atomic claim boundary.
    ///
    /// # Errors
    ///
    /// Rejects malformed owner identifiers and anything other than a lowercase SHA-256 token.
    pub fn try_new(input: AttemptLeaseInput) -> Result<Self, StoreError> {
        if !valid_identifier(&input.lease_owner) || !is_lowercase_sha256(&input.lease_token_hash) {
            return Err(StoreError::InvalidInput);
        }
        Ok(Self {
            tenant_id: input.tenant_id,
            attempt_id: input.attempt_id,
            execution_generation: input.execution_generation,
            lease_owner: input.lease_owner.into(),
            lease_token_hash: input.lease_token_hash.into(),
        })
    }

    #[must_use]
    pub const fn tenant_id(&self) -> &TenantId {
        &self.tenant_id
    }

    #[must_use]
    pub const fn attempt_id(&self) -> &CallAttemptId {
        &self.attempt_id
    }

    #[must_use]
    pub const fn execution_generation(&self) -> ExecutionGeneration {
        self.execution_generation
    }
}

impl fmt::Debug for AttemptLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AttemptLease")
            .field("attempt_id", &self.attempt_id)
            .field("execution_generation", &self.execution_generation)
            .field("lease_owner", &self.lease_owner)
            .field("lease_token_hash", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

/// Deterministic, content-free effect intent bound to one exact leased Attempt revision.
#[derive(Clone, Eq, PartialEq)]
pub struct AppendEffectIntent {
    lease: AttemptLease,
    expected_revision: u64,
    event_id: EventId,
    event_type: Box<str>,
    idempotency_key: IdempotencyKey,
    payload_hash: Box<str>,
    payload: Value,
}

impl AppendEffectIntent {
    /// Creates a stable event identity for exact replay before one external mutation.
    ///
    /// # Errors
    ///
    /// Rejects a cross-Attempt aggregate or canonical serialization failure.
    pub fn try_new(
        lease: &AttemptLease,
        attempt: &CallAttempt,
        intent: EffectIntent,
    ) -> Result<Self, StoreError> {
        if lease.attempt_id != *attempt.id() {
            return Err(StoreError::InvalidInput);
        }
        let payload = serde_json::json!({
            "tenant_id": lease.tenant_id.as_str(),
            "call_attempt_id": lease.attempt_id.as_str(),
            "execution_generation": lease.execution_generation.get(),
            "attempt_revision": attempt.revision(),
            "effect": intent.as_str(),
        });
        let payload_hash = canonical_sha256(&payload).map_err(|_| StoreError::InvalidInput)?;
        let stable_id = format!("effect-intent-{payload_hash}");
        Ok(Self {
            lease: lease.clone(),
            expected_revision: attempt.revision(),
            event_id: EventId::parse(&stable_id).map_err(|_| StoreError::InvalidInput)?,
            event_type: format!("effect_intent.{}", intent.as_str()).into(),
            idempotency_key: IdempotencyKey::parse(&stable_id)
                .map_err(|_| StoreError::InvalidInput)?,
            payload_hash: payload_hash.into(),
            payload,
        })
    }

    #[must_use]
    pub const fn expected_revision(&self) -> u64 {
        self.expected_revision
    }

    #[must_use]
    pub const fn event_id(&self) -> &EventId {
        &self.event_id
    }

    #[must_use]
    pub fn event_type(&self) -> &str {
        &self.event_type
    }

    #[must_use]
    pub const fn idempotency_key(&self) -> &IdempotencyKey {
        &self.idempotency_key
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }
}

impl fmt::Debug for AppendEffectIntent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AppendEffectIntent")
            .field("attempt_id", &self.lease.attempt_id)
            .field("execution_generation", &self.lease.execution_generation)
            .field("expected_revision", &self.expected_revision)
            .field("event_id", &self.event_id)
            .field("event_type", &self.event_type)
            .field("payload_hash", &self.payload_hash)
            .finish_non_exhaustive()
    }
}

impl ClaimedAttempt {
    #[must_use]
    pub const fn id(&self) -> &CallAttemptId {
        &self.id
    }

    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    #[must_use]
    pub const fn execution_generation(&self) -> ExecutionGeneration {
        self.execution_generation
    }
}

/// Fenced state mutation for a leased Attempt.
#[derive(Clone, Eq, PartialEq)]
pub struct AdvanceAttempt {
    pub tenant_id: TenantId,
    pub attempt_id: CallAttemptId,
    pub expected_revision: u64,
    pub expected_generation: ExecutionGeneration,
    pub lease_owner: String,
    pub lease_token_hash: String,
    pub next_state: CallAttemptState,
    pub disclosure_completed: bool,
}

impl fmt::Debug for AdvanceAttempt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AdvanceAttempt")
            .field("attempt_id", &self.attempt_id)
            .field("expected_revision", &self.expected_revision)
            .field("expected_generation", &self.expected_generation)
            .field("lease_owner", &self.lease_owner)
            .field("lease_token_hash", &"[REDACTED]")
            .field("next_state", &self.next_state)
            .field("disclosure_completed", &self.disclosure_completed)
            .finish_non_exhaustive()
    }
}

impl AdvanceAttempt {
    /// Binds one already-validated aggregate transition to the exact current lease.
    ///
    /// # Errors
    ///
    /// Rejects cross-Attempt observations and revisions that cannot have one predecessor.
    pub fn try_from_observation(
        lease: &AttemptLease,
        attempt: &CallAttempt,
    ) -> Result<Self, StoreError> {
        let expected_revision = attempt
            .revision()
            .checked_sub(1)
            .filter(|revision| *revision > 0)
            .ok_or(StoreError::InvalidInput)?;
        if lease.attempt_id != *attempt.id() {
            return Err(StoreError::InvalidInput);
        }
        Ok(Self {
            tenant_id: lease.tenant_id.clone(),
            attempt_id: lease.attempt_id.clone(),
            expected_revision,
            expected_generation: lease.execution_generation,
            lease_owner: lease.lease_owner.to_string(),
            lease_token_hash: lease.lease_token_hash.to_string(),
            next_state: attempt.state(),
            disclosure_completed: attempt.disclosure_completed(),
        })
    }
}

/// Append-only normalized event proposal.
#[derive(Clone, Debug, PartialEq)]
pub struct AppendEvent {
    pub tenant_id: TenantId,
    pub event_id: EventId,
    pub call_attempt_id: CallAttemptId,
    pub execution_generation: ExecutionGeneration,
    pub event_type: String,
    pub idempotency_key: IdempotencyKey,
    pub payload_hash: String,
    pub payload: Value,
    pub occurred_at_ms: u64,
    pub received_at_ms: u64,
}

/// Idempotent event append result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppendEventStatus {
    Inserted,
    Replayed,
}

/// SQL adapter. The caller owns a tenant-scoped transaction and its deadline.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AiOutboundStore {
    config: StoreConfig,
}

impl AiOutboundStore {
    #[must_use]
    pub const fn new(config: StoreConfig) -> Self {
        Self { config }
    }

    /// Loads the exact immutable dial snapshot for one physical Attempt.
    ///
    /// # Errors
    ///
    /// Rejects absent Attempts and legacy, partial or malformed snapshots without dialing.
    pub async fn load_dial_binding(
        &self,
        transaction: &Transaction<'_>,
        tenant_id: &TenantId,
        attempt_id: &CallAttemptId,
    ) -> Result<OutboundDialBinding, StoreError> {
        let row = transaction
            .query_opt(
                "SELECT dial_destination, dial_caller_id, dial_timeout_secs, dial_trunk
                 FROM converact_outbound_call_attempts
                 WHERE tenant_id = $1 AND id = $2",
                &[&tenant_id.as_str(), &attempt_id.as_str()],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?
            .ok_or(StoreError::AttemptNotFound)?;
        parse_dial_binding(&row)
    }

    /// Loads a complete aggregate snapshot only while the exact lease remains current.
    ///
    /// # Errors
    ///
    /// Returns a bounded failure for a stale lease, unavailable database or malformed row.
    pub async fn load_leased_attempt(
        &self,
        transaction: &Transaction<'_>,
        lease: &AttemptLease,
    ) -> Result<CallAttempt, StoreError> {
        let generation = i64::try_from(lease.execution_generation.get())
            .map_err(|_| StoreError::InvalidInput)?;
        let row = transaction
            .query_opt(
                "SELECT previous_attempt_id, state, revision,
                        CASE WHEN state IN (
                          'conversing', 'handoff_pending', 'human_active',
                          'ai_resuming', 'finalizing', 'completed'
                        ) THEN TRUE ELSE disclosure_completed END
                 FROM converact_outbound_call_attempts
                 WHERE tenant_id = $1 AND id = $2
                   AND execution_generation = $3 AND lease_owner = $4
                   AND lease_token_hash = $5
                   AND lease_expires_at > transaction_timestamp()",
                &[
                    &lease.tenant_id.as_str(),
                    &lease.attempt_id.as_str(),
                    &generation,
                    &lease.lease_owner.as_ref(),
                    &lease.lease_token_hash.as_ref(),
                ],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?
            .ok_or(StoreError::LeaseStale)?;
        let previous: Option<&str> = row.try_get(0).map_err(|_| StoreError::StoredRowInvalid)?;
        let state: &str = row.try_get(1).map_err(|_| StoreError::StoredRowInvalid)?;
        let revision: i64 = row.try_get(2).map_err(|_| StoreError::StoredRowInvalid)?;
        let disclosure_completed: bool =
            row.try_get(3).map_err(|_| StoreError::StoredRowInvalid)?;
        CallAttempt::restore(CallAttemptRestoreInput {
            id: lease.attempt_id.clone(),
            previous_attempt_id: previous
                .map(CallAttemptId::parse)
                .transpose()
                .map_err(|_| StoreError::StoredRowInvalid)?,
            state: parse_attempt_state(state)?,
            revision: positive_i64(revision)?,
            disclosure_completed,
        })
        .map_err(|_| StoreError::StoredRowInvalid)
    }

    /// Loads the immutable dial snapshot only while the exact lease remains current.
    ///
    /// # Errors
    ///
    /// Returns a bounded failure for a stale lease, unavailable database or malformed snapshot.
    pub async fn load_dial_binding_with_lease(
        &self,
        transaction: &Transaction<'_>,
        lease: &AttemptLease,
    ) -> Result<OutboundDialBinding, StoreError> {
        let generation = i64::try_from(lease.execution_generation.get())
            .map_err(|_| StoreError::InvalidInput)?;
        let row = transaction
            .query_opt(
                "SELECT dial_destination, dial_caller_id, dial_timeout_secs, dial_trunk
                 FROM converact_outbound_call_attempts
                 WHERE tenant_id = $1 AND id = $2
                   AND execution_generation = $3 AND lease_owner = $4
                   AND lease_token_hash = $5
                   AND lease_expires_at > transaction_timestamp()",
                &[
                    &lease.tenant_id.as_str(),
                    &lease.attempt_id.as_str(),
                    &generation,
                    &lease.lease_owner.as_ref(),
                    &lease.lease_token_hash.as_ref(),
                ],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?
            .ok_or(StoreError::LeaseStale)?;
        parse_dial_binding(&row)
    }

    /// Claims a bounded batch using the database clock and `SKIP LOCKED`.
    ///
    /// # Errors
    ///
    /// Rejects malformed lease authority, oversized batches, database failures and invalid rows.
    pub async fn claim_planned(
        &self,
        transaction: &Transaction<'_>,
        tenant_id: &TenantId,
        lease_owner: &str,
        lease_token_hash: &str,
        requested_limit: u16,
    ) -> Result<Vec<ClaimedAttempt>, StoreError> {
        if !valid_identifier(lease_owner)
            || !is_lowercase_sha256(lease_token_hash)
            || requested_limit == 0
            || requested_limit > self.config.max_claim_batch
        {
            return Err(StoreError::InvalidInput);
        }
        let limit = i64::from(requested_limit);
        let lease_ms =
            i64::try_from(self.config.lease_duration_ms).map_err(|_| StoreError::InvalidInput)?;
        let rows = transaction
            .query(
                CLAIM_SQL,
                &[
                    &tenant_id.as_str(),
                    &limit,
                    &lease_owner,
                    &lease_token_hash,
                    &lease_ms,
                ],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?;
        rows.iter().map(parse_claimed_attempt).collect()
    }

    /// Advances a leased Attempt only when revision, generation, owner, token and expiry match.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::LeaseStale`] when any fence is stale or the row is absent.
    pub async fn advance_with_lease(
        &self,
        transaction: &Transaction<'_>,
        command: &AdvanceAttempt,
    ) -> Result<u64, StoreError> {
        if command.expected_revision == 0
            || !valid_identifier(&command.lease_owner)
            || !is_lowercase_sha256(&command.lease_token_hash)
        {
            return Err(StoreError::InvalidInput);
        }
        let expected_revision =
            i64::try_from(command.expected_revision).map_err(|_| StoreError::InvalidInput)?;
        let generation = i64::try_from(command.expected_generation.get())
            .map_err(|_| StoreError::InvalidInput)?;
        let terminal = is_terminal_state(command.next_state);
        let row = transaction
            .query_opt(
                "UPDATE converact_outbound_call_attempts
                 SET state = $7,
                     revision = revision + 1,
                     disclosure_completed = $9,
                     updated_at = transaction_timestamp(),
                     terminal_at = CASE WHEN $8 THEN transaction_timestamp() ELSE terminal_at END,
                     lease_owner = CASE WHEN $8 THEN '' ELSE lease_owner END,
                     lease_token_hash = CASE WHEN $8 THEN '' ELSE lease_token_hash END,
                     lease_expires_at = CASE WHEN $8 THEN NULL ELSE lease_expires_at END
                 WHERE tenant_id = $1 AND id = $2 AND revision = $3
                   AND execution_generation = $4 AND lease_owner = $5
                   AND lease_token_hash = $6
                   AND lease_expires_at > transaction_timestamp()
                 RETURNING revision",
                &[
                    &command.tenant_id.as_str(),
                    &command.attempt_id.as_str(),
                    &expected_revision,
                    &generation,
                    &command.lease_owner,
                    &command.lease_token_hash,
                    &command.next_state.as_str(),
                    &terminal,
                    &command.disclosure_completed,
                ],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?
            .ok_or(StoreError::LeaseStale)?;
        positive_i64(row.try_get(0).map_err(|_| StoreError::StoredRowInvalid)?)
    }

    /// Appends an exact effect intent only while revision, generation and lease all match.
    ///
    /// # Errors
    ///
    /// Returns a bounded failure for stale authority, a conflicting replay or database failure.
    pub async fn append_effect_intent_with_lease(
        &self,
        transaction: &Transaction<'_>,
        command: &AppendEffectIntent,
    ) -> Result<AppendEventStatus, StoreError> {
        let lease = &command.lease;
        let revision =
            i64::try_from(command.expected_revision).map_err(|_| StoreError::InvalidInput)?;
        let generation = i64::try_from(lease.execution_generation.get())
            .map_err(|_| StoreError::InvalidInput)?;
        let inserted = transaction
            .query_opt(
                APPEND_EFFECT_INTENT_SQL,
                &[
                    &lease.tenant_id.as_str(),
                    &lease.attempt_id.as_str(),
                    &revision,
                    &generation,
                    &lease.lease_owner.as_ref(),
                    &lease.lease_token_hash.as_ref(),
                    &command.event_id.as_str(),
                    &command.event_type.as_ref(),
                    &command.idempotency_key.as_str(),
                    &command.payload_hash.as_ref(),
                    &command.payload,
                ],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?;
        if inserted.is_some() {
            return Ok(AppendEventStatus::Inserted);
        }
        let current = transaction
            .query_opt(
                "SELECT 1 FROM converact_outbound_call_attempts
                 WHERE tenant_id = $1 AND id = $2 AND revision = $3
                   AND execution_generation = $4 AND lease_owner = $5
                   AND lease_token_hash = $6
                   AND lease_expires_at > transaction_timestamp()",
                &[
                    &lease.tenant_id.as_str(),
                    &lease.attempt_id.as_str(),
                    &revision,
                    &generation,
                    &lease.lease_owner.as_ref(),
                    &lease.lease_token_hash.as_ref(),
                ],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?;
        if current.is_none() {
            return Err(StoreError::LeaseStale);
        }
        let existing = transaction
            .query_opt(
                "SELECT 1 FROM converact_outbound_attempt_events
                 WHERE tenant_id = $1 AND event_id = $2 AND call_attempt_id = $3
                   AND execution_generation = $4 AND event_type = $5
                   AND idempotency_key = $6 AND payload_hash = $7",
                &[
                    &lease.tenant_id.as_str(),
                    &command.event_id.as_str(),
                    &lease.attempt_id.as_str(),
                    &generation,
                    &command.event_type.as_ref(),
                    &command.idempotency_key.as_str(),
                    &command.payload_hash.as_ref(),
                ],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?;
        if existing.is_some() {
            Ok(AppendEventStatus::Replayed)
        } else {
            Err(StoreError::EventConflict)
        }
    }

    /// Appends one event or reports an exact same-ID/same-hash replay.
    ///
    /// # Errors
    ///
    /// Rejects malformed bounded fields, clock inversion, database failure and hash conflicts.
    pub async fn append_event(
        &self,
        transaction: &Transaction<'_>,
        event: &AppendEvent,
    ) -> Result<AppendEventStatus, StoreError> {
        validate_event(event)?;
        let generation = i64::try_from(event.execution_generation.get())
            .map_err(|_| StoreError::InvalidInput)?;
        let occurred_at_ms =
            i64::try_from(event.occurred_at_ms).map_err(|_| StoreError::InvalidInput)?;
        let received_at_ms =
            i64::try_from(event.received_at_ms).map_err(|_| StoreError::InvalidInput)?;
        let inserted = transaction
            .query_opt(
                "INSERT INTO converact_outbound_attempt_events (
                   tenant_id, event_id, call_attempt_id, execution_generation,
                   event_type, schema_version, idempotency_key, payload_hash,
                   payload, occurred_at, received_at
                 ) VALUES (
                   $1, $2, $3, $4, $5, 1, $6, $7, $8,
                   to_timestamp($9::double precision / 1000.0),
                   to_timestamp($10::double precision / 1000.0)
                 ) ON CONFLICT DO NOTHING
                 RETURNING event_id",
                &[
                    &event.tenant_id.as_str(),
                    &event.event_id.as_str(),
                    &event.call_attempt_id.as_str(),
                    &generation,
                    &event.event_type,
                    &event.idempotency_key.as_str(),
                    &event.payload_hash,
                    &event.payload,
                    &occurred_at_ms,
                    &received_at_ms,
                ],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?;
        if inserted.is_some() {
            return Ok(AppendEventStatus::Inserted);
        }
        let existing = transaction
            .query_opt(
                "SELECT payload_hash FROM converact_outbound_attempt_events
                 WHERE tenant_id = $1 AND event_id = $2",
                &[&event.tenant_id.as_str(), &event.event_id.as_str()],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?;
        match existing {
            Some(row)
                if row
                    .try_get::<_, &str>(0)
                    .is_ok_and(|hash| hash == event.payload_hash) =>
            {
                Ok(AppendEventStatus::Replayed)
            }
            _ => Err(StoreError::EventConflict),
        }
    }

    /// Inserts one separately identified retry Attempt or exactly replays the prior insert.
    ///
    /// The caller owns the tenant transaction and its deadline. This method never performs a
    /// physical dial.
    ///
    /// # Errors
    ///
    /// Rejects stale/non-retryable predecessors, stopped Campaigns, terminal Contacts, identity
    /// conflicts, invalid numeric conversion and database failures.
    pub async fn plan_retry(
        &self,
        transaction: &Transaction<'_>,
        command: &PlanRetryAttempt,
    ) -> Result<PlanRetryStatus, StoreError> {
        if let Some(row) = transaction
            .query_opt(
                LOAD_RETRY_SQL,
                &[
                    &command.tenant_id.as_str(),
                    &command.next_attempt_id.as_str(),
                    &command.idempotency_key.as_str(),
                ],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?
        {
            return classify_retry_replay(&row, command);
        }

        let revision = i64::try_from(command.expected_previous_revision)
            .map_err(|_| StoreError::InvalidInput)?;
        let generation = i64::try_from(command.expected_previous_generation.get())
            .map_err(|_| StoreError::InvalidInput)?;
        let attempt_number = i32::from(command.next_attempt_number);
        let scheduled_for_ms =
            i64::try_from(command.scheduled_for_ms).map_err(|_| StoreError::InvalidInput)?;
        let inserted = transaction
            .query_opt(
                PLAN_RETRY_SQL,
                &[
                    &command.tenant_id.as_str(),
                    &command.previous_attempt_id.as_str(),
                    &command.next_attempt_id.as_str(),
                    &revision,
                    &generation,
                    &attempt_number,
                    &scheduled_for_ms,
                    &command.idempotency_key.as_str(),
                    &command.retry_failed_after_answer,
                ],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?;
        if inserted.is_some() {
            return Ok(PlanRetryStatus::Created);
        }

        match transaction
            .query_opt(
                LOAD_RETRY_SQL,
                &[
                    &command.tenant_id.as_str(),
                    &command.next_attempt_id.as_str(),
                    &command.idempotency_key.as_str(),
                ],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?
        {
            Some(row) => classify_retry_replay(&row, command),
            None => Err(StoreError::RetryNotAllowed),
        }
    }
}

fn classify_retry_replay(
    row: &Row,
    command: &PlanRetryAttempt,
) -> Result<PlanRetryStatus, StoreError> {
    let next_attempt_id: &str = row.try_get(0).map_err(|_| StoreError::StoredRowInvalid)?;
    let previous_attempt_id: &str = row.try_get(1).map_err(|_| StoreError::StoredRowInvalid)?;
    let attempt_number: i32 = row.try_get(2).map_err(|_| StoreError::StoredRowInvalid)?;
    let scheduled_for_ms: i64 = row.try_get(3).map_err(|_| StoreError::StoredRowInvalid)?;
    let idempotency_key: &str = row.try_get(4).map_err(|_| StoreError::StoredRowInvalid)?;
    let exact = next_attempt_id == command.next_attempt_id.as_str()
        && previous_attempt_id == command.previous_attempt_id.as_str()
        && attempt_number == i32::from(command.next_attempt_number)
        && u64::try_from(scheduled_for_ms).ok() == Some(command.scheduled_for_ms)
        && idempotency_key == command.idempotency_key.as_str();
    if exact {
        Ok(PlanRetryStatus::Replayed)
    } else {
        Err(StoreError::RetryConflict)
    }
}

fn parse_claimed_attempt(row: &Row) -> Result<ClaimedAttempt, StoreError> {
    let id: &str = row.try_get(0).map_err(|_| StoreError::StoredRowInvalid)?;
    let revision: i64 = row.try_get(1).map_err(|_| StoreError::StoredRowInvalid)?;
    let generation: i64 = row.try_get(2).map_err(|_| StoreError::StoredRowInvalid)?;
    Ok(ClaimedAttempt {
        id: CallAttemptId::parse(id).map_err(|_| StoreError::StoredRowInvalid)?,
        revision: positive_i64(revision)?,
        execution_generation: ExecutionGeneration::new(positive_i64(generation)?)
            .map_err(|_| StoreError::StoredRowInvalid)?,
    })
}

fn parse_dial_binding(row: &Row) -> Result<OutboundDialBinding, StoreError> {
    let destination: &str = row.try_get(0).map_err(|_| StoreError::StoredRowInvalid)?;
    let caller_id: Option<&str> = row.try_get(1).map_err(|_| StoreError::StoredRowInvalid)?;
    let timeout_secs: i32 = row.try_get(2).map_err(|_| StoreError::StoredRowInvalid)?;
    let trunk: Option<&str> = row.try_get(3).map_err(|_| StoreError::StoredRowInvalid)?;
    OutboundDialBinding::try_new(OutboundDialBindingInput {
        destination: destination.to_owned(),
        caller_id: caller_id.map(str::to_owned),
        timeout_secs: u32::try_from(timeout_secs).map_err(|_| StoreError::StoredRowInvalid)?,
        trunk: trunk.map(str::to_owned),
    })
    .map_err(|_| StoreError::StoredRowInvalid)
}

fn parse_attempt_state(value: &str) -> Result<CallAttemptState, StoreError> {
    match value {
        "planned" => Ok(CallAttemptState::Planned),
        "claimed" => Ok(CallAttemptState::Claimed),
        "compliance_approved" => Ok(CallAttemptState::ComplianceApproved),
        "compliance_blocked" => Ok(CallAttemptState::ComplianceBlocked),
        "agent_capacity_reserved" => Ok(CallAttemptState::AgentCapacityReserved),
        "dialing" => Ok(CallAttemptState::Dialing),
        "ringing" => Ok(CallAttemptState::Ringing),
        "answered" => Ok(CallAttemptState::Answered),
        "agent_connecting" => Ok(CallAttemptState::AgentConnecting),
        "disclosure_pending" => Ok(CallAttemptState::DisclosurePending),
        "conversing" => Ok(CallAttemptState::Conversing),
        "handoff_pending" => Ok(CallAttemptState::HandoffPending),
        "human_active" => Ok(CallAttemptState::HumanActive),
        "ai_resuming" => Ok(CallAttemptState::AiResuming),
        "finalizing" => Ok(CallAttemptState::Finalizing),
        "completed" => Ok(CallAttemptState::Completed),
        "cancelled" => Ok(CallAttemptState::Cancelled),
        "busy" => Ok(CallAttemptState::Busy),
        "no_answer" => Ok(CallAttemptState::NoAnswer),
        "rejected" => Ok(CallAttemptState::Rejected),
        "failed_before_answer" => Ok(CallAttemptState::FailedBeforeAnswer),
        "failed_after_answer" => Ok(CallAttemptState::FailedAfterAnswer),
        "outcome_unknown" => Ok(CallAttemptState::OutcomeUnknown),
        "reconcile_required" => Ok(CallAttemptState::ReconcileRequired),
        _ => Err(StoreError::StoredRowInvalid),
    }
}

fn validate_event(event: &AppendEvent) -> Result<(), StoreError> {
    if !valid_identifier(&event.event_type)
        || event.event_type.len() > MAX_EVENT_TYPE_BYTES
        || !is_lowercase_sha256(&event.payload_hash)
        || event.received_at_ms < event.occurred_at_ms
        || serde_json::to_vec(&event.payload)
            .map_err(|_| StoreError::InvalidInput)?
            .len()
            > MAX_EVENT_PAYLOAD_BYTES
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}

fn positive_i64(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or(StoreError::StoredRowInvalid)
}

fn valid_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_IDENTIFIER_BYTES
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == SHA256_HEX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

const fn is_terminal_state(state: CallAttemptState) -> bool {
    matches!(
        state,
        CallAttemptState::ComplianceBlocked
            | CallAttemptState::Completed
            | CallAttemptState::Cancelled
            | CallAttemptState::Busy
            | CallAttemptState::NoAnswer
            | CallAttemptState::Rejected
            | CallAttemptState::FailedBeforeAnswer
            | CallAttemptState::FailedAfterAnswer
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_is_bounded_and_uses_database_clock_skip_locked() {
        assert!(CLAIM_SQL.contains("FOR UPDATE SKIP LOCKED"));
        assert!(CLAIM_SQL.contains("transaction_timestamp()"));
        assert_eq!(StoreConfig::new(0, 1), Err(StoreError::InvalidInput));
        assert_eq!(StoreConfig::new(30_000, 0), Err(StoreError::InvalidInput));
        assert!(StoreConfig::new(30_000, 10).is_ok());
    }
}
