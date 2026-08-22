use converact_tenant_auth::{
    Rs256JwksCache, Rs256JwksCachePolicy, Rs256JwksLifecycleError, Rs256JwksResolution,
    Rs256JwksSnapshot, Rs256JwksUnavailableReason,
};
use serde_json::Value;

const CACHE_FIXTURE: &str = include_str!("../../../tests/fixtures/platform-jwks-cache-v1.json");
const RS256_FIXTURE: &str = include_str!("../../../tests/fixtures/platform-rs256-v1.json");
const CACHE_SOURCE: &str = include_str!("../src/jwks_cache.rs");

#[test]
fn rust_jwks_cache_replays_the_target_lifecycle_contract() {
    let fixture: Value = serde_json::from_str(CACHE_FIXTURE).expect("cache fixture");
    let rs256_fixture: Value = serde_json::from_str(RS256_FIXTURE).expect("RS256 fixture");
    let policy = Rs256JwksCachePolicy::new(
        fixture["policy"]["fresh_for_ms"].as_u64().unwrap(),
        fixture["policy"]["on_demand_refresh_floor_ms"]
            .as_u64()
            .unwrap(),
    )
    .unwrap();
    let mut target_divergences = Vec::new();

    for sequence in fixture["sequences"].as_array().unwrap() {
        let seed_at = sequence["seed_at_ms"].as_u64().unwrap();
        let mut cache = Rs256JwksCache::new(policy);
        seed(&mut cache, snapshot(&rs256_fixture, None), seed_at);
        let mut pending = None;

        for step in sequence["steps"].as_array().unwrap() {
            if step["target_expected"].is_object() {
                target_divergences.push(step["name"].as_str().unwrap());
            }
            let key_id = match step["key"].as_str().unwrap() {
                "known" => fixture["known_key_id"].as_str().unwrap(),
                "unknown" => fixture["unknown_key_id"].as_str().unwrap(),
                other => panic!("unknown key selector: {other}"),
            };
            let resolution = cache.resolve(key_id, step["at_ms"].as_u64().unwrap());
            let expected = step
                .get("target_expected")
                .filter(|value| value.is_object())
                .unwrap_or(&step["expected"]);
            assert_eq!(
                availability(&resolution),
                expected["availability"].as_str().unwrap(),
                "{}/{}",
                sequence["name"],
                step["name"]
            );
            assert_eq!(
                resolution.refresh_lease().is_some(),
                expected["refresh_started"].as_bool().unwrap(),
                "{}/{} refresh",
                sequence["name"],
                step["name"]
            );
            if let Some(lease) = resolution.refresh_lease() {
                if sequence["fetch_mode"] == "reject" {
                    cache.complete_failure(lease).unwrap();
                } else {
                    pending = Some(lease);
                }
            }
        }
        if let Some(lease) = pending {
            cache.complete_failure(lease).unwrap();
        }
    }
    assert_eq!(target_divergences, ["clock_regression_fails_closed"]);
}

#[test]
fn refresh_completion_is_single_flight_fenced_and_atomically_replaces_keys() {
    let fixture: Value = serde_json::from_str(RS256_FIXTURE).unwrap();
    let mut cache = Rs256JwksCache::new(Rs256JwksCachePolicy::default());
    seed(&mut cache, snapshot(&fixture, Some("key-v1")), 1_000);

    let first_refresh = cache.begin_scheduled_refresh(2_000).unwrap().unwrap();
    assert!(cache.begin_scheduled_refresh(2_000).unwrap().is_none());
    assert!(cache.resolve("key-v1", 2_000).is_ready());
    cache.complete_failure(first_refresh).unwrap();
    assert!(cache.resolve("key-v1", 2_001).is_ready());

    let second_refresh = cache.begin_scheduled_refresh(3_000).unwrap().unwrap();
    assert_eq!(
        cache.complete_success(first_refresh, snapshot(&fixture, Some("stale-key")), 3_000),
        Err(Rs256JwksLifecycleError::StaleRefresh)
    );
    assert!(cache.resolve("key-v1", 3_000).is_ready());
    cache
        .complete_success(second_refresh, snapshot(&fixture, Some("key-v2")), 3_000)
        .unwrap();
    assert!(cache.resolve("key-v2", 3_000).is_ready());
    assert_eq!(
        cache.resolve("key-v1", 3_000).unavailable_reason(),
        Some(Rs256JwksUnavailableReason::KeyUnknown)
    );
}

