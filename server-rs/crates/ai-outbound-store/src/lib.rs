//! Durable `PostgreSQL` boundary for Converact AI outbound Attempts.

mod postgres;

pub use postgres::{
    AdvanceAttempt, AiOutboundStore, AppendEvent, AppendEventStatus, ClaimedAttempt, StoreConfig,
    StoreError,
};
