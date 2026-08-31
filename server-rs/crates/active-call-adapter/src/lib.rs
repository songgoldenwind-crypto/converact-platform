//! Fail-closed adapter for the pinned Active Call 0.3.83 wire protocol.

mod client;
mod command;
mod mapper;
mod upstream;

pub use client::{
    ActiveCallClient, ActiveCallCommand, ActiveCallEvent, ActiveCallEventKind,
    ActiveCallEventStream, ActiveCallSessionState, ClientConfig, ClientConfigError, ClientError,
    ClientFailureKind, CommandAccepted,
};
pub use command::{AdapterCommand, encode_command};
pub use mapper::{
    AdapterContext, AdapterError, DtmfDigit, IntentCandidate, NormalizedEvent, normalize_event,
};
