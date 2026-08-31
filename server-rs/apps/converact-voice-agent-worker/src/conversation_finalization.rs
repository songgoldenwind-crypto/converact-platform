use std::future::Future;

use converact_conversation_result_core::{TranscriptSegment, TranscriptSnapshot};
use converact_conversation_result_store::{ProjectionCommand, ProjectionCommandKind};
use converact_post_call_finalization_store::ClaimedFinalizationJob;

use crate::{
    ConversationEvaluationDurabilityPort, ConversationEvaluationProviderPort,
    ConversationEvidenceDurabilityPort, ConversationProjectionDurabilityPort,
    ConversationProjectionPortError, ConversationProjectionProviderPort,
    ConversationProjectionRuntime, EvaluationProjectionProgress, FinalizationProjectionPort,
    FinalizationProjectionProgress, FinalizationWorkerError, ResultGenerationEvidence,
    ResultProjectionProgress,
};

/// Complete final-only input needed to reuse the D7 result and quality pipeline.
#[derive(Clone)]
pub struct ConversationFinalizationEvidence {
    segments: Vec<TranscriptSegment>,
    snapshot: TranscriptSnapshot,
    result_command: ProjectionCommand,
    evaluation_command: ProjectionCommand,
    result_generation_evidence: ResultGenerationEvidence,
}

impl ConversationFinalizationEvidence {
    /// Binds terminal evidence to exact result and evaluation commands.
    ///
    /// # Errors
    ///
    /// Rejects mixed interactions, generations or command kinds before a Provider can run.
    pub fn try_new(
        segments: Vec<TranscriptSegment>,
        snapshot: TranscriptSnapshot,
        result_command: ProjectionCommand,
        evaluation_command: ProjectionCommand,
        result_generation_evidence: ResultGenerationEvidence,
    ) -> Result<Self, FinalizationWorkerError> {
        let context = snapshot.context();
        if result_command.kind() != ProjectionCommandKind::PersistResult
            || evaluation_command.kind() != ProjectionCommandKind::PersistEvaluation
            || result_command.interaction_id() != context.interaction_id()
            || evaluation_command.interaction_id() != context.interaction_id()
            || result_command.expected_generation() != context.execution_generation()
            || evaluation_command.expected_generation() != context.execution_generation()
            || result_command.expected_result_revision()
                != evaluation_command.expected_result_revision()
        {
            return Err(FinalizationWorkerError::new(
                "conversation_finalization_evidence_invalid",
            ));
        }
        if result_command.payload_hash() != result_generation_evidence.payload_hash() {
            return Err(FinalizationWorkerError::new(
                "conversation_finalization_result_evidence_hash_mismatch",
            ));
        }
        if !result_generation_evidence.matches_snapshot(&snapshot) {
            return Err(FinalizationWorkerError::new(
                "conversation_finalization_result_evidence_snapshot_mismatch",
            ));
        }
        if result_command.expected_result_revision()
            != Some(result_generation_evidence.expected_result_revision())
        {
            return Err(FinalizationWorkerError::new(
                "conversation_finalization_result_evidence_revision_mismatch",
            ));
        }
        Ok(Self {
            segments,
            snapshot,
            result_command,
            evaluation_command,
            result_generation_evidence,
        })
    }
}

/// Final evidence authority observation. Unknown never means inventing terminal data.
#[derive(Clone)]
pub enum FinalizationEvidenceObservation {
    Ready(Box<ConversationFinalizationEvidence>),
    Incomplete,
    OutcomeUnknown,
}

/// Reads final-only evidence after Call and channel-agent terminal observations exist.
pub trait FinalizationEvidenceSourcePort: Sync {
    fn load(
        &self,
        tenant_id: &str,
        job: &ClaimedFinalizationJob,
    ) -> impl Future<Output = Result<FinalizationEvidenceObservation, FinalizationWorkerError>> + Send;
}

/// Composition root that reuses D7 transcript, result, evaluation and Bad Case behavior.
pub struct ConversationFinalizationProjector<'a, E, D, P> {
    evidence: &'a E,
    durability: &'a D,
    provider: &'a P,
}

