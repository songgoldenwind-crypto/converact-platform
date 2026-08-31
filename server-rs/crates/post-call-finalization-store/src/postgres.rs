use converact_contracts::canonical_sha256;
use converact_kernel_ids::TenantId;
use converact_post_call_finalization_core::{FinalizationResolution, PostCallFinalizationJob};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, ConversationFinalizationJobId,
    ConversationFinalizationReceiptId, ExecutionGeneration, InteractionId,
};
use serde_json::json;
use tokio_postgres::{Row, Transaction};

use crate::{
    ClaimedFinalizationJob, ClaimedFinalizationJobInput, EnqueueFinalizationDecision,
    FinalizationJobProgress, FinalizationLease, FinalizationLeaseCommand,
    FinalizationReconcileCommand, FinalizationStoreConfig, FinalizationStoreError,
};

/// Stateless tenant-transaction SQL adapter for durable post-call finalization work.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FinalizationSqlStore {
    config: FinalizationStoreConfig,
}

impl FinalizationSqlStore {
    #[must_use]
    pub const fn new(config: FinalizationStoreConfig) -> Self {
        Self { config }
    }

    /// Enqueues one exact job and immutable receipt or classifies its replay.
    ///
    /// # Errors
    ///
    /// Returns conversion, conflict, database or stored-row failures.
    pub async fn enqueue(
        &self,
        transaction: &Transaction<'_>,
        job: &PostCallFinalizationJob,
    ) -> Result<EnqueueFinalizationDecision, FinalizationStoreError> {
        let context = job.context();
        let generation = i64_from(context.execution_generation().get())?;
        let enqueued_at_ms = i64_from(job.enqueued_at_ms())?;
        let inserted = transaction
            .query_opt(
                "INSERT INTO converact_post_call_finalization_jobs (
                   tenant_id, job_id, interaction_id, call_attempt_id, agent_release_id,
                   execution_generation, retention_policy_ref, payload_hash, state, revision,
                   enqueued_at
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 1,
                   to_timestamp($9::DOUBLE PRECISION / 1000.0))
                 ON CONFLICT DO NOTHING RETURNING job_id",
                &[
                    &context.tenant_id(),
                    &job.id().as_str(),
                    &context.interaction_id().as_str(),
                    &context.call_attempt_id().as_str(),
                    &context.agent_release_id().as_str(),
                    &generation,
                    &job.retention_policy_ref(),
                    &job.payload_hash(),
                    &enqueued_at_ms,
                ],
            )
            .await
            .map_err(|_| FinalizationStoreError::DatabaseUnavailable)?;
        if inserted.is_some() {
            insert_receipt(
                transaction,
                ReceiptInput {
                    tenant_id: context.tenant_id(),
                    job_id: job.id(),
                    call_attempt_id: context.call_attempt_id(),
                    stage: "enqueued",
                    payload_hash: job.payload_hash(),
                    resolution: None,
                    observed_revision: 1,
                    observed_at_ms: job.enqueued_at_ms(),
                },
            )
            .await?;
            return Ok(EnqueueFinalizationDecision::Created);
        }
        classify_enqueue_replay(transaction, job).await
    }

    /// Claims a bounded due batch using the database-clock function and an expiring lease.
    ///
    /// # Errors
    ///
    /// Rejects oversized batches and returns database or stored-row failures.
    pub async fn claim_due(
        &self,
        transaction: &Transaction<'_>,
        tenant_id: &TenantId,
        lease: &FinalizationLease,
        requested_limit: u16,
    ) -> Result<Vec<ClaimedFinalizationJob>, FinalizationStoreError> {
        if requested_limit == 0 || requested_limit > self.config.max_claim_batch() {
            return Err(FinalizationStoreError::InvalidInput);
        }
        let lease_ms = i64_from(self.config.lease_duration_ms())?;
        let limit = i32::from(requested_limit);
        let rows = transaction
            .query(
                "SELECT job_id, interaction_id, call_attempt_id, agent_release_id,
                        execution_generation, retention_policy_ref, payload_hash, revision
                 FROM converact_claim_post_call_finalization_jobs($1, $2, $3, $4, $5)
                 ORDER BY enqueued_at, job_id LIMIT $5",
                &[
                    &tenant_id.as_str(),
                    &lease.owner(),
                    &lease.token_hash(),
                    &lease_ms,
                    &limit,
                ],
            )
            .await
            .map_err(|_| FinalizationStoreError::DatabaseUnavailable)?;
        rows.iter().map(claimed_job).collect()
    }

    /// Loads bounded progress for one tenant-bound physical Attempt.
    ///
    /// # Errors
    ///
    /// Returns only database or stored-row failures.
    pub async fn load_progress(
        &self,
        transaction: &Transaction<'_>,
        tenant_id: &TenantId,
        call_attempt_id: &CallAttemptId,
    ) -> Result<Option<FinalizationJobProgress>, FinalizationStoreError> {
        transaction
            .query_opt(
                "SELECT state, resolution, last_error_code, revision
                 FROM converact_post_call_finalization_jobs
                 WHERE tenant_id = $1 AND call_attempt_id = $2",
                &[&tenant_id.as_str(), &call_attempt_id.as_str()],
            )
            .await
            .map_err(|_| FinalizationStoreError::DatabaseUnavailable)?
            .map(|row| {
                FinalizationJobProgress::try_from_stored(
                    &string_at(&row, 0)?,
                    optional_string_at(&row, 1)?.as_deref(),
                    optional_string_at(&row, 2)?,
                    u64_at(&row, 3)?,
                )
            })
            .transpose()
    }

    /// Releases a claimed job into explicit reconcile state using every lease/revision fence.
    ///
    /// # Errors
    ///
    /// Returns stale lease, invalid command or database failure.
    pub async fn require_reconcile(
        &self,
        transaction: &Transaction<'_>,
        command: &FinalizationReconcileCommand,
    ) -> Result<u64, FinalizationStoreError> {
        mutate_claimed_job(
            transaction,
            command.lease_command(),
            "reconcile_required",
            None,
            Some(command.error_code()),
        )
        .await
    }

    /// Atomically settles a claimed job and appends its immutable state-observed receipt.
    ///
    /// # Errors
    ///
    /// Returns stale lease, invalid command, conversion, receipt or database failure.
    pub async fn complete(
        &self,
        transaction: &Transaction<'_>,
        command: &FinalizationLeaseCommand,
        resolution: FinalizationResolution,
    ) -> Result<u64, FinalizationStoreError> {
        let row = update_claimed_job(
            transaction,
            command,
            "completed",
            Some(resolution.as_str()),
            None,
        )
        .await?;
        let revision = u64_at(&row, 0)?;
        let observed_at_ms = u64_at(&row, 1)?;
        let payload_hash = string_at(&row, 2)?;
        let call_attempt_id = CallAttemptId::parse(string_at(&row, 3)?)
            .map_err(|_| FinalizationStoreError::StoredRowInvalid)?;
        insert_receipt(
            transaction,
            ReceiptInput {
                tenant_id: command.tenant_id.as_str(),
                job_id: &command.job_id,
                call_attempt_id: &call_attempt_id,
                stage: "state_observed",
                payload_hash: &payload_hash,
                resolution: Some(resolution.as_str()),
                observed_revision: revision,
                observed_at_ms,
            },
        )
        .await?;
        Ok(revision)
    }
}

