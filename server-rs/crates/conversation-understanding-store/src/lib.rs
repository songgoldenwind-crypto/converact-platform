//! Tenant-scoped durable boundary for conversation-understanding evidence and heads.

#![forbid(unsafe_code)]

mod model;
mod postgres;

pub use model::{
    AppendAction, AppendUnderstandingRecord, RecordPresence, UnderstandingDomain,
    UnderstandingHead, UnderstandingHeadExpectation, UnderstandingHeadExpectationInput,
    UnderstandingHeadInput, UnderstandingRecord, UnderstandingRecordInput, UnderstandingRecordKind,
    UnderstandingStoreError,
};
pub use postgres::{AppendOutcome, StoredUnderstandingHead, UnderstandingSqlStore};
