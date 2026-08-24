use std::{
    sync::{Arc, Barrier},
    thread,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use converact_tenant_auth::{
    PlatformTokenVerificationError, Rs256CachedTokenVerificationError, Rs256CachedTokenVerifier,
    Rs256JwksCachePolicy, Rs256JwksLifecycleError, Rs256JwksSnapshot, Rs256JwksUnavailableReason,
};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../tests/fixtures/platform-rs256-v1.json");
const FACADE_SOURCE: &str = include_str!("../src/jwks_verifier.rs");

#[test]
fn malformed_tokens_are_rejected_before_cache_refresh() {
    let fixture = fixture();
    let verifier = verifier(&fixture, Rs256JwksCachePolicy::default());

    let malformed = verifier.verify("not-a-compact-token", wall_now(&fixture), 100);
    assert_eq!(
        malformed.unwrap_err().rejection(),
        Some(PlatformTokenVerificationError::EncodingInvalid)
    );
    assert_eq!(verifier.refresh_in_flight(), Ok(false));

    let wrong_algorithm = verifier.verify(
        &token_for_case(&fixture, "wrong_algorithm"),
        wall_now(&fixture),
        100,
    );
    assert_eq!(
        wrong_algorithm.unwrap_err().rejection(),
        Some(PlatformTokenVerificationError::HeaderInvalid)
    );
    assert_eq!(verifier.refresh_in_flight(), Ok(false));

    let oversized_key = token_with_key_id(&fixture, &"k".repeat(257));
    let invalid_key = verifier.verify(&oversized_key, wall_now(&fixture), 100);
    assert_eq!(
        invalid_key.unwrap_err().rejection(),
        Some(PlatformTokenVerificationError::HeaderInvalid)
    );
    assert_eq!(verifier.refresh_in_flight(), Ok(false));
}

#[test]
fn unwarmed_cache_denies_and_issues_exactly_one_refresh_lease() {
    let fixture = fixture();
    let verifier = verifier(&fixture, Rs256JwksCachePolicy::default());
    let token = valid_token(&fixture);

    let first = verifier.verify(token, wall_now(&fixture), 100).unwrap_err();
    assert_eq!(
        first.unavailable_reason(),
        Some(Rs256JwksUnavailableReason::Unwarmed)
    );
    let lease = first.refresh_lease().expect("sole refresh lease");

    let second = verifier.verify(token, wall_now(&fixture), 100).unwrap_err();
    assert_eq!(
        second.unavailable_reason(),
        Some(Rs256JwksUnavailableReason::Unwarmed)
    );
    assert!(second.refresh_lease().is_none());
    verifier.complete_failure(lease).unwrap();
}

#[test]
fn a_fresh_snapshot_authenticates_and_bad_signatures_do_not_refresh() {
    let fixture = fixture();
    let verifier = verifier(&fixture, Rs256JwksCachePolicy::default());
    seed(&verifier, snapshot(&fixture), 100);

    let identity = verifier
        .verify(valid_token(&fixture), wall_now(&fixture), 101)
        .expect("valid identity");
    assert_eq!(identity.tenant_id(), "tenant-rs");
    assert_eq!(identity.identity_id(), "user-rs");

    let invalid = verifier
        .verify(
            &token_for_case(&fixture, "invalid_signature"),
            wall_now(&fixture),
            101,
        )
        .unwrap_err();
    assert_eq!(
        invalid.rejection(),
        Some(PlatformTokenVerificationError::SignatureInvalid)
    );
    assert!(invalid.refresh_lease().is_none());
    assert_eq!(verifier.refresh_in_flight(), Ok(false));
}

#[test]
fn an_unknown_key_denies_and_uses_the_shared_single_flight_gate() {
    let fixture = fixture();
    let verifier = verifier(&fixture, Rs256JwksCachePolicy::default());
    seed(&verifier, snapshot(&fixture), 100);
    let unknown_key = token_for_case(&fixture, "unknown_key_id");

    let first = verifier
        .verify(&unknown_key, wall_now(&fixture), 101)
        .unwrap_err();
    assert_eq!(
        first.unavailable_reason(),
        Some(Rs256JwksUnavailableReason::KeyUnknown)
    );
    assert!(first.refresh_lease().is_some());
    assert!(verifier.readiness(101).is_ready());

    let second = verifier
        .verify(&unknown_key, wall_now(&fixture), 101)
        .unwrap_err();
    assert_eq!(
        second.unavailable_reason(),
        Some(Rs256JwksUnavailableReason::KeyUnknown)
    );
    assert!(second.refresh_lease().is_none());
    verifier
        .complete_failure(first.refresh_lease().unwrap())
        .unwrap();
}

#[test]
fn last_known_good_remains_usable_during_and_after_failed_refresh() {
    let fixture = fixture();
    let policy = Rs256JwksCachePolicy::new(100, 10).unwrap();
    let verifier = verifier(&fixture, policy);
    assert!(!verifier.readiness(99).is_ready());

    seed(&verifier, snapshot(&fixture), 100);
    assert!(verifier.readiness(199).is_ready());
    let lease = verifier
        .begin_scheduled_refresh(199)
        .unwrap()
        .expect("scheduled refresh");
    assert!(verifier.readiness(199).is_ready());
    assert!(
        verifier
            .verify(valid_token(&fixture), wall_now(&fixture), 199)
            .is_ok()
    );

    verifier.complete_failure(lease).unwrap();
    assert!(verifier.readiness(199).is_ready());
    let expired = verifier.readiness(200);
    assert!(!expired.is_ready());
    assert_eq!(
        expired.unavailable_reason(),
        Some(Rs256JwksUnavailableReason::Expired)
    );
}

#[test]
fn concurrent_unknown_key_requests_issue_one_refresh_lease() {
    let fixture = fixture();
    let verifier = Arc::new(verifier(&fixture, Rs256JwksCachePolicy::default()));
    seed(&verifier, snapshot(&fixture), 100);
    let token = Arc::<str>::from(token_for_case(&fixture, "unknown_key_id"));
    let barrier = Arc::new(Barrier::new(16));

    let workers = (0..16)
        .map(|_| {
            let verifier = Arc::clone(&verifier);
            let token = Arc::clone(&token);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                verifier.verify(&token, 1_775_217_600_000, 101).unwrap_err()
            })
        })
        .collect::<Vec<_>>();

    let errors = workers
        .into_iter()
        .map(|worker| worker.join().expect("worker"))
        .collect::<Vec<_>>();
    assert!(errors.iter().all(|error| {
        error.unavailable_reason() == Some(Rs256JwksUnavailableReason::KeyUnknown)
    }));
    assert_eq!(
        errors
            .iter()
            .filter(|error| error.refresh_lease().is_some())
            .count(),
        1
    );
    verifier
        .complete_failure(
            errors
                .iter()
                .find_map(Rs256CachedTokenVerificationError::refresh_lease)
                .unwrap(),
        )
        .unwrap();
}