async fn classify_enqueue_replay(
    transaction: &Transaction<'_>,
    job: &PostCallFinalizationJob,
) -> Result<EnqueueFinalizationDecision, FinalizationStoreError> {
    let context = job.context();
    let row = transaction
        .query_opt(
            "SELECT job_id, interaction_id, call_attempt_id, agent_release_id,
                    execution_generation, retention_policy_ref, payload_hash
             FROM converact_post_call_finalization_jobs
             WHERE tenant_id = $1 AND (job_id = $2 OR call_attempt_id = $3)",
            &[
                &context.tenant_id(),
                &job.id().as_str(),
                &context.call_attempt_id().as_str(),
            ],
        )
        .await
        .map_err(|_| FinalizationStoreError::DatabaseUnavailable)?
        .ok_or(FinalizationStoreError::Conflict)?;
    let generation = u64_at(&row, 4)?;
    let exact = string_at(&row, 0)? == job.id().as_str()
        && string_at(&row, 1)? == context.interaction_id().as_str()
        && string_at(&row, 2)? == context.call_attempt_id().as_str()
        && string_at(&row, 3)? == context.agent_release_id().as_str()
        && generation == context.execution_generation().get()
        && string_at(&row, 5)? == job.retention_policy_ref()
        && string_at(&row, 6)? == job.payload_hash();
    if exact {
        Ok(EnqueueFinalizationDecision::Replay)
    } else {
        Err(FinalizationStoreError::Conflict)
    }
}

async fn mutate_claimed_job(
    transaction: &Transaction<'_>,
    command: &FinalizationLeaseCommand,
    state: &str,
    resolution: Option<&str>,
    last_error_code: Option<&str>,
) -> Result<u64, FinalizationStoreError> {
    update_claimed_job(transaction, command, state, resolution, last_error_code)
        .await
        .and_then(|row| u64_at(&row, 0))
}

