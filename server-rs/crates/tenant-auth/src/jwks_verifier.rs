use std::{
    error::Error,
    fmt,
    sync::{
        Arc, RwLock,
        atomic::{AtomicU64, Ordering},
    },
};

use super::{
    jwks::Rs256JwksSnapshot,
    jwks_cache::{
        Rs256JwksCache, Rs256JwksCachePolicy, Rs256JwksLifecycleError, Rs256JwksRefreshLease,
        Rs256JwksUnavailableReason,
    },
    jwt::{
        AuthenticatedPlatformIdentity, PlatformJwtPolicy, PlatformTokenVerificationError,
        PlatformTokenVerifierConfigError,
    },
    rs256::{
        PreparedRs256Token, PreparedRs256VerificationError, prepare_rs256_token,
        verify_prepared_rs256,
    },
};

/// Closed token result that distinguishes rejected input from temporarily
/// unavailable issuer key state without exposing key or token material.
#[derive(Eq, PartialEq)]
pub enum Rs256CachedTokenVerificationError {
    Rejected(PlatformTokenVerificationError),
    Unavailable {
        reason: Rs256JwksUnavailableReason,
        refresh: Option<Rs256JwksRefreshLease>,
    },
}

impl Rs256CachedTokenVerificationError {
    #[must_use]
    pub const fn rejection(&self) -> Option<PlatformTokenVerificationError> {
        match self {
            Self::Rejected(error) => Some(*error),
            Self::Unavailable { .. } => None,
        }
    }

    #[must_use]
    pub const fn unavailable_reason(&self) -> Option<Rs256JwksUnavailableReason> {
        match self {
            Self::Rejected(_) => None,
            Self::Unavailable { reason, .. } => Some(*reason),
        }
    }

    #[must_use]
    pub const fn refresh_lease(&self) -> Option<Rs256JwksRefreshLease> {
        match self {
            Self::Rejected(_) => None,
            Self::Unavailable { refresh, .. } => *refresh,
        }
    }
}

impl fmt::Debug for Rs256CachedTokenVerificationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rejected(error) => formatter
                .debug_tuple("Rs256CachedTokenVerificationError::Rejected")
                .field(error)
                .finish(),
            Self::Unavailable { reason, refresh } => formatter
                .debug_struct("Rs256CachedTokenVerificationError::Unavailable")
                .field("reason", reason)
                .field("refresh_started", &refresh.is_some())
                .finish(),
        }
    }
}

impl fmt::Display for Rs256CachedTokenVerificationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rejected(error) => error.fmt(formatter),
            Self::Unavailable { reason, .. } => reason.fmt(formatter),
        }
    }
}

impl Error for Rs256CachedTokenVerificationError {}

/// One value-only readiness observation for the configured external issuer.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct Rs256JwksReadiness {
    unavailable: Option<Rs256JwksUnavailableReason>,
}

impl Rs256JwksReadiness {
    #[must_use]
    pub const fn is_ready(self) -> bool {
        self.unavailable.is_none()
    }

    #[must_use]
    pub const fn unavailable_reason(self) -> Option<Rs256JwksUnavailableReason> {
        self.unavailable
    }
}

impl fmt::Debug for Rs256JwksReadiness {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.unavailable {
            None => formatter.write_str("Rs256JwksReadiness::Ready"),
            Some(reason) => formatter
                .debug_tuple("Rs256JwksReadiness::NotReady")
                .field(&reason)
                .finish(),
        }
    }
}

/// One issuer-local concurrent cache plus verifier. The lock protects only
/// bounded lifecycle state; request-owned immutable snapshots are verified
/// after every lock guard has left scope.
pub struct Rs256CachedTokenVerifier {
    state: RwLock<Rs256JwksCache>,
    policy: PlatformJwtPolicy,
    monotonic_high_water_ms: AtomicU64,
}

impl Rs256CachedTokenVerifier {
    /// Creates one issuer-local verifier with no network, task or clock owner.
    ///
    /// # Errors
    ///
    /// Rejects malformed policy text or out-of-range policy epochs.
    pub fn new(
        cache_policy: Rs256JwksCachePolicy,
        expected_issuer: &str,
        expected_audience: &str,
        current_policy_version: u64,
        current_revocation_epoch: u64,
    ) -> Result<Self, PlatformTokenVerifierConfigError> {
        let policy = PlatformJwtPolicy::new(
            expected_issuer,
            expected_audience,
            None,
            current_policy_version,
            current_revocation_epoch,
        )?;
        Ok(Self {
            state: RwLock::new(Rs256JwksCache::new(cache_policy)),
            policy,
            monotonic_high_water_ms: AtomicU64::new(0),
        })
    }

