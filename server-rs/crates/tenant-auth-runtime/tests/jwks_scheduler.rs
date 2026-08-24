use std::sync::{
    Arc,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};

use converact_tenant_auth::{
    JwksIssuerTransportPolicy, Rs256JwksCachePolicy, Rs256JwksSnapshot, ValidatedJwksIssuer,
};
use converact_tenant_auth_runtime::{
    JwksFetchError, JwksMonotonicClock, JwksSnapshotFetcher, Rs256JwksIssuerLifecycle,
    Rs256JwksRefreshError, Rs256JwksRefreshScheduleError, Rs256JwksRefreshScheduler,
    Rs256JwksRefreshSchedulerExit, Rs256JwksRefreshStatus,
};
use serde_json::Value;
use tokio::sync::{Notify, watch};

const FIXTURE: &str = include_str!("../../../tests/fixtures/platform-rs256-v1.json");
const SCHEDULER_SOURCE: &str = include_str!("../src/jwks_scheduler.rs");

struct ManualClock(AtomicU64);

impl ManualClock {
    fn new(now_ms: u64) -> Self {
        Self(AtomicU64::new(now_ms))
    }
}

impl JwksMonotonicClock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

struct FixtureFetcher {
    body: Box<str>,
    calls: Arc<AtomicUsize>,
}

impl JwksSnapshotFetcher for FixtureFetcher {
    async fn fetch<'a>(
        &'a self,
        _issuer: &'a ValidatedJwksIssuer,
    ) -> Result<Rs256JwksSnapshot, JwksFetchError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(snapshot(&self.body))
    }
}

struct FixtureFailFixtureFetcher {
    body: Box<str>,
    calls: Arc<AtomicUsize>,
}

impl JwksSnapshotFetcher for FixtureFailFixtureFetcher {
    async fn fetch<'a>(
        &'a self,
        _issuer: &'a ValidatedJwksIssuer,
    ) -> Result<Rs256JwksSnapshot, JwksFetchError> {
        match self.calls.fetch_add(1, Ordering::SeqCst) {
            0 | 2 => Ok(snapshot(&self.body)),
            _ => Err(JwksFetchError::Transport),
        }
    }
}

struct FixturePendingFailFetcher {
    body: Box<str>,
    calls: Arc<AtomicUsize>,
    pending_started: Arc<Notify>,
}

impl JwksSnapshotFetcher for FixturePendingFailFetcher {
    async fn fetch<'a>(
        &'a self,
        _issuer: &'a ValidatedJwksIssuer,
    ) -> Result<Rs256JwksSnapshot, JwksFetchError> {
        match self.calls.fetch_add(1, Ordering::SeqCst) {
            0 => Ok(snapshot(&self.body)),
            1 => {
                self.pending_started.notify_one();
                std::future::pending().await
            }
            _ => Err(JwksFetchError::Transport),
        }
    }
}

#[test]
fn schedule_is_bounded_by_the_exact_lifecycle_freshness_window() {
    let fixture = fixture();
    let lifecycle = lifecycle(
        &fixture,
        Rs256JwksCachePolicy::new(10_000, 1_000).unwrap(),
        FixtureFetcher {
            body: jwks_body(&fixture).into_boxed_str(),
            calls: Arc::new(AtomicUsize::new(0)),
        },
    );

    for (period_ms, jitter_ms, seed, expected) in [
        (999, 10, 7, Rs256JwksRefreshScheduleError::PeriodInvalid),
        (2_000, 0, 7, Rs256JwksRefreshScheduleError::JitterInvalid),
        (
            2_000,
            1_001,
            7,
            Rs256JwksRefreshScheduleError::JitterInvalid,
        ),
        (
            9_000,
            1_000,
            7,
            Rs256JwksRefreshScheduleError::FreshnessWindowTooSmall,
        ),
        (2_000, 100, 0, Rs256JwksRefreshScheduleError::SeedInvalid),
    ] {
        assert_eq!(
            Rs256JwksRefreshScheduler::new(Arc::clone(&lifecycle), period_ms, jitter_ms, seed)
                .unwrap_err(),
            expected
        );
    }

    let scheduler = Rs256JwksRefreshScheduler::new(lifecycle, 8_000, 1_000, 7).unwrap();
    let first = scheduler.delay_for_attempt_ms(1);
    assert!((7_000..=9_000).contains(&first));
    assert_eq!(first, scheduler.delay_for_attempt_ms(1));
    assert_ne!(first, scheduler.delay_for_attempt_ms(2));
    for attempt in 1..=10_000 {
        assert!((7_000..=9_000).contains(&scheduler.delay_for_attempt_ms(attempt)));
    }
    assert_eq!(
        format!("{scheduler:?}"),
        "Rs256JwksRefreshScheduler([REDACTED])"
    );
}

