//! Bounded Rust client for the frozen `RustPBX` RWI v1 subset.

mod client;
mod envelope;

pub use client::{
    ClientConfig, ClientError, CommandOutcome, RustPbxRwiClient, RwiSecretResolver, SecretRef,
    SecretValue,
};
pub use envelope::{
    AddAgentLegRequest, BridgeRequest, HangupRequest, ListCallsRequest, OriginateRequest,
    RwiCommand, RwiError, SubscribeRequest, encode_command,
};
