use std::{error::Error, fmt};

use converact_contracts::canonical_sha256;
use converact_conversation_result_core::{
    ConversationResult, Evaluation, TranscriptGenerationStatus, TranscriptSegment,
};
use converact_voice_agent_contracts::{
    BadCaseId, ExecutionGeneration, InteractionId, ResultProjectionCommandId,
};
use serde_json::json;

/// Low-cardinality durable result boundary failure without customer or topology data.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConversationResultStoreError {
    InvalidCommand,
    InvalidQuery,
    InvalidEvaluationProjection,
    NumericOverflow,
    SerializationFailed,
    DatabaseUnavailable,
    Conflict,
    StoredRowInvalid,
}

impl ConversationResultStoreError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidCommand => "conversation_projection_command_invalid",
            Self::InvalidQuery => "conversation_result_query_invalid",
            Self::InvalidEvaluationProjection => "conversation_evaluation_projection_invalid",
            Self::NumericOverflow => "conversation_result_store_numeric_overflow",
            Self::SerializationFailed => "conversation_result_store_serialization_failed",
            Self::DatabaseUnavailable => "conversation_result_store_unavailable",
            Self::Conflict => "conversation_result_store_conflict",
            Self::StoredRowInvalid => "conversation_result_store_row_invalid",
        }
    }
}

/// Closed durable projection effect kind.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionCommandKind {
    FreezeSnapshot,
    PersistResult,
    PersistEvaluation,
}

impl ProjectionCommandKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FreezeSnapshot => "freeze_snapshot",
            Self::PersistResult => "persist_result",
            Self::PersistEvaluation => "persist_evaluation",
        }
    }
}

/// Unvalidated durable projection command and optimistic fences.
pub struct ProjectionCommandInput {
    pub id: ResultProjectionCommandId,
    pub interaction_id: InteractionId,
    pub kind: ProjectionCommandKind,
    pub payload_hash: String,
    pub expected_result_revision: Option<u64>,
    pub expected_generation: ExecutionGeneration,
}

/// Immutable idempotent effect command prepared before invoking a Provider.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionCommand {
    id: ResultProjectionCommandId,
    interaction_id: InteractionId,
    kind: ProjectionCommandKind,
    payload_hash: Box<str>,
    expected_result_revision: Option<u64>,
    expected_generation: ExecutionGeneration,
}

impl ProjectionCommand {
    /// Validates an exact request digest and kind-specific result revision fence.
    ///
    /// # Errors
    ///
    /// Rejects malformed hashes, zero revisions and invalid kind/revision combinations.
    pub fn try_new(input: ProjectionCommandInput) -> Result<Self, ConversationResultStoreError> {
        let revision_valid = match input.kind {
            ProjectionCommandKind::FreezeSnapshot => input.expected_result_revision.is_none(),
            ProjectionCommandKind::PersistResult | ProjectionCommandKind::PersistEvaluation => {
                input
                    .expected_result_revision
                    .is_some_and(|value| value > 0)
            }
        };
        if !lowercase_sha256(&input.payload_hash) || !revision_valid {
            return Err(ConversationResultStoreError::InvalidCommand);
        }
        Ok(Self {
            id: input.id,
            interaction_id: input.interaction_id,
            kind: input.kind,
            payload_hash: input.payload_hash.into(),
            expected_result_revision: input.expected_result_revision,
            expected_generation: input.expected_generation,
        })
    }

    #[must_use]
    pub const fn id(&self) -> &ResultProjectionCommandId {
        &self.id
    }

    #[must_use]
    pub const fn interaction_id(&self) -> &InteractionId {
        &self.interaction_id
    }

    #[must_use]
    pub const fn kind(&self) -> ProjectionCommandKind {
        self.kind
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }

    #[must_use]
    pub const fn expected_result_revision(&self) -> Option<u64> {
        self.expected_result_revision
    }

    #[must_use]
    pub const fn expected_generation(&self) -> ExecutionGeneration {
        self.expected_generation
    }
}

impl fmt::Display for ConversationResultStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ConversationResultStoreError {}

