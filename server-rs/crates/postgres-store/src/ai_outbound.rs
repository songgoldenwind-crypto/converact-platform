use std::sync::Arc;

use converact_ai_outbound_core::{
    AttemptStorePort, CallAttempt, EffectIntent, OutboundDialBinding, PortError,
};
use converact_ai_outbound_store::{
    AdvanceAttempt, AiOutboundStore, AppendEffectIntent, AttemptLease, AttemptLeaseInput,
    StoreError,
};
use converact_kernel_ids::TenantId;
use converact_voice_agent_contracts::CallAttemptId;

use crate::{PostgresRuntime, TransactionError};

/// Shareable claim boundary that creates one lease-scoped Store adapter per physical Attempt.
pub struct PostgresAiOutboundAttemptStore {
    runtime: Arc<PostgresRuntime>,
    sql: AiOutboundStore,
}

impl PostgresAiOutboundAttemptStore {
    #[must_use]
    pub const fn new(runtime: Arc<PostgresRuntime>, sql: AiOutboundStore) -> Self {
        Self { runtime, sql }
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
    lease: AttemptLease,
}

impl PostgresLeasedAttemptStore {
    #[must_use]
    pub const fn new(
        runtime: Arc<PostgresRuntime>,
        sql: AiOutboundStore,
        lease: AttemptLease,
    ) -> Self {
        Self {
            runtime,
            sql,
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
}
