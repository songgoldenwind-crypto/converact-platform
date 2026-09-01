use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use converact_contracts::health::ReadinessStatus;
use converact_runtime_health::RuntimeHealth;
use tokio::sync::watch;

const MAX_WORKERS: u16 = 256;
const MAX_CLAIM_SIZE: u16 = 1_024;
const MIN_CLAIM_POLL_INTERVAL: Duration = Duration::from_millis(1);
const MAX_CLAIM_POLL_INTERVAL: Duration = Duration::from_secs(60);

/// Invalid bounded worker lifecycle configuration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerConfigError {
    InvalidWorkerCount,
    InvalidClaimSize,
    InvalidClaimPollInterval,
}

impl std::fmt::Display for WorkerConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidWorkerCount => "voice_agent_worker_count_invalid",
            Self::InvalidClaimSize => "voice_agent_claim_size_invalid",
            Self::InvalidClaimPollInterval => "voice_agent_claim_poll_interval_invalid",
        })
    }
}

/// Fixed delay used only when the durable queue has no immediately available work.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ClaimLoopConfig {
    poll_interval: Duration,
}

impl ClaimLoopConfig {
    /// # Errors
    ///
    /// Rejects intervals that could busy-spin or make shutdown/configuration changes unresponsive.
    pub fn new(poll_interval: Duration) -> Result<Self, WorkerConfigError> {
        if poll_interval < MIN_CLAIM_POLL_INTERVAL || poll_interval > MAX_CLAIM_POLL_INTERVAL {
            return Err(WorkerConfigError::InvalidClaimPollInterval);
        }
        Ok(Self { poll_interval })
    }

    #[must_use]
    pub const fn poll_interval(self) -> Duration {
        self.poll_interval
    }
}

impl std::error::Error for WorkerConfigError {}

/// Fixed concurrency and bounded durable claim size for one process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkerConfig {
    worker_count: u16,
    claim_size: u16,
}

impl WorkerConfig {
    /// Creates bounded process concurrency. Neither value can grow at runtime.
    ///
    /// # Errors
    ///
    /// Rejects zero or values above the frozen process envelope.
    pub const fn new(worker_count: u16, claim_size: u16) -> Result<Self, WorkerConfigError> {
        if worker_count == 0 || worker_count > MAX_WORKERS {
            return Err(WorkerConfigError::InvalidWorkerCount);
        }
        if claim_size == 0 || claim_size > MAX_CLAIM_SIZE {
            return Err(WorkerConfigError::InvalidClaimSize);
        }
        Ok(Self {
            worker_count,
            claim_size,
        })
    }

    #[must_use]
    pub const fn worker_count(self) -> u16 {
        self.worker_count
    }

    #[must_use]
    pub const fn claim_size(self) -> u16 {
        self.claim_size
    }
}

/// One-way process shutdown signal shared by claim loops and HTTP inspection.
#[derive(Clone)]
pub struct ShutdownToken(Arc<watch::Sender<bool>>);

impl Default for ShutdownToken {
    fn default() -> Self {
        let (sender, _) = watch::channel(false);
        Self(Arc::new(sender))
    }
}

impl ShutdownToken {
    pub fn cancel(&self) {
        self.0.send_replace(true);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        *self.0.borrow()
    }

    pub async fn cancelled(&self) {
        let mut receiver = self.0.subscribe();
        if *receiver.borrow_and_update() {
            return;
        }
        let _ = receiver.wait_for(|cancelled| *cancelled).await;
    }
}

impl std::fmt::Debug for ShutdownToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ShutdownToken")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

/// Admission state. Changes stop new claims and never terminate established calls.
#[derive(Clone)]
pub struct AdmissionReadiness {
    platform: RuntimeHealth,
    durable_store: Arc<AtomicBool>,
    agent_reservation: Arc<AtomicBool>,
    telephony_control: Arc<AtomicBool>,
}

impl AdmissionReadiness {
    #[must_use]
    pub fn new(platform: RuntimeHealth) -> Self {
        Self {
            platform,
            durable_store: Arc::new(AtomicBool::new(false)),
            agent_reservation: Arc::new(AtomicBool::new(false)),
            telephony_control: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set_durable_store(&self, accepting: bool) {
        self.durable_store.store(accepting, Ordering::Release);
    }

    pub fn set_agent_reservation(&self, accepting: bool) {
        self.agent_reservation.store(accepting, Ordering::Release);
    }

    pub fn set_telephony_control(&self, accepting: bool) {
        self.telephony_control.store(accepting, Ordering::Release);
    }

    #[must_use]
    pub fn accepts_new_work(&self) -> bool {
        self.platform.snapshot().status == ReadinessStatus::Ready
            && self.durable_store.load(Ordering::Acquire)
            && self.agent_reservation.load(Ordering::Acquire)
            && self.telephony_control.load(Ordering::Acquire)
    }

    #[must_use]
    pub fn failure_codes(&self) -> Vec<&'static str> {
        let mut failures = Vec::with_capacity(4);
        if self.platform.snapshot().status != ReadinessStatus::Ready {
            failures.push("platform_not_ready");
        }
        if !self.durable_store.load(Ordering::Acquire) {
            failures.push("durable_store_not_ready");
        }
        if !self.agent_reservation.load(Ordering::Acquire) {
            failures.push("agent_reservation_not_ready");
        }
        if !self.telephony_control.load(Ordering::Acquire) {
            failures.push("telephony_control_not_ready");
        }
        failures
    }
}

impl std::fmt::Debug for AdmissionReadiness {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AdmissionReadiness")
            .field("accepts_new_work", &self.accepts_new_work())
            .finish_non_exhaustive()
    }
}
