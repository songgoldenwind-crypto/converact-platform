use std::sync::Arc;

use converact_ai_outbound_core::{
    AttemptCompletionPort, AttemptStorePort, CallAttempt, EffectIntent, OutboundDialBinding,
    PortError, TerminalAttemptCommit,
};
use converact_ai_outbound_store::{
    AdvanceAttempt, AiOutboundStore, AppendEffectIntent, AttemptLease, AttemptLeaseInput,
    StoreError,
};
use converact_contracts::canonical_sha256;
use converact_kernel_ids::TenantId;
use converact_post_call_finalization_core::{FinalizationJobInput, PostCallFinalizationJob};
use converact_post_call_finalization_store::{FinalizationSqlStore, FinalizationStoreError};
use converact_voice_agent_contracts::{
    CallAttemptId, CampaignContactId, ConversationFinalizationJobId, EnvelopeContext,
    EnvelopeContextInput, InteractionId, VOICE_AGENT_SCHEMA_VERSION,
};
use serde_json::json;
use tokio_postgres::{Row, Transaction};

use crate::{PostgresRuntime, TransactionError};

/// Shareable claim boundary that creates one lease-scoped Store adapter per physical Attempt.
pub struct PostgresAiOutboundAttemptStore {
    runtime: Arc<PostgresRuntime>,
    sql: AiOutboundStore,
    finalization_sql: FinalizationSqlStore,
}

impl PostgresAiOutboundAttemptStore {
    #[must_use]
    pub const fn new(
        runtime: Arc<PostgresRuntime>,
        sql: AiOutboundStore,
        finalization_sql: FinalizationSqlStore,
    ) -> Self {
        Self {
            runtime,
            sql,
            finalization_sql,
        }
    }

    /// Atomically claims a bounded batch and returns adapters that cannot cross Attempt fences.
    ///
    /// # Errors
    ///
    /// Rejects malformed claim authority and reports an unknown commit outcome for reconciliation.
    pub async fn claim_planned(
        &self,
        tenant_id: &TenantId,
        lease_owner: &str,
        lease_token_hash: &str,
        requested_limit: u16,
    ) -> Result<Vec<PostgresLeasedAttemptStore>, PortError> {
        let tenant = tenant_id.clone();
        let owner = lease_owner.to_owned();
        let token_hash = lease_token_hash.to_owned();
        let transaction_tenant = tenant.clone();
        let transaction_owner = owner.clone();
        let transaction_token_hash = token_hash.clone();
        let sql = self.sql;
        let claimed = self
            .runtime
            .with_tenant_transaction(&transaction_tenant, move |transaction| {
                Box::pin(async move {
                    sql.claim_planned(
                        transaction,
                        &tenant,
                        &transaction_owner,
                        &transaction_token_hash,
                        requested_limit,
                    )
                    .await
                })
            })
            .await
            .map_err(map_write_error)?;

        claimed
            .into_iter()
            .map(|attempt| {
                let lease = AttemptLease::try_new(AttemptLeaseInput {
                    tenant_id: tenant_id.clone(),
                    attempt_id: attempt.id().clone(),
                    execution_generation: attempt.execution_generation(),
                    lease_owner: owner.clone(),
                    lease_token_hash: token_hash.clone(),
                })
                .map_err(map_store_error)?;
                Ok(PostgresLeasedAttemptStore::new(
                    Arc::clone(&self.runtime),
                    self.sql,
                    self.finalization_sql,
                    lease,
                ))
            })
            .collect()
    }
}

/// Tenant-transaction-owned Attempt port for exactly one claimed execution.
///
/// Keeping the lease in the adapter makes it impossible for the orchestrator to issue an
/// unfenced load, intent or transition, or to accidentally reuse the adapter for another
/// physical Attempt.
pub struct PostgresLeasedAttemptStore {
    runtime: Arc<PostgresRuntime>,
    sql: AiOutboundStore,
    finalization_sql: FinalizationSqlStore,
    lease: AttemptLease,
}

