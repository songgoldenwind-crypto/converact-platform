use std::{error::Error, fmt, future::Future};

use converact_contracts::canonical_sha256;
use converact_conversation_result_core::{
    ConversationResult, Evaluation, TranscriptGenerationStatus, TranscriptSegment,
    TranscriptSnapshot,
};
use converact_conversation_result_store::{ProjectionCommand, ProjectionCommandKind};
use converact_voice_agent_contracts::{BadCaseId, ExecutionGeneration};
use serde_json::json;

/// Durable effect-oracle permission returned before invoking a projection Provider.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DurableProjectionPrepareDecision {
    Execute,
    Query,
    ReplayApplied,
    ReplayNotApplied,
    Conflict,
}

/// Durable immutable projection write decision.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DurableProjectionWriteDecision {
    Created,
    Replayed,
}

/// Durable final transcript append decision including stale-generation classification.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DurableTranscriptAppendDecision {
    Appended(TranscriptGenerationStatus),
    Replayed(TranscriptGenerationStatus),
}

/// Terminal evidence persistence outcome without transcript text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalEvidenceProgress {
    pub final_segments: u32,
    pub historical_segments: u32,
    pub snapshot: DurableProjectionWriteDecision,
}

/// Closed Provider observation; unknown never implies retrying a mutation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectionObservation<T> {
    Applied(T),
    NotApplied(&'static str),
    OutcomeUnknown,
}

/// Durable result projection progress without pretending an unknown effect completed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResultProjectionProgress {
    Applied(Box<ConversationResult>),
    Pending,
    NotApplied(&'static str),
    ReplayedNotApplied,
}

/// Durable evaluation projection progress without pretending an unknown effect completed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EvaluationProjectionProgress {
    Applied(Box<Evaluation>),
    Pending,
    NotApplied(&'static str),
    ReplayedApplied,
    ReplayedNotApplied,
}

/// Bounded projection adapter failure without prompt, transcript, credentials or topology.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConversationProjectionPortError {
    code: &'static str,
}

impl ConversationProjectionPortError {
    #[must_use]
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for ConversationProjectionPortError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for ConversationProjectionPortError {}

/// Durable result effect oracle. Implementations own tenant transactions and deadlines.
pub trait ConversationProjectionDurabilityPort: Sync {
    fn prepare(
        &self,
        tenant_id: &str,
        command: &ProjectionCommand,
    ) -> impl Future<
        Output = Result<DurableProjectionPrepareDecision, ConversationProjectionPortError>,
    > + Send;

    fn finalize_result_applied(
        &self,
        command: &ProjectionCommand,
        result: &ConversationResult,
    ) -> impl Future<Output = Result<(), ConversationProjectionPortError>> + Send;

    fn finalize_not_applied(
        &self,
        tenant_id: &str,
        command: &ProjectionCommand,
        failure_code: &'static str,
    ) -> impl Future<Output = Result<(), ConversationProjectionPortError>> + Send;
}

/// Durable final transcript and terminal snapshot boundary.
pub trait ConversationEvidenceDurabilityPort: Sync {
    fn append_final_segment(
        &self,
        segment: &TranscriptSegment,
        current_generation: ExecutionGeneration,
    ) -> impl Future<
        Output = Result<DurableTranscriptAppendDecision, ConversationProjectionPortError>,
    > + Send;

    fn freeze_snapshot(
        &self,
        snapshot: &TranscriptSnapshot,
    ) -> impl Future<
        Output = Result<DurableProjectionWriteDecision, ConversationProjectionPortError>,
    > + Send;
}

/// Atomic durable evaluation/Bad Case finalization boundary.
pub trait ConversationEvaluationDurabilityPort: Sync {
    fn finalize_evaluation_applied(
        &self,
        command: &ProjectionCommand,
        result: &ConversationResult,
        evaluation: &Evaluation,
        bad_case_id: Option<BadCaseId>,
    ) -> impl Future<Output = Result<(), ConversationProjectionPortError>> + Send;
}

/// Provider boundary for an idempotent result request and its read-only status query.
pub trait ConversationProjectionProviderPort: Sync {
    fn generate_result(
        &self,
        command: &ProjectionCommand,
    ) -> impl Future<
        Output = Result<ProjectionObservation<ConversationResult>, ConversationProjectionPortError>,
    > + Send;

    fn query_result(
        &self,
        command: &ProjectionCommand,
    ) -> impl Future<
        Output = Result<ProjectionObservation<ConversationResult>, ConversationProjectionPortError>,
    > + Send;
}

/// Provider boundary for an idempotent evaluation request and its read-only status query.
pub trait ConversationEvaluationProviderPort: Sync {
    fn generate_evaluation(
        &self,
        command: &ProjectionCommand,
        result: &ConversationResult,
    ) -> impl Future<
        Output = Result<ProjectionObservation<Evaluation>, ConversationProjectionPortError>,
    > + Send;

