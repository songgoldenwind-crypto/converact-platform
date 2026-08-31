use std::{error::Error, fmt, sync::Arc};

use converact_conversation_result_core::{
    ConversationResult, Evaluation, TranscriptGenerationStatus, TranscriptSegment,
    TranscriptSnapshot,
};
use converact_conversation_result_store::{
    BadCaseView, ConversationEvaluationView, ConversationResultSqlStore,
    ConversationResultStoreError, ConversationResultView, EntityCursor, EvaluationProjectionWrite,
    ProjectionCommand, ProjectionCommandKind, ProjectionFinalizeDecision,
    ProjectionPrepareDecision, ProjectionWriteDecision, QueryLimit, QueryPage,
    TranscriptAppendDecision, TranscriptSegmentView,
};
use converact_kernel_ids::TenantId;
use converact_voice_agent_contracts::{
    BadCaseId, EnvelopeContext, ExecutionGeneration, InteractionId,
};

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

/// Durable Provider effect-oracle decision before invocation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PostgresProjectionPrepareDecision {
    Execute,
    Query,
    ReplayApplied,
    ReplayNotApplied,
    Conflict,
}

/// Durable Provider state-observed decision after invocation or query.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PostgresProjectionFinalizeDecision {
    Applied,
    NotApplied,
    ReplayApplied,
    ReplayNotApplied,
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

    /// Prepares one Provider projection before any external mutation.
    ///
    /// # Errors
    ///
    /// Returns only sanitized tenant, Store or transaction failure categories.
    pub async fn prepare_projection(
        &self,
        tenant_id: &str,
        command: &ProjectionCommand,
    ) -> Result<PostgresProjectionPrepareDecision, PostgresConversationResultStoreError> {
        let tenant = parse_tenant(tenant_id)?;
        let tenant_id = tenant_id.to_owned();
        let command = command.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    sql.prepare_projection_command(transaction, &tenant_id, &command)
                        .await
                })
            })
            .await
            .map(map_prepare_decision)
            .map_err(map_transaction_error)
    }

    /// Atomically persists an applied result and its state-observed command receipt.
    ///
    /// # Errors
    ///
    /// Returns only sanitized validation, tenant, Store or transaction failure categories.
    pub async fn finalize_result_projection(
        &self,
        command: &ProjectionCommand,
        result: &ConversationResult,
    ) -> Result<PostgresProjectionFinalizeDecision, PostgresConversationResultStoreError> {
        validate_result_command(command, result, ProjectionCommandKind::PersistResult)?;
        let tenant = tenant(result.context())?;
        let tenant_id = result.context().tenant_id().to_owned();
        let command = command.clone();
        let result = result.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    sql.persist_result(transaction, &result).await?;
                    sql.finalize_projection_applied(
                        transaction,
                        &tenant_id,
                        &command,
                        result.id().as_str(),
                        result.payload_hash(),
                    )
                    .await
                })
            })
            .await
            .map(map_finalize_decision)
            .map_err(map_transaction_error)
    }

    /// Atomically persists an applied evaluation/Bad Case and its state-observed receipt.
    ///
    /// # Errors
    ///
    /// Returns only sanitized validation, tenant, Store or transaction failure categories.
    pub async fn finalize_evaluation_projection(
        &self,
        command: &ProjectionCommand,
        result: &ConversationResult,
        evaluation: &Evaluation,
        bad_case_id: Option<BadCaseId>,
    ) -> Result<PostgresProjectionFinalizeDecision, PostgresConversationResultStoreError> {
        validate_result_command(command, result, ProjectionCommandKind::PersistEvaluation)?;
        let tenant = tenant(result.context())?;
        let tenant_id = result.context().tenant_id().to_owned();
        let command = command.clone();
        let result = result.clone();
        let evaluation = evaluation.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    let write =
                        EvaluationProjectionWrite::try_new(&result, &evaluation, bad_case_id)?;
                    sql.persist_evaluation(transaction, &write).await?;
                    sql.finalize_projection_applied(
                        transaction,
                        &tenant_id,
                        &command,
                        evaluation.id().as_str(),
                        evaluation.payload_hash(),
                    )
                    .await
                })
            })
            .await
            .map(map_finalize_decision)
            .map_err(map_transaction_error)
    }

    /// Atomically records a definitive non-applied Provider result.
    ///
    /// # Errors
    ///
    /// Returns only sanitized tenant, Store or transaction failure categories.
    pub async fn finalize_projection_not_applied(
        &self,
        tenant_id: &str,
        command: &ProjectionCommand,
        failure_code: &str,
    ) -> Result<PostgresProjectionFinalizeDecision, PostgresConversationResultStoreError> {
        let tenant = parse_tenant(tenant_id)?;
        let tenant_id = tenant_id.to_owned();
        let command = command.clone();
        let failure_code = failure_code.to_owned();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    sql.finalize_projection_not_applied(
                        transaction,
                        &tenant_id,
                        &command,
                        &failure_code,
                    )
                    .await
                })
            })
            .await
            .map(map_finalize_decision)
            .map_err(map_transaction_error)
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

    /// Loads the latest immutable result for one tenant-bound Interaction.
    ///
    /// # Errors
    ///
    /// Returns only sanitized identifier, tenant, Store or transaction failure categories.
    pub async fn load_latest_result(
        &self,
        tenant_id: &str,
        interaction_id: &str,
    ) -> Result<Option<ConversationResultView>, PostgresConversationResultStoreError> {
        let tenant = parse_tenant(tenant_id)?;
        let interaction = parse_interaction(interaction_id)?;
        let tenant_id = tenant_id.to_owned();
        let interaction_id = interaction.as_str().to_owned();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    sql.load_latest_result(transaction, &tenant_id, &interaction_id)
                        .await
                })
            })
            .await
            .map_err(map_transaction_error)
    }

    /// Lists one bounded authorized transcript page under a tenant transaction.
    ///
    /// # Errors
    ///
    /// Returns only sanitized identifier, cursor, tenant, Store or transaction failures.
    pub async fn list_transcript(
        &self,
        tenant_id: &str,
        interaction_id: &str,
        cursor: Option<&EntityCursor>,
        limit: QueryLimit,
    ) -> Result<QueryPage<TranscriptSegmentView>, PostgresConversationResultStoreError> {
        let tenant = parse_tenant(tenant_id)?;
        let interaction = parse_interaction(interaction_id)?;
        let tenant_id = tenant_id.to_owned();
        let interaction_id = interaction.as_str().to_owned();
        let cursor = cursor.cloned();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    sql.list_transcript(
                        transaction,
                        &tenant_id,
                        &interaction_id,
                        cursor.as_ref(),
                        limit,
                    )
                    .await
                })
            })
            .await
            .map_err(map_transaction_error)
    }

    /// Lists one bounded evaluation page without transcript text.
    ///
    /// # Errors
    ///
    /// Returns only sanitized identifier, cursor, tenant, Store or transaction failures.
    pub async fn list_evaluations(
        &self,
        tenant_id: &str,
        interaction_id: &str,
        cursor: Option<&EntityCursor>,
        limit: QueryLimit,
    ) -> Result<QueryPage<ConversationEvaluationView>, PostgresConversationResultStoreError> {
        let tenant = parse_tenant(tenant_id)?;
        let interaction = parse_interaction(interaction_id)?;
        let tenant_id = tenant_id.to_owned();
        let interaction_id = interaction.as_str().to_owned();
        let cursor = cursor.cloned();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    sql.list_evaluations(
                        transaction,
                        &tenant_id,
                        &interaction_id,
                        cursor.as_ref(),
                        limit,
                    )
                    .await
                })
            })
            .await
            .map_err(map_transaction_error)
    }

    /// Lists one bounded tenant Bad Case page without transcript or summary content.
    ///
    /// # Errors
    ///
    /// Returns only sanitized cursor, tenant, Store or transaction failure categories.
    pub async fn list_bad_cases(
        &self,
        tenant_id: &str,
        cursor: Option<&EntityCursor>,
        limit: QueryLimit,
    ) -> Result<QueryPage<BadCaseView>, PostgresConversationResultStoreError> {
        let tenant = parse_tenant(tenant_id)?;
        let tenant_id = tenant_id.to_owned();
        let cursor = cursor.cloned();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    sql.list_bad_cases(transaction, &tenant_id, cursor.as_ref(), limit)
                        .await
                })
            })
            .await
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
    parse_tenant(context.tenant_id())
}

