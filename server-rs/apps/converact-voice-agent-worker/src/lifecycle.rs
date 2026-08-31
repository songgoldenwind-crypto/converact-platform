use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use converact_contracts::health::ReadinessStatus;
use converact_runtime_health::RuntimeHealth;

const MAX_WORKERS: u16 = 256;
const MAX_CLAIM_SIZE: u16 = 1_024;

/// Invalid bounded worker lifecycle configuration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerConfigError {
    InvalidWorkerCount,
    InvalidClaimSize,
}

impl std::fmt::Display for WorkerConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidWorkerCount => "voice_agent_worker_count_invalid",
            Self::InvalidClaimSize => "voice_agent_claim_size_invalid",
        })
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
#[derive(Clone, Debug, Default)]
pub struct ShutdownToken(Arc<AtomicBool>);

impl ShutdownToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// Admission state. Changes stop new claims and never terminate established calls.
#[derive(Clone)]
pub struct AdmissionReadiness {
    platform: RuntimeHealth,
    durable_store: Arc<AtomicBool>,
    agent_reservation: Arc<AtomicBool>,
}

impl AdmissionReadiness {
    #[must_use]
    pub fn new(platform: RuntimeHealth) -> Self {
        Self {
            platform,
            durable_store: Arc::new(AtomicBool::new(false)),
            agent_reservation: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set_durable_store(&self, accepting: bool) {
        self.durable_store.store(accepting, Ordering::Release);
    }

    pub fn set_agent_reservation(&self, accepting: bool) {
        self.agent_reservation.store(accepting, Ordering::Release);
    }

    #[must_use]
    pub fn accepts_new_work(&self) -> bool {
        self.platform.snapshot().status == ReadinessStatus::Ready
            && self.durable_store.load(Ordering::Acquire)
            && self.agent_reservation.load(Ordering::Acquire)
    }

    #[must_use]
    pub fn failure_codes(&self) -> Vec<&'static str> {
        let mut failures = Vec::with_capacity(3);
        if self.platform.snapshot().status != ReadinessStatus::Ready {
            failures.push("platform_not_ready");
        }
        if !self.durable_store.load(Ordering::Acquire) {
            failures.push("durable_store_not_ready");
        }
        if !self.agent_reservation.load(Ordering::Acquire) {
            failures.push("agent_reservation_not_ready");
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
