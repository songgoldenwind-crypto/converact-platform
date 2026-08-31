use converact_conversation_result_core::{
    ConversationResult, Evaluation, TranscriptSegment, TranscriptSnapshot,
};
use converact_conversation_result_store::ProjectionCommand;
use converact_postgres_store::{
    PostgresConversationResultStore, PostgresConversationResultStoreError,
    PostgresProjectionFinalizeDecision, PostgresProjectionPrepareDecision,
    PostgresProjectionWriteDecision, PostgresTranscriptAppendDecision,
};
use converact_voice_agent_contracts::{BadCaseId, ExecutionGeneration};

use crate::{
    ConversationEvaluationDurabilityPort, ConversationEvidenceDurabilityPort,
    ConversationProjectionDurabilityPort, ConversationProjectionPortError,
    DurableProjectionPrepareDecision, DurableProjectionWriteDecision,
    DurableTranscriptAppendDecision,
};

impl ConversationEvidenceDurabilityPort for PostgresConversationResultStore {
    async fn append_final_segment(
        &self,
        segment: &TranscriptSegment,
        current_generation: ExecutionGeneration,
    ) -> Result<DurableTranscriptAppendDecision, ConversationProjectionPortError> {
        PostgresConversationResultStore::append_final_segment(self, segment, current_generation)
            .await
            .map(|decision| match decision {
                PostgresTranscriptAppendDecision::Appended(status) => {
                    DurableTranscriptAppendDecision::Appended(status)
                }
                PostgresTranscriptAppendDecision::Replayed(status) => {
                    DurableTranscriptAppendDecision::Replayed(status)
                }
            })
            .map_err(port_error)
    }

    async fn freeze_snapshot(
        &self,
        snapshot: &TranscriptSnapshot,
    ) -> Result<DurableProjectionWriteDecision, ConversationProjectionPortError> {
        PostgresConversationResultStore::freeze_snapshot(self, snapshot)
            .await
            .map(|decision| match decision {
                PostgresProjectionWriteDecision::Created => DurableProjectionWriteDecision::Created,
                PostgresProjectionWriteDecision::Replayed => {
                    DurableProjectionWriteDecision::Replayed
                }
            })
            .map_err(port_error)
    }
}

impl ConversationProjectionDurabilityPort for PostgresConversationResultStore {
    async fn prepare(
        &self,
        tenant_id: &str,
        command: &ProjectionCommand,
    ) -> Result<DurableProjectionPrepareDecision, ConversationProjectionPortError> {
        self.prepare_projection(tenant_id, command)
            .await
            .map(|decision| match decision {
                PostgresProjectionPrepareDecision::Execute => {
                    DurableProjectionPrepareDecision::Execute
                }
                PostgresProjectionPrepareDecision::Query => DurableProjectionPrepareDecision::Query,
                PostgresProjectionPrepareDecision::ReplayApplied => {
                    DurableProjectionPrepareDecision::ReplayApplied
                }
                PostgresProjectionPrepareDecision::ReplayNotApplied => {
                    DurableProjectionPrepareDecision::ReplayNotApplied
                }
                PostgresProjectionPrepareDecision::Conflict => {
                    DurableProjectionPrepareDecision::Conflict
                }
            })
            .map_err(port_error)
    }

    async fn finalize_result_applied(
        &self,
        command: &ProjectionCommand,
        result: &ConversationResult,
    ) -> Result<(), ConversationProjectionPortError> {
        match self.finalize_result_projection(command, result).await {
            Ok(
                PostgresProjectionFinalizeDecision::Applied
                | PostgresProjectionFinalizeDecision::ReplayApplied,
            ) => Ok(()),
            Ok(
                PostgresProjectionFinalizeDecision::NotApplied
                | PostgresProjectionFinalizeDecision::ReplayNotApplied,
            ) => Err(ConversationProjectionPortError::new(
                "conversation_projection_resolution_conflict",
            )),
            Err(error) => Err(port_error(error)),
        }
    }

    async fn finalize_not_applied(
        &self,
        tenant_id: &str,
        command: &ProjectionCommand,
        failure_code: &'static str,
    ) -> Result<(), ConversationProjectionPortError> {
        match self
            .finalize_projection_not_applied(tenant_id, command, failure_code)
            .await
        {
            Ok(
                PostgresProjectionFinalizeDecision::NotApplied
                | PostgresProjectionFinalizeDecision::ReplayNotApplied,
            ) => Ok(()),
            Ok(
                PostgresProjectionFinalizeDecision::Applied
                | PostgresProjectionFinalizeDecision::ReplayApplied,
            ) => Err(ConversationProjectionPortError::new(
                "conversation_projection_resolution_conflict",
            )),
            Err(error) => Err(port_error(error)),
        }
    }
}

impl ConversationEvaluationDurabilityPort for PostgresConversationResultStore {
    async fn finalize_evaluation_applied(
        &self,
        command: &ProjectionCommand,
        result: &ConversationResult,
        evaluation: &Evaluation,
        bad_case_id: Option<BadCaseId>,
    ) -> Result<(), ConversationProjectionPortError> {
        match self
            .finalize_evaluation_projection(command, result, evaluation, bad_case_id)
            .await
        {
            Ok(
                PostgresProjectionFinalizeDecision::Applied
                | PostgresProjectionFinalizeDecision::ReplayApplied,
            ) => Ok(()),
            Ok(
                PostgresProjectionFinalizeDecision::NotApplied
                | PostgresProjectionFinalizeDecision::ReplayNotApplied,
            ) => Err(ConversationProjectionPortError::new(
                "conversation_projection_resolution_conflict",
            )),
            Err(error) => Err(port_error(error)),
        }
    }
}

fn port_error(error: PostgresConversationResultStoreError) -> ConversationProjectionPortError {
    ConversationProjectionPortError::new(error.code())
}
