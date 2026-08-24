//! Runtime adapters for tenant-scoped platform identity.

#![forbid(unsafe_code)]

mod resolved_addresses;

pub use resolved_addresses::{
    JwksResolvedAddressError, JwksResolvedAddressPolicy, MAX_JWKS_RESOLVED_ADDRESSES,
    ValidatedJwksResolvedAddresses,
};
