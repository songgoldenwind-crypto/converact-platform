use std::{error::Error, fmt};

use super::jwks::Rs256JwksSnapshot;

const CURRENT_FRESH_FOR_MS: u64 = 300_000;
const CURRENT_ON_DEMAND_REFRESH_FLOOR_MS: u64 = 5_000;
const MAX_FRESH_FOR_MS: u64 = 86_400_000;

/// Invalid bounded cache timing policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Rs256JwksCacheConfigError;

impl fmt::Display for Rs256JwksCacheConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("platform_rs256_jwks_cache_config_invalid")
    }
}

impl Error for Rs256JwksCacheConfigError {}

/// Bounded monotonic cache and on-demand refresh timing policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Rs256JwksCachePolicy {
    fresh_for_ms: u64,
    on_demand_refresh_floor_ms: u64,
}

impl Rs256JwksCachePolicy {
    /// Creates a policy whose freshness is at most 24 hours and whose refresh
    /// floor cannot exceed freshness.
    ///
    /// # Errors
    ///
    /// Rejects zero, oversized or internally inverted durations.
    pub const fn new(
        fresh_for_ms: u64,
        on_demand_refresh_floor_ms: u64,
    ) -> Result<Self, Rs256JwksCacheConfigError> {
        if fresh_for_ms == 0
            || fresh_for_ms > MAX_FRESH_FOR_MS
            || on_demand_refresh_floor_ms == 0
            || on_demand_refresh_floor_ms > fresh_for_ms
        {
            return Err(Rs256JwksCacheConfigError);
        }
        Ok(Self {
            fresh_for_ms,
            on_demand_refresh_floor_ms,
        })
    }

    #[must_use]
    pub const fn fresh_for_ms(self) -> u64 {
        self.fresh_for_ms
    }

    #[must_use]
    pub const fn on_demand_refresh_floor_ms(self) -> u64 {
        self.on_demand_refresh_floor_ms
    }
}

impl Default for Rs256JwksCachePolicy {
    fn default() -> Self {
        Self {
            fresh_for_ms: CURRENT_FRESH_FOR_MS,
            on_demand_refresh_floor_ms: CURRENT_ON_DEMAND_REFRESH_FLOOR_MS,
        }
    }
}

/// Opaque single-flight capability for exactly one refresh generation.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct Rs256JwksRefreshLease {
    generation: u64,
}

impl Rs256JwksRefreshLease {
    #[must_use]
    pub const fn generation(self) -> u64 {
        self.generation
    }
}

impl fmt::Debug for Rs256JwksRefreshLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Rs256JwksRefreshLease")
            .field("generation", &self.generation)
            .finish()
    }
}

/// Closed lifecycle failure for refresh fencing and monotonic time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Rs256JwksLifecycleError {
    ClockRegressed,
    StaleRefresh,
    RefreshGenerationExhausted,
}

impl Rs256JwksLifecycleError {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClockRegressed => "platform_rs256_jwks_clock_regressed",
            Self::StaleRefresh => "platform_rs256_jwks_refresh_stale",
            Self::RefreshGenerationExhausted => "platform_rs256_jwks_refresh_generation_exhausted",
        }
    }
}

impl fmt::Display for Rs256JwksLifecycleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Error for Rs256JwksLifecycleError {}

/// Fail-closed reason for an unusable key snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Rs256JwksUnavailableReason {
    Unwarmed,
    Expired,
    KeyUnknown,
    ClockRegressed,
    RefreshGenerationExhausted,
}

/// One bounded key-resolution result. Key material stays private to the crate
/// so callers cannot retain a stale snapshot past this lifecycle boundary.
pub struct Rs256JwksResolution {
    state: ResolutionState,
}

enum ResolutionState {
    Ready,
    Unavailable {
        reason: Rs256JwksUnavailableReason,
        refresh: Option<Rs256JwksRefreshLease>,
    },
}

impl Rs256JwksResolution {
    #[must_use]
    pub const fn is_ready(&self) -> bool {
        matches!(self.state, ResolutionState::Ready)
    }

    #[must_use]
    pub const fn unavailable_reason(&self) -> Option<Rs256JwksUnavailableReason> {
        match &self.state {
            ResolutionState::Ready => None,
            ResolutionState::Unavailable { reason, .. } => Some(*reason),
        }
    }

    #[must_use]
    pub const fn refresh_lease(&self) -> Option<Rs256JwksRefreshLease> {
        match &self.state {
            ResolutionState::Ready => None,
            ResolutionState::Unavailable { refresh, .. } => *refresh,
        }
    }
}

impl fmt::Debug for Rs256JwksResolution {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.state {
            ResolutionState::Ready => formatter.write_str("Rs256JwksResolution::Ready([REDACTED])"),
            ResolutionState::Unavailable { reason, refresh } => formatter
                .debug_struct("Rs256JwksResolution::Unavailable")
                .field("reason", reason)
                .field("refresh_started", &refresh.is_some())
                .finish(),
        }
    }
}

struct CachedSnapshot {
    keys: Rs256JwksSnapshot,
    refreshed_at_ms: u64,
}

/// One issuer-local, bounded and deterministic JWKS lifecycle state machine.
/// Network fetch and task scheduling are deliberately caller-owned.
pub struct Rs256JwksCache {
    policy: Rs256JwksCachePolicy,
    current: Option<CachedSnapshot>,
    refresh_in_flight: Option<Rs256JwksRefreshLease>,
    next_refresh_generation: u64,
    last_on_demand_refresh_ms: Option<u64>,
    last_observed_monotonic_ms: Option<u64>,
}

