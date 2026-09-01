use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use converact_tenant_auth::{
    Hs256PlatformTokenVerifier, PlatformIdentityRole, PlatformTokenVerificationError,
    PlatformTokenVerifierConfigError,
};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::Value;
use sha2_11::Sha256;

const FIXTURE: &str = include_str!("../../../tests/fixtures/platform-hs256-v1.json");
const VERIFIER_SOURCE: &str = include_str!("../src/hs256.rs");
const JWT_SOURCE: &str = include_str!("../src/jwt.rs");

#[test]
fn rust_hs256_verifier_replays_the_active_typescript_contract() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("HS256 fixture");
    let policy = &fixture["policy"];
    let verifier = verifier(&fixture);
    let mut intentional_target_divergences = Vec::new();

    for vector in fixture["cases"].as_array().expect("cases") {
        let token = token_for(&fixture, vector);
        let actual = verifier.verify(
            &token,
            policy["wall_now_epoch_ms"].as_i64().expect("wall clock"),
        );
        let expected_allowed = vector["target_expected"]
            .as_str()
            .unwrap_or_else(|| vector["expected"].as_str().unwrap())
            == "allowed";
        if vector["target_expected"].as_str().is_some() {
            intentional_target_divergences.push(vector["name"].as_str().unwrap());
        }
        assert_eq!(actual.is_ok(), expected_allowed, "{}", vector["name"]);
        if let Ok(identity) = actual {
            assert_eq!(identity.tenant_id(), "tenant-1");
            assert_eq!(identity.identity_id(), "user-1");
            assert_eq!(identity.role(), PlatformIdentityRole::Operator);
            assert!(identity.has_capability("platform.api"));
            assert!(!identity.has_capability("voice_agent.campaign.manage"));
            assert_eq!(identity.expires_at_epoch_seconds(), 4_102_444_800);
            assert_eq!(
                format!("{identity:?}"),
                "AuthenticatedPlatformIdentity([REDACTED])"
            );
        }
    }
    assert_eq!(intentional_target_divergences, ["hs256_cannot_claim_mtls"]);
}

#[test]
fn verifier_bounds_key_policy_token_and_redacts_key_material() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("HS256 fixture");
    assert!(matches!(
        Hs256PlatformTokenVerifier::new("", "issuer", "audience", "key", 1, 0),
        Err(PlatformTokenVerifierConfigError)
    ));
    assert!(matches!(
        Hs256PlatformTokenVerifier::new(&"x".repeat(4097), "issuer", "audience", "key", 1, 0,),
        Err(PlatformTokenVerifierConfigError)
    ));
    assert!(matches!(
        Hs256PlatformTokenVerifier::new("secret", " issuer", "audience", "key", 1, 0),
        Err(PlatformTokenVerifierConfigError)
    ));

    let verifier = verifier(&fixture);
    assert_eq!(
        format!("{verifier:?}"),
        "Hs256PlatformTokenVerifier([REDACTED])"
    );
    assert!(!format!("{verifier:?}").contains(fixture["test_key_utf8"].as_str().unwrap()));
    assert_eq!(
        verifier.verify(&"x".repeat(65_537), 0),
        Err(PlatformTokenVerificationError::EncodingInvalid)
    );
}

#[test]
fn verifier_returns_closed_errors_without_reading_runtime_state() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("HS256 fixture");
    let verifier = verifier(&fixture);
    let wall_now = fixture["policy"]["wall_now_epoch_ms"].as_i64().unwrap();
    for (name, expected) in [
        (
            "wrong_algorithm",
            PlatformTokenVerificationError::HeaderInvalid,
        ),
        (
            "missing_identity_claim",
            PlatformTokenVerificationError::ClaimsInvalid,
        ),
        (
            "hs256_cannot_claim_mtls",
            PlatformTokenVerificationError::ClaimsInvalid,
        ),
        (
            "invalid_signature",
            PlatformTokenVerificationError::SignatureInvalid,
        ),
        (
            "noncanonical_signature",
            PlatformTokenVerificationError::EncodingInvalid,
        ),
        (
            "expired",
            PlatformTokenVerificationError::PolicyDenied(
                converact_tenant_auth::DenialReason::Expired,
            ),
        ),
    ] {
        let vector = fixture["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|vector| vector["name"] == name)
            .unwrap();
        assert_eq!(
            verifier.verify(&token_for(&fixture, vector), wall_now),
            Err(expected)
        );
    }
    let wrong_key = Hs256PlatformTokenVerifier::new(
        "different-test-only-key",
        fixture["policy"]["expected_issuer"].as_str().unwrap(),
        fixture["policy"]["expected_audience"].as_str().unwrap(),
        fixture["policy"]["expected_key_id"].as_str().unwrap(),
        12,
        4,
    )
    .unwrap();
    assert_eq!(
        wrong_key.verify(fixture["frozen_valid_token"].as_str().unwrap(), wall_now),
        Err(PlatformTokenVerificationError::SignatureInvalid)
    );

    for forbidden in [
        "std::env",
        "SystemTime",
        "tokio",
        "reqwest",
        "TcpStream",
        "File::open",
    ] {
        for source in [VERIFIER_SOURCE, JWT_SOURCE] {
            assert!(!source.contains(forbidden), "found {forbidden}");
        }
    }
}

fn verifier(fixture: &Value) -> Hs256PlatformTokenVerifier {
    let policy = &fixture["policy"];
    Hs256PlatformTokenVerifier::new(
        fixture["test_key_utf8"].as_str().expect("test key"),
        policy["expected_issuer"].as_str().expect("issuer"),
        policy["expected_audience"].as_str().expect("audience"),
        policy["expected_key_id"].as_str().expect("key id"),
        policy["current_policy_version"]
            .as_u64()
            .expect("policy version"),
        policy["current_revocation_epoch"]
            .as_u64()
            .expect("revocation epoch"),
    )
    .expect("valid verifier")
}

fn token_for(fixture: &Value, vector: &Value) -> String {
    match vector["recipe"].as_str() {
        Some("frozen") => fixture["frozen_valid_token"].as_str().unwrap().to_owned(),
        Some("invalid_signature") => {
            let mut token = fixture["frozen_valid_token"].as_str().unwrap().to_owned();
            token.pop();
            token.push('A');
            token
        }
        Some("signature_padding") => {
            format!("{}=", fixture["frozen_valid_token"].as_str().unwrap())
        }
        None => sign_case(fixture, vector),
        Some(recipe) => panic!("unknown recipe: {recipe}"),
    }
}

fn sign_case(fixture: &Value, vector: &Value) -> String {
    let mut header = fixture["header"].as_object().unwrap().clone();
    if let Some(overrides) = vector["header_overrides"].as_object() {
        header.extend(overrides.clone());
    }
    let mut payload = fixture["payload"].as_object().unwrap().clone();
    if let Some(overrides) = vector["payload_overrides"].as_object() {
        payload.extend(overrides.clone());
    }
    if let Some(fields) = vector["payload_remove"].as_array() {
        for field in fields {
            payload.remove(field.as_str().unwrap());
        }
    }
    let header_part = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap());
    let payload_part = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
    let signing_input = format!("{header_part}.{payload_part}");
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(
        fixture["test_key_utf8"].as_str().unwrap().as_bytes(),
    )
    .unwrap();
    mac.update(signing_input.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{signing_input}.{signature}")
}
