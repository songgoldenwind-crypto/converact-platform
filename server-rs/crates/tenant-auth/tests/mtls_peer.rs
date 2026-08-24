use converact_tenant_auth::{MtlsPeerIdentity, MtlsPeerIdentityError, SpiffeTrustDomain};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../tests/fixtures/platform-mtls-peer-v1.json");
const MTLS_SOURCE: &str = include_str!("../src/mtls_peer.rs");

#[test]
fn rust_mtls_peer_mapping_replays_the_active_typescript_contract() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("mTLS peer fixture");
    let trust_domain = SpiffeTrustDomain::parse(fixture["trust_domain"].as_str().unwrap()).unwrap();

    for vector in fixture["cases"].as_array().unwrap() {
        let uri_sans = vector["uri_subject_alt_names"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<Vec<_>>();
        let actual = MtlsPeerIdentity::from_tls_peer(
            vector["authorized"].as_bool().unwrap(),
            &uri_sans,
            &trust_domain,
        );
        assert_eq!(
            actual.is_ok(),
            vector["expected"] == "allowed",
            "{}",
            vector["name"]
        );
        if let Some(expected_error) = vector["error"].as_str() {
            assert_eq!(
                actual.as_ref().err().copied(),
                Some(error(expected_error)),
                "{}",
                vector["name"]
            );
        }
        if let Ok(identity) = actual {
            let expected = &vector["identity"];
            assert_eq!(identity.spiffe_id(), expected["spiffe_id"]);
            assert_eq!(identity.cell_id(), expected["cell_id"]);
            assert_eq!(identity.fault_domain(), expected["fault_domain"]);
            assert_eq!(identity.node_id(), expected["node_id"]);
            assert_eq!(format!("{identity:?}"), "MtlsPeerIdentity([REDACTED])");
        }
    }
}

#[test]
fn trust_domain_and_certificate_projection_are_bounded_and_fail_closed() {
    for invalid in [
        "",
        "UPPER.example",
        ".example.test",
        "example.test.",
        "example..test",
        "example_test",
        &"a".repeat(254),
    ] {
        assert!(SpiffeTrustDomain::parse(invalid).is_err(), "{invalid}");
    }
    let trust = SpiffeTrustDomain::parse("identity.converact.test").unwrap();
    assert_eq!(format!("{trust:?}"), "SpiffeTrustDomain([REDACTED])");
    let valid = "spiffe://identity.converact.test/cells/cell-a/fault-domains/az-1/nodes/node-1";
    assert_eq!(
        MtlsPeerIdentity::from_tls_peer(true, &[valid; 65], &trust),
        Err(MtlsPeerIdentityError::SubjectAltNamesInvalid)
    );
    assert_eq!(
        MtlsPeerIdentity::from_tls_peer(true, &[&"x".repeat(2_049)], &trust),
        Err(MtlsPeerIdentityError::SubjectAltNamesInvalid)
    );
}

#[test]
fn mtls_mapping_has_no_tls_io_policy_or_authority_side_effects() {
    for forbidden in [
        "std::env",
        "SystemTime",
        "tokio",
        "reqwest",
        "TcpStream",
        "File::open",
        "x509",
        "rustls",
        "HashMap",
        "unsafe",
    ] {
        assert!(!MTLS_SOURCE.contains(forbidden), "found {forbidden}");
    }
    assert_eq!(
        MtlsPeerIdentityError::PeerUnverified.to_string(),
        "platform_mtls_peer_unverified"
    );
}

fn error(name: &str) -> MtlsPeerIdentityError {
    match name {
        "peer_unverified" => MtlsPeerIdentityError::PeerUnverified,
        "identity_count_invalid" => MtlsPeerIdentityError::IdentityCountInvalid,
        "identity_invalid" => MtlsPeerIdentityError::IdentityInvalid,
        value => panic!("unknown fixture error: {value}"),
    }
}