impl Rs256JwksCache {
    #[must_use]
    pub const fn new(policy: Rs256JwksCachePolicy) -> Self {
        Self {
            policy,
            current: None,
            refresh_in_flight: None,
            next_refresh_generation: 1,
            last_on_demand_refresh_ms: None,
            last_observed_monotonic_ms: None,
        }
    }

    /// Resolves an exact key from a fresh snapshot or returns a closed reason
    /// and, when allowed, the sole refresh lease the caller may execute.
    #[must_use]
    pub fn resolve(&mut self, key_id: &str, monotonic_now_ms: u64) -> Rs256JwksResolution {
        if self.observe_time(monotonic_now_ms).is_err() {
            return unavailable(Rs256JwksUnavailableReason::ClockRegressed, None);
        }

        let reason = match &self.current {
            None => Rs256JwksUnavailableReason::Unwarmed,
            Some(current)
                if monotonic_now_ms - current.refreshed_at_ms >= self.policy.fresh_for_ms =>
            {
                Rs256JwksUnavailableReason::Expired
            }
            Some(current) if !current.keys.contains_key(key_id) => {
                Rs256JwksUnavailableReason::KeyUnknown
            }
            Some(_) => {
                return Rs256JwksResolution {
                    state: ResolutionState::Ready,
                };
            }
        };

        match self.begin_on_demand_refresh(monotonic_now_ms) {
            Ok(refresh) => unavailable(reason, refresh),
            Err(Rs256JwksLifecycleError::RefreshGenerationExhausted) => {
                unavailable(Rs256JwksUnavailableReason::RefreshGenerationExhausted, None)
            }
            Err(_) => unavailable(reason, None),
        }
    }

    /// Starts one caller-scheduled refresh, bypassing only the on-demand
    /// attempt floor while preserving global single-flight behavior.
    ///
    /// # Errors
    ///
    /// Fails on regressed monotonic time or exhausted refresh generations.
    pub fn begin_scheduled_refresh(
        &mut self,
        monotonic_now_ms: u64,
    ) -> Result<Option<Rs256JwksRefreshLease>, Rs256JwksLifecycleError> {
        self.observe_time(monotonic_now_ms)?;
        self.begin_refresh()
    }

    /// Atomically installs a validated snapshot for the exact in-flight
    /// refresh generation.
    ///
    /// # Errors
    ///
    /// A stale lease or regressed completion clock cannot replace keys.
    pub fn complete_success(
        &mut self,
        lease: Rs256JwksRefreshLease,
        keys: Rs256JwksSnapshot,
        monotonic_now_ms: u64,
    ) -> Result<(), Rs256JwksLifecycleError> {
        self.take_exact_refresh(lease)?;
        self.observe_time(monotonic_now_ms)?;
        self.current = Some(CachedSnapshot {
            keys,
            refreshed_at_ms: monotonic_now_ms,
        });
        Ok(())
    }

    /// Completes a failed exact refresh without deleting the last-known-good
    /// snapshot.
    ///
    /// # Errors
    ///
    /// A stale lease cannot mutate lifecycle state.
    pub fn complete_failure(
        &mut self,
        lease: Rs256JwksRefreshLease,
    ) -> Result<(), Rs256JwksLifecycleError> {
        self.take_exact_refresh(lease)
    }

    #[must_use]
    pub const fn refresh_in_flight(&self) -> bool {
        self.refresh_in_flight.is_some()
    }

    fn begin_on_demand_refresh(
        &mut self,
        monotonic_now_ms: u64,
    ) -> Result<Option<Rs256JwksRefreshLease>, Rs256JwksLifecycleError> {
        if self.refresh_in_flight.is_some()
            || self.last_on_demand_refresh_ms.is_some_and(|last| {
                monotonic_now_ms - last < self.policy.on_demand_refresh_floor_ms
            })
        {
            return Ok(None);
        }
        self.last_on_demand_refresh_ms = Some(monotonic_now_ms);
        self.begin_refresh()
    }

    fn begin_refresh(&mut self) -> Result<Option<Rs256JwksRefreshLease>, Rs256JwksLifecycleError> {
        if self.refresh_in_flight.is_some() {
            return Ok(None);
        }
        let next = self
            .next_refresh_generation
            .checked_add(1)
            .ok_or(Rs256JwksLifecycleError::RefreshGenerationExhausted)?;
        let lease = Rs256JwksRefreshLease {
            generation: self.next_refresh_generation,
        };
        self.next_refresh_generation = next;
        self.refresh_in_flight = Some(lease);
        Ok(Some(lease))
    }

    fn take_exact_refresh(
        &mut self,
        lease: Rs256JwksRefreshLease,
    ) -> Result<(), Rs256JwksLifecycleError> {
        if self.refresh_in_flight != Some(lease) {
            return Err(Rs256JwksLifecycleError::StaleRefresh);
        }
        self.refresh_in_flight = None;
        Ok(())
    }

    fn observe_time(&mut self, monotonic_now_ms: u64) -> Result<(), Rs256JwksLifecycleError> {
        if self
            .last_observed_monotonic_ms
            .is_some_and(|last| monotonic_now_ms < last)
        {
            return Err(Rs256JwksLifecycleError::ClockRegressed);
        }
        self.last_observed_monotonic_ms = Some(monotonic_now_ms);
        Ok(())
    }
}

impl fmt::Debug for Rs256JwksCache {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Rs256JwksCache(warmed={}, refresh_in_flight={})",
            self.current.is_some(),
            self.refresh_in_flight.is_some()
        )
    }
}

fn unavailable(
    reason: Rs256JwksUnavailableReason,
    refresh: Option<Rs256JwksRefreshLease>,
) -> Rs256JwksResolution {
    Rs256JwksResolution {
        state: ResolutionState::Unavailable { reason, refresh },
    }
}