#[test]
fn concurrent_known_key_verification_succeeds_during_refresh() {
    let fixture = fixture();
    let verifier = Arc::new(verifier(&fixture, Rs256JwksCachePolicy::default()));
    seed(&verifier, snapshot(&fixture), 100);
    let refresh = verifier
        .begin_scheduled_refresh(101)
        .unwrap()
        .expect("refresh");
    let token = Arc::<str>::from(valid_token(&fixture));
    let barrier = Arc::new(Barrier::new(16));

    let workers = (0..16)
        .map(|_| {
            let verifier = Arc::clone(&verifier);
            let token = Arc::clone(&token);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                verifier.verify(&token, 1_775_217_600_000, 101)
            })
        })
        .collect::<Vec<_>>();

    for worker in workers {
        assert!(worker.join().expect("worker").is_ok());
    }
    verifier.complete_failure(refresh).unwrap();
}

#[test]
fn monotonic_regression_fails_closed_clears_exact_completion_and_recovers() {
    let fixture = fixture();
    let verifier = verifier(&fixture, Rs256JwksCachePolicy::default());
    seed(&verifier, snapshot(&fixture), 100);
    assert!(
        verifier
            .verify(valid_token(&fixture), wall_now(&fixture), 200)
            .is_ok()
    );

    let regressed = verifier.readiness(199);
    assert_eq!(
        regressed.unavailable_reason(),
        Some(Rs256JwksUnavailableReason::ClockRegressed)
    );
    assert!(verifier.readiness(201).is_ready());

    let lease = verifier
        .begin_scheduled_refresh(300)
        .unwrap()
        .expect("refresh");
    assert_eq!(
        verifier.complete_success(lease, snapshot(&fixture), 299),
        Err(Rs256JwksLifecycleError::ClockRegressed)
    );
    assert_eq!(verifier.refresh_in_flight(), Ok(false));
    assert_eq!(
        verifier.complete_failure(lease),
        Err(Rs256JwksLifecycleError::StaleRefresh)
    );
    assert!(
        verifier
            .verify(valid_token(&fixture), wall_now(&fixture), 301)
            .is_ok()
    );
}