#[test]
fn regressed_completion_fails_closed_without_sticking_or_destroying_last_known_good() {
    let fixture: Value = serde_json::from_str(RS256_FIXTURE).unwrap();
    let mut cache = Rs256JwksCache::new(Rs256JwksCachePolicy::default());
    seed(&mut cache, snapshot(&fixture, None), 1_000);
    let lease = cache.begin_scheduled_refresh(2_000).unwrap().unwrap();
    assert_eq!(
        cache.complete_success(lease, snapshot(&fixture, Some("new-key")), 1_999),
        Err(Rs256JwksLifecycleError::ClockRegressed)
    );
    assert!(!cache.refresh_in_flight());
    assert!(cache.resolve("external-rs256-v7", 2_001).is_ready());
}

#[test]
fn cache_policy_state_and_source_are_bounded_and_value_free() {
    assert!(Rs256JwksCachePolicy::new(0, 1).is_err());
    assert!(Rs256JwksCachePolicy::new(86_400_001, 1).is_err());
    assert!(Rs256JwksCachePolicy::new(1_000, 0).is_err());
    assert!(Rs256JwksCachePolicy::new(1_000, 1_001).is_err());
    let policy = Rs256JwksCachePolicy::default();
    assert_eq!(policy.fresh_for_ms(), 300_000);
    assert_eq!(policy.on_demand_refresh_floor_ms(), 5_000);

    let mut cache = Rs256JwksCache::new(policy);
    assert_eq!(
        format!("{cache:?}"),
        "Rs256JwksCache(warmed=false, refresh_in_flight=false)"
    );
    let unwarmed = cache.resolve("untrusted-key", 0);
    assert_eq!(
        unwarmed.unavailable_reason(),
        Some(Rs256JwksUnavailableReason::Unwarmed)
    );
    assert!(unwarmed.refresh_lease().is_some());
    assert_eq!(
        format!("{unwarmed:?}"),
        "Rs256JwksResolution::Unavailable { reason: Unwarmed, refresh_started: true }"
    );
    cache
        .complete_failure(unwarmed.refresh_lease().unwrap())
        .unwrap();
    for forbidden in [
        "std::env",
        "SystemTime",
        "Instant::now",
        "tokio",
        "reqwest",
        "TcpStream",
        "File::open",
        "static mut",
        "unsafe",
    ] {
        assert!(!CACHE_SOURCE.contains(forbidden), "found {forbidden}");
    }
}

fn seed(cache: &mut Rs256JwksCache, keys: Rs256JwksSnapshot, at_ms: u64) {
    let lease = cache.begin_scheduled_refresh(at_ms).unwrap().unwrap();
    cache.complete_success(lease, keys, at_ms).unwrap();
}

fn snapshot(fixture: &Value, key_id: Option<&str>) -> Rs256JwksSnapshot {
    let mut key = fixture["public_jwk"].as_object().unwrap().clone();
    if let Some(key_id) = key_id {
        key.insert("kid".to_owned(), Value::String(key_id.to_owned()));
    }
    Rs256JwksSnapshot::parse_json(&serde_json::json!({ "keys": [key] }).to_string()).unwrap()
}

fn availability(resolution: &Rs256JwksResolution) -> &'static str {
    if resolution.is_ready() {
        "ready"
    } else if resolution.unavailable_reason() == Some(Rs256JwksUnavailableReason::ClockRegressed) {
        "clock_regressed"
    } else {
        "unavailable"
    }
}