    fn query_evaluation(
        &self,
        command: &ProjectionCommand,
        result: &ConversationResult,
    ) -> impl Future<
        Output = Result<ProjectionObservation<Evaluation>, ConversationProjectionPortError>,
    > + Send;
}

/// Post-call coordinator isolated from Telephony and established media.
pub struct ConversationProjectionRuntime<'a, D, P> {
    durability: &'a D,
    provider: &'a P,
}

impl<'a, D, P> ConversationProjectionRuntime<'a, D, P> {
    #[must_use]
    pub const fn new(durability: &'a D, provider: &'a P) -> Self {
        Self {
            durability,
            provider,
        }
    }
}

impl<D, P> ConversationProjectionRuntime<'_, D, P>
where
    D: ConversationProjectionDurabilityPort,
    P: ConversationProjectionProviderPort,
{
    /// Runs or resumes one durable result projection without blindly repeating unknown work.
    ///
    /// # Errors
    ///
    /// Returns bounded command, Store or Provider failure categories. No path owns a Telephony
    /// port, terminates a Call or initiates a dial.
    pub async fn project_result(
        &self,
        tenant_id: &str,
        command: &ProjectionCommand,
    ) -> Result<ResultProjectionProgress, ConversationProjectionPortError> {
        if command.kind() != ProjectionCommandKind::PersistResult {
            return Err(ConversationProjectionPortError::new(
                "conversation_projection_command_kind_invalid",
            ));
        }
        let (observation, replayed_applied) =
            match self.durability.prepare(tenant_id, command).await? {
                DurableProjectionPrepareDecision::Execute => {
                    (self.provider.generate_result(command).await?, false)
                }
                DurableProjectionPrepareDecision::Query => {
                    (self.provider.query_result(command).await?, false)
                }
                DurableProjectionPrepareDecision::ReplayApplied => {
                    (self.provider.query_result(command).await?, true)
                }
                DurableProjectionPrepareDecision::ReplayNotApplied => {
                    return Ok(ResultProjectionProgress::ReplayedNotApplied);
                }
                DurableProjectionPrepareDecision::Conflict => {
                    return Err(ConversationProjectionPortError::new(
                        "conversation_projection_command_conflict",
                    ));
                }
            };
        match observation {
            ProjectionObservation::Applied(result) => {
                if result.context().tenant_id() != tenant_id
                    || result.context().interaction_id() != command.interaction_id()
                    || Some(result.revision().get()) != command.expected_result_revision()
                    || result.context().execution_generation() != command.expected_generation()
                {
                    return Err(ConversationProjectionPortError::new(
                        "conversation_projection_result_fence_invalid",
                    ));
                }
                self.durability
                    .finalize_result_applied(command, &result)
                    .await?;
                Ok(ResultProjectionProgress::Applied(Box::new(result)))
            }
            ProjectionObservation::NotApplied(failure_code) => {
                if replayed_applied {
                    return Err(ConversationProjectionPortError::new(
                        "conversation_projection_resolution_conflict",
                    ));
                }
                self.durability
                    .finalize_not_applied(tenant_id, command, failure_code)
                    .await?;
                Ok(ResultProjectionProgress::NotApplied(failure_code))
            }
            ProjectionObservation::OutcomeUnknown => Ok(ResultProjectionProgress::Pending),
        }
    }
}

impl<D, P> ConversationProjectionRuntime<'_, D, P>
where
    D: ConversationEvidenceDurabilityPort,
{
    /// Persists final-only segments before freezing their terminal content-addressed snapshot.
    ///
    /// # Errors
    ///
    /// Rejects mismatched evidence sets, unbounded counters or durable Store failures. The method
    /// owns neither Telephony nor media control and cannot alter an established Call.
    pub async fn persist_terminal_evidence(
        &self,
        segments: &[TranscriptSegment],
        snapshot: &TranscriptSnapshot,
    ) -> Result<TerminalEvidenceProgress, ConversationProjectionPortError> {
        if segments.len() != snapshot.segment_count() {
            return Err(ConversationProjectionPortError::new(
                "conversation_terminal_evidence_mismatch",
            ));
        }
        let mut input_ids = segments
            .iter()
            .map(|segment| segment.id().as_str())
            .collect::<Vec<_>>();
        let mut snapshot_ids = snapshot
            .segment_ids()
            .iter()
            .map(converact_voice_agent_contracts::TranscriptSegmentId::as_str)
            .collect::<Vec<_>>();
        input_ids.sort_unstable();
        snapshot_ids.sort_unstable();
        if input_ids != snapshot_ids {
            return Err(ConversationProjectionPortError::new(
                "conversation_terminal_evidence_mismatch",
            ));
        }

        let mut historical_segments = 0_u32;
        for segment in segments {
            let decision = self
                .durability
                .append_final_segment(segment, snapshot.current_generation())
                .await?;
            if matches!(
                decision,
                DurableTranscriptAppendDecision::Appended(TranscriptGenerationStatus::Historical)
                    | DurableTranscriptAppendDecision::Replayed(
                        TranscriptGenerationStatus::Historical
                    )
            ) {
                historical_segments = historical_segments.checked_add(1).ok_or_else(|| {
                    ConversationProjectionPortError::new(
                        "conversation_terminal_evidence_count_invalid",
                    )
                })?;
            }
        }
        let snapshot_decision = self.durability.freeze_snapshot(snapshot).await?;
        let final_segments = u32::try_from(segments.len()).map_err(|_| {
            ConversationProjectionPortError::new("conversation_terminal_evidence_count_invalid")
        })?;
        Ok(TerminalEvidenceProgress {
            final_segments,
            historical_segments,
            snapshot: snapshot_decision,
        })
    }
}

