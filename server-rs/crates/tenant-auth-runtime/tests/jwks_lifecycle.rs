use std::sync::{
    Arc,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};

use converact_tenant_auth::{
    JwksIssuerTransportPolicy, Rs256JwksCachePolicy, Rs256JwksLifecycleError, Rs256JwksSnapshot,
    Rs256JwksUnavailableReason, ValidatedJwksIssuer,
};
use converact_tenant_auth_runtime::{
    JwksFetchError, JwksMonotonicClock, JwksSnapshotFetcher, Rs256JwksIssuerLifecycle,
    Rs256JwksRefreshError, Rs256JwksRefreshOutcome,
};
use serde_json::Value;
use tokio::sync::Notify;

const FIXTURE: &str = include_str!("../../../tests/fixtures/platform-rs256-v1.json");
const LIFECYCLE_SOURCE: &str = include_str!("../src/jwks_lifecycle.rs");

struct ManualClock(AtomicU64);

impl ManualClock {
    fn new(now_ms: u64) -> Self {
        Self(AtomicU64::new(now_ms))
    }

    fn set(&self, now_ms: u64) {
        self.0.store(now_ms, Ordering::SeqCst);
    }
}

impl JwksMonotonicClock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

struct FixtureFetcher {
    body: Box<str>,
}

struct FirstPendingThenFailFetcher {
    calls: Arc<AtomicUsize>,
    first_started: Arc<Notify>,
}

struct FailThenFixtureFetcher {
    calls: AtomicUsize,
    body: Box<str>,
}

impl JwksSnapshotFetcher for FailThenFixtureFetcher {
    async fn fetch<'a>(
        &'a self,
        _issuer: &'a ValidatedJwksIssuer,
    ) -> Result<Rs256JwksSnapshot, JwksFetchError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err(JwksFetchError::Transport);
        }
        Ok(Rs256JwksSnapshot::parse_json(&self.body).expect("valid JWKS fixture"))
    }
}

impl JwksSnapshotFetcher for FirstPendingThenFailFetcher {
    async fn fetch<'a>(
        &'a self,
        _issuer: &'a ValidatedJwksIssuer,
    ) -> Result<Rs256JwksSnapshot, JwksFetchError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            self.first_started.notify_one();
            return std::future::pending().await;
        }
        Err(JwksFetchError::Transport)
    }
}

impl JwksSnapshotFetcher for FixtureFetcher {
    async fn fetch<'a>(
        &'a self,
        _issuer: &'a ValidatedJwksIssuer,
    ) -> Result<Rs256JwksSnapshot, JwksFetchError> {
        Ok(Rs256JwksSnapshot::parse_json(&self.body).expect("valid JWKS fixture"))
    }
}

#[tokio::test]
async fn startup_warm_binds_the_exact_issuer_and_shared_clock() {
    let fixture = fixture();
    let lifecycle = Rs256JwksIssuerLifecycle::new(
        issuer(&fixture),
        Rs256JwksCachePolicy::default(),
        fixture["policy"]["expected_audience"].as_str().unwrap(),
        fixture["policy"]["current_policy_version"]
            .as_u64()
            .unwrap(),
        fixture["policy"]["current_revocation_epoch"]
            .as_u64()
            .unwrap(),
        FixtureFetcher {
            body: jwks_body(&fixture).into_boxed_str(),
        },
        Arc::new(ManualClock::new(100)),
    )
    .expect("valid lifecycle");

    assert!(!lifecycle.readiness().is_ready());
    lifecycle.warm().await.unwrap();

    assert!(lifecycle.readiness().is_ready());
    let identity = lifecycle
        .verify_cached(valid_token(&fixture), wall_now(&fixture))
        .expect("valid platform identity");
    assert_eq!(identity.tenant_id(), "tenant-rs");
    assert_eq!(
        format!("{lifecycle:?}"),
        "Rs256JwksIssuerLifecycle([REDACTED])"
    );
}

#[tokio::test]
async fn request_refresh_lease_is_driven_by_the_same_issuer_lifecycle() {
    let fixture = fixture();
    let lifecycle = lifecycle(&fixture, Arc::new(ManualClock::new(100)));
    let unavailable = lifecycle
        .verify_cached(valid_token(&fixture), wall_now(&fixture))
        .unwrap_err();
    assert_eq!(
        unavailable.unavailable_reason(),
        Some(Rs256JwksUnavailableReason::Unwarmed)
    );
    let lease = unavailable.refresh_lease().expect("request refresh lease");

    lifecycle.drive_refresh(lease).await.unwrap();

    assert!(
        lifecycle
            .verify_cached(valid_token(&fixture), wall_now(&fixture))
            .is_ok()
    );
    assert!(lifecycle.readiness().is_ready());
}

#[tokio::test]
async fn refresh_lease_cannot_cross_lifecycle_instances() {
    let fixture = fixture();
    let first = lifecycle(&fixture, Arc::new(ManualClock::new(100)));
    let second = lifecycle(&fixture, Arc::new(ManualClock::new(100)));
    let first_lease = first
        .verify_cached(valid_token(&fixture), wall_now(&fixture))
        .unwrap_err()
        .refresh_lease()
        .expect("first lease");
    let second_lease = second
        .verify_cached(valid_token(&fixture), wall_now(&fixture))
        .unwrap_err()
        .refresh_lease()
        .expect("second lease");

    assert_eq!(
        second.drive_refresh(first_lease).await,
        Err(Rs256JwksRefreshError::Lifecycle(
            Rs256JwksLifecycleError::StaleRefresh
        ))
    );
    second.drive_refresh(second_lease).await.unwrap();
    first.drive_refresh(first_lease).await.unwrap();
    assert!(first.readiness().is_ready());
    assert!(second.readiness().is_ready());
}