#[tokio::test(start_paused = true)]
async fn scheduler_waits_for_its_slot_refreshes_and_stops_cooperatively() {
    let fixture = fixture();
    let calls = Arc::new(AtomicUsize::new(0));
    let lifecycle = lifecycle(
        &fixture,
        Rs256JwksCachePolicy::default(),
        FixtureFetcher {
            body: jwks_body(&fixture).into_boxed_str(),
            calls: Arc::clone(&calls),
        },
    );
    lifecycle.warm().await.unwrap();
    let scheduler = Rs256JwksRefreshScheduler::new(lifecycle, 2_000, 100, 11).unwrap();
    let first_delay = scheduler.delay_for_attempt_ms(1);
    let mut status = scheduler.subscribe();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let task = tokio::spawn(scheduler.run(shutdown_rx));
    tokio::task::yield_now().await;

    tokio::time::advance(std::time::Duration::from_millis(first_delay - 1)).await;
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    tokio::time::advance(std::time::Duration::from_millis(1)).await;
    status.changed().await.unwrap();
    assert_eq!(
        *status.borrow_and_update(),
        Rs256JwksRefreshStatus::Completed { attempt: 1 }
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);

    shutdown_tx.send(true).unwrap();
    assert_eq!(
        task.await.unwrap(),
        Rs256JwksRefreshSchedulerExit::Shutdown { attempts: 1 }
    );
}

#[tokio::test(start_paused = true)]
async fn failed_periodic_refresh_is_observable_and_the_next_slot_recovers() {
    let fixture = fixture();
    let calls = Arc::new(AtomicUsize::new(0));
    let lifecycle = lifecycle(
        &fixture,
        Rs256JwksCachePolicy::default(),
        FixtureFailFixtureFetcher {
            body: jwks_body(&fixture).into_boxed_str(),
            calls: Arc::clone(&calls),
        },
    );
    lifecycle.warm().await.unwrap();
    let scheduler = Rs256JwksRefreshScheduler::new(lifecycle, 2_000, 100, 13).unwrap();
    let first_delay = scheduler.delay_for_attempt_ms(1);
    let second_delay = scheduler.delay_for_attempt_ms(2);
    let mut status = scheduler.subscribe();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let task = tokio::spawn(scheduler.run(shutdown_rx));

    tokio::time::advance(std::time::Duration::from_millis(first_delay)).await;
    status.changed().await.unwrap();
    assert_eq!(
        *status.borrow_and_update(),
        Rs256JwksRefreshStatus::Failed {
            attempt: 1,
            error: Rs256JwksRefreshError::Fetch(JwksFetchError::Transport)
        }
    );

    tokio::time::advance(std::time::Duration::from_millis(second_delay)).await;
    status.changed().await.unwrap();
    assert_eq!(
        *status.borrow_and_update(),
        Rs256JwksRefreshStatus::Completed { attempt: 2 }
    );
    assert_eq!(calls.load(Ordering::SeqCst), 3);

    shutdown_tx.send(true).unwrap();
    assert_eq!(
        task.await.unwrap(),
        Rs256JwksRefreshSchedulerExit::Shutdown { attempts: 2 }
    );
}

