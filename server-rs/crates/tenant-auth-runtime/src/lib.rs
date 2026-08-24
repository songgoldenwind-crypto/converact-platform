//! Runtime adapters for tenant-scoped platform identity.

#![forbid(unsafe_code)]

mod jwks_fetch;
mod resolved_addresses;

pub use jwks_fetch::{
    JwksDnsResolveError, JwksDnsResolver, JwksFetchError, JwksFetchPolicy, JwksFetchPolicyError,
    JwksFetcher, SystemJwksDnsResolver,
};
pub use resolved_addresses::{
    JwksResolvedAddressError, JwksResolvedAddressPolicy, MAX_JWKS_RESOLVED_ADDRESSES,
    ValidatedJwksResolvedAddresses,
};