    /// Verifies one token against a snapshot that was fresh when this request
    /// acquired it. Malformed or cryptographically rejected input never starts
    /// refresh work. An unavailable or unknown key may return the sole lease.
    ///
    /// # Errors
    ///
    /// Returns a value-free rejection or fail-closed key availability reason.
    pub fn verify(
        &self,
        token: &str,
        wall_now_epoch_ms: i64,
        monotonic_now_ms: u64,
    ) -> Result<AuthenticatedPlatformIdentity, Rs256CachedTokenVerificationError> {
        let prepared =
            prepare_rs256_token(token).map_err(Rs256CachedTokenVerificationError::Rejected)?;
        self.observe_time(monotonic_now_ms)
            .map_err(unavailable_lifecycle)?;

        let snapshot = match self.read_fresh_snapshot(monotonic_now_ms) {
            Ok(snapshot) => snapshot,
            Err(Rs256JwksUnavailableReason::StateUnavailable) => {
                return Err(unavailable(
                    Rs256JwksUnavailableReason::StateUnavailable,
                    None,
                ));
            }
            Err(_) => {
                return self.verify_after_resolution(
                    &prepared,
                    wall_now_epoch_ms,
                    monotonic_now_ms,
                );
            }
        };
        match verify_prepared_rs256(&snapshot, &self.policy, &prepared, wall_now_epoch_ms) {
            Ok(identity) => Ok(identity),
            Err(PreparedRs256VerificationError::Rejected(error)) => {
                Err(Rs256CachedTokenVerificationError::Rejected(error))
            }
            Err(PreparedRs256VerificationError::KeyUnknown) => {
                self.verify_after_resolution(&prepared, wall_now_epoch_ms, monotonic_now_ms)
            }
        }
    }

    /// Starts one caller-scheduled refresh through the same single-flight gate.
    ///
    /// # Errors
    ///
    /// Fails closed on time regression, generation exhaustion or poisoned state.
    pub fn begin_scheduled_refresh(
        &self,
        monotonic_now_ms: u64,
    ) -> Result<Option<Rs256JwksRefreshLease>, Rs256JwksLifecycleError> {
        self.observe_time(monotonic_now_ms)?;
        self.write_state()?
            .begin_scheduled_refresh(monotonic_now_ms)
    }

    /// Installs one validated snapshot only for the exact in-flight generation.
    /// A regressed completion clears that exact lease without replacing keys.
    ///
    /// # Errors
    ///
    /// Fails closed on stale lease, time regression or poisoned state.
    pub fn complete_success(
        &self,
        lease: Rs256JwksRefreshLease,
        keys: Rs256JwksSnapshot,
        monotonic_now_ms: u64,
    ) -> Result<(), Rs256JwksLifecycleError> {
        if let Err(error) = self.observe_time(monotonic_now_ms) {
            let completion = self.write_state()?.complete_failure(lease);
            return completion.and(Err(error));
        }
        self.write_state()?
            .complete_success(lease, keys, monotonic_now_ms)
    }

    /// Completes one exact failed refresh while retaining last-known-good keys.
    ///
    /// # Errors
    ///
    /// Fails closed on stale lease or poisoned state.
    pub fn complete_failure(
        &self,
        lease: Rs256JwksRefreshLease,
    ) -> Result<(), Rs256JwksLifecycleError> {
        self.write_state()?.complete_failure(lease)
    }

    /// Reports ready only while a complete snapshot is warmed and fresh.
    #[must_use]
    pub fn readiness(&self, monotonic_now_ms: u64) -> Rs256JwksReadiness {
        let unavailable = match self.observe_time(monotonic_now_ms) {
            Ok(()) => self.read_fresh_snapshot(monotonic_now_ms).err(),
            Err(Rs256JwksLifecycleError::ClockRegressed) => {
                Some(Rs256JwksUnavailableReason::ClockRegressed)
            }
            Err(_) => Some(Rs256JwksUnavailableReason::StateUnavailable),
        };
        Rs256JwksReadiness { unavailable }
    }

