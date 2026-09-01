//! Tenant-scoped durable boundary for final conversation result and quality projections.

#![forbid(unsafe_code)]

mod model;
mod postgres;
mod query;

pub use model::{
    ConversationResultStoreError, EvaluationProjectionWrite, ProjectionCommand,
    ProjectionCommandInput, ProjectionCommandKind, ProjectionFinalizeDecision,
    ProjectionPrepareDecision, ProjectionWriteDecision, SequencedTranscriptAppend,
    TranscriptAppendDecision, canonical_bad_case_payload_hash,
};
pub use postgres::ConversationResultSqlStore;
pub use query::{
    BadCaseView, ConversationEvaluationView, ConversationResultView, EntityCursor, QueryLimit,
    QueryPage, TranscriptSegmentView,
};
