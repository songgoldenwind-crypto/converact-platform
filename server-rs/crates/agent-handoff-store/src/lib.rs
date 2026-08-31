//! Durable `PostgreSQL` boundary for Agent Handoff authority.

#![forbid(unsafe_code)]

mod model;
mod postgres;

pub use model::{
    HandoffStoreCommand, HandoffStoreCommandInput, HandoffStoreError, HandoffTransitionWrite,
    canonical_request_payload_hash, canonical_transition_payload_hash,
};
pub use postgres::{
    HandoffCommandResolution, HandoffPrepareDecision, HandoffSqlStore, HandoffStoreReceipt,
    ReceiptStage,
};