async fn update_claimed_job(
    transaction: &Transaction<'_>,
    command: &FinalizationLeaseCommand,
    state: &str,
    resolution: Option<&str>,
    last_error_code: Option<&str>,
) -> Result<Row, FinalizationStoreError> {
    if command.expected_revision == 0 {
        return Err(FinalizationStoreError::InvalidInput);
    }
    let revision = i64_from(command.expected_revision)?;
    transaction
        .query_opt(
            "UPDATE converact_post_call_finalization_jobs
             SET state = $6, resolution = $7, last_error_code = $8,
                 revision = revision + 1,
                 lease_owner = '', lease_token_hash = '', lease_expires_at = NULL,
                 completed_at = CASE WHEN $6 = 'completed' THEN transaction_timestamp()
                                     ELSE NULL END,
                 updated_at = transaction_timestamp()
             WHERE tenant_id = $1 AND job_id = $2 AND state = 'claimed'
               AND revision = $3 AND lease_owner = $4 AND lease_token_hash = $5
               AND lease_expires_at > transaction_timestamp()
             RETURNING revision,
               floor(extract(epoch FROM updated_at) * 1000)::BIGINT,
               payload_hash, call_attempt_id",
            &[
                &command.tenant_id.as_str(),
                &command.job_id.as_str(),
                &revision,
                &command.lease.owner(),
                &command.lease.token_hash(),
                &state,
                &resolution,
                &last_error_code,
            ],
        )
        .await
        .map_err(|_| FinalizationStoreError::DatabaseUnavailable)?
        .ok_or(FinalizationStoreError::LeaseStale)
}

struct ReceiptInput<'a> {
    tenant_id: &'a str,
    job_id: &'a ConversationFinalizationJobId,
    call_attempt_id: &'a CallAttemptId,
    stage: &'static str,
    payload_hash: &'a str,
    resolution: Option<&'a str>,
    observed_revision: u64,
    observed_at_ms: u64,
}

async fn insert_receipt(
    transaction: &Transaction<'_>,
    input: ReceiptInput<'_>,
) -> Result<(), FinalizationStoreError> {
    let digest = canonical_sha256(&json!({
        "tenant_id": input.tenant_id,
        "job_id": input.job_id.as_str(),
        "call_attempt_id": input.call_attempt_id.as_str(),
        "stage": input.stage,
        "payload_hash": input.payload_hash,
        "resolution": input.resolution,
        "observed_revision": input.observed_revision,
        "observed_at_ms": input.observed_at_ms
    }))
    .map_err(|_| FinalizationStoreError::SerializationFailed)?;
    let receipt_id = ConversationFinalizationReceiptId::parse(format!(
        "post-call-receipt-{}-{digest}",
        input.stage
    ))
    .map_err(|_| FinalizationStoreError::SerializationFailed)?;
    let revision = i64_from(input.observed_revision)?;
    let observed_at_ms = i64_from(input.observed_at_ms)?;
    transaction
        .execute(
            "INSERT INTO converact_post_call_finalization_receipts (
               tenant_id, receipt_id, job_id, call_attempt_id, stage, receipt_digest,
               payload_hash, resolution, observed_revision, observed_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               to_timestamp($10::DOUBLE PRECISION / 1000.0))",
            &[
                &input.tenant_id,
                &receipt_id.as_str(),
                &input.job_id.as_str(),
                &input.call_attempt_id.as_str(),
                &input.stage,
                &digest,
                &input.payload_hash,
                &input.resolution,
                &revision,
                &observed_at_ms,
            ],
        )
        .await
        .map_err(|_| FinalizationStoreError::DatabaseUnavailable)?;
    Ok(())
}

fn claimed_job(row: &Row) -> Result<ClaimedFinalizationJob, FinalizationStoreError> {
    ClaimedFinalizationJob::try_from_claim(ClaimedFinalizationJobInput {
        id: ConversationFinalizationJobId::parse(string_at(row, 0)?)
            .map_err(|_| FinalizationStoreError::StoredRowInvalid)?,
        interaction_id: InteractionId::parse(string_at(row, 1)?)
            .map_err(|_| FinalizationStoreError::StoredRowInvalid)?,
        call_attempt_id: CallAttemptId::parse(string_at(row, 2)?)
            .map_err(|_| FinalizationStoreError::StoredRowInvalid)?,
        agent_release_id: AgentReleaseId::parse(string_at(row, 3)?)
            .map_err(|_| FinalizationStoreError::StoredRowInvalid)?,
        execution_generation: ExecutionGeneration::new(u64_at(row, 4)?)
            .map_err(|_| FinalizationStoreError::StoredRowInvalid)?,
        retention_policy_ref: string_at(row, 5)?,
        payload_hash: string_at(row, 6)?,
        revision: u64_at(row, 7)?,
    })
}

fn string_at(row: &Row, index: usize) -> Result<String, FinalizationStoreError> {
    row.try_get(index)
        .map_err(|_| FinalizationStoreError::StoredRowInvalid)
}

fn optional_string_at(row: &Row, index: usize) -> Result<Option<String>, FinalizationStoreError> {
    row.try_get(index)
        .map_err(|_| FinalizationStoreError::StoredRowInvalid)
}

fn i64_at(row: &Row, index: usize) -> Result<i64, FinalizationStoreError> {
    row.try_get(index)
        .map_err(|_| FinalizationStoreError::StoredRowInvalid)
}

fn u64_at(row: &Row, index: usize) -> Result<u64, FinalizationStoreError> {
    u64::try_from(i64_at(row, index)?).map_err(|_| FinalizationStoreError::StoredRowInvalid)
}

fn i64_from(value: u64) -> Result<i64, FinalizationStoreError> {
    i64::try_from(value).map_err(|_| FinalizationStoreError::InvalidInput)
}
