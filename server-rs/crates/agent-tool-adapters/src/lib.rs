//! Typed industry-neutral Tool Adapters for Converact Agents.

#![forbid(unsafe_code)]

mod adapter;
mod model;
mod ports;

pub use adapter::AgentToolAdapter;
pub use model::{
    AdapterInputError, CustomerLookup, CustomerLookupResult, CustomerSnapshot,
    FollowUpExecuteResult, FollowUpQuery, FollowUpRequest, FollowUpTaskId,
};
pub use ports::{CustomerDirectoryPort, FollowUpTaskPort};
