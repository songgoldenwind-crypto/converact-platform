//! Bounded Rust client for the frozen `RustPBX` RWI v1 subset.

mod client;
mod envelope;
mod secret;
mod telephony;

pub use client::{
    ClientConfig, ClientError, CommandOutcome, RustPbxRwiClient, RwiSecretResolver, SecretRef,
    SecretValue,
};
pub use envelope::{
    AddAgentLegRequest, BridgeRequest, HangupRequest, InspectCallRequest, ListCallsRequest,
    OriginateRequest, RwiCommand, RwiError, SubscribeRequest, encode_command,
};
pub use secret::FileRwiSecretResolver;
pub use telephony::{RustPbxTelephony, RustPbxTelephonyConfig, RustPbxTelephonyConfigError};
