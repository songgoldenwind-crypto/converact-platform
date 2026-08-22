use converact_audit::{AuditIpHmacError, AuditIpHmacKey, audit_source_ip_hmac};
use serde::Deserialize;

const FIXTURE: &str = include_str!("../../../tests/fixtures/audit-ip-hmac-v1.json");

#[derive(Deserialize)]
struct Fixture {
    contract_version: u32,
    key_base64: String,
    valid_cases: Vec<ValidCase>,
    accepted_keys: Vec<String>,
    rejected_keys: Vec<String>,
    invalid_source_ips: Vec<String>,
}

#[derive(Deserialize)]
struct ValidCase {
    name: String,
    source_ip_present: bool,
    source_ip: Option<String>,
    expected_hmac: String,
}

#[test]
fn matches_frozen_typescript_ip_hmac_vectors() {
    let fixture = fixture();
    assert_eq!(fixture.contract_version, 1);
    let key = AuditIpHmacKey::parse_base64(&fixture.key_base64).expect("fixture key");

    for vector in fixture.valid_cases {
        let source_ip = vector
            .source_ip_present
            .then_some(vector.source_ip.as_deref())
            .flatten();
        let actual = audit_source_ip_hmac(source_ip, &key).expect(&vector.name);
        assert_eq!(actual, vector.expected_hmac, "{}", vector.name);
    }
}

#[test]
fn matches_frozen_typescript_key_acceptance() {
    let fixture = fixture();
    for encoded in fixture.accepted_keys {
        assert!(
            AuditIpHmacKey::parse_base64(&encoded).is_ok(),
            "accepted key {encoded:?}"
        );
    }
    for encoded in fixture.rejected_keys {
        assert!(
            matches!(
                AuditIpHmacKey::parse_base64(&encoded),
                Err(AuditIpHmacError::InvalidKey)
            ),
            "rejected key {encoded:?}"
        );
    }
}

#[test]
fn matches_frozen_typescript_invalid_source_ips() {
    let fixture = fixture();
    let key = AuditIpHmacKey::parse_base64(&fixture.key_base64).expect("fixture key");
    for source_ip in fixture.invalid_source_ips {
        assert_eq!(
            audit_source_ip_hmac(Some(&source_ip), &key),
            Err(AuditIpHmacError::InvalidSourceIp),
            "invalid source IP {source_ip:?}"
        );
    }
}

#[test]
fn key_debug_output_is_redacted() {
    let fixture = fixture();
    let key = AuditIpHmacKey::parse_base64(&fixture.key_base64).expect("fixture key");
    let debug = format!("{key:?}");
    assert_eq!(debug, "AuditIpHmacKey([REDACTED])");
    assert!(!debug.contains(&fixture.key_base64));
    assert!(!debug.contains("04"));
}

fn fixture() -> Fixture {
    serde_json::from_str(FIXTURE).expect("valid fixture")
}
