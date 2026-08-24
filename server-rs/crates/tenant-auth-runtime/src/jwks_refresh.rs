use std::{error::Error, fmt, future::Future, sync::Arc, time::Instant};

use converact_tenant_auth::{
    Rs256CachedTokenVerifier, Rs256JwksLifecycleError, Rs256JwksRefreshLease, Rs256JwksSnapshot,
    ValidatedJwksIssuer,
};

use crate::{JwksDnsResolver, JwksFetchError, JwksFetcher};

/// Monotonic millisecond source used only when a fetched snapshot completes.
pub trait JwksMonotonicClock: Send + Sync {
    fn now_ms(&self) -> u64;
}

/// Process-local monotonic clock with no wall-time or ambient configuration.
pub struct SystemJwksMonotonicClock(Instant);

impl SystemJwksMonotonicClock {
    #[must_use]
    pub fn new() -> Self {
        Self(Instant::now())
    }
}

impl Default for SystemJwksMonotonicClock {
    fn default() -> Self {
        Self::new()
    }
}

impl JwksMonotonicClock for SystemJwksMonotonicClock {
    fn now_ms(&self) -> u64 {
        u64::try_from(self.0.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

impl fmt::Debug for SystemJwksMonotonicClock {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SystemJwksMonotonicClock")
    }
}

/// Vendor-neutral boundary for one validated snapshot fetch.
pub trait JwksSnapshotFetcher: Send + Sync {
    fn fetch<'a>(
        &'a self,
        issuer: &'a ValidatedJwksIssuer,
    ) -> impl Future<Output = Result<Rs256JwksSnapshot, JwksFetchError>> + Send + 'a;
}

impl<Resolver: JwksDnsResolver> JwksSnapshotFetcher for JwksFetcher<Resolver> {
    fn fetch<'a>(
        &'a self,
        issuer: &'a ValidatedJwksIssuer,
    ) -> impl Future<Output = Result<Rs256JwksSnapshot, JwksFetchError>> + Send + 'a {
        JwksFetcher::fetch(self, issuer)
    }
}

/// Closed result for one leased refresh attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Rs256JwksRefreshError {
    Fetch(JwksFetchError),
    Lifecycle(Rs256JwksLifecycleError),
}

impl fmt::Display for Rs256JwksRefreshError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Fetch(error) => error.fmt(formatter),
            Self::Lifecycle(error) => error.fmt(formatter),
        }
    }
}

impl Error for Rs256JwksRefreshError {}

/// Drives one exact refresh lease without owning scheduling or issuer lookup.
pub struct Rs256JwksRefreshDriver<Fetcher, Clock> {
    issuer: ValidatedJwksIssuer,
    verifier: Arc<Rs256CachedTokenVerifier>,
    fetcher: Fetcher,
    clock: Clock,
}

impl<Fetcher, Clock> Rs256JwksRefreshDriver<Fetcher, Clock> {
    #[must_use]
    pub const fn new(
        issuer: ValidatedJwksIssuer,
        verifier: Arc<Rs256CachedTokenVerifier>,
        fetcher: Fetcher,
        clock: Clock,
    ) -> Self {
        Self {
            issuer,
            verifier,
            fetcher,
            clock,
        }
    }
}

impl<Fetcher: JwksSnapshotFetcher, Clock: JwksMonotonicClock>
    Rs256JwksRefreshDriver<Fetcher, Clock>
{
    /// Fetches and atomically installs one snapshot for the exact lease.
    ///
    /// # Errors
    ///
    /// Returns a value-free fetch or lifecycle failure.
    pub fn refresh(
        &self,
        lease: Rs256JwksRefreshLease,
    ) -> impl Future<Output = Result<(), Rs256JwksRefreshError>> + Send + '_ {
        let mut lease = RefreshLeaseGuard::new(Arc::clone(&self.verifier), lease);
        async move {
            let snapshot = match self.fetcher.fetch(&self.issuer).await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    lease
                        .complete_failure()
                        .map_err(Rs256JwksRefreshError::Lifecycle)?;
                    return Err(Rs256JwksRefreshError::Fetch(error));
                }
            };
            let result = self
                .verifier
                .complete_success(lease.value(), snapshot, self.clock.now_ms())
                .map_err(Rs256JwksRefreshError::Lifecycle);
            lease.disarm();
            result
        }
    }
}

impl<Fetcher, Clock> fmt::Debug for Rs256JwksRefreshDriver<Fetcher, Clock> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Rs256JwksRefreshDriver([REDACTED])")
    }
}

struct RefreshLeaseGuard {
    verifier: Arc<Rs256CachedTokenVerifier>,
    lease: Rs256JwksRefreshLease,
    armed: bool,
}

impl RefreshLeaseGuard {
    fn new(verifier: Arc<Rs256CachedTokenVerifier>, lease: Rs256JwksRefreshLease) -> Self {
        Self {
            verifier,
            lease,
            armed: true,
        }
    }

    fn value(&self) -> Rs256JwksRefreshLease {
        self.lease
    }

    fn complete_failure(mut self) -> Result<(), Rs256JwksLifecycleError> {
        self.armed = false;
        self.verifier.complete_failure(self.lease)
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for RefreshLeaseGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.verifier.complete_failure(self.lease);
        }
    }
}