#[tokio::test]
async fn concurrent_refresh_is_skipped_and_cancelled_owner_releases_the_lease() {
    let fixture = fixture();
    let calls = Arc::new(AtomicUsize::new(0));
    let first_started = Arc::new(Notify::new());
    let lifecycle = Arc::new(
        Rs256JwksIssuerLifecycle::new(
            issuer(&fixture),
            Rs256JwksCachePolicy::default(),
            fixture["policy"]["expected_audience"].as_str().unwrap(),
            fixture["policy"]["current_policy_version"]
                .as_u64()
                .unwrap(),
            fixture["policy"]["current_revocation_epoch"]
                .as_u64()
                .unwrap(),
            FirstPendingThenFailFetcher {
                calls: Arc::clone(&calls),
                first_started: Arc::clone(&first_started),
            },
            Arc::new(ManualClock::new(100)),
        )
        .expect("valid lifecycle"),
    );
    let first = {
        let lifecycle = Arc::clone(&lifecycle);
        tokio::spawn(async move { lifecycle.refresh_now().await })
    };
    first_started.notified().await;

    assert_eq!(
        lifecycle.refresh_now().await,
        Ok(Rs256JwksRefreshOutcome::InFlight)
    );
    assert_eq!(
        lifecycle.warm().await,
        Err(converact_tenant_auth_runtime::Rs256JwksWarmError::RefreshInFlight)
    );
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());

    assert_eq!(
        lifecycle.refresh_now().await,
        Err(Rs256JwksRefreshError::Fetch(JwksFetchError::Transport))
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn failed_startup_warm_stays_closed_and_can_recover() {
    let fixture = fixture();
    let lifecycle = Rs256JwksIssuerLifecycle::new(
        issuer(&fixture),
        Rs256JwksCachePolicy::default(),
        fixture["policy"]["expected_audience"].as_str().unwrap(),
        fixture["policy"]["current_policy_version"]
            .as_u64()
            .unwrap(),
        fixture["policy"]["current_revocation_epoch"]
            .as_u64()
            .unwrap(),
        FailThenFixtureFetcher {
            calls: AtomicUsize::new(0),
            body: jwks_body(&fixture).into_boxed_str(),
        },
        Arc::new(ManualClock::new(100)),
    )
    .expect("valid lifecycle");

    assert_eq!(
        lifecycle.warm().await,
        Err(converact_tenant_auth_runtime::Rs256JwksWarmError::Refresh(
            Rs256JwksRefreshError::Fetch(JwksFetchError::Transport)
        ))
    );
    assert!(!lifecycle.readiness().is_ready());

    lifecycle.warm().await.unwrap();
    assert!(lifecycle.readiness().is_ready());
}

#[tokio::test]
async fn readiness_uses_the_same_clock_and_expires_at_the_exact_boundary() {
    let fixture = fixture();
    let clock = Arc::new(ManualClock::new(100));
    let lifecycle = Rs256JwksIssuerLifecycle::new(
        issuer(&fixture),
        Rs256JwksCachePolicy::new(100, 10).unwrap(),
        fixture["policy"]["expected_audience"].as_str().unwrap(),
        fixture["policy"]["current_policy_version"]
            .as_u64()
            .unwrap(),
        fixture["policy"]["current_revocation_epoch"]
            .as_u64()
            .unwrap(),
        FixtureFetcher {
            body: jwks_body(&fixture).into_boxed_str(),
        },
        Arc::clone(&clock),
    )
    .expect("valid lifecycle");
    lifecycle.warm().await.unwrap();

    clock.set(199);
    assert!(lifecycle.readiness().is_ready());
    clock.set(200);
    assert_eq!(
        lifecycle.readiness().unavailable_reason(),
        Some(Rs256JwksUnavailableReason::Expired)
    );
}

#[test]
fn lifecycle_is_single_issuer_inert_and_value_free() {
    assert!(LIFECYCLE_SOURCE.contains("issuer.claim_issuer()"));
    assert!(LIFECYCLE_SOURCE.contains("Arc<Clock>"));
    for forbidden in [
        "tokio::spawn",
        "HashMap",
        "loop {",
        "std::env",
        "SystemTime",
        "static mut",
        "unsafe",
    ] {
        assert!(!LIFECYCLE_SOURCE.contains(forbidden), "found {forbidden}");
    }
}

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("RS256 fixture")
}

fn issuer(fixture: &Value) -> ValidatedJwksIssuer {
    ValidatedJwksIssuer::parse(
        fixture["policy"]["expected_issuer"].as_str().unwrap(),
        JwksIssuerTransportPolicy::HttpsOnly,
    )
    .expect("valid fixture issuer")
}

fn lifecycle(
    fixture: &Value,
    clock: Arc<ManualClock>,
) -> Rs256JwksIssuerLifecycle<FixtureFetcher, ManualClock> {
    Rs256JwksIssuerLifecycle::new(
        issuer(fixture),
        Rs256JwksCachePolicy::default(),
        fixture["policy"]["expected_audience"].as_str().unwrap(),
        fixture["policy"]["current_policy_version"]
            .as_u64()
            .unwrap(),
        fixture["policy"]["current_revocation_epoch"]
            .as_u64()
            .unwrap(),
        FixtureFetcher {
            body: jwks_body(fixture).into_boxed_str(),
        },
        clock,
    )
    .expect("valid lifecycle")
}

fn jwks_body(fixture: &Value) -> String {
    serde_json::json!({ "keys": [fixture["public_jwk"].clone()] }).to_string()
}

fn valid_token(fixture: &Value) -> &str {
    fixture["tokens"]["valid"].as_str().unwrap()
}

fn wall_now(fixture: &Value) -> i64 {
    fixture["policy"]["wall_now_epoch_ms"].as_i64().unwrap()
}