/// Exact replay classification for an immutable projection write.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionWriteDecision {
    Created,
    Replay,
}

/// Durable effect-oracle decision made before invoking a projection Provider.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionPrepareDecision {
    Execute,
    Query,
    ReplayApplied,
    ReplayNotApplied,
    Conflict,
}

/// Durable state-observed decision after a projection Provider is queried or invoked.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionFinalizeDecision {
    Applied,
    NotApplied,
    ReplayApplied,
    ReplayNotApplied,
}

/// Exact replay classification for one final transcript append.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TranscriptAppendDecision {
    Appended(TranscriptGenerationStatus),
    Replay(TranscriptGenerationStatus),
}

/// One Store-sequenced immutable segment and its exact append/replay classification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SequencedTranscriptAppend {
    segment: TranscriptSegment,
    decision: TranscriptAppendDecision,
}

impl SequencedTranscriptAppend {
    pub(crate) const fn new(
        segment: TranscriptSegment,
        decision: TranscriptAppendDecision,
    ) -> Self {
        Self { segment, decision }
    }

    #[must_use]
    pub const fn segment(&self) -> &TranscriptSegment {
        &self.segment
    }

    #[must_use]
    pub const fn decision(&self) -> TranscriptAppendDecision {
        self.decision
    }

    #[must_use]
    pub fn into_parts(self) -> (TranscriptSegment, TranscriptAppendDecision) {
        (self.segment, self.decision)
    }
}

/// Evaluation and optional deterministic Bad Case row persisted in one transaction.
#[derive(Debug)]
pub struct EvaluationProjectionWrite<'a> {
    result: &'a ConversationResult,
    evaluation: &'a Evaluation,
    bad_case_id: Option<BadCaseId>,
}

impl<'a> EvaluationProjectionWrite<'a> {
    /// Binds an evaluation to its exact result and derived Bad Case identity.
    ///
    /// # Errors
    ///
    /// Rejects cross-result evaluations and caller-selected Bad Case classification.
    pub fn try_new(
        result: &'a ConversationResult,
        evaluation: &'a Evaluation,
        bad_case_id: Option<BadCaseId>,
    ) -> Result<Self, ConversationResultStoreError> {
        if evaluation.result_id() != result.id()
            || evaluation.result_revision() != result.revision()
            || evaluation.is_bad_case() != bad_case_id.is_some()
        {
            return Err(ConversationResultStoreError::InvalidEvaluationProjection);
        }
        Ok(Self {
            result,
            evaluation,
            bad_case_id,
        })
    }

    #[must_use]
    pub const fn result(&self) -> &ConversationResult {
        self.result
    }

    #[must_use]
    pub const fn evaluation(&self) -> &Evaluation {
        self.evaluation
    }

    #[must_use]
    pub const fn interaction_id(&self) -> &InteractionId {
        self.result.context().interaction_id()
    }

    #[must_use]
    pub const fn bad_case_id(&self) -> Option<&BadCaseId> {
        self.bad_case_id.as_ref()
    }
}

/// Computes the only accepted immutable Bad Case row digest.
///
/// # Errors
///
/// Rejects a non-Bad-Case projection or canonical serialization failure.
pub fn canonical_bad_case_payload_hash(
    write: &EvaluationProjectionWrite<'_>,
) -> Result<String, ConversationResultStoreError> {
    let bad_case_id = write
        .bad_case_id()
        .ok_or(ConversationResultStoreError::InvalidEvaluationProjection)?;
    canonical_sha256(&json!({
        "tenant_id": write.result().context().tenant_id(),
        "bad_case_id": bad_case_id.as_str(),
        "interaction_id": write.interaction_id().as_str(),
        "evaluation_id": write.evaluation().id().as_str(),
        "evaluation_payload_hash": write.evaluation().payload_hash(),
        "bad_case_reasons": write
            .evaluation()
            .bad_case_reasons()
            .iter()
            .map(|reason| reason.as_str())
            .collect::<Vec<_>>(),
        "review_state": "pending",
        "created_at_ms": write.evaluation().created_at_ms()
    }))
    .map_err(|_| ConversationResultStoreError::SerializationFailed)
}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
