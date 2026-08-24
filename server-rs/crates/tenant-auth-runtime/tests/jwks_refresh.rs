use std::sync::{Arc, Mutex};

use converact_tenant_auth::{
    JwksIssuerTransportPolicy, Rs256CachedTokenVerifier, Rs256JwksCachePolicy,
    Rs256JwksLifecycleError, Rs256JwksSnapshot, ValidatedJwksIssuer,
};
use converact_tenant_auth_runtime::{
    JwksFetchError, JwksFetchPolicy, JwksFetcher, JwksMonotonicClock, JwksResolvedAddressPolicy,
    JwksSnapshotFetcher, Rs256JwksRefreshDriver, Rs256JwksRefreshError, SystemJwksDnsResolver,
    SystemJwksMonotonicClock,
};
use serde_json::Value;
use tokio::sync::oneshot;

const FIXTURE: &str = include_str!("../../../tests/fixtures/platform-rs256-v1.json");
const REFRESH_SOURCE: &str = include_str!("../src/jwks_refresh.rs");

#[test]
fn system_clock_is_process_local_monotonic_and_value_free() {
    let clock = SystemJwksMonotonicClock::new();
    let first = clock.now_ms();
    let second = clock.now_ms();

    assert!(second >= first);
    assert_eq!(format!("{clock:?}"), "SystemJwksMonotonicClock");
}

struct FixedClock(u64);

impl JwksMonotonicClock for FixedClock {
    fn now_ms(&self) -> u64 {
        self.0
    }
}

struct FixtureFetcher {
    body: Box<str>,
}

impl JwksSnapshotFetcher for FixtureFetcher {
    async fn fetch<'a>(
        &'a self,
        _issuer: &'a ValidatedJwksIssuer,
    ) -> Result<Rs256JwksSnapshot, JwksFetchError> {
        Ok(Rs256JwksSnapshot::parse_json(&self.body).expect("valid JWKS fixture"))
    }
}

struct FailingFetcher;

impl JwksSnapshotFetcher for FailingFetcher {
    async fn fetch<'a>(
        &'a self,
        _issuer: &'a ValidatedJwksIssuer,
    ) -> Result<Rs256JwksSnapshot, JwksFetchError> {
        Err(JwksFetchError::Transport)
    }
}

struct PendingFetcher {
    started: Mutex<Option<oneshot::Sender<()>>>,
}

impl JwksSnapshotFetcher for PendingFetcher {
    async fn fetch<'a>(
        &'a self,
        _issuer: &'a ValidatedJwksIssuer,
    ) -> Result<Rs256JwksSnapshot, JwksFetchError> {
        self.started
            .lock()
            .unwrap()
            .take()
            .expect("one fetch")
            .send(())
            .unwrap();
        std::future::pending().await
    }
}

#[tokio::test]
async fn successful_refresh_installs_the_exact_snapshot() {
    let fixture = fixture();
    let verifier = Arc::new(verifier(&fixture));
    let lease = verifier
        .begin_scheduled_refresh(100)
        .unwrap()
        .expect("startup refresh lease");
    let driver = Rs256JwksRefreshDriver::new(
        issuer(),
        Arc::clone(&verifier),
        FixtureFetcher {
            body: jwks_body(&fixture).into_boxed_str(),
        },
        FixedClock(101),
    );

    driver.refresh(lease).await.unwrap();

    assert!(verifier.readiness(101).is_ready());
    assert!(
        verifier
            .verify(valid_token(&fixture), wall_now(&fixture), 101)
            .is_ok()
    );
    assert_eq!(verifier.refresh_in_flight(), Ok(false));
}

#[tokio::test]
async fn failed_fetch_releases_the_lease_and_retains_last_known_good() {
    let fixture = fixture();
    let verifier = Arc::new(verifier(&fixture));
    seed(&verifier, &fixture, 100);
    let lease = verifier
        .begin_scheduled_refresh(101)
        .unwrap()
        .expect("periodic refresh lease");
    let driver = Rs256JwksRefreshDriver::new(
        issuer(),
        Arc::clone(&verifier),
        FailingFetcher,
        FixedClock(102),
    );

    assert_eq!(
        driver.refresh(lease).await,
        Err(Rs256JwksRefreshError::Fetch(JwksFetchError::Transport))
    );

    assert_eq!(verifier.refresh_in_flight(), Ok(false));
    assert!(verifier.readiness(102).is_ready());
    assert!(
        verifier
            .verify(valid_token(&fixture), wall_now(&fixture), 102)
            .is_ok()
    );
}

#[tokio::test]
async fn regressed_completion_cannot_replace_last_known_good_or_stick_the_lease() {
    let fixture = fixture();
    let verifier = Arc::new(verifier(&fixture));
    seed(&verifier, &fixture, 200);
    let lease = verifier
        .begin_scheduled_refresh(300)
        .unwrap()
        .expect("periodic refresh lease");
    let driver = Rs256JwksRefreshDriver::new(
        issuer(),
        Arc::clone(&verifier),
        FixtureFetcher {
            body: jwks_body(&fixture).into_boxed_str(),
        },
        FixedClock(299),
    );

    assert_eq!(
        driver.refresh(lease).await,
        Err(Rs256JwksRefreshError::Lifecycle(
            Rs256JwksLifecycleError::ClockRegressed
        ))
    );
    assert_eq!(verifier.refresh_in_flight(), Ok(false));
    assert!(
        verifier
            .verify(valid_token(&fixture), wall_now(&fixture), 301)
            .is_ok()
    );
}