impl PostgresLeasedAttemptStore {
    #[must_use]
    pub const fn new(
        runtime: Arc<PostgresRuntime>,
        sql: AiOutboundStore,
        finalization_sql: FinalizationSqlStore,
        lease: AttemptLease,
    ) -> Self {
        Self {
            runtime,
            sql,
            finalization_sql,
            lease,
        }
    }

    #[must_use]
    pub const fn attempt_id(&self) -> &CallAttemptId {
        self.lease.attempt_id()
    }

    fn accepts(&self, attempt_id: &CallAttemptId) -> Result<(), PortError> {
        if self.lease.attempt_id() == attempt_id {
            Ok(())
        } else {
            Err(PortError::rejected("ai_outbound_attempt_lease_mismatch"))
        }
    }
}

impl AttemptStorePort for PostgresLeasedAttemptStore {
    async fn load(&self, attempt_id: &CallAttemptId) -> Result<CallAttempt, PortError> {
        self.accepts(attempt_id)?;
        let tenant = self.lease.tenant_id().clone();
        let lease = self.lease.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move { sql.load_leased_attempt(transaction, &lease).await })
            })
            .await
            .map_err(map_read_error)
    }

    async fn load_dial_binding(
        &self,
        attempt_id: &CallAttemptId,
    ) -> Result<OutboundDialBinding, PortError> {
        self.accepts(attempt_id)?;
        let tenant = self.lease.tenant_id().clone();
        let lease = self.lease.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move { sql.load_dial_binding_with_lease(transaction, &lease).await })
            })
            .await
            .map_err(map_read_error)
    }

    async fn persist_intent(
        &self,
        attempt: &CallAttempt,
        intent: EffectIntent,
    ) -> Result<(), PortError> {
        let command =
            AppendEffectIntent::try_new(&self.lease, attempt, intent).map_err(map_store_error)?;
        let tenant = self.lease.tenant_id().clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    sql.append_effect_intent_with_lease(transaction, &command)
                        .await
                        .map(|_| ())
                })
            })
            .await
            .map_err(map_write_error)
    }

    async fn persist_observation(&self, attempt: &CallAttempt) -> Result<(), PortError> {
        let command =
            AdvanceAttempt::try_from_observation(&self.lease, attempt).map_err(map_store_error)?;
        let tenant = self.lease.tenant_id().clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    sql.advance_with_lease(transaction, &command)
                        .await
                        .map(|_| ())
                })
            })
            .await
            .map_err(map_write_error)
    }
}

impl AttemptCompletionPort for PostgresLeasedAttemptStore {
    async fn complete_and_enqueue(&self, command: TerminalAttemptCommit) -> Result<(), PortError> {
        self.accepts(command.attempt().id())?;
        let tenant = self.lease.tenant_id().clone();
        let lease = self.lease.clone();
        let finalization_sql = self.finalization_sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    let job = settle_terminal_attempt(transaction, &lease, &command).await?;
                    finalization_sql
                        .enqueue(transaction, &job)
                        .await
                        .map_err(AtomicCompletionError::Finalization)?;
                    Ok(())
                })
            })
            .await
            .map_err(map_completion_error)
    }
}

#[derive(Clone, Copy)]
enum AtomicCompletionError {
    Attempt(StoreError),
    Finalization(FinalizationStoreError),
}

