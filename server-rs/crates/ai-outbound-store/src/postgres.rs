use std::{error::Error, fmt};

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
            Self::StoredRowInvalid => "ai_outbound_stored_row_invalid",
        }
    }
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
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdvanceAttempt {
    pub tenant_id: TenantId,
    pub attempt_id: CallAttemptId,
    pub expected_revision: u64,
    pub expected_generation: ExecutionGeneration,
    pub lease_owner: String,
    pub lease_token_hash: String,
    pub next_state: CallAttemptState,
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
                ],
            )
            .await
            .map_err(|_| StoreError::DatabaseUnavailable)?
            .ok_or(StoreError::LeaseStale)?;
        positive_i64(row.try_get(0).map_err(|_| StoreError::StoredRowInvalid)?)
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
