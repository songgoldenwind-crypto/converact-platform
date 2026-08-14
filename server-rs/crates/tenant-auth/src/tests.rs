use serde_json::{Map, Value};

use super::*;

const FIXTURE: &str = include_str!("../../../tests/fixtures/platform-access-v1.json");

#[test]
fn rust_replays_every_frozen_typescript_access_decision() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("platform access fixture");
    assert_eq!(fixture["contract_version"], 1);
    assert_eq!(
        fixture["source"],
        "src/agent-runtime/converact/platform-foundation/identity.ts#evaluatePlatformAccess"
    );

    for vector in fixture["cases"].as_array().expect("access cases") {
        let mut claims = merged(&fixture["base_claims"], &vector["claims_overrides"]);
        if let Some(fields) = vector["claims_remove"].as_array() {
            for field in fields {
                claims.remove(field.as_str().expect("removed claims field"));
            }
        }
        let input = merged(&fixture["base_input"], &vector["input_overrides"]);
        let parsed = parse_policy_claims_json(
            &serde_json::to_string(&claims).expect("projected claims JSON"),
        );
        let actual = match parsed {
            Err(ClaimsProjectionError::Invalid) => deny(DenialReason::ClaimsInvalid),
            Ok(mut claims) => {
                if let Some(units) = vector["claims_utf16_overrides"]["identity_id"].as_array() {
                    claims.identity_id = JsText::from_utf16_units(
                        units
                            .iter()
                            .map(|unit| {
                                u16::try_from(unit.as_u64().expect("UTF-16 unit"))
                                    .expect("bounded UTF-16 unit")
                            })
                            .collect(),
                    );
                }
                evaluate_platform_access(&request(VerifiedPlatformIdentityClaims(claims), &input))
            }
        };
        assert_eq!(
            serde_json::to_value(actual).expect("decision"),
            vector["expected"],
            "{}",
            vector["name"]
        );
    }
}

#[test]
fn canonical_timestamp_parser_matches_javascript_date_boundaries() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("platform access fixture");
    assert_eq!(
        fixture["timestamp_source"],
        "src/agent-runtime/converact/platform-foundation/identity.ts#canonicalTimestamp"
    );
    for vector in fixture["timestamp_vectors"]
        .as_array()
        .expect("timestamp vectors")
    {
        let expected = vector["expected_epoch_ms"].as_i64();
        assert_eq!(
            parse_canonical_timestamp_ms(vector["input"].as_str().expect("timestamp input")),
            expected,
            "{}",
            vector["input"]
        );
    }
}

#[test]
fn projection_validation_is_non_authorizing_and_value_free_on_failure() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("platform access fixture");
    let document = serde_json::to_string(&fixture["base_claims"]).expect("base claims JSON");
    assert_eq!(validate_claims_projection_json(&document), Ok(()));

    let mut missing = fixture["base_claims"]
        .as_object()
        .expect("base claims object")
        .clone();
    missing.remove("identity_id");
    let error = validate_claims_projection_json(
        &serde_json::to_string(&missing).expect("invalid claims JSON"),
    )
    .unwrap_err();
    assert_eq!(error, ClaimsProjectionError::Invalid);
    assert_eq!(
        error.to_string(),
        "platform_identity_claims_projection_invalid"
    );

    let oversized_document = " ".repeat(MAX_CLAIMS_PROJECTION_BYTES + 1);
    assert_eq!(
        validate_claims_projection_json(&oversized_document),
        Err(ClaimsProjectionError::Invalid)
    );

    let mut oversized_text = fixture["base_claims"].clone();
    oversized_text["identity_id"] = Value::String("x".repeat(MAX_TEXT_UTF16_UNITS + 1));
    assert_eq!(
        validate_claims_projection_json(
            &serde_json::to_string(&oversized_text).expect("oversized claims JSON")
        ),
        Err(ClaimsProjectionError::Invalid)
    );

    let mut oversized_set = fixture["base_claims"].clone();
    oversized_set["audience"] = Value::Array(
        (0..=MAX_STRING_SET_ITEMS)
            .map(|index| Value::String(format!("audience-{index}")))
            .collect(),
    );
    assert_eq!(
        validate_claims_projection_json(
            &serde_json::to_string(&oversized_set).expect("oversized claims JSON")
        ),
        Err(ClaimsProjectionError::Invalid)
    );
}