async fn settle_terminal_attempt(
    transaction: &Transaction<'_>,
    lease: &AttemptLease,
    command: &TerminalAttemptCommit,
) -> Result<PostCallFinalizationJob, AtomicCompletionError> {
    if let Some(row) = load_committed_attempt(transaction, lease.attempt_id())
        .await
        .map_err(AtomicCompletionError::Attempt)?
    {
        return restore_committed_job(&row, lease, command).map_err(AtomicCompletionError::Attempt);
    }

    let expected_revision = command
        .attempt()
        .revision()
        .checked_sub(2)
        .filter(|revision| *revision > 0)
        .ok_or(AtomicCompletionError::Attempt(StoreError::InvalidInput))?;
    let expected_revision = i64::try_from(expected_revision)
        .map_err(|_| AtomicCompletionError::Attempt(StoreError::InvalidInput))?;
    let terminal_revision = i64::try_from(command.attempt().revision())
        .map_err(|_| AtomicCompletionError::Attempt(StoreError::InvalidInput))?;
    let generation = i64::try_from(lease.execution_generation().get())
        .map_err(|_| AtomicCompletionError::Attempt(StoreError::InvalidInput))?;
    let row = transaction
        .query_opt(
            "UPDATE converact_outbound_call_attempts
             SET state = 'completed', revision = $9, disclosure_completed = TRUE,
                 call_id = $10, channel_agent_session_id = $11,
                 updated_at = transaction_timestamp(), terminal_at = transaction_timestamp(),
                 lease_owner = '', lease_token_hash = '', lease_expires_at = NULL
             WHERE tenant_id = $1 AND id = $2 AND campaign_id = $3
               AND agent_release_id = $4 AND execution_generation = $5
               AND lease_owner = $6 AND lease_token_hash = $7
               AND lease_expires_at > transaction_timestamp()
               AND revision = $8 AND state = 'conversing' AND disclosure_completed = TRUE
             RETURNING campaign_contact_id, interaction_id,
                       ROUND(EXTRACT(EPOCH FROM retention_until) * 1000)::BIGINT,
                       ROUND(EXTRACT(EPOCH FROM transaction_timestamp()) * 1000)::BIGINT",
            &[
                &lease.tenant_id().as_str(),
                &lease.attempt_id().as_str(),
                &command.campaign_id().as_str(),
                &command.agent_release_id().as_str(),
                &generation,
                &lease.lease_owner(),
                &lease.lease_token_hash(),
                &expected_revision,
                &terminal_revision,
                &command.call_id().as_str(),
                &command.channel_agent_session_id().as_str(),
            ],
        )
        .await
        .map_err(|_| AtomicCompletionError::Attempt(StoreError::DatabaseUnavailable))?
        .ok_or(AtomicCompletionError::Attempt(StoreError::LeaseStale))?;
    build_finalization_job(&row, lease, command).map_err(AtomicCompletionError::Attempt)
}

async fn load_committed_attempt(
    transaction: &Transaction<'_>,
    attempt_id: &CallAttemptId,
) -> Result<Option<Row>, StoreError> {
    transaction
        .query_opt(
            "SELECT attempt.campaign_contact_id, attempt.interaction_id,
                    ROUND(EXTRACT(EPOCH FROM attempt.retention_until) * 1000)::BIGINT,
                    ROUND(EXTRACT(EPOCH FROM job.enqueued_at) * 1000)::BIGINT,
                    attempt.campaign_id, attempt.agent_release_id, attempt.call_id,
                    attempt.channel_agent_session_id, attempt.execution_generation,
                    attempt.revision, attempt.disclosure_completed,
                    job.job_id, job.retention_policy_ref
             FROM converact_outbound_call_attempts AS attempt
             LEFT JOIN converact_post_call_finalization_jobs AS job
               ON job.tenant_id = attempt.tenant_id AND job.call_attempt_id = attempt.id
             WHERE attempt.tenant_id = opc_current_tenant() AND attempt.id = $1
               AND attempt.state = 'completed'",
            &[&attempt_id.as_str()],
        )
        .await
        .map_err(|_| StoreError::DatabaseUnavailable)
}

fn build_finalization_job(
    row: &Row,
    lease: &AttemptLease,
    command: &TerminalAttemptCommit,
) -> Result<PostCallFinalizationJob, StoreError> {
    let contact: &str = row.try_get(0).map_err(|_| StoreError::StoredRowInvalid)?;
    let contact = CampaignContactId::parse(contact).map_err(|_| StoreError::StoredRowInvalid)?;
    let interaction: &str = row.try_get(1).map_err(|_| StoreError::StoredRowInvalid)?;
    let interaction =
        InteractionId::parse(interaction).map_err(|_| StoreError::StoredRowInvalid)?;
    let retention_until_ms = positive_ms(row, 2)?;
    let enqueued_at_ms = positive_ms(row, 3)?;
    create_finalization_job(
        lease,
        command,
        contact,
        interaction,
        retention_until_ms,
        enqueued_at_ms,
    )
}

