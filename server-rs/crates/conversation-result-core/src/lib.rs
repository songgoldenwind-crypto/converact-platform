//! Durable final transcript, business result and quality contracts.

#![forbid(unsafe_code)]

mod error;
mod evaluation;
mod result;
mod transcript;
mod validation;

pub use error::ResultError;
pub use evaluation::{
    BadCaseReason, Evaluation, EvaluationDimensionInput, EvaluationInput, EvaluationRubric,
    EvaluationRubricInput, QualityGrade,
};
pub use result::{
    ConversationResult, ConversationResultInput, OutcomeSchema, OutcomeSchemaInput, ResultRevision,
    ValidatedIntentEvidence,
};
pub use transcript::{
    TranscriptGenerationStatus, TranscriptSegment, TranscriptSegmentDraft,
    TranscriptSegmentDraftInput, TranscriptSegmentInput, TranscriptSnapshot,
    TranscriptSnapshotInput, TranscriptSnapshotRevision, TranscriptSpeaker,
};
