use std::time::Duration;

use converact_runtime_health::RuntimeHealth;
use converact_voice_agent_worker::{
    AdmissionReadiness, ClaimLoopConfig, WorkerConfig, WorkerConfigError,
};

#[test]
fn worker_concurrency_and_claim_size_are_bounded() {
    assert_eq!(
        WorkerConfig::new(0, 1),
        Err(WorkerConfigError::InvalidWorkerCount)
    );
    assert_eq!(
        WorkerConfig::new(1, 0),
        Err(WorkerConfigError::InvalidClaimSize)
    );
    assert_eq!(
        WorkerConfig::new(257, 1),
        Err(WorkerConfigError::InvalidWorkerCount)
    );
    assert_eq!(
        WorkerConfig::new(1, 1_025),
        Err(WorkerConfigError::InvalidClaimSize)
    );
}

#[test]
fn claim_poll_interval_rejects_busy_spin_and_unresponsive_shutdown() {
    assert_eq!(
        ClaimLoopConfig::new(Duration::ZERO),
        Err(WorkerConfigError::InvalidClaimPollInterval)
    );
    assert_eq!(
        ClaimLoopConfig::new(Duration::from_secs(61)),
        Err(WorkerConfigError::InvalidClaimPollInterval)
    );
    assert_eq!(
        ClaimLoopConfig::new(Duration::from_millis(250))
            .unwrap()
            .poll_interval(),
        Duration::from_millis(250)
    );
}

#[test]
fn admission_starts_fail_closed() {
    let readiness = AdmissionReadiness::new(RuntimeHealth::new());
    readiness.set_durable_store(true);
    readiness.set_agent_reservation(true);

    assert!(!readiness.accepts_new_work());
    assert!(readiness.failure_codes().contains(&"platform_not_ready"));
}