impl<D, P> ConversationProjectionRuntime<'_, D, P>
where
    D: ConversationProjectionDurabilityPort + ConversationEvaluationDurabilityPort,
    P: ConversationEvaluationProviderPort,
{
    /// Runs or resumes one durable evaluation without blindly repeating unknown work.
    ///
    /// # Errors
    ///
    /// Returns bounded command, Store or Provider failure categories. Bad Case identity is
    /// platform-derived only after deterministic Core classification.
    pub async fn project_evaluation(
        &self,
        tenant_id: &str,
        command: &ProjectionCommand,
        result: &ConversationResult,
    ) -> Result<EvaluationProjectionProgress, ConversationProjectionPortError> {
        if command.kind() != ProjectionCommandKind::PersistEvaluation
            || result.context().tenant_id() != tenant_id
            || result.context().interaction_id() != command.interaction_id()
            || Some(result.revision().get()) != command.expected_result_revision()
            || result.context().execution_generation() != command.expected_generation()
        {
            return Err(ConversationProjectionPortError::new(
                "conversation_evaluation_command_fence_invalid",
            ));
        }
        let observation = match self.durability.prepare(tenant_id, command).await? {
            DurableProjectionPrepareDecision::Execute => {
                self.provider.generate_evaluation(command, result).await?
            }
            DurableProjectionPrepareDecision::Query => {
                self.provider.query_evaluation(command, result).await?
            }
            DurableProjectionPrepareDecision::ReplayApplied => {
                return Ok(EvaluationProjectionProgress::ReplayedApplied);
            }
            DurableProjectionPrepareDecision::ReplayNotApplied => {
                return Ok(EvaluationProjectionProgress::ReplayedNotApplied);
            }
            DurableProjectionPrepareDecision::Conflict => {
                return Err(ConversationProjectionPortError::new(
                    "conversation_projection_command_conflict",
                ));
            }
        };
        match observation {
            ProjectionObservation::Applied(evaluation) => {
                if evaluation.result_id() != result.id()
                    || evaluation.result_revision() != result.revision()
                {
                    return Err(ConversationProjectionPortError::new(
                        "conversation_evaluation_result_fence_invalid",
                    ));
                }
                let bad_case_id = derive_bad_case_id(&evaluation)?;
                self.durability
                    .finalize_evaluation_applied(command, result, &evaluation, bad_case_id)
                    .await?;
                Ok(EvaluationProjectionProgress::Applied(Box::new(evaluation)))
            }
            ProjectionObservation::NotApplied(failure_code) => {
                self.durability
                    .finalize_not_applied(tenant_id, command, failure_code)
                    .await?;
                Ok(EvaluationProjectionProgress::NotApplied(failure_code))
            }
            ProjectionObservation::OutcomeUnknown => Ok(EvaluationProjectionProgress::Pending),
        }
    }
}

fn derive_bad_case_id(
    evaluation: &Evaluation,
) -> Result<Option<BadCaseId>, ConversationProjectionPortError> {
    if !evaluation.is_bad_case() {
        return Ok(None);
    }
    let digest = canonical_sha256(&json!({
        "evaluation_id": evaluation.id().as_str(),
        "evaluation_payload_hash": evaluation.payload_hash()
    }))
    .map_err(|_| ConversationProjectionPortError::new("conversation_bad_case_id_invalid"))?;
    BadCaseId::parse(format!("bad-case-{digest}"))
        .map(Some)
        .map_err(|_| ConversationProjectionPortError::new("conversation_bad_case_id_invalid"))
}
