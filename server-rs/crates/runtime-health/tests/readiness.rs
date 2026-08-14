use converact_contracts::health::{
    ConfigurationCheck, ConfigurationStatus, DatabaseCheck, DatabaseStatus, MigrationCheck,
    MigrationStatus, NotificationProviderCheck, NotificationProviderStatus, PlacementSnapshotCheck,
    PlacementSnapshotStatus, ReadinessChecks, ReadinessStatus, RuntimeHeartbeatCheck,
    RuntimeHeartbeatStatus,
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use converact_runtime_health::{BuildIdentity, HealthClock, RuntimeHealth};

const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[test]
fn health_starts_closed_and_derives_ready_only_from_healthy_checks() {
    let health = RuntimeHealth::new();
    assert_eq!(health.snapshot().status, ReadinessStatus::NotReady);
    assert_eq!(
        health.failure_codes(),
        [
            "database_failed",
            "migrations_failed",
            "configuration_failed",
            "runtime_heartbeat_unknown",
            "placement_snapshot_missing",
        ]
    );

    health
        .publish(ready_checks())
        .expect("publish ready checks");
    assert_eq!(health.snapshot().status, ReadinessStatus::Ready);
    assert!(health.failure_codes().is_empty());
}

#[test]
fn mandatory_unknown_stale_draining_and_failed_states_revoke_readiness() {
    let health = RuntimeHealth::new();
    health
        .publish(ready_checks())
        .expect("publish ready checks");

    for status in [
        RuntimeHeartbeatStatus::Unknown,
        RuntimeHeartbeatStatus::Stale,
        RuntimeHeartbeatStatus::Draining,
        RuntimeHeartbeatStatus::Missing,
    ] {
        let mut checks = ready_checks();
        checks.runtime_heartbeat = RuntimeHeartbeatCheck {
            status,
            instance_id: "node-a".to_owned(),
        };
        health.publish(checks).expect("publish heartbeat state");
        assert_eq!(health.snapshot().status, ReadinessStatus::NotReady);
        assert_eq!(
            health.failure_codes(),
            [format!(
                "runtime_heartbeat_{}",
                heartbeat_wire_status(status)
            )]
        );
    }

    let mut checks = ready_checks();
    checks.notification_providers = NotificationProviderCheck {
        status: NotificationProviderStatus::Unknown,
        active: 0,
        unhealthy: 0,
        blocking: true,
    };
    health.publish(checks).expect("publish provider state");
    assert_eq!(health.snapshot().status, ReadinessStatus::NotReady);
    assert_eq!(health.failure_codes(), ["notification_provider_unknown"]);

    let mut checks = ready_checks();
    checks.placement_snapshot = PlacementSnapshotCheck {
        status: PlacementSnapshotStatus::Failed,
        snapshot_version: 0,
        error_code: "placement_snapshot_unavailable".to_owned(),
    };
    health.publish(checks).expect("publish placement state");
    assert_eq!(health.snapshot().status, ReadinessStatus::NotReady);
    assert_eq!(health.failure_codes(), ["placement_snapshot_failed"]);
}

fn heartbeat_wire_status(status: RuntimeHeartbeatStatus) -> &'static str {
    match status {
        RuntimeHeartbeatStatus::Ok => "ok",
        RuntimeHeartbeatStatus::Disabled => "disabled",
        RuntimeHeartbeatStatus::Missing => "missing",
        RuntimeHeartbeatStatus::Stale => "stale",
        RuntimeHeartbeatStatus::Draining => "draining",
        RuntimeHeartbeatStatus::Unknown => "unknown",
    }
}

#[test]
fn health_rejects_unbounded_or_noncanonical_diagnostic_values() {
    let health = RuntimeHealth::new();
    let mut checks = ready_checks();
    checks.migrations.missing = (0..257).map(|index| format!("migration-{index}")).collect();
    assert!(health.publish(checks).is_err());

    let mut checks = ready_checks();
    checks.placement_snapshot = PlacementSnapshotCheck {
        status: PlacementSnapshotStatus::Failed,
        snapshot_version: 0,
        error_code: "leak\nlocal-secret".to_owned(),
    };
    assert!(health.publish(checks).is_err());

    let mut checks = ready_checks();
    checks.migrations.missing = vec!["postgres://user:password@database".to_owned()];
    assert!(health.publish(checks).is_err());

    let mut checks = ready_checks();
    checks.configuration.missing_or_invalid = vec!["DATABASE_URL=secret".to_owned()];
    assert!(health.publish(checks).is_err());
}