#[test]
fn projection_number_parser_matches_javascript_safe_integer() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("platform access fixture");
    let template = serde_json::to_string(&fixture["base_claims"]).expect("base claims JSON");
    assert!(template.contains("\"policy_version\":12"));

    for vector in fixture["safe_integer_vectors"]
        .as_array()
        .expect("safe integer vectors")
    {
        let literal = vector["input"].as_str().expect("number literal");
        let document = template.replacen(
            "\"policy_version\":12",
            &format!("\"policy_version\":{literal}"),
            1,
        );
        let actual = parse_policy_claims_json(&document)
            .ok()
            .map(|claims| claims.policy_version.value());
        assert_eq!(actual, vector["expected"].as_u64(), "{literal}");
    }
}

#[test]
fn javascript_bounds_fail_closed_before_authorization() {
    let claims = base_verified_claims();
    for invalid_identity in [format!("{}x", "a".repeat(256)), "😀".repeat(129)] {
        let mut invalid = claims.0.clone();
        invalid.identity_id = invalid_identity.into();
        assert_eq!(
            evaluate_platform_access(&base_request(VerifiedPlatformIdentityClaims(invalid)))
                .reason(),
            Some(DenialReason::ClaimsInvalid)
        );
    }

    let mut padded = claims.0.clone();
    padded.identity_id = "\u{feff}user-a".into();
    assert_eq!(
        evaluate_platform_access(&base_request(VerifiedPlatformIdentityClaims(padded))).reason(),
        Some(DenialReason::ClaimsInvalid)
    );

    let mut oversized_set = claims.0.clone();
    oversized_set.capabilities = (0..65)
        .map(|index| JsText::from(format!("capability-{index}")))
        .collect();
    assert_eq!(
        evaluate_platform_access(&base_request(VerifiedPlatformIdentityClaims(oversized_set)))
            .reason(),
        Some(DenialReason::ClaimsInvalid)
    );

    let invalid_version = AccessRequest {
        claims,
        resource_tenant_id: "tenant-a".into(),
        required_audience: "converact-core".into(),
        required_capability: "recording.start".into(),
        required_purpose: "support_evidence".into(),
        current_policy_version: 9_007_199_254_740_992,
        current_revocation_epoch: 4,
        wall_now_epoch_ms: 1_775_217_600_000,
    };
    assert_eq!(
        evaluate_platform_access(&invalid_version).reason(),
        Some(DenialReason::ClaimsInvalid)
    );

    let invalid_clock = AccessRequest {
        claims: base_verified_claims(),
        resource_tenant_id: "tenant-a".into(),
        required_audience: "converact-core".into(),
        required_capability: "recording.start".into(),
        required_purpose: "support_evidence".into(),
        current_policy_version: 12,
        current_revocation_epoch: 4,
        wall_now_epoch_ms: 8_640_000_000_000_001,
    };
    assert_eq!(
        evaluate_platform_access(&invalid_clock).reason(),
        Some(DenialReason::ClaimsInvalid)
    );
}

fn merged(base: &Value, overrides: &Value) -> Map<String, Value> {
    let mut merged = base.as_object().expect("base object").clone();
    for (key, value) in overrides.as_object().expect("overrides object") {
        merged.insert(key.clone(), value.clone());
    }
    merged
}

fn text(input: &Map<String, Value>, key: &str) -> String {
    input[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key}"))
        .into()
}

fn request(claims: VerifiedPlatformIdentityClaims, input: &Map<String, Value>) -> AccessRequest {
    AccessRequest {
        claims,
        resource_tenant_id: text(input, "resource_tenant_id").into(),
        required_audience: text(input, "required_audience").into(),
        required_capability: text(input, "required_capability").into(),
        required_purpose: text(input, "required_purpose").into(),
        current_policy_version: input["current_policy_version"]
            .as_u64()
            .expect("policy version"),
        current_revocation_epoch: input["current_revocation_epoch"]
            .as_u64()
            .expect("revocation epoch"),
        wall_now_epoch_ms: parse_canonical_timestamp_ms(
            input["wall_now"].as_str().expect("wall clock timestamp"),
        )
        .expect("canonical wall clock"),
    }
}

fn base_verified_claims() -> VerifiedPlatformIdentityClaims {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("platform access fixture");
    let projection = parse_policy_claims_json(
        &serde_json::to_string(&fixture["base_claims"]).expect("base claims JSON"),
    )
    .expect("base claims projection");
    VerifiedPlatformIdentityClaims(projection)
}

fn base_request(claims: VerifiedPlatformIdentityClaims) -> AccessRequest {
    AccessRequest {
        claims,
        resource_tenant_id: "tenant-a".into(),
        required_audience: "converact-core".into(),
        required_capability: "recording.start".into(),
        required_purpose: "support_evidence".into(),
        current_policy_version: 12,
        current_revocation_epoch: 4,
        wall_now_epoch_ms: 1_775_217_600_000,
    }
}
