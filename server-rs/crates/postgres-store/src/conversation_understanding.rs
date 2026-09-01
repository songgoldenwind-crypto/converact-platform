use std::{error::Error, fmt, sync::Arc};

use converact_conversation_understanding_store::{
    StoredUnderstandingHead, UnderstandingSqlStore, UnderstandingStoreError,
    UnderstandingTurnAppendOutcome, UnderstandingTurnBatch,
};
use converact_kernel_ids::TenantId;
use converact_voice_agent_contracts::EnvelopeContext;

use crate::{PostgresRuntime, TransactionError};

/// Sanitized tenant-transaction or understanding Store failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PostgresConversationUnderstandingStoreError {
    code: &'static str,
}

impl PostgresConversationUnderstandingStoreError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for PostgresConversationUnderstandingStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for PostgresConversationUnderstandingStoreError {}

/// Tenant-scoped owner of consistent understanding reads and atomic turn commits.
pub struct PostgresConversationUnderstandingStore {
    runtime: Arc<PostgresRuntime>,
    sql: UnderstandingSqlStore,
}

impl PostgresConversationUnderstandingStore {
    #[must_use]
    pub const fn new(runtime: Arc<PostgresRuntime>, sql: UnderstandingSqlStore) -> Self {
        Self { runtime, sql }
    }

    /// Reads all current understanding heads through one SQL statement in one tenant transaction.
    ///
    /// # Errors
    ///
    /// Returns only bounded tenant, Store or transaction failure categories.
    pub async fn load_consistent_heads(
        &self,
        context: &EnvelopeContext,
    ) -> Result<Vec<StoredUnderstandingHead>, PostgresConversationUnderstandingStoreError> {
        let tenant = parse_tenant(context.tenant_id())?;
        let context = context.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move { sql.load_consistent_heads(transaction, &context).await })
            })
            .await
            .map_err(map_transaction_error)
    }

    /// Commits bounded record-only Intent evidence and all four fenced heads atomically.
    ///
    /// # Errors
    ///
    /// Rolls back and returns a bounded error when any domain append or transaction stage fails.
    pub async fn append_turn(
        &self,
        batch: &UnderstandingTurnBatch,
    ) -> Result<UnderstandingTurnAppendOutcome, PostgresConversationUnderstandingStoreError> {
        let tenant = parse_tenant(batch.context().tenant_id())?;
        let batch = batch.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move { sql.append_turn(transaction, &batch).await })
            })
            .await
            .map_err(map_transaction_error)
    }
}

impl fmt::Debug for PostgresConversationUnderstandingStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PostgresConversationUnderstandingStore")
            .finish_non_exhaustive()
    }
}

fn parse_tenant(value: &str) -> Result<TenantId, PostgresConversationUnderstandingStoreError> {
    TenantId::parse(value).map_err(|_| PostgresConversationUnderstandingStoreError {
        code: "conversation_understanding_store_tenant_invalid",
    })
}

#[allow(clippy::needless_pass_by_value)]
fn map_transaction_error(
    error: TransactionError<UnderstandingStoreError>,
) -> PostgresConversationUnderstandingStoreError {
    let code = match error {
        TransactionError::Work(error) => error.code(),
        TransactionError::AdmissionRejected => {
            "conversation_understanding_store_admission_rejected"
        }
        TransactionError::PoolUnavailable
        | TransactionError::DatabaseUnavailable
        | TransactionError::DeadlineExceeded
        | TransactionError::RollbackUnknown
        | TransactionError::CommitUnknown => "conversation_understanding_store_unavailable",
    };
    PostgresConversationUnderstandingStoreError { code }
}