fn parse_tenant(value: &str) -> Result<TenantId, PostgresConversationResultStoreError> {
    TenantId::parse(value).map_err(|_| PostgresConversationResultStoreError {
        code: "conversation_result_store_tenant_invalid",
    })
}

fn parse_interaction(value: &str) -> Result<InteractionId, PostgresConversationResultStoreError> {
    InteractionId::parse(value).map_err(|_| PostgresConversationResultStoreError {
        code: "conversation_result_store_interaction_invalid",
    })
}

fn validate_result_command(
    command: &ProjectionCommand,
    result: &ConversationResult,
    expected_kind: ProjectionCommandKind,
) -> Result<(), PostgresConversationResultStoreError> {
    if command.kind() != expected_kind
        || command.interaction_id() != result.context().interaction_id()
        || command.expected_result_revision() != Some(result.revision().get())
        || command.expected_generation() != result.context().execution_generation()
    {
        return Err(PostgresConversationResultStoreError {
            code: "conversation_projection_command_fence_invalid",
        });
    }
    Ok(())
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

const fn map_prepare_decision(
    decision: ProjectionPrepareDecision,
) -> PostgresProjectionPrepareDecision {
    match decision {
        ProjectionPrepareDecision::Execute => PostgresProjectionPrepareDecision::Execute,
        ProjectionPrepareDecision::Query => PostgresProjectionPrepareDecision::Query,
        ProjectionPrepareDecision::ReplayApplied => {
            PostgresProjectionPrepareDecision::ReplayApplied
        }
        ProjectionPrepareDecision::ReplayNotApplied => {
            PostgresProjectionPrepareDecision::ReplayNotApplied
        }
        ProjectionPrepareDecision::Conflict => PostgresProjectionPrepareDecision::Conflict,
    }
}

const fn map_finalize_decision(
    decision: ProjectionFinalizeDecision,
) -> PostgresProjectionFinalizeDecision {
    match decision {
        ProjectionFinalizeDecision::Applied => PostgresProjectionFinalizeDecision::Applied,
        ProjectionFinalizeDecision::NotApplied => PostgresProjectionFinalizeDecision::NotApplied,
        ProjectionFinalizeDecision::ReplayApplied => {
            PostgresProjectionFinalizeDecision::ReplayApplied
        }
        ProjectionFinalizeDecision::ReplayNotApplied => {
            PostgresProjectionFinalizeDecision::ReplayNotApplied
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
