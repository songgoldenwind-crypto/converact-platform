//! Fail-closed adapter for the pinned Active Call 0.3.83 wire protocol.

mod command;
mod mapper;
mod upstream;

pub use command::{AdapterCommand, encode_command};
pub use mapper::{AdapterContext, AdapterError, NormalizedEvent, normalize_event};
