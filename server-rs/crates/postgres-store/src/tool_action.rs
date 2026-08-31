use std::sync::Arc;

use converact_kernel_ids::TenantId;
use converact_tool_broker_core::{
    ActionObservation, ActionReceipt, AuthorizedToolAction, PrepareDecision, ToolActionStorePort,
    ToolPortError,
};
use converact_tool_broker_store::ToolActionSqlStore;

use crate::{PostgresRuntime, TransactionError};

/// Tenant-transaction-owned implementation of the Tool Broker durable Store port.
pub struct PostgresToolActionStore {
    runtime: Arc<PostgresRuntime>,
    sql: ToolActionSqlStore,
}

impl PostgresToolActionStore {
    #[must_use]
    pub const fn new(runtime: Arc<PostgresRuntime>, sql: ToolActionSqlStore) -> Self {
        Self { runtime, sql }
    }
}

impl ToolActionStorePort for PostgresToolActionStore {
    async fn prepare(
        &self,
        action: &AuthorizedToolAction,
        _now_ms: u64,
    ) -> Result<PrepareDecision, ToolPortError> {
        let tenant = TenantId::parse(action.proposal().context().tenant_id())
            .map_err(|_| ToolPortError::new("tool_store_tenant_invalid"))?;
        let action = action.clone();
        let sql = self.sql.clone();
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move { sql.prepare(transaction, &action).await })
            })
            .await
            .map_err(map_transaction_error)
    }

    async fn finalize(
        &self,
        action: &AuthorizedToolAction,
        observation: ActionObservation,
        _now_ms: u64,
    ) -> Result<ActionReceipt, ToolPortError> {
        let tenant = TenantId::parse(action.proposal().context().tenant_id())
            .map_err(|_| ToolPortError::new("tool_store_tenant_invalid"))?;
        let action = action.clone();
        let sql = self.sql.clone();
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move { sql.finalize(transaction, &action, observation).await })
            })
            .await
            .map_err(map_transaction_error)
    }
}

#[allow(clippy::needless_pass_by_value)] // `Result::map_err` transfers the opaque transaction outcome.
fn map_transaction_error(
    error: TransactionError<converact_tool_broker_store::ToolStoreError>,
) -> ToolPortError {
    match error {
        TransactionError::Work(error) => ToolPortError::new(error.code()),
        TransactionError::AdmissionRejected => ToolPortError::new("tool_store_admission_rejected"),
        TransactionError::PoolUnavailable
        | TransactionError::DatabaseUnavailable
        | TransactionError::DeadlineExceeded
        | TransactionError::RollbackUnknown
        | TransactionError::CommitUnknown => ToolPortError::new("tool_store_unavailable"),
    }
}
