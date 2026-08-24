//! Bounded internal mTLS transport adapter.

#![forbid(unsafe_code)]

mod listener;
mod material;
mod peer_certificate;

pub use listener::{
    InternalMtlsConnectionInfo, InternalMtlsHandshakeError, InternalMtlsListener,
    InternalMtlsListenerPolicy, InternalMtlsListenerPolicyError, InternalMtlsListenerStats,
    InternalMtlsStream,
};
pub use material::{InternalMtlsServerConfig, MtlsMaterialError, MtlsMaterialPolicy};
pub use peer_certificate::{
    MtlsCertificatePolicy, PeerCertificateError, peer_identity_from_verified_leaf_der,
};
