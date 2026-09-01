use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use converact_tenant_auth::{
    DenialReason, PlatformIdentityRole, PlatformTokenVerificationError, Rs256JwksSnapshot,
    Rs256PlatformTokenVerifier,
};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../tests/fixtures/platform-rs256-v1.json");
const VERIFIER_SOURCE: &str = include_str!("../src/rs256.rs");

#[test]
fn rust_rs256_verifier_replays_the_target_contract() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("RS256 fixture");
    let verifier = verifier(&fixture);
    let wall_now = fixture["policy"]["wall_now_epoch_ms"]
        .as_i64()
        .expect("wall clock");
    let mut intentional_target_divergences = Vec::new();

    for vector in fixture["cases"].as_array().expect("cases") {
        if vector["target_expected"].as_str().is_some() {
            intentional_target_divergences.push(vector["name"].as_str().unwrap());
        }
        let expected_allowed = vector["target_expected"]
            .as_str()
            .unwrap_or_else(|| vector["expected"].as_str().unwrap())
            == "allowed";
        let actual = verifier.verify(&token_for(&fixture, vector), wall_now);
        assert_eq!(actual.is_ok(), expected_allowed, "{}", vector["name"]);
        if let Ok(identity) = actual {
            assert_eq!(identity.tenant_id(), "tenant-rs");
            assert_eq!(identity.identity_id(), "user-rs");
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
    assert_eq!(
        intentional_target_divergences,
        ["rs256_cannot_claim_mtls", "duplicate_tenant_claim"]
    );
}

#[test]
fn verifier_returns_closed_errors_for_header_signature_claims_and_policy() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("RS256 fixture");
    let verifier = verifier(&fixture);
    let wall_now = fixture["policy"]["wall_now_epoch_ms"].as_i64().unwrap();
    for (name, expected) in [
        (
            "wrong_algorithm",
            PlatformTokenVerificationError::HeaderInvalid,
        ),
        ("wrong_type", PlatformTokenVerificationError::HeaderInvalid),
        (
            "missing_key_id",
            PlatformTokenVerificationError::HeaderInvalid,
        ),
        (
            "unknown_key_id",
            PlatformTokenVerificationError::HeaderInvalid,
        ),
        (
            "payload_key_mismatch",
            PlatformTokenVerificationError::ClaimsInvalid,
        ),
        (
            "wrong_issuer",
            PlatformTokenVerificationError::ClaimsInvalid,
        ),
        (
            "expired",
            PlatformTokenVerificationError::PolicyDenied(DenialReason::Expired),
        ),
        (
            "rs256_cannot_claim_mtls",
            PlatformTokenVerificationError::ClaimsInvalid,
        ),
        (
            "duplicate_tenant_claim",
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
            "wrong_signature_length",
            PlatformTokenVerificationError::SignatureInvalid,
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
            Err(expected),
            "{name}"
        );
    }
}

#[test]
fn verifier_is_inert_bounded_redacted_and_public_key_only() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("RS256 fixture");
    let verifier = verifier(&fixture);
    assert_eq!(
        format!("{verifier:?}"),
        "Rs256PlatformTokenVerifier([REDACTED])"
    );
    assert!(!format!("{verifier:?}").contains(fixture["public_jwk"]["n"].as_str().unwrap()));
    assert_eq!(
        verifier.verify(&"x".repeat(65_537), 0),
        Err(PlatformTokenVerificationError::EncodingInvalid)
    );

    assert!(VERIFIER_SOURCE.contains("ring::signature::RsaPublicKeyComponents"));
    assert!(VERIFIER_SOURCE.contains("RSA_PKCS1_2048_8192_SHA256"));
    for forbidden in [
        "std::env",
        "SystemTime",
        "tokio",
        "reqwest",
        "TcpStream",
        "File::open",
        "RsaKeyPair",
        "SecureRandom",
        ".sign(",
        ".decrypt(",
        "unsafe",
    ] {
        assert!(!VERIFIER_SOURCE.contains(forbidden), "found {forbidden}");
    }
}

fn verifier(fixture: &Value) -> Rs256PlatformTokenVerifier {
    let jwks = serde_json::to_string(&serde_json::json!({
        "keys": [fixture["public_jwk"].clone()]
    }))
    .unwrap();
    let keys = Rs256JwksSnapshot::parse_json(&jwks).expect("bounded JWKS");
    let policy = &fixture["policy"];
    Rs256PlatformTokenVerifier::new(
        keys,
        policy["expected_issuer"].as_str().unwrap(),
        policy["expected_audience"].as_str().unwrap(),
        policy["current_policy_version"].as_u64().unwrap(),
        policy["current_revocation_epoch"].as_u64().unwrap(),
    )
    .expect("valid verifier")
}

fn token_for(fixture: &Value, vector: &Value) -> String {
    if let Some(token_ref) = vector["token_ref"].as_str() {
        return fixture["tokens"][token_ref].as_str().unwrap().to_owned();
    }
    let valid = fixture["tokens"]["valid"].as_str().unwrap();
    let parts = valid.split('.').collect::<Vec<_>>();
    assert_eq!(parts.len(), 3);
    match vector["recipe"].as_str() {
        Some("header_override" | "header_remove_key") => {
            let bytes = URL_SAFE_NO_PAD.decode(parts[0]).unwrap();
            let mut header: serde_json::Map<String, Value> =
                serde_json::from_slice(&bytes).unwrap();
            if vector["recipe"] == "header_remove_key" {
                header.remove("kid");
            } else {
                header.extend(vector["header_overrides"].as_object().unwrap().clone());
            }
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
        Some("signature_padding") => format!("{valid}="),
        Some("short_signature") => format!(
            "{}.{}.{}",
            parts[0],
            parts[1],
            URL_SAFE_NO_PAD.encode([0_u8; 255])
        ),
        Some(recipe) => panic!("unknown recipe: {recipe}"),
        None => panic!("missing token recipe for {}", vector["name"]),
    }
}
