use std::{error::Error, fmt, sync::Arc};

use converact_kernel_ids::TenantId;
use converact_post_call_finalization_core::{FinalizationResolution, PostCallFinalizationJob};
use converact_post_call_finalization_store::{
    ClaimedFinalizationJob, EnqueueFinalizationDecision, FinalizationLease,
    FinalizationLeaseCommand, FinalizationSqlStore, FinalizationStoreError,
};

use crate::{PostgresRuntime, TransactionError};

/// Exact enqueue outcome after the tenant transaction commits.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PostgresEnqueueFinalizationDecision {
    Created,
    Replayed,
}

/// Sanitized tenant-transaction or post-call finalization Store failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PostgresPostCallFinalizationStoreError {
    code: &'static str,
}

impl PostgresPostCallFinalizationStoreError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for PostgresPostCallFinalizationStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for PostgresPostCallFinalizationStoreError {}

/// Tenant-scoped runtime adapter for durable post-call finalization work.
pub struct PostgresPostCallFinalizationStore {
    runtime: Arc<PostgresRuntime>,
    sql: FinalizationSqlStore,
}

impl PostgresPostCallFinalizationStore {
    #[must_use]
    pub const fn new(runtime: Arc<PostgresRuntime>, sql: FinalizationSqlStore) -> Self {
        Self { runtime, sql }
    }

    /// Enqueues or exactly replays one content-free finalization job.
    ///
    /// # Errors
    ///
    /// Returns only sanitized tenant, Store or transaction failure categories.
    pub async fn enqueue(
        &self,
        job: &PostCallFinalizationJob,
    ) -> Result<PostgresEnqueueFinalizationDecision, PostgresPostCallFinalizationStoreError> {
        let tenant = parse_tenant(job.context().tenant_id())?;
        let job = job.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move { sql.enqueue(transaction, &job).await })
            })
            .await
            .map(map_enqueue_decision)
            .map_err(map_transaction_error)
    }

    /// Claims one bounded tenant batch under a database-clock lease.
    ///
    /// # Errors
    ///
    /// Returns only sanitized tenant, Store or transaction failure categories.
    pub async fn claim_due(
        &self,
        tenant_id: &str,
        lease: &FinalizationLease,
        requested_limit: u16,
    ) -> Result<Vec<ClaimedFinalizationJob>, PostgresPostCallFinalizationStoreError> {
        let tenant = parse_tenant(tenant_id)?;
        let query_tenant = tenant.clone();
        let lease = lease.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    sql.claim_due(transaction, &query_tenant, &lease, requested_limit)
                        .await
                })
            })
            .await
            .map_err(map_transaction_error)
    }

    /// Moves one fenced claimed job to explicit reconcile state.
    ///
    /// # Errors
    ///
    /// Returns only sanitized tenant, Store or transaction failure categories.
    pub async fn require_reconcile(
        &self,
        command: &FinalizationLeaseCommand,
    ) -> Result<u64, PostgresPostCallFinalizationStoreError> {
        let tenant = command.tenant_id.clone();
        let command = command.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move { sql.require_reconcile(transaction, &command).await })
            })
            .await
            .map_err(map_transaction_error)
    }

    /// Atomically settles one fenced job and its immutable observation receipt.
    ///
    /// # Errors
    ///
    /// Returns only sanitized tenant, Store or transaction failure categories.
    pub async fn complete(
        &self,
        command: &FinalizationLeaseCommand,
        resolution: FinalizationResolution,
    ) -> Result<u64, PostgresPostCallFinalizationStoreError> {
        let tenant = command.tenant_id.clone();
        let command = command.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move { sql.complete(transaction, &command, resolution).await })
            })
            .await
            .map_err(map_transaction_error)
    }
}

impl fmt::Debug for PostgresPostCallFinalizationStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PostgresPostCallFinalizationStore")
            .finish_non_exhaustive()
    }
}

fn parse_tenant(value: &str) -> Result<TenantId, PostgresPostCallFinalizationStoreError> {
    TenantId::parse(value).map_err(|_| PostgresPostCallFinalizationStoreError {
        code: "post_call_finalization_store_tenant_invalid",
    })
}

const fn map_enqueue_decision(
    decision: EnqueueFinalizationDecision,
) -> PostgresEnqueueFinalizationDecision {
    match decision {
        EnqueueFinalizationDecision::Created => PostgresEnqueueFinalizationDecision::Created,
        EnqueueFinalizationDecision::Replay => PostgresEnqueueFinalizationDecision::Replayed,
    }
}

#[allow(clippy::needless_pass_by_value)]
fn map_transaction_error(
    error: TransactionError<FinalizationStoreError>,
) -> PostgresPostCallFinalizationStoreError {
    let code = match error {
        TransactionError::Work(error) => error.code(),
        TransactionError::AdmissionRejected => "post_call_finalization_store_admission_rejected",
        TransactionError::PoolUnavailable
        | TransactionError::DatabaseUnavailable
        | TransactionError::DeadlineExceeded
        | TransactionError::RollbackUnknown
        | TransactionError::CommitUnknown => "post_call_finalization_store_unavailable",
    };
    PostgresPostCallFinalizationStoreError { code }
}
