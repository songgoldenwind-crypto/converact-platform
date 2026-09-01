use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use converact_contracts::health::{
    ConfigurationCheck, ConfigurationStatus, DatabaseCheck, DatabaseStatus, MigrationCheck,
    MigrationStatus, NotificationProviderCheck, NotificationProviderStatus, PlacementSnapshotCheck,
    PlacementSnapshotStatus, ReadinessChecks, RuntimeHeartbeatCheck, RuntimeHeartbeatStatus,
};
use converact_runtime_health::RuntimeHealth;
use converact_voice_agent_worker::{
    AdmissionReadiness, AttemptClaimSource, ClaimSupervisor, ClaimedAttemptExecutor, ShutdownToken,
    WorkerConfig, WorkerError,
};

#[tokio::test]
async fn one_batch_never_exceeds_fixed_executor_concurrency() {
    let source = FixedClaims::new(vec![1, 2, 3, 4, 5]);
    let executor = Arc::new(ConcurrencyProbe::default());
    let supervisor = ClaimSupervisor::new(
        source,
        Arc::clone(&executor),
        WorkerConfig::new(2, 5).unwrap(),
        ready(),
        ShutdownToken::default(),
    );

    let progress = supervisor.run_once().await.unwrap();

    assert_eq!(progress.claimed(), 5);
    assert_eq!(progress.completed(), 5);
    assert_eq!(progress.failed(), 0);
    assert_eq!(executor.maximum.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn admission_and_oversized_source_batches_fail_closed_before_execution() {
    let source = FixedClaims::new(vec![1]);
    let executor = Arc::new(ConcurrencyProbe::default());
    let supervisor = ClaimSupervisor::new(
        source.clone(),
        Arc::clone(&executor),
        WorkerConfig::new(1, 1).unwrap(),
        AdmissionReadiness::new(RuntimeHealth::new()),
        ShutdownToken::default(),
    );
    assert_eq!(
        supervisor.run_once().await.unwrap_err().code(),
        "voice_agent_admission_unavailable"
    );
    assert_eq!(source.claim_calls(), 0);

    let oversized = FixedClaims::new(vec![1, 2]);
    let supervisor = ClaimSupervisor::new(
        oversized,
        Arc::clone(&executor),
        WorkerConfig::new(1, 1).unwrap(),
        ready(),
        ShutdownToken::default(),
    );
    assert_eq!(
        supervisor.run_once().await.unwrap_err().code(),
        "voice_agent_claim_batch_oversized"
    );
    assert_eq!(executor.completed.load(Ordering::SeqCst), 0);
}

#[derive(Clone)]
struct FixedClaims {
    claims: Arc<Mutex<Option<Vec<u8>>>>,
    claim_calls: Arc<AtomicUsize>,
}

impl FixedClaims {
    fn new(claims: Vec<u8>) -> Self {
        Self {
            claims: Arc::new(Mutex::new(Some(claims))),
            claim_calls: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn claim_calls(&self) -> usize {
        self.claim_calls.load(Ordering::SeqCst)
    }
}

impl AttemptClaimSource for FixedClaims {
    type Claim = u8;

    async fn claim(&self, _limit: u16) -> Result<Vec<Self::Claim>, WorkerError> {
        self.claim_calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.claims.lock().unwrap().take().unwrap_or_default())
    }
}

#[derive(Default)]
struct ConcurrencyProbe {
    active: AtomicUsize,
    maximum: AtomicUsize,
    completed: AtomicUsize,
}

impl ClaimedAttemptExecutor<u8> for ConcurrencyProbe {
    async fn execute(&self, _claim: u8) -> Result<(), WorkerError> {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.maximum.fetch_max(active, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(5)).await;
        self.active.fetch_sub(1, Ordering::SeqCst);
        self.completed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn ready() -> AdmissionReadiness {
    let health = RuntimeHealth::new();
    health.publish(ready_checks()).unwrap();
    let readiness = AdmissionReadiness::new(health);
    readiness.set_durable_store(true);
    readiness.set_agent_reservation(true);
    readiness
}

fn ready_checks() -> ReadinessChecks {
    ReadinessChecks {
        database: DatabaseCheck {
            status: DatabaseStatus::Ok,
        },
        migrations: MigrationCheck {
            status: MigrationStatus::Ok,
            missing: vec![],
        },
        configuration: ConfigurationCheck {
            status: ConfigurationStatus::Ok,
            missing_or_invalid: vec![],
        },
        notification_providers: NotificationProviderCheck {
            status: NotificationProviderStatus::NotConfigured,
            active: 0,
            unhealthy: 0,
            blocking: false,
        },
        runtime_heartbeat: RuntimeHeartbeatCheck {
            status: RuntimeHeartbeatStatus::Disabled,
            instance_id: String::new(),
        },
        placement_snapshot: PlacementSnapshotCheck {
            status: PlacementSnapshotStatus::Disabled,
            snapshot_version: 0,
            error_code: String::new(),
        },
    }
}
