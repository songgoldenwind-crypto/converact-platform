//! Tenant-scoped durable boundary for conversation-understanding evidence and heads.

#![forbid(unsafe_code)]

mod codec;
mod model;
mod postgres;

pub use codec::{
    encode_customer_state_snapshot, encode_dialogue_recommendation, encode_emotion_checkpoint,
    encode_intent_checkpoint, restore_customer_state_snapshot, restore_dialogue_recommendation,
    restore_emotion_checkpoint, restore_intent_checkpoint,
};
pub use model::{
    AppendAction, AppendUnderstandingRecord, RecordPresence, UnderstandingDomain,
    UnderstandingHead, UnderstandingHeadExpectation, UnderstandingHeadExpectationInput,
    UnderstandingHeadInput, UnderstandingRecord, UnderstandingRecordInput, UnderstandingRecordKind,
    UnderstandingStoreError,
};
pub use postgres::{AppendOutcome, StoredUnderstandingHead, UnderstandingSqlStore};
