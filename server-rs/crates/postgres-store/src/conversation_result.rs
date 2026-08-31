use std::{error::Error, fmt, sync::Arc};

use converact_conversation_result_core::{
    ConversationResult, Evaluation, TranscriptGenerationStatus, TranscriptSegment,
    TranscriptSnapshot,
};
use converact_conversation_result_store::{
    ConversationResultSqlStore, ConversationResultStoreError, EvaluationProjectionWrite,
    ProjectionWriteDecision, TranscriptAppendDecision,
};
use converact_kernel_ids::TenantId;
use converact_voice_agent_contracts::{BadCaseId, EnvelopeContext, ExecutionGeneration};

use crate::{PostgresRuntime, TransactionError};

/// Result of an immutable conversation projection write.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PostgresProjectionWriteDecision {
    Created,
    Replayed,
}

/// Result of an immutable final transcript append.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PostgresTranscriptAppendDecision {
    Appended(TranscriptGenerationStatus),
    Replayed(TranscriptGenerationStatus),
}

/// Sanitized tenant-transaction or conversation result Store failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PostgresConversationResultStoreError {
    code: &'static str,
}

impl PostgresConversationResultStoreError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for PostgresConversationResultStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for PostgresConversationResultStoreError {}

/// Tenant-scoped runtime adapter for final transcript, result and quality projections.
pub struct PostgresConversationResultStore {
    runtime: Arc<PostgresRuntime>,
    sql: ConversationResultSqlStore,
}

impl PostgresConversationResultStore {
    #[must_use]
    pub const fn new(runtime: Arc<PostgresRuntime>, sql: ConversationResultSqlStore) -> Self {
        Self { runtime, sql }
    }

    /// Appends or exactly replays one final transcript segment in a tenant transaction.
    ///
    /// # Errors
    ///
    /// Returns only sanitized tenant, Store or transaction failure categories.
    pub async fn append_final_segment(
        &self,
        segment: &TranscriptSegment,
        current_generation: ExecutionGeneration,
    ) -> Result<PostgresTranscriptAppendDecision, PostgresConversationResultStoreError> {
        let tenant = tenant(segment.context())?;
        let segment = segment.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    sql.append_final_segment(transaction, &segment, current_generation)
                        .await
                })
            })
            .await
            .map(map_append_decision)
            .map_err(map_transaction_error)
    }

    /// Freezes or exactly replays one terminal transcript snapshot.
    ///
    /// # Errors
    ///
    /// Returns only sanitized tenant, Store or transaction failure categories.
    pub async fn freeze_snapshot(
        &self,
        snapshot: &TranscriptSnapshot,
    ) -> Result<PostgresProjectionWriteDecision, PostgresConversationResultStoreError> {
        let tenant = tenant(snapshot.context())?;
        let snapshot = snapshot.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move { sql.freeze_snapshot(transaction, &snapshot).await })
            })
            .await
            .map(map_projection_decision)
            .map_err(map_transaction_error)
    }

    /// Persists or exactly replays one continuous conversation result revision.
    ///
    /// # Errors
    ///
    /// Returns only sanitized tenant, Store or transaction failure categories.
    pub async fn persist_result(
        &self,
        result: &ConversationResult,
    ) -> Result<PostgresProjectionWriteDecision, PostgresConversationResultStoreError> {
        let tenant = tenant(result.context())?;
        let result = result.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move { sql.persist_result(transaction, &result).await })
            })
            .await
            .map(map_projection_decision)
            .map_err(map_transaction_error)
    }

    /// Persists or exactly replays an evaluation and its deterministic Bad Case row.
    ///
    /// # Errors
    ///
    /// Returns only sanitized tenant, Store or transaction failure categories.
    pub async fn persist_evaluation(
        &self,
        result: &ConversationResult,
        evaluation: &Evaluation,
        bad_case_id: Option<BadCaseId>,
    ) -> Result<PostgresProjectionWriteDecision, PostgresConversationResultStoreError> {
        let tenant = tenant(result.context())?;
        let result = result.clone();
        let evaluation = evaluation.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    let write =
                        EvaluationProjectionWrite::try_new(&result, &evaluation, bad_case_id)?;
                    sql.persist_evaluation(transaction, &write).await
                })
            })
            .await
            .map(map_projection_decision)
            .map_err(map_transaction_error)
    }
}

impl fmt::Debug for PostgresConversationResultStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PostgresConversationResultStore")
            .finish_non_exhaustive()
    }
}

fn tenant(context: &EnvelopeContext) -> Result<TenantId, PostgresConversationResultStoreError> {
    TenantId::parse(context.tenant_id()).map_err(|_| PostgresConversationResultStoreError {
        code: "conversation_result_store_tenant_invalid",
    })
}

const fn map_projection_decision(
    decision: ProjectionWriteDecision,
) -> PostgresProjectionWriteDecision {
    match decision {
        ProjectionWriteDecision::Created => PostgresProjectionWriteDecision::Created,
        ProjectionWriteDecision::Replay => PostgresProjectionWriteDecision::Replayed,
    }
}

const fn map_append_decision(
    decision: TranscriptAppendDecision,
) -> PostgresTranscriptAppendDecision {
    match decision {
        TranscriptAppendDecision::Appended(status) => {
            PostgresTranscriptAppendDecision::Appended(status)
        }
        TranscriptAppendDecision::Replay(status) => {
            PostgresTranscriptAppendDecision::Replayed(status)
        }
    }
}

#[allow(clippy::needless_pass_by_value)]
fn map_transaction_error(
    error: TransactionError<ConversationResultStoreError>,
) -> PostgresConversationResultStoreError {
    let code = match error {
        TransactionError::Work(error) => error.code(),
        TransactionError::AdmissionRejected => "conversation_result_store_admission_rejected",
        TransactionError::PoolUnavailable
        | TransactionError::DatabaseUnavailable
        | TransactionError::DeadlineExceeded
        | TransactionError::RollbackUnknown
        | TransactionError::CommitUnknown => "conversation_result_store_unavailable",
    };
    PostgresConversationResultStoreError { code }
}
