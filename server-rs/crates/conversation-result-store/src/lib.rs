//! Tenant-scoped durable boundary for final conversation result and quality projections.

#![forbid(unsafe_code)]

mod model;
mod postgres;

pub use model::{
    ConversationResultStoreError, EvaluationProjectionWrite, ProjectionWriteDecision,
    TranscriptAppendDecision, canonical_bad_case_payload_hash,
};
pub use postgres::ConversationResultSqlStore;
