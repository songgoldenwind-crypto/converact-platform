//! Offline filesystem adapter for bounded internal mTLS material.

#![forbid(unsafe_code)]

mod bundle;

pub use bundle::{
    InternalMtlsBundleAccessPolicy, InternalMtlsBundleLayout, InternalMtlsBundleLoadError,
    InternalMtlsBundleLoader, InternalMtlsBundleRevision, InternalMtlsBundleSource,
    LoadedInternalMtlsPemBundle,
};