fn restore_committed_job(
    row: &Row,
    lease: &AttemptLease,
    command: &TerminalAttemptCommit,
) -> Result<PostCallFinalizationJob, StoreError> {
    let campaign: &str = row.try_get(4).map_err(|_| StoreError::StoredRowInvalid)?;
    let release: &str = row.try_get(5).map_err(|_| StoreError::StoredRowInvalid)?;
    let call: Option<&str> = row.try_get(6).map_err(|_| StoreError::StoredRowInvalid)?;
    let session: Option<&str> = row.try_get(7).map_err(|_| StoreError::StoredRowInvalid)?;
    let generation: i64 = row.try_get(8).map_err(|_| StoreError::StoredRowInvalid)?;
    let revision: i64 = row.try_get(9).map_err(|_| StoreError::StoredRowInvalid)?;
    let disclosure_completed: bool = row.try_get(10).map_err(|_| StoreError::StoredRowInvalid)?;
    let stored_job_id: Option<&str> = row.try_get(11).map_err(|_| StoreError::StoredRowInvalid)?;
    let stored_retention: Option<&str> =
        row.try_get(12).map_err(|_| StoreError::StoredRowInvalid)?;
    if campaign != command.campaign_id().as_str()
        || release != command.agent_release_id().as_str()
        || call != Some(command.call_id().as_str())
        || session != Some(command.channel_agent_session_id().as_str())
        || generation != i64::try_from(lease.execution_generation().get()).unwrap_or_default()
        || revision != i64::try_from(command.attempt().revision()).unwrap_or_default()
        || !disclosure_completed
        || stored_job_id.is_none()
    {
        return Err(StoreError::StoredRowInvalid);
    }
    let job = build_finalization_job(row, lease, command)?;
    if stored_job_id != Some(job.id().as_str())
        || stored_retention != Some(job.retention_policy_ref())
    {
        return Err(StoreError::StoredRowInvalid);
    }
    Ok(job)
}

fn create_finalization_job(
    lease: &AttemptLease,
    command: &TerminalAttemptCommit,
    campaign_contact_id: CampaignContactId,
    interaction_id: InteractionId,
    retention_until_ms: u64,
    enqueued_at_ms: u64,
) -> Result<PostCallFinalizationJob, StoreError> {
    let identity_hash = canonical_sha256(&json!({
        "tenant_id": lease.tenant_id().as_str(),
        "call_attempt_id": lease.attempt_id().as_str(),
        "execution_generation": lease.execution_generation().get(),
    }))
    .map_err(|_| StoreError::InvalidInput)?;
    let stable_id = format!("post-call-{identity_hash}");
    let context = EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version: VOICE_AGENT_SCHEMA_VERSION,
        tenant_id: lease.tenant_id().as_str().to_owned(),
        interaction_id,
        campaign_id: command.campaign_id().clone(),
        campaign_contact_id,
        call_attempt_id: lease.attempt_id().clone(),
        call_id: Some(command.call_id().clone()),
        agent_release_id: command.agent_release_id().clone(),
        channel_agent_session_id: Some(command.channel_agent_session_id().clone()),
        execution_generation: lease.execution_generation(),
        trace_id: stable_id.clone(),
    })
    .map_err(|_| StoreError::StoredRowInvalid)?;
    PostCallFinalizationJob::try_new(FinalizationJobInput {
        id: ConversationFinalizationJobId::parse(&stable_id)
            .map_err(|_| StoreError::StoredRowInvalid)?,
        context,
        retention_policy_ref: format!("until-ms-{retention_until_ms}"),
        enqueued_at_ms,
    })
    .map_err(|_| StoreError::StoredRowInvalid)
}

fn positive_ms(row: &Row, index: usize) -> Result<u64, StoreError> {
    let value: i64 = row
        .try_get(index)
        .map_err(|_| StoreError::StoredRowInvalid)?;
    u64::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or(StoreError::StoredRowInvalid)
}

const fn map_store_error(error: StoreError) -> PortError {
    match error {
        StoreError::DatabaseUnavailable => PortError::unavailable("ai_outbound_store_unavailable"),
        StoreError::LeaseStale => PortError::rejected("ai_outbound_lease_stale"),
        _ => PortError::rejected(error.code()),
    }
}

