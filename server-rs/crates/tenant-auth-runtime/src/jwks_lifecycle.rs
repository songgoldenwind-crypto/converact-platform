use std::{error::Error, fmt, future::Future, sync::Arc};

use converact_tenant_auth::{
    AuthenticatedPlatformIdentity, PlatformTokenVerifierConfigError,
    Rs256CachedTokenVerificationError, Rs256CachedTokenVerifier, Rs256JwksCachePolicy,
    Rs256JwksReadiness, Rs256JwksRefreshLease, Rs256JwksUnavailableReason, ValidatedJwksIssuer,
};

use crate::{
    JwksMonotonicClock, JwksSnapshotFetcher, Rs256JwksRefreshDriver, Rs256JwksRefreshError,
};

/// Result of one explicit scheduled-refresh request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Rs256JwksRefreshOutcome {
    Completed,
    InFlight,
}

/// Closed failure while warming one issuer-local key lifecycle.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Rs256JwksWarmError {
    Refresh(Rs256JwksRefreshError),
    RefreshInFlight,
    Unavailable(Rs256JwksUnavailableReason),
}

impl fmt::Display for Rs256JwksWarmError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refresh(error) => error.fmt(formatter),
            Self::RefreshInFlight => formatter.write_str("platform_rs256_jwks_refresh_in_flight"),
            Self::Unavailable(reason) => reason.fmt(formatter),
        }
    }
}

impl Error for Rs256JwksWarmError {}

/// One validated issuer, one verifier, one refresh driver and one clock owner.
pub struct Rs256JwksIssuerLifecycle<Fetcher, Clock> {
    cache_policy: Rs256JwksCachePolicy,
    verifier: Arc<Rs256CachedTokenVerifier>,
    driver: Rs256JwksRefreshDriver<Fetcher, Arc<Clock>>,
    clock: Arc<Clock>,
}

impl<Fetcher: JwksSnapshotFetcher, Clock: JwksMonotonicClock>
    Rs256JwksIssuerLifecycle<Fetcher, Clock>
{
    /// Composes one inert issuer-local lifecycle without starting I/O or tasks.
    ///
    /// # Errors
    ///
    /// Rejects malformed token-policy configuration.
    pub fn new(
        issuer: ValidatedJwksIssuer,
        cache_policy: Rs256JwksCachePolicy,
        expected_audience: &str,
        current_policy_version: u64,
        current_revocation_epoch: u64,
        fetcher: Fetcher,
        clock: Arc<Clock>,
    ) -> Result<Self, PlatformTokenVerifierConfigError> {
        let verifier = Arc::new(Rs256CachedTokenVerifier::new(
            cache_policy,
            issuer.claim_issuer(),
            expected_audience,
            current_policy_version,
            current_revocation_epoch,
        )?);
        let driver =
            Rs256JwksRefreshDriver::new(issuer, Arc::clone(&verifier), fetcher, Arc::clone(&clock));
        Ok(Self {
            cache_policy,
            verifier,
            driver,
            clock,
        })
    }

    /// Performs one mandatory startup refresh and remains fail-closed unless
    /// the resulting complete snapshot is ready on the shared clock.
    ///
    /// # Errors
    ///
    /// Returns a closed refresh, concurrency or availability reason.
    pub async fn warm(&self) -> Result<(), Rs256JwksWarmError> {
        match self
            .refresh_now()
            .await
            .map_err(Rs256JwksWarmError::Refresh)?
        {
            Rs256JwksRefreshOutcome::Completed => {}
            Rs256JwksRefreshOutcome::InFlight => {
                return Err(Rs256JwksWarmError::RefreshInFlight);
            }
        }
        let readiness = self.readiness();
        match readiness.unavailable_reason() {
            None => Ok(()),
            Some(reason) => Err(Rs256JwksWarmError::Unavailable(reason)),
        }
    }

    /// Starts at most one scheduled refresh through the shared single-flight
    /// gate. The caller owns and may cancel this future.
    ///
    /// # Errors
    ///
    /// Returns a closed lifecycle or fetch failure.
    pub async fn refresh_now(&self) -> Result<Rs256JwksRefreshOutcome, Rs256JwksRefreshError> {
        let lease = self
            .verifier
            .begin_scheduled_refresh(self.clock.now_ms())
            .map_err(Rs256JwksRefreshError::Lifecycle)?;
        let Some(lease) = lease else {
            return Ok(Rs256JwksRefreshOutcome::InFlight);
        };
        self.driver.refresh(lease).await?;
        Ok(Rs256JwksRefreshOutcome::Completed)
    }

    /// Verifies against the current cache using the lifecycle's exact clock.
    ///
    /// # Errors
    ///
    /// Returns the existing closed rejection or key-availability contract.
    pub fn verify_cached(
        &self,
        token: &str,
        wall_now_epoch_ms: i64,
    ) -> Result<AuthenticatedPlatformIdentity, Rs256CachedTokenVerificationError> {
        self.verifier
            .verify(token, wall_now_epoch_ms, self.clock.now_ms())
    }

    /// Drives the exact optional refresh lease returned by `verify_cached`.
    /// The returned future owns cancellation-safe lease cleanup before poll.
    pub fn drive_refresh(
        &self,
        lease: Rs256JwksRefreshLease,
    ) -> impl Future<Output = Result<(), Rs256JwksRefreshError>> + Send + '_ {
        self.driver.refresh(lease)
    }

    /// Reports readiness from the same clock used by refresh and verification.
    #[must_use]
    pub fn readiness(&self) -> Rs256JwksReadiness {
        self.verifier.readiness(self.clock.now_ms())
    }

    pub(crate) const fn cache_policy(&self) -> Rs256JwksCachePolicy {
        self.cache_policy
    }
}

impl<Fetcher, Clock> fmt::Debug for Rs256JwksIssuerLifecycle<Fetcher, Clock> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Rs256JwksIssuerLifecycle([REDACTED])")
    }
}
