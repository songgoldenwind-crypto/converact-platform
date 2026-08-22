use converact_tenant_auth::{Rs256JwksError, Rs256JwksSnapshot};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../tests/fixtures/platform-jwks-v1.json");
const JWKS_SOURCE: &str = include_str!("../src/jwks.rs");

#[test]
fn rust_jwks_snapshot_replays_the_bounded_target_contract() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("JWKS fixture");
    let mut target_divergences = Vec::new();
    for vector in fixture["cases"].as_array().expect("cases") {
        if vector["target_expected"].as_str().is_some() {
            target_divergences.push(vector["name"].as_str().unwrap());
        }
        let document = serde_json::to_string(&document_for(&fixture, vector)).unwrap();
        let snapshot = Rs256JwksSnapshot::parse_json(&document);
        let target_expected = vector["target_expected"]
            .as_str()
            .unwrap_or_else(|| vector["expected"].as_str().unwrap());
        assert_eq!(
            snapshot.is_ok(),
            target_expected == "allowed",
            "{}",
            vector["name"]
        );
        if let Ok(snapshot) = snapshot {
            assert_eq!(snapshot.len(), 1);
            assert!(!snapshot.is_empty());
            assert!(snapshot.contains_key("identity-rs256-v7"));
            assert!(!snapshot.contains_key("missing-key"));
            let components = snapshot.key_components("identity-rs256-v7").unwrap();
            assert_eq!(components.modulus().len(), 256);
            assert_eq!(components.exponent(), 65_537);
            assert_eq!(
                format!("{components:?}"),
                "Rs256PublicKeyComponents([REDACTED])"
            );
            assert_eq!(format!("{snapshot:?}"), "Rs256JwksSnapshot(keys=1)");
        }
    }
    assert_eq!(
        target_divergences,
        [
            "encryption_key_operation",
            "weak_2041_bit_modulus",
            "noncanonical_modulus_encoding",
            "zero_exponent",
            "even_modulus",
            "even_exponent",
            "oversized_exponent"
        ]
    );
}

#[test]
fn jwks_snapshot_bounds_document_and_lookup_without_runtime_io() {
    assert_eq!(
        Rs256JwksSnapshot::parse_json(&" ".repeat(131_073)),
        Err(Rs256JwksError)
    );
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let document = serde_json::to_string(&serde_json::json!({
        "keys": [fixture["base_key"].clone()]
    }))
    .unwrap();
    let snapshot = Rs256JwksSnapshot::parse_json(&document).unwrap();
    assert!(!snapshot.contains_key(""));
    assert!(!snapshot.contains_key(&"x".repeat(257)));

    for forbidden in [
        "std::env",
        "SystemTime",
        "tokio",
        "reqwest",
        "TcpStream",
        "File::open",
        "unsafe",
    ] {
        assert!(!JWKS_SOURCE.contains(forbidden), "found {forbidden}");
    }
}

fn document_for(fixture: &Value, vector: &Value) -> Value {
    match vector["recipe"].as_str() {
        Some("invalid_root") => return Value::Array(Vec::new()),
        Some("missing_keys") => return serde_json::json!({}),
        Some("empty_keys") => return serde_json::json!({ "keys": [] }),
        _ => {}
    }
    let mut key = fixture["base_key"].as_object().unwrap().clone();
    if let Some(overrides) = vector["key_overrides"].as_object() {
        key.extend(overrides.clone());
    }
    if let Some(fields) = vector["key_remove"].as_array() {
        for field in fields {
            key.remove(field.as_str().unwrap());
        }
    }
    match vector["recipe"].as_str() {
        Some("duplicate_key") => serde_json::json!({ "keys": [key.clone(), key] }),
        Some("too_many_keys") => {
            let keys = (0..65)
                .map(|index| {
                    let mut item = key.clone();
                    item.insert(
                        "kid".to_owned(),
                        Value::String(format!("identity-rs256-{index}")),
                    );
                    Value::Object(item)
                })
                .collect::<Vec<_>>();
            serde_json::json!({ "keys": keys })
        }
        None => serde_json::json!({ "keys": [key] }),
        Some(recipe) => panic!("unknown recipe: {recipe}"),
    }
}