#[test]
fn facade_is_bounded_inert_and_value_free() {
    let fixture = fixture();
    let verifier = verifier(&fixture, Rs256JwksCachePolicy::default());
    assert_eq!(
        format!("{verifier:?}"),
        "Rs256CachedTokenVerifier([REDACTED])"
    );
    let error = verifier
        .verify(valid_token(&fixture), wall_now(&fixture), 100)
        .unwrap_err();
    assert_eq!(
        format!("{error:?}"),
        "Rs256CachedTokenVerificationError::Unavailable { reason: Unwarmed, refresh_started: true }"
    );
    assert!(!format!("{error:?}").contains(fixture["public_jwk"]["n"].as_str().unwrap()));

    assert!(FACADE_SOURCE.contains("RwLock<Rs256JwksCache>"));
    assert!(FACADE_SOURCE.contains("Arc<Rs256JwksSnapshot>"));
    assert!(FACADE_SOURCE.contains("verify_prepared_rs256(&snapshot"));
    for forbidden in [
        "tokio",
        "reqwest",
        "HashMap",
        "thread::spawn",
        "std::env",
        "SystemTime",
        "Instant::now",
        "static mut",
        "unsafe",
    ] {
        assert!(!FACADE_SOURCE.contains(forbidden), "found {forbidden}");
    }
}

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("RS256 fixture")
}

fn verifier(fixture: &Value, cache_policy: Rs256JwksCachePolicy) -> Rs256CachedTokenVerifier {
    let policy = &fixture["policy"];
    Rs256CachedTokenVerifier::new(
        cache_policy,
        policy["expected_issuer"].as_str().unwrap(),
        policy["expected_audience"].as_str().unwrap(),
        policy["current_policy_version"].as_u64().unwrap(),
        policy["current_revocation_epoch"].as_u64().unwrap(),
    )
    .expect("valid verifier")
}

fn seed(verifier: &Rs256CachedTokenVerifier, keys: Rs256JwksSnapshot, at_ms: u64) {
    let lease = verifier
        .begin_scheduled_refresh(at_ms)
        .unwrap()
        .expect("seed refresh");
    verifier.complete_success(lease, keys, at_ms).unwrap();
}

fn snapshot(fixture: &Value) -> Rs256JwksSnapshot {
    Rs256JwksSnapshot::parse_json(
        &serde_json::json!({ "keys": [fixture["public_jwk"].clone()] }).to_string(),
    )
    .expect("bounded JWKS")
}

fn valid_token(fixture: &Value) -> &str {
    fixture["tokens"]["valid"].as_str().unwrap()
}

fn wall_now(fixture: &Value) -> i64 {
    fixture["policy"]["wall_now_epoch_ms"].as_i64().unwrap()
}

fn token_for_case(fixture: &Value, name: &str) -> String {
    let vector = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|vector| vector["name"] == name)
        .unwrap();
    let valid = valid_token(fixture);
    let parts = valid.split('.').collect::<Vec<_>>();
    match vector["recipe"].as_str() {
        Some("header_override") => {
            let bytes = URL_SAFE_NO_PAD.decode(parts[0]).unwrap();
            let mut header: serde_json::Map<String, Value> =
                serde_json::from_slice(&bytes).unwrap();
            header.extend(vector["header_overrides"].as_object().unwrap().clone());
            format!(
                "{}.{}.{}",
                URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap()),
                parts[1],
                parts[2]
            )
        }
        Some("invalid_signature") => {
            let replacement = if parts[2].starts_with('A') { 'B' } else { 'A' };
            format!("{}.{}.{replacement}{}", parts[0], parts[1], &parts[2][1..])
        }
        Some(recipe) => panic!("unsupported test recipe: {recipe}"),
        None => fixture["tokens"][vector["token_ref"].as_str().unwrap()]
            .as_str()
            .unwrap()
            .to_owned(),
    }
}

fn token_with_key_id(fixture: &Value, key_id: &str) -> String {
    let valid = valid_token(fixture);
    let parts = valid.split('.').collect::<Vec<_>>();
    let bytes = URL_SAFE_NO_PAD.decode(parts[0]).unwrap();
    let mut header: serde_json::Map<String, Value> = serde_json::from_slice(&bytes).unwrap();
    header.insert("kid".to_owned(), Value::String(key_id.to_owned()));
    format!(
        "{}.{}.{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap()),
        parts[1],
        parts[2]
    )
}
