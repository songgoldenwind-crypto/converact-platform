use converact_contracts::{
    CanonicalJsonError, CanonicalKeyOrder, canonical_json, canonical_json_with_max_bytes,
    canonical_json_with_max_bytes_and_key_order, canonical_sha256, canonical_sha256_with_max_bytes,
    format_canonical_timestamp_ms, parse_canonical_timestamp_ms,
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
fn bounded_node_24_en_us_ascii_order_matches_the_frozen_audit_key_domain() {
    let input = serde_json::json!({
        "Z": 1,
        "a": 2,
        "A": 3,
        "_": 4,
        "-": 5,
        ".": 6,
        "a1": 7,
        "A1": 8,
        "aa": 9,
        "aA": 10,
    });
    assert_eq!(
        canonical_json_with_max_bytes_and_key_order(
            &input,
            1_024,
            CanonicalKeyOrder::Node24EnUsAscii,
        )
        .unwrap(),
        r#"{"_":4,"-":5,".":6,"a":2,"A":3,"a1":7,"A1":8,"aa":9,"aA":10,"Z":1}"#,
    );
    assert_eq!(
        canonical_json_with_max_bytes_and_key_order(
            &serde_json::json!({"非ASCII": true}),
            1_024,
            CanonicalKeyOrder::Node24EnUsAscii,
        ),
        Err(CanonicalJsonError::EncodingFailed),
    );
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

#[test]
fn canonical_timestamp_formatter_is_the_inverse_of_node_24_to_iso_string() {
    for (milliseconds, canonical) in [
        (0, "1970-01-01T00:00:00.000Z"),
        (-1, "1969-12-31T23:59:59.999Z"),
        (-62_167_219_200_000, "0000-01-01T00:00:00.000Z"),
        (-62_198_755_200_000, "-000001-01-01T00:00:00.000Z"),
        (253_402_300_800_000, "+010000-01-01T00:00:00.000Z"),
        (8_640_000_000_000_000, "+275760-09-13T00:00:00.000Z"),
        (-8_640_000_000_000_000, "-271821-04-20T00:00:00.000Z"),
    ] {
        assert_eq!(
            format_canonical_timestamp_ms(milliseconds).as_deref(),
            Some(canonical)
        );
        assert_eq!(parse_canonical_timestamp_ms(canonical), Some(milliseconds));
    }
    assert_eq!(format_canonical_timestamp_ms(8_640_000_000_000_001), None);
    assert_eq!(format_canonical_timestamp_ms(-8_640_000_000_000_001), None);
}