#[tokio::test(start_paused = true)]
async fn shutdown_during_sleep_starts_no_refresh() {
    let fixture = fixture();
    let calls = Arc::new(AtomicUsize::new(0));
    let lifecycle = lifecycle(
        &fixture,
        Rs256JwksCachePolicy::default(),
        FixtureFetcher {
            body: jwks_body(&fixture).into_boxed_str(),
            calls: Arc::clone(&calls),
        },
    );
    lifecycle.warm().await.unwrap();
    let scheduler = Rs256JwksRefreshScheduler::new(lifecycle, 2_000, 100, 17).unwrap();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let task = tokio::spawn(scheduler.run(shutdown_rx));
    tokio::task::yield_now().await;

    shutdown_tx.send(true).unwrap();
    assert_eq!(
        task.await.unwrap(),
        Rs256JwksRefreshSchedulerExit::Shutdown { attempts: 0 }
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn shutdown_cancels_an_active_fetch_and_releases_its_exact_lease() {
    let fixture = fixture();
    let calls = Arc::new(AtomicUsize::new(0));
    let pending_started = Arc::new(Notify::new());
    let lifecycle = lifecycle(
        &fixture,
        Rs256JwksCachePolicy::default(),
        FixturePendingFailFetcher {
            body: jwks_body(&fixture).into_boxed_str(),
            calls: Arc::clone(&calls),
            pending_started: Arc::clone(&pending_started),
        },
    );
    lifecycle.warm().await.unwrap();
    let scheduler = Rs256JwksRefreshScheduler::new(Arc::clone(&lifecycle), 2_000, 100, 19).unwrap();
    let first_delay = scheduler.delay_for_attempt_ms(1);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let task = tokio::spawn(scheduler.run(shutdown_rx));

    tokio::time::advance(std::time::Duration::from_millis(first_delay)).await;
    pending_started.notified().await;
    shutdown_tx.send(true).unwrap();
    assert_eq!(
        task.await.unwrap(),
        Rs256JwksRefreshSchedulerExit::Shutdown { attempts: 1 }
    );

    assert_eq!(
        lifecycle.refresh_now().await,
        Err(Rs256JwksRefreshError::Fetch(JwksFetchError::Transport))
    );
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[tokio::test(start_paused = true)]
async fn scheduler_observes_an_existing_single_flight_owner_without_fetching_again() {
    let fixture = fixture();
    let calls = Arc::new(AtomicUsize::new(0));
    let pending_started = Arc::new(Notify::new());
    let lifecycle = lifecycle(
        &fixture,
        Rs256JwksCachePolicy::default(),
        FixturePendingFailFetcher {
            body: jwks_body(&fixture).into_boxed_str(),
            calls: Arc::clone(&calls),
            pending_started: Arc::clone(&pending_started),
        },
    );
    lifecycle.warm().await.unwrap();
    let owner = {
        let lifecycle = Arc::clone(&lifecycle);
        tokio::spawn(async move { lifecycle.refresh_now().await })
    };
    pending_started.notified().await;

    let scheduler = Rs256JwksRefreshScheduler::new(lifecycle, 2_000, 100, 29).unwrap();
    let first_delay = scheduler.delay_for_attempt_ms(1);
    let mut status = scheduler.subscribe();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let scheduler_task = tokio::spawn(scheduler.run(shutdown_rx));
    tokio::time::advance(std::time::Duration::from_millis(first_delay)).await;
    status.changed().await.unwrap();

    assert_eq!(
        *status.borrow_and_update(),
        Rs256JwksRefreshStatus::InFlight { attempt: 1 }
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    shutdown_tx.send(true).unwrap();
    assert_eq!(
        scheduler_task.await.unwrap(),
        Rs256JwksRefreshSchedulerExit::Shutdown { attempts: 1 }
    );
    owner.abort();
    assert!(owner.await.unwrap_err().is_cancelled());
}

#[tokio::test(start_paused = true)]
async fn preclosed_or_dropped_shutdown_channel_exits_without_work() {
    let fixture = fixture();
    let calls = Arc::new(AtomicUsize::new(0));
    let lifecycle = lifecycle(
        &fixture,
        Rs256JwksCachePolicy::default(),
        FixtureFetcher {
            body: jwks_body(&fixture).into_boxed_str(),
            calls: Arc::clone(&calls),
        },
    );
    lifecycle.warm().await.unwrap();

    for dropped in [false, true] {
        let scheduler =
            Rs256JwksRefreshScheduler::new(Arc::clone(&lifecycle), 2_000, 100, 23).unwrap();
        let (shutdown_tx, shutdown_rx) = watch::channel(!dropped);
        if dropped {
            drop(shutdown_tx);
        }
        assert_eq!(
            scheduler.run(shutdown_rx).await,
            Rs256JwksRefreshSchedulerExit::Shutdown { attempts: 0 }
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn scheduler_source_has_one_bounded_latest_value_channel_and_no_task_authority() {
    assert!(SCHEDULER_SOURCE.contains("watch::Sender<Rs256JwksRefreshStatus>"));
    for forbidden in [
        "tokio::spawn",
        "mpsc",
        "VecDeque",
        "HashMap",
        "std::env",
        "SystemTime",
        "static mut",
        "unsafe",
    ] {
        assert!(!SCHEDULER_SOURCE.contains(forbidden), "found {forbidden}");
    }
    assert_eq!(
        Rs256JwksRefreshScheduleError::PeriodInvalid.to_string(),
        "platform_rs256_jwks_refresh_period_invalid"
    );
}

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("RS256 fixture")
}

fn lifecycle<Fetcher: JwksSnapshotFetcher>(
    fixture: &Value,
    cache_policy: Rs256JwksCachePolicy,
    fetcher: Fetcher,
) -> Arc<Rs256JwksIssuerLifecycle<Fetcher, ManualClock>> {
    Arc::new(
        Rs256JwksIssuerLifecycle::new(
            ValidatedJwksIssuer::parse(
                fixture["policy"]["expected_issuer"].as_str().unwrap(),
                JwksIssuerTransportPolicy::HttpsOnly,
            )
            .unwrap(),
            cache_policy,
            fixture["policy"]["expected_audience"].as_str().unwrap(),
            fixture["policy"]["current_policy_version"]
                .as_u64()
                .unwrap(),
            fixture["policy"]["current_revocation_epoch"]
                .as_u64()
                .unwrap(),
            fetcher,
            Arc::new(ManualClock::new(100)),
        )
        .unwrap(),
    )
}

fn snapshot(body: &str) -> Rs256JwksSnapshot {
    Rs256JwksSnapshot::parse_json(body).expect("valid JWKS fixture")
}

fn jwks_body(fixture: &Value) -> String {
    serde_json::json!({ "keys": [fixture["public_jwk"].clone()] }).to_string()
}
