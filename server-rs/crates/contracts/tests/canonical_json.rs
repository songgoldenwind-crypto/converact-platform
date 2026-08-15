use converact_contracts::{
    CanonicalJsonError, canonical_json, canonical_json_with_max_bytes, canonical_sha256,
    canonical_sha256_with_max_bytes,
};
#[test]
fn canonical_json_and_sha256_replay_the_active_typescript_contract_fixture() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/canonical-json-v1.json"
    ))
    .expect("canonical fixture");

    for vector in fixture["vectors"].as_array().expect("fixture vectors") {
        let name = vector["name"].as_str().expect("vector name");
        let input = &vector["input"];
        assert_eq!(
            canonical_json(input).expect("canonical JSON"),
            vector["canonical"].as_str().expect("canonical bytes"),
            "{name}",
        );
        assert_eq!(
            canonical_sha256(input).expect("canonical SHA-256"),
            vector["sha256"].as_str().expect("canonical SHA-256"),
            "{name}",
        );
    }
}

#[test]
fn canonical_json_is_independent_of_object_insertion_order() {
    let left: serde_json::Value = serde_json::from_str(r#"{"z":2,"a":1}"#).unwrap();
    let right: serde_json::Value = serde_json::from_str(r#"{"a":1,"z":2}"#).unwrap();

    assert_eq!(canonical_json(&left), canonical_json(&right));
    assert_eq!(canonical_sha256(&left), canonical_sha256(&right));
}

#[test]
fn canonical_json_rejects_values_before_unbounded_encoding_or_sorting() {
    let oversized_string = serde_json::Value::String("x".repeat(65_537));
    assert!(canonical_json(&oversized_string).is_err());

    let oversized_object = (0..8_193)
        .map(|index| (format!("key-{index:05}"), serde_json::Value::Null))
        .collect();
    assert!(canonical_json(&serde_json::Value::Object(oversized_object)).is_err());

    let aggregate_oversized_keys = (0..2_048)
        .map(|index| {
            (
                format!("key-{index:05}-{}", "k".repeat(24)),
                serde_json::Value::Null,
            )
        })
        .collect();
    assert!(canonical_json(&serde_json::Value::Object(aggregate_oversized_keys)).is_err());
}

#[test]
fn explicit_budget_is_bounded_and_supports_the_frozen_escaped_string_case() {
    let escaped = serde_json::Value::String("\u{0001}".repeat(65_536));
    let maximum = 65_536 * 6 + 2;
    let encoded = canonical_json_with_max_bytes(&escaped, maximum).expect("escaped payload");
    assert_eq!(encoded.len(), maximum);
    assert_eq!(
        canonical_sha256_with_max_bytes(&escaped, maximum)
            .unwrap()
            .len(),
        64
    );
    assert_eq!(
        canonical_json_with_max_bytes(&escaped, 65_536),
        Err(CanonicalJsonError::BoundsExceeded)
    );
    assert_eq!(
        canonical_json_with_max_bytes(&serde_json::Value::Null, 0),
        Err(CanonicalJsonError::BoundsExceeded)
    );
    assert_eq!(
        canonical_json_with_max_bytes(&serde_json::Value::Null, maximum + 1),
        Err(CanonicalJsonError::BoundsExceeded)
    );
}