#[tokio::test]
async fn stale_lease_failure_is_not_reported_as_a_fetch_outcome() {
    let fixture = fixture();
    let verifier = Arc::new(verifier(&fixture));
    let lease = verifier
        .begin_scheduled_refresh(100)
        .unwrap()
        .expect("startup refresh lease");
    verifier.complete_failure(lease).unwrap();
    let driver = Rs256JwksRefreshDriver::new(
        issuer(),
        Arc::clone(&verifier),
        FailingFetcher,
        FixedClock(101),
    );

    assert_eq!(
        driver.refresh(lease).await,
        Err(Rs256JwksRefreshError::Lifecycle(
            Rs256JwksLifecycleError::StaleRefresh
        ))
    );
    assert_eq!(verifier.refresh_in_flight(), Ok(false));
}

#[tokio::test]
async fn cancelled_refresh_releases_the_exact_lease() {
    let fixture = fixture();
    let verifier = Arc::new(verifier(&fixture));
    let lease = verifier
        .begin_scheduled_refresh(100)
        .unwrap()
        .expect("startup refresh lease");
    let (started_tx, started_rx) = oneshot::channel();
    let driver = Rs256JwksRefreshDriver::new(
        issuer(),
        Arc::clone(&verifier),
        PendingFetcher {
            started: Mutex::new(Some(started_tx)),
        },
        FixedClock(101),
    );
    let task = tokio::spawn(async move { driver.refresh(lease).await });

    started_rx.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());

    assert_eq!(verifier.refresh_in_flight(), Ok(false));
    let next = verifier
        .begin_scheduled_refresh(101)
        .unwrap()
        .expect("replacement refresh lease");
    assert!(next.generation() > lease.generation());
    verifier.complete_failure(next).unwrap();
}

#[test]
fn unpolled_refresh_future_releases_the_exact_lease() {
    let fixture = fixture();
    let verifier = Arc::new(verifier(&fixture));
    let lease = verifier
        .begin_scheduled_refresh(100)
        .unwrap()
        .expect("startup refresh lease");
    let driver = Rs256JwksRefreshDriver::new(
        issuer(),
        Arc::clone(&verifier),
        FixtureFetcher {
            body: jwks_body(&fixture).into_boxed_str(),
        },
        FixedClock(101),
    );

    let refresh = driver.refresh(lease);
    drop(refresh);

    assert_eq!(verifier.refresh_in_flight(), Ok(false));
}

#[test]
fn refresh_driver_is_inert_bounded_and_value_free() {
    fn assert_fetcher<Fetcher: JwksSnapshotFetcher>() {}
    assert_fetcher::<JwksFetcher<SystemJwksDnsResolver>>();

    let fixture = fixture();
    let driver = Rs256JwksRefreshDriver::new(
        issuer(),
        Arc::new(verifier(&fixture)),
        JwksFetcher::with_system_resolver(JwksFetchPolicy::current_default(
            JwksResolvedAddressPolicy::public_internet(),
        )),
        SystemJwksMonotonicClock::new(),
    );
    assert_eq!(format!("{driver:?}"), "Rs256JwksRefreshDriver([REDACTED])");
    assert_eq!(
        Rs256JwksRefreshError::Fetch(JwksFetchError::Transport).to_string(),
        "platform_rs256_jwks_fetch_transport_failed"
    );

    assert!(REFRESH_SOURCE.contains("impl Drop for RefreshLeaseGuard"));
    assert!(REFRESH_SOURCE.contains("complete_failure(self.lease)"));
    for forbidden in [
        "tokio::spawn",
        "HashMap",
        "loop {",
        "std::env",
        "SystemTime",
        "static mut",
        "unsafe",
    ] {
        assert!(!REFRESH_SOURCE.contains(forbidden), "found {forbidden}");
    }
}

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("RS256 fixture")
}

fn verifier(fixture: &Value) -> Rs256CachedTokenVerifier {
    let policy = &fixture["policy"];
    Rs256CachedTokenVerifier::new(
        Rs256JwksCachePolicy::default(),
        policy["expected_issuer"].as_str().unwrap(),
        policy["expected_audience"].as_str().unwrap(),
        policy["current_policy_version"].as_u64().unwrap(),
        policy["current_revocation_epoch"].as_u64().unwrap(),
    )
    .expect("valid verifier")
}

fn issuer() -> ValidatedJwksIssuer {
    ValidatedJwksIssuer::parse(
        "http://localhost/tenant",
        JwksIssuerTransportPolicy::ExplicitLoopbackHttp,
    )
    .expect("valid fixture issuer")
}

fn jwks_body(fixture: &Value) -> String {
    serde_json::json!({ "keys": [fixture["public_jwk"].clone()] }).to_string()
}

fn seed(verifier: &Rs256CachedTokenVerifier, fixture: &Value, at_ms: u64) {
    let lease = verifier
        .begin_scheduled_refresh(at_ms)
        .unwrap()
        .expect("seed refresh lease");
    verifier
        .complete_success(
            lease,
            Rs256JwksSnapshot::parse_json(&jwks_body(fixture)).unwrap(),
            at_ms,
        )
        .unwrap();
}

fn valid_token(fixture: &Value) -> &str {
    fixture["tokens"]["valid"].as_str().unwrap()
}

fn wall_now(fixture: &Value) -> i64 {
    fixture["policy"]["wall_now_epoch_ms"].as_i64().unwrap()
}
