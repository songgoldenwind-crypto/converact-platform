//! Bounded internal mTLS transport adapter.

#![forbid(unsafe_code)]

mod material;
mod peer_certificate;

pub use material::{InternalMtlsServerConfig, MtlsMaterialError, MtlsMaterialPolicy};
pub use peer_certificate::{
    MtlsCertificatePolicy, PeerCertificateError, peer_identity_from_verified_leaf_der,
};