#[test]
fn health_rejects_values_that_cannot_round_trip_through_typescript() {
    let health = RuntimeHealth::new();
    let mut checks = ready_checks();
    checks.notification_providers.active = MAX_JAVASCRIPT_SAFE_INTEGER + 1;
    assert!(health.publish(checks).is_err());

    let mut checks = ready_checks();
    checks.notification_providers = NotificationProviderCheck {
        status: NotificationProviderStatus::Degraded,
        active: 1,
        unhealthy: 2,
        blocking: false,
    };
    assert!(health.publish(checks).is_err());

    let mut checks = ready_checks();
    checks.placement_snapshot = PlacementSnapshotCheck {
        status: PlacementSnapshotStatus::Ok,
        snapshot_version: MAX_JAVASCRIPT_SAFE_INTEGER + 1,
        error_code: String::new(),
    };
    assert!(health.publish(checks).is_err());

    let mut checks = ready_checks();
    checks.notification_providers = NotificationProviderCheck {
        status: NotificationProviderStatus::NotConfigured,
        active: 1,
        unhealthy: 0,
        blocking: false,
    };
    assert!(health.publish(checks).is_err());

    let mut checks = ready_checks();
    checks.placement_snapshot.snapshot_version = 1;
    assert!(health.publish(checks).is_err());

    let mut checks = ready_checks();
    checks.migrations.missing = vec!["116_converact_sip_capability_recovery_fence".to_owned()];
    assert!(health.publish(checks).is_err());

    let mut checks = ready_checks();
    checks.configuration.missing_or_invalid = vec!["CONVERACT_FABRIC_AUDIT_IP_HMAC_KEY".to_owned()];
    assert!(health.publish(checks).is_err());
}

#[test]
fn a_stalled_publisher_cannot_leave_readiness_open() {
    let clock = Arc::new(ManualClock::default());
    let health = RuntimeHealth::with_clock(clock.clone());
    health
        .publish_for(ready_checks(), Duration::from_millis(100))
        .expect("publish fresh state");
    assert_eq!(health.snapshot().status, ReadinessStatus::Ready);

    clock.advance(Duration::from_millis(101));

    assert_eq!(health.snapshot().status, ReadinessStatus::NotReady);
    assert!(
        health
            .failure_codes()
            .contains(&"runtime_heartbeat_stale".to_owned())
    );
    assert!(health.publish_for(ready_checks(), Duration::ZERO).is_err());
    assert!(
        health
            .publish_for(ready_checks(), Duration::from_secs(31))
            .is_err()
    );
}

#[test]
fn build_identity_accepts_only_bounded_exact_source_metadata() {
    let identity = BuildIdentity::new("converact-api", "0.1.0", &"a".repeat(40))
        .expect("valid build identity");
    assert_eq!(identity.service_name(), "converact-api");
    assert_eq!(identity.build_version(), "0.1.0");
    assert_eq!(identity.source_commit(), "a".repeat(40));

    assert!(BuildIdentity::new("converact\napi", "0.1.0", &"a".repeat(40)).is_err());
    assert!(BuildIdentity::new("converact-api", "0.1.0", "main").is_err());

    let declared = "a".repeat(40);
    assert!(BuildIdentity::verified("converact-api", "0.1.0", &declared, Some(&declared)).is_ok());
    assert!(BuildIdentity::verified("converact-api", "0.1.0", &declared, None).is_err());
    assert!(
        BuildIdentity::verified("converact-api", "0.1.0", &declared, Some(&"b".repeat(40)))
            .is_err()
    );
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

#[derive(Default)]
struct ManualClock(AtomicU64);

impl ManualClock {
    fn advance(&self, duration: Duration) {
        self.0.fetch_add(
            u64::try_from(duration.as_millis()).expect("test duration"),
            Ordering::Relaxed,
        );
    }
}

impl HealthClock for ManualClock {
    fn now(&self) -> Duration {
        Duration::from_millis(self.0.load(Ordering::Relaxed))
    }
}