    /// Exposes only whether one refresh capability is currently outstanding.
    ///
    /// # Errors
    ///
    /// Fails closed when lifecycle state is poisoned.
    pub fn refresh_in_flight(&self) -> Result<bool, Rs256JwksLifecycleError> {
        self.state
            .read()
            .map(|state| state.refresh_in_flight())
            .map_err(|_| Rs256JwksLifecycleError::StateUnavailable)
    }

    fn verify_after_resolution(
        &self,
        prepared: &PreparedRs256Token<'_>,
        wall_now_epoch_ms: i64,
        monotonic_now_ms: u64,
    ) -> Result<AuthenticatedPlatformIdentity, Rs256CachedTokenVerificationError> {
        let snapshot = self.resolve_snapshot(prepared.key_id(), monotonic_now_ms)?;
        match verify_prepared_rs256(&snapshot, &self.policy, prepared, wall_now_epoch_ms) {
            Ok(identity) => Ok(identity),
            Err(PreparedRs256VerificationError::Rejected(error)) => {
                Err(Rs256CachedTokenVerificationError::Rejected(error))
            }
            Err(PreparedRs256VerificationError::KeyUnknown) => {
                Err(unavailable(Rs256JwksUnavailableReason::KeyUnknown, None))
            }
        }
    }

    fn resolve_snapshot(
        &self,
        key_id: &str,
        monotonic_now_ms: u64,
    ) -> Result<Arc<Rs256JwksSnapshot>, Rs256CachedTokenVerificationError> {
        let mut state = self
            .state
            .write()
            .map_err(|_| unavailable(Rs256JwksUnavailableReason::StateUnavailable, None))?;
        let resolution = state.resolve(key_id, monotonic_now_ms);
        if let Some(reason) = resolution.unavailable_reason() {
            return Err(unavailable(reason, resolution.refresh_lease()));
        }
        state
            .fresh_snapshot(monotonic_now_ms)
            .map_err(|reason| unavailable(reason, None))
    }

    fn read_fresh_snapshot(
        &self,
        monotonic_now_ms: u64,
    ) -> Result<Arc<Rs256JwksSnapshot>, Rs256JwksUnavailableReason> {
        self.state
            .read()
            .map_err(|_| Rs256JwksUnavailableReason::StateUnavailable)?
            .fresh_snapshot(monotonic_now_ms)
    }

    fn write_state(
        &self,
    ) -> Result<std::sync::RwLockWriteGuard<'_, Rs256JwksCache>, Rs256JwksLifecycleError> {
        self.state
            .write()
            .map_err(|_| Rs256JwksLifecycleError::StateUnavailable)
    }

    fn observe_time(&self, monotonic_now_ms: u64) -> Result<(), Rs256JwksLifecycleError> {
        let previous = self
            .monotonic_high_water_ms
            .fetch_max(monotonic_now_ms, Ordering::AcqRel);
        if monotonic_now_ms < previous {
            return Err(Rs256JwksLifecycleError::ClockRegressed);
        }
        Ok(())
    }
}

impl fmt::Debug for Rs256CachedTokenVerifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Rs256CachedTokenVerifier([REDACTED])")
    }
}

fn unavailable(
    reason: Rs256JwksUnavailableReason,
    refresh: Option<Rs256JwksRefreshLease>,
) -> Rs256CachedTokenVerificationError {
    Rs256CachedTokenVerificationError::Unavailable { reason, refresh }
}

fn unavailable_lifecycle(error: Rs256JwksLifecycleError) -> Rs256CachedTokenVerificationError {
    let reason = match error {
        Rs256JwksLifecycleError::ClockRegressed => Rs256JwksUnavailableReason::ClockRegressed,
        Rs256JwksLifecycleError::RefreshGenerationExhausted => {
            Rs256JwksUnavailableReason::RefreshGenerationExhausted
        }
        Rs256JwksLifecycleError::StateUnavailable | Rs256JwksLifecycleError::StaleRefresh => {
            Rs256JwksUnavailableReason::StateUnavailable
        }
    };
    unavailable(reason, None)
}
