use std::{error::Error, fmt};

use converact_contracts::canonical_sha256;
use converact_conversation_result_core::{
    ConversationResult, Evaluation, TranscriptGenerationStatus,
};
use converact_voice_agent_contracts::{BadCaseId, InteractionId};
use serde_json::json;

/// Low-cardinality durable result boundary failure without customer or topology data.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConversationResultStoreError {
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
            Self::InvalidEvaluationProjection => "conversation_evaluation_projection_invalid",
            Self::NumericOverflow => "conversation_result_store_numeric_overflow",
            Self::SerializationFailed => "conversation_result_store_serialization_failed",
            Self::DatabaseUnavailable => "conversation_result_store_unavailable",
            Self::Conflict => "conversation_result_store_conflict",
            Self::StoredRowInvalid => "conversation_result_store_row_invalid",
        }
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

/// Exact replay classification for one final transcript append.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TranscriptAppendDecision {
    Appended(TranscriptGenerationStatus),
    Replay(TranscriptGenerationStatus),
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
