//! Runtime adapters for tenant-scoped platform identity.

#![forbid(unsafe_code)]

mod jwks_fetch;
mod jwks_lifecycle;
mod jwks_refresh;
mod resolved_addresses;

pub use jwks_fetch::{
    JwksDnsResolveError, JwksDnsResolver, JwksFetchError, JwksFetchPolicy, JwksFetchPolicyError,
    JwksFetcher, SystemJwksDnsResolver,
};
pub use jwks_lifecycle::{Rs256JwksIssuerLifecycle, Rs256JwksRefreshOutcome, Rs256JwksWarmError};
pub use jwks_refresh::{
    JwksMonotonicClock, JwksSnapshotFetcher, Rs256JwksRefreshDriver, Rs256JwksRefreshError,
    SystemJwksMonotonicClock,
};
pub use resolved_addresses::{
    JwksResolvedAddressError, JwksResolvedAddressPolicy, MAX_JWKS_RESOLVED_ADDRESSES,
    ValidatedJwksResolvedAddresses,
};