#[allow(clippy::needless_pass_by_value)]
fn map_read_error(error: TransactionError<StoreError>) -> PortError {
    match error {
        TransactionError::Work(error) => map_store_error(error),
        TransactionError::AdmissionRejected => {
            PortError::unavailable("ai_outbound_store_admission_rejected")
        }
        TransactionError::PoolUnavailable
        | TransactionError::DatabaseUnavailable
        | TransactionError::DeadlineExceeded
        | TransactionError::RollbackUnknown
        | TransactionError::CommitUnknown => {
            PortError::unavailable("ai_outbound_store_unavailable")
        }
    }
}

#[allow(clippy::needless_pass_by_value)]
fn map_write_error(error: TransactionError<StoreError>) -> PortError {
    match error {
        TransactionError::Work(error) => map_store_error(error),
        TransactionError::CommitUnknown | TransactionError::RollbackUnknown => {
            PortError::outcome_unknown("ai_outbound_store_outcome_unknown")
        }
        TransactionError::AdmissionRejected => {
            PortError::unavailable("ai_outbound_store_admission_rejected")
        }
        TransactionError::PoolUnavailable
        | TransactionError::DatabaseUnavailable
        | TransactionError::DeadlineExceeded => {
            PortError::unavailable("ai_outbound_store_unavailable")
        }
    }
}

#[allow(clippy::needless_pass_by_value)]
fn map_completion_error(error: TransactionError<AtomicCompletionError>) -> PortError {
    match error {
        TransactionError::Work(AtomicCompletionError::Attempt(error)) => map_store_error(error),
        TransactionError::Work(AtomicCompletionError::Finalization(
            FinalizationStoreError::DatabaseUnavailable,
        )) => PortError::unavailable("post_call_finalization_store_unavailable"),
        TransactionError::Work(AtomicCompletionError::Finalization(error)) => {
            PortError::rejected(error.code())
        }
        TransactionError::CommitUnknown | TransactionError::RollbackUnknown => {
            PortError::outcome_unknown("ai_outbound_completion_outcome_unknown")
        }
        TransactionError::AdmissionRejected => {
            PortError::unavailable("ai_outbound_store_admission_rejected")
        }
        TransactionError::PoolUnavailable
        | TransactionError::DatabaseUnavailable
        | TransactionError::DeadlineExceeded => {
            PortError::unavailable("ai_outbound_store_unavailable")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use converact_ai_outbound_core::PortFailureKind;

    #[test]
    fn mutation_commit_or_rollback_uncertainty_requires_reconciliation() {
        for error in [
            TransactionError::CommitUnknown,
            TransactionError::RollbackUnknown,
        ] {
            let mapped = map_write_error(error);
            assert_eq!(mapped.kind(), PortFailureKind::OutcomeUnknown);
            assert_eq!(mapped.code(), "ai_outbound_store_outcome_unknown");
        }
    }

    #[test]
    fn deterministic_stale_lease_is_rejected() {
        let mapped = map_write_error(TransactionError::Work(StoreError::LeaseStale));
        assert_eq!(mapped.kind(), PortFailureKind::Rejected);
        assert_eq!(mapped.code(), "ai_outbound_lease_stale");
    }

    #[test]
    fn atomic_completion_uncertainty_never_becomes_a_retryable_failure() {
        for error in [
            TransactionError::CommitUnknown,
            TransactionError::RollbackUnknown,
        ] {
            let mapped = map_completion_error(error);
            assert_eq!(mapped.kind(), PortFailureKind::OutcomeUnknown);
            assert_eq!(mapped.code(), "ai_outbound_completion_outcome_unknown");
        }
    }

    #[test]
    fn finalization_database_failure_rolls_back_as_unavailable() {
        let mapped = map_completion_error(TransactionError::Work(
            AtomicCompletionError::Finalization(FinalizationStoreError::DatabaseUnavailable),
        ));

        assert_eq!(mapped.kind(), PortFailureKind::Unavailable);
        assert_eq!(mapped.code(), "post_call_finalization_store_unavailable");
    }
}
