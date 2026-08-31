use std::{error::Error, fmt};

/// Stable fail-closed conversation result and quality rejection categories.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResultError {
    InvalidTranscriptSegment,
    InvalidTranscriptSnapshot,
    FutureGeneration,
    InvalidResultRevision,
    InvalidOutcomeSchema,
    InvalidConversationResult,
    OutcomeSchemaMismatch,
    InvalidRubric,
    InvalidEvaluation,
    RubricMismatch,
    CanonicalPayloadInvalid,
}

impl ResultError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidTranscriptSegment => "conversation_transcript_segment_invalid",
            Self::InvalidTranscriptSnapshot => "conversation_transcript_snapshot_invalid",
            Self::FutureGeneration => "conversation_transcript_generation_future",
            Self::InvalidResultRevision => "conversation_result_revision_invalid",
            Self::InvalidOutcomeSchema => "conversation_outcome_schema_invalid",
            Self::InvalidConversationResult => "conversation_result_invalid",
            Self::OutcomeSchemaMismatch => "conversation_outcome_schema_mismatch",
            Self::InvalidRubric => "conversation_evaluation_rubric_invalid",
            Self::InvalidEvaluation => "conversation_evaluation_invalid",
            Self::RubricMismatch => "conversation_evaluation_rubric_mismatch",
            Self::CanonicalPayloadInvalid => "conversation_canonical_payload_invalid",
        }
    }
}

impl fmt::Display for ResultError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ResultError {}
