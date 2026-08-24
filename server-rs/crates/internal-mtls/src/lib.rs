//! Bounded internal mTLS transport adapter.

#![forbid(unsafe_code)]

mod config_slot;
mod listener;
mod material;
mod peer_certificate;

pub use config_slot::{
    InternalMtlsConfigCandidate, InternalMtlsConfigFingerprint, InternalMtlsConfigPublishError,
    InternalMtlsConfigPublishOutcome, InternalMtlsConfigSlot,
};
pub use listener::{
    InternalMtlsConnectionInfo, InternalMtlsHandshakeError, InternalMtlsListener,
    InternalMtlsListenerPolicy, InternalMtlsListenerPolicyError, InternalMtlsListenerStats,
    InternalMtlsStream,
};
pub use material::{
    InternalMtlsPemBundle, InternalMtlsServerConfig, MtlsMaterialError, MtlsMaterialPolicy,
    MtlsPemError, MtlsPemPolicy,
};
pub use peer_certificate::{
    MtlsCertificatePolicy, PeerCertificateError, peer_identity_from_verified_leaf_der,
};