impl<'a, E, D, P> ConversationFinalizationProjector<'a, E, D, P> {
    #[must_use]
    pub const fn new(evidence: &'a E, durability: &'a D, provider: &'a P) -> Self {
        Self {
            evidence,
            durability,
            provider,
        }
    }
}

impl<E, D, P> FinalizationProjectionPort for ConversationFinalizationProjector<'_, E, D, P>
where
    E: FinalizationEvidenceSourcePort,
    D: ConversationEvidenceDurabilityPort
        + ConversationProjectionDurabilityPort
        + ConversationEvaluationDurabilityPort,
    P: ConversationProjectionProviderPort + ConversationEvaluationProviderPort,
{
    async fn finalize(
        &self,
        tenant_id: &str,
        job: &ClaimedFinalizationJob,
    ) -> Result<FinalizationProjectionProgress, FinalizationWorkerError> {
        let evidence = match self.evidence.load(tenant_id, job).await? {
            FinalizationEvidenceObservation::Ready(evidence) => evidence,
            FinalizationEvidenceObservation::Incomplete => {
                return Ok(FinalizationProjectionProgress::Incomplete);
            }
            FinalizationEvidenceObservation::OutcomeUnknown => {
                return Ok(FinalizationProjectionProgress::ReconcileRequired(
                    "conversation_terminal_evidence_outcome_unknown",
                ));
            }
        };
        validate_job_evidence(tenant_id, job, &evidence)?;
        let runtime = ConversationProjectionRuntime::new(self.durability, self.provider);
        runtime
            .persist_terminal_evidence(&evidence.segments, &evidence.snapshot)
            .await
            .map_err(projection_error)?;
        let result = match runtime
            .project_result_with_evidence(
                tenant_id,
                &evidence.result_command,
                &evidence.result_generation_evidence,
            )
            .await
            .map_err(projection_error)?
        {
            ResultProjectionProgress::Applied(result) => result,
            ResultProjectionProgress::Pending => {
                return Ok(FinalizationProjectionProgress::ReconcileRequired(
                    "conversation_result_projection_outcome_unknown",
                ));
            }
            ResultProjectionProgress::NotApplied(_)
            | ResultProjectionProgress::ReplayedNotApplied => {
                return Ok(FinalizationProjectionProgress::Incomplete);
            }
        };
        match runtime
            .project_evaluation(tenant_id, &evidence.evaluation_command, &result)
            .await
            .map_err(projection_error)?
        {
            EvaluationProjectionProgress::Applied(_)
            | EvaluationProjectionProgress::ReplayedApplied => {
                Ok(FinalizationProjectionProgress::Projected)
            }
            EvaluationProjectionProgress::Pending => {
                Ok(FinalizationProjectionProgress::ReconcileRequired(
                    "conversation_evaluation_projection_outcome_unknown",
                ))
            }
            EvaluationProjectionProgress::NotApplied(_)
            | EvaluationProjectionProgress::ReplayedNotApplied => {
                Ok(FinalizationProjectionProgress::Incomplete)
            }
        }
    }
}

fn validate_job_evidence(
    tenant_id: &str,
    job: &ClaimedFinalizationJob,
    evidence: &ConversationFinalizationEvidence,
) -> Result<(), FinalizationWorkerError> {
    let context = evidence.snapshot.context();
    if context.tenant_id() != tenant_id
        || context.interaction_id() != job.interaction_id()
        || context.call_attempt_id() != job.call_attempt_id()
        || context.agent_release_id() != job.agent_release_id()
        || context.execution_generation() != job.execution_generation()
        || evidence
            .segments
            .iter()
            .any(|segment| segment.retention_policy_ref() != job.retention_policy_ref())
    {
        return Err(FinalizationWorkerError::new(
            "conversation_finalization_job_fence_invalid",
        ));
    }
    Ok(())
}

fn projection_error(error: ConversationProjectionPortError) -> FinalizationWorkerError {
    FinalizationWorkerError::new(error.code())
}
