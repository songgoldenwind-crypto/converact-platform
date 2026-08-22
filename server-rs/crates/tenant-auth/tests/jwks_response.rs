use converact_tenant_auth::{Rs256JwksResponseCollector, Rs256JwksResponseError};
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../tests/fixtures/platform-jwks-response-v1.json");
const KEY_FIXTURE: &str = include_str!("../../../tests/fixtures/platform-rs256-v1.json");
const RESPONSE_SOURCE: &str = include_str!("../src/jwks_response.rs");

#[derive(Deserialize)]
struct Fixture {
    contract_version: u64,
    max_response_bytes: usize,
    cases: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    status: u16,
    content_type: Option<String>,
    content_length: Option<String>,
    body: String,
    expected: String,
    target_expected: Option<String>,
}

#[test]
fn rust_response_boundary_replays_the_bounded_target_contract() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("valid response fixture");
    assert_eq!(fixture.contract_version, 1);
    assert_eq!(fixture.max_response_bytes, 131_072);
    let public_key = serde_json::from_str::<Value>(KEY_FIXTURE).unwrap()["public_jwk"].clone();
    let mut divergences = Vec::new();

    for vector in fixture.cases {
        let body = response_body(&vector.body, fixture.max_response_bytes, &public_key);
        let declared_length = vector.content_length.as_deref().map(|value| {
            if value == "actual" {
                body.len().to_string()
            } else {
                value.to_owned()
            }
        });
        let result = Rs256JwksResponseCollector::start(
            vector.status,
            vector.content_type.as_deref(),
            declared_length.as_deref(),
        )
        .and_then(|mut response| {
            for chunk in body.chunks(8_191) {
                response.push_chunk(chunk)?;
            }
            response.finish()
        });
        let target_expected = vector
            .target_expected
            .as_deref()
            .unwrap_or(vector.expected.as_str());
        assert_eq!(
            result.is_ok(),
            target_expected == "allowed",
            "{}",
            vector.name
        );
        if let Ok(snapshot) = result {
            assert_eq!(snapshot.len(), 1, "{}", vector.name);
        }
        if vector.target_expected.is_some() {
            divergences.push(vector.name);
        }
    }

    assert_eq!(
        divergences,
        [
            "missing_content_type_is_rejected",
            "text_plain_is_rejected",
            "non_200_success_is_rejected",
            "declared_length_mismatch_is_rejected",
        ]
    );
}

#[test]
fn response_head_body_and_media_type_fail_closed_with_stable_reasons() {
    assert!(matches!(
        Rs256JwksResponseCollector::start(503, Some("application/json"), None),
        Err(Rs256JwksResponseError::StatusRejected)
    ));
    assert!(matches!(
        Rs256JwksResponseCollector::start(200, None, None),
        Err(Rs256JwksResponseError::ContentTypeRejected)
    ));
    assert!(matches!(
        Rs256JwksResponseCollector::start(200, Some("text/plain"), None),
        Err(Rs256JwksResponseError::ContentTypeRejected)
    ));
    assert!(
        Rs256JwksResponseCollector::start(200, Some("APPLICATION/JSON; CHARSET=\"utf-8\""), None,)
            .is_ok()
    );
    assert!(matches!(
        Rs256JwksResponseCollector::start(200, Some("application/json; boundary=value"), None,),
        Err(Rs256JwksResponseError::ContentTypeRejected)
    ));
    assert!(matches!(
        Rs256JwksResponseCollector::start(200, Some("application/json"), Some("01")),
        Err(Rs256JwksResponseError::ContentLengthInvalid)
    ));
    assert!(matches!(
        Rs256JwksResponseCollector::start(200, Some("application/json"), Some("131073")),
        Err(Rs256JwksResponseError::BodyTooLarge)
    ));

    let mut shorter =
        Rs256JwksResponseCollector::start(200, Some("application/json"), Some("2")).unwrap();
    shorter.push_chunk(b"{").unwrap();
    assert!(matches!(
        shorter.finish(),
        Err(Rs256JwksResponseError::ContentLengthMismatch)
    ));

    let mut longer =
        Rs256JwksResponseCollector::start(200, Some("application/json"), Some("1")).unwrap();
    assert_eq!(
        longer.push_chunk(b"{}"),
        Err(Rs256JwksResponseError::ContentLengthMismatch)
    );

    let mut invalid =
        Rs256JwksResponseCollector::start(200, Some("application/json"), None).unwrap();
    invalid.push_chunk(b"{").unwrap();
    assert!(matches!(
        invalid.finish(),
        Err(Rs256JwksResponseError::BodyInvalid)
    ));

    assert_eq!(
        Rs256JwksResponseError::BodyTooLarge.to_string(),
        "platform_rs256_jwks_response_body_too_large"
    );
}

#[test]
fn response_collector_is_bounded_redacted_and_has_no_runtime_authority() {
    let mut response =
        Rs256JwksResponseCollector::start(200, Some("application/json"), None).unwrap();
    response.push_chunk(br#"{"private":"value"}"#).unwrap();
    assert_eq!(
        format!("{response:?}"),
        "Rs256JwksResponseCollector(bytes=19, declared=false)"
    );
    assert_eq!(
        response.push_chunk(&vec![0; 131_072]),
        Err(Rs256JwksResponseError::BodyTooLarge)
    );

    for forbidden in [
        "std::env",
        "SystemTime",
        "Instant",
        "tokio::",
        "reqwest",
        "TcpStream",
        "UdpSocket",
        "std::fs",
        "unsafe",
    ] {
        assert!(
            !RESPONSE_SOURCE.contains(forbidden),
            "response boundary must not contain {forbidden}"
        );
    }
}

fn response_body(kind: &str, limit: usize, public_key: &Value) -> Vec<u8> {
    let valid = serde_json::json!({ "keys": [public_key] }).to_string();
    match kind {
        "valid_jwks" => valid.into_bytes(),
        "valid_jwks_exact_limit" => {
            let seed = serde_json::json!({ "keys": [public_key], "padding": "" }).to_string();
            assert!(seed.len() <= limit);
            let body = serde_json::json!({
                "keys": [public_key],
                "padding": "x".repeat(limit - seed.len()),
            })
            .to_string();
            assert_eq!(body.len(), limit);
            body.into_bytes()
        }
        "valid_jwks_over_limit" => {
            let mut body = response_body("valid_jwks_exact_limit", limit, public_key);
            body.push(b' ');
            body
        }
        "invalid_utf8" => vec![0xff],
        "malformed_json" => b"{".to_vec(),
        "empty" => Vec::new(),
        unknown => panic!("unknown response body {unknown}"),
    }
}
