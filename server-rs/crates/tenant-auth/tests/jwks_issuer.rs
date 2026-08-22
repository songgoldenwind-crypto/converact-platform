use converact_tenant_auth::{JwksIssuerError, JwksIssuerTransportPolicy, ValidatedJwksIssuer};
use serde::Deserialize;

const FIXTURE: &str = include_str!("../../../tests/fixtures/platform-jwks-issuer-v1.json");
const ISSUER_SOURCE: &str = include_str!("../src/jwks_issuer.rs");

#[derive(Deserialize)]
struct Fixture {
    contract_version: u64,
    cases: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    issuer: String,
    target_policy: String,
    expected: String,
    expected_jwks_url: Option<String>,
    target_expected: Option<String>,
    target_jwks_url: Option<String>,
}

#[test]
fn rust_issuer_boundary_replays_the_bounded_target_contract() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("valid issuer fixture");
    assert_eq!(fixture.contract_version, 1);

    let mut divergences = Vec::new();
    for vector in fixture.cases {
        let policy = match vector.target_policy.as_str() {
            "https_only" => JwksIssuerTransportPolicy::HttpsOnly,
            "explicit_loopback_http" => JwksIssuerTransportPolicy::ExplicitLoopbackHttp,
            unknown => panic!("unknown target policy {unknown}"),
        };
        let target_expected = vector
            .target_expected
            .as_deref()
            .unwrap_or(vector.expected.as_str());
        let parsed = ValidatedJwksIssuer::parse(&vector.issuer, policy);

        assert_eq!(
            parsed.is_ok(),
            target_expected == "allowed",
            "{}",
            vector.name
        );
        if let Ok(issuer) = parsed {
            assert_eq!(issuer.claim_issuer(), vector.issuer, "{}", vector.name);
            assert_eq!(
                issuer.jwks_url(),
                vector
                    .target_jwks_url
                    .as_deref()
                    .or(vector.expected_jwks_url.as_deref())
                    .expect("allowed vector has expected JWKS URL"),
                "{}",
                vector.name
            );
        }
        if vector.target_expected.is_some() {
            divergences.push(vector.name);
        }
    }

    assert_eq!(
        divergences,
        [
            "query_and_fragment_are_not_authority",
            "credentials_are_not_authority",
            "empty_userinfo_is_not_authority",
            "leading_whitespace_is_rejected",
            "embedded_ascii_whitespace_is_rejected",
            "trailing_dot_host_is_rejected",
            "zero_port_is_rejected",
            "loopback_http_requires_explicit_policy",
            "ipv6_loopback_supported_when_explicit",
        ]
    );
}

#[test]
fn issuer_boundary_is_bounded_fail_closed_and_redacted() {
    assert_eq!(
        ValidatedJwksIssuer::parse(
            &format!("https://example.test/{}", "x".repeat(2_049)),
            JwksIssuerTransportPolicy::HttpsOnly,
        ),
        Err(JwksIssuerError)
    );
    assert_eq!(
        ValidatedJwksIssuer::parse(
            "https://example.test/tenant?",
            JwksIssuerTransportPolicy::HttpsOnly,
        ),
        Err(JwksIssuerError)
    );
    assert_eq!(
        ValidatedJwksIssuer::parse(
            "https://example.test/tenant#",
            JwksIssuerTransportPolicy::HttpsOnly,
        ),
        Err(JwksIssuerError)
    );
    assert_eq!(
        ValidatedJwksIssuer::parse(
            "http://localhost.example.test/tenant",
            JwksIssuerTransportPolicy::ExplicitLoopbackHttp,
        ),
        Err(JwksIssuerError)
    );

    let value = ValidatedJwksIssuer::parse(
        "https://identity.example.test/private-tenant",
        JwksIssuerTransportPolicy::HttpsOnly,
    )
    .expect("valid issuer");
    assert_eq!(format!("{value:?}"), "ValidatedJwksIssuer([REDACTED])");
    assert_eq!(
        JwksIssuerError.to_string(),
        "platform_rs256_jwks_issuer_invalid"
    );
}

#[test]
fn issuer_boundary_has_no_runtime_or_io_authority() {
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
            !ISSUER_SOURCE.contains(forbidden),
            "issuer boundary must not contain {forbidden}"
        );
    }
}
