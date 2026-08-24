use std::{error::Error, fmt, num::NonZeroU64, sync::Arc, time::Duration};

use tokio::sync::watch;

use crate::{
    JwksMonotonicClock, JwksSnapshotFetcher, Rs256JwksIssuerLifecycle, Rs256JwksRefreshError,
    Rs256JwksRefreshOutcome,
};

const MIN_REFRESH_PERIOD_MS: u64 = 1_000;
const MAX_REFRESH_PERIOD_MS: u64 = 86_400_000;
const SPLITMIX_INCREMENT: u64 = 0x9e37_79b9_7f4a_7c15;

/// Invalid bounded periodic-refresh configuration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Rs256JwksRefreshScheduleError {
    PeriodInvalid,
    JitterInvalid,
    FreshnessWindowTooSmall,
    SeedInvalid,
}

impl Rs256JwksRefreshScheduleError {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PeriodInvalid => "platform_rs256_jwks_refresh_period_invalid",
            Self::JitterInvalid => "platform_rs256_jwks_refresh_jitter_invalid",
            Self::FreshnessWindowTooSmall => {
                "platform_rs256_jwks_refresh_freshness_window_too_small"
            }
            Self::SeedInvalid => "platform_rs256_jwks_refresh_seed_invalid",
        }
    }
}

impl fmt::Display for Rs256JwksRefreshScheduleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Error for Rs256JwksRefreshScheduleError {}

/// Latest value-free observation from one issuer-local periodic scheduler.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Rs256JwksRefreshStatus {
    Idle,
    Completed {
        attempt: u64,
    },
    InFlight {
        attempt: u64,
    },
    Failed {
        attempt: u64,
        error: Rs256JwksRefreshError,
    },
}

/// Terminal outcome of a caller-owned scheduler future.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Rs256JwksRefreshSchedulerExit {
    Shutdown { attempts: u64 },
    AttemptSequenceExhausted,
}

/// One issuer-local, bounded and cooperatively stoppable refresh scheduler.
///
/// The scheduler owns no task. A process task group must own the future
/// returned by [`Self::run`]. Startup warm remains an explicit lifecycle gate.
pub struct Rs256JwksRefreshScheduler<Fetcher, Clock> {
    lifecycle: Arc<Rs256JwksIssuerLifecycle<Fetcher, Clock>>,
    period_ms: u64,
    jitter_ms: u64,
    seed: NonZeroU64,
    status: watch::Sender<Rs256JwksRefreshStatus>,
}

impl<Fetcher: JwksSnapshotFetcher, Clock: JwksMonotonicClock>
    Rs256JwksRefreshScheduler<Fetcher, Clock>
{
    /// Validates one scheduler against the exact lifecycle cache policy.
    ///
    /// The stable non-zero seed must be derived by the caller from bounded
    /// runtime identity. It spreads instances without runtime randomness.
    ///
    /// # Errors
    ///
    /// Rejects invalid period, jitter, freshness-window or seed values.
    pub fn new(
        lifecycle: Arc<Rs256JwksIssuerLifecycle<Fetcher, Clock>>,
        period_ms: u64,
        jitter_ms: u64,
        seed: u64,
    ) -> Result<Self, Rs256JwksRefreshScheduleError> {
        if !(MIN_REFRESH_PERIOD_MS..=MAX_REFRESH_PERIOD_MS).contains(&period_ms) {
            return Err(Rs256JwksRefreshScheduleError::PeriodInvalid);
        }
        if jitter_ms == 0 || jitter_ms > period_ms / 2 {
            return Err(Rs256JwksRefreshScheduleError::JitterInvalid);
        }
        let maximum_delay_ms = period_ms
            .checked_add(jitter_ms)
            .ok_or(Rs256JwksRefreshScheduleError::PeriodInvalid)?;
        if maximum_delay_ms >= lifecycle.cache_policy().fresh_for_ms() {
            return Err(Rs256JwksRefreshScheduleError::FreshnessWindowTooSmall);
        }
        let seed = NonZeroU64::new(seed).ok_or(Rs256JwksRefreshScheduleError::SeedInvalid)?;
        let (status, _) = watch::channel(Rs256JwksRefreshStatus::Idle);
        Ok(Self {
            lifecycle,
            period_ms,
            jitter_ms,
            seed,
            status,
        })
    }

    /// Returns the deterministic bounded delay for one non-zero attempt.
    #[must_use]
    pub fn delay_for_attempt_ms(&self, attempt: u64) -> u64 {
        let spread = self.jitter_ms * 2 + 1;
        let sample = splitmix64(self.seed.get() ^ attempt.wrapping_mul(SPLITMIX_INCREMENT));
        self.period_ms - self.jitter_ms + sample % spread
    }

    /// Subscribes to one fixed-capacity latest-value status channel.
    #[must_use]
    pub fn subscribe(&self) -> watch::Receiver<Rs256JwksRefreshStatus> {
        self.status.subscribe()
    }

    /// Waits one bounded slot at a time, refreshes once and repeats until
    /// cooperative shutdown. Failed attempts are published and do not form a
    /// retry burst; the next attempt waits its complete next slot.
    pub async fn run(self, mut shutdown: watch::Receiver<bool>) -> Rs256JwksRefreshSchedulerExit {
        let mut attempts = 0_u64;
        loop {
            let Some(attempt) = attempts.checked_add(1) else {
                return Rs256JwksRefreshSchedulerExit::AttemptSequenceExhausted;
            };
            let delay = Duration::from_millis(self.delay_for_attempt_ms(attempt));
            tokio::select! {
                biased;
                () = shutdown_requested(&mut shutdown) => {
                    return Rs256JwksRefreshSchedulerExit::Shutdown { attempts };
                }
                () = tokio::time::sleep(delay) => {}
            }

            attempts = attempt;
            let refresh = self.lifecycle.refresh_now();
            tokio::pin!(refresh);
            let result = tokio::select! {
                biased;
                () = shutdown_requested(&mut shutdown) => {
                    return Rs256JwksRefreshSchedulerExit::Shutdown { attempts };
                }
                result = &mut refresh => result,
            };
            let status = match result {
                Ok(Rs256JwksRefreshOutcome::Completed) => {
                    Rs256JwksRefreshStatus::Completed { attempt }
                }
                Ok(Rs256JwksRefreshOutcome::InFlight) => {
                    Rs256JwksRefreshStatus::InFlight { attempt }
                }
                Err(error) => Rs256JwksRefreshStatus::Failed { attempt, error },
            };
            self.status.send_replace(status);
        }
    }
}

impl<Fetcher, Clock> fmt::Debug for Rs256JwksRefreshScheduler<Fetcher, Clock> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Rs256JwksRefreshScheduler([REDACTED])")
    }
}

async fn shutdown_requested(shutdown: &mut watch::Receiver<bool>) {
    if *shutdown.borrow_and_update() {
        return;
    }
    loop {
        match shutdown.changed().await {
            Ok(()) if !*shutdown.borrow_and_update() => {}
            Ok(()) | Err(_) => return,
        }
    }
}

const fn splitmix64(mut value: u64) -> u64 {
    value = value.wrapping_add(SPLITMIX_INCREMENT);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}
