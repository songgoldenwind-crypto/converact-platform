use std::{
    fmt::Write as _,
    time::{Duration, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use converact_internal_mtls::{
    InternalMtlsPemBundle, InternalMtlsServerConfig, MtlsMaterialPolicy, MtlsPemError,
    MtlsPemPolicy,
};
use rcgen::{
    BasicConstraints, CertificateParams, CertificateRevocationListParams, ExtendedKeyUsagePurpose,
    IsCa, Issuer, KeyIdMethod, KeyPair, KeyUsagePurpose, SerialNumber, date_time_ymd,
};

const SERVER_NAME: &str = "internal.converact.test";
const VALIDATION_TIME: u64 = 1_735_689_600;
const VALID_UNTIL: u64 = 1_893_456_000;

#[test]
fn bounded_pem_bundle_builds_one_time_qualified_redacted_config() {
    let material = TestMaterial::new(ServerProfile::Valid, CrlProfile::Valid);

    let config = build(&material).unwrap();

    assert_eq!(config.validated_until_epoch_seconds(), Some(VALID_UNTIL));
    assert_eq!(
        format!("{config:?}"),
        "InternalMtlsServerConfig([REDACTED])"
    );
    assert_eq!(
        format!("{:?}", material.bundle()),
        "InternalMtlsPemBundle([REDACTED])"
    );
}

#[test]
fn pem_sections_and_counts_fail_closed_before_material_construction() {
    let material = TestMaterial::new(ServerProfile::Valid, CrlProfile::Valid);
    let extra_key = format!("{}{}", material.server_key, material.server_key);
    let too_many_certificates = material.ca.repeat(9);
    let wrong_root_type = material.server_key.as_bytes();
    let wrong_crl_type = material.ca.as_bytes();
    let unknown_root_type = to_pem("UNKNOWN", &[1]);

    for (bundle, expected) in [
        (
            InternalMtlsPemBundle::new(
                material.server_chain.as_bytes().to_vec(),
                extra_key.as_bytes().to_vec(),
                material.ca.as_bytes().to_vec(),
                material.crl.as_bytes().to_vec(),
            ),
            MtlsPemError::PrivateKeyInvalid,
        ),
        (
            InternalMtlsPemBundle::new(
                material.server_chain.as_bytes().to_vec(),
                material.server_key.as_bytes().to_vec(),
                wrong_root_type.to_vec(),
                material.crl.as_bytes().to_vec(),
            ),
            MtlsPemError::ClientRootsInvalid,
        ),
        (
            InternalMtlsPemBundle::new(
                material.server_chain.as_bytes().to_vec(),
                material.server_key.as_bytes().to_vec(),
                material.ca.as_bytes().to_vec(),
                wrong_crl_type.to_vec(),
            ),
            MtlsPemError::ClientCrlInvalid,
        ),
        (
            InternalMtlsPemBundle::new(
                too_many_certificates.as_bytes().to_vec(),
                material.server_key.as_bytes().to_vec(),
                material.ca.as_bytes().to_vec(),
                material.crl.as_bytes().to_vec(),
            ),
            MtlsPemError::BundleBoundsExceeded,
        ),
        (
            InternalMtlsPemBundle::new(
                material.server_chain.as_bytes().to_vec(),
                material.server_key.as_bytes().to_vec(),
                unknown_root_type.as_bytes().to_vec(),
                material.crl.as_bytes().to_vec(),
            ),
            MtlsPemError::ClientRootsInvalid,
        ),
    ] {
        assert_eq!(build_bundle(bundle).unwrap_err(), expected);
    }
}

#[test]
fn pem_file_budgets_run_before_decoding() {
    let material = TestMaterial::new(ServerProfile::Valid, CrlProfile::Valid);
    let oversized = vec![b'A'; 512 * 1024 + 1];
    let oversized_key = vec![b'A'; 128 * 1024 + 1];
    let oversized_crl = vec![b'A'; 2 * 1024 * 1024 + 1];

    for bundle in [
        InternalMtlsPemBundle::new(
            oversized,
            material.server_key.as_bytes().to_vec(),
            material.ca.as_bytes().to_vec(),
            material.crl.as_bytes().to_vec(),
        ),
        InternalMtlsPemBundle::new(
            material.server_chain.as_bytes().to_vec(),
            oversized_key,
            material.ca.as_bytes().to_vec(),
            material.crl.as_bytes().to_vec(),
        ),
        InternalMtlsPemBundle::new(
            material.server_chain.as_bytes().to_vec(),
            material.server_key.as_bytes().to_vec(),
            material.ca.as_bytes().to_vec(),
            oversized_crl,
        ),
    ] {
        assert_eq!(
            build_bundle(bundle).unwrap_err(),
            MtlsPemError::BundleBoundsExceeded
        );
    }
}

#[test]
fn server_dns_purpose_and_time_are_exact_and_fail_closed() {
    for (profile, expected) in [
        (ServerProfile::WrongDns, MtlsPemError::ServerIdentityInvalid),
        (
            ServerProfile::WrongPurpose,
            MtlsPemError::ServerIdentityInvalid,
        ),
        (ServerProfile::Expired, MtlsPemError::ServerTimeInvalid),
        (ServerProfile::NotYetValid, MtlsPemError::ServerTimeInvalid),
    ] {
        let material = TestMaterial::new(profile, CrlProfile::Valid);
        assert_eq!(build(&material).unwrap_err(), expected);
    }
}

#[test]
fn required_crl_must_be_current_and_exceed_the_safety_margin() {
    for profile in [
        CrlProfile::Missing,
        CrlProfile::Expired,
        CrlProfile::NotYetValid,
        CrlProfile::NoNextUpdate,
    ] {
        let material = TestMaterial::new(ServerProfile::Valid, profile);
        assert_eq!(build(&material).unwrap_err(), MtlsPemError::CrlTimeInvalid);
    }
}

#[test]
fn pem_policy_rejects_unbounded_identity_and_safety_margin() {
    assert_eq!(
        MtlsPemPolicy::new("not a dns name", Duration::from_secs(900)).unwrap_err(),
        MtlsPemError::PolicyInvalid
    );
    assert_eq!(
        MtlsPemPolicy::new(SERVER_NAME, Duration::from_secs(59)).unwrap_err(),
        MtlsPemError::PolicyInvalid
    );
    assert_eq!(
        MtlsPemPolicy::new(SERVER_NAME, Duration::from_secs(24 * 60 * 60 + 1)).unwrap_err(),
        MtlsPemError::PolicyInvalid
    );
    assert_eq!(
        MtlsPemPolicy::new("Internal.converact.test", Duration::from_secs(900)).unwrap_err(),
        MtlsPemError::PolicyInvalid
    );
}

fn build(material: &TestMaterial) -> Result<InternalMtlsServerConfig, MtlsPemError> {
    build_bundle(material.bundle())
}

fn build_bundle(bundle: InternalMtlsPemBundle) -> Result<InternalMtlsServerConfig, MtlsPemError> {
    InternalMtlsServerConfig::from_pem_bundle(
        bundle,
        &MtlsPemPolicy::new(SERVER_NAME, Duration::from_secs(15 * 60)).unwrap(),
        UNIX_EPOCH + Duration::from_secs(VALIDATION_TIME),
        &MtlsMaterialPolicy::strict(),
    )
}

#[derive(Clone, Copy)]
enum ServerProfile {
    Valid,
    WrongDns,
    WrongPurpose,
    Expired,
    NotYetValid,
}

#[derive(Clone, Copy)]
enum CrlProfile {
    Valid,
    Missing,
    Expired,
    NotYetValid,
    NoNextUpdate,
}

struct TestMaterial {
    server_chain: String,
    server_key: String,
    ca: String,
    crl: String,
}

impl TestMaterial {
    fn new(server_profile: ServerProfile, crl_profile: CrlProfile) -> Self {
        let ca_key = KeyPair::generate().unwrap();
        let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        let ca = ca_params.self_signed(&ca_key).unwrap();
        let issuer = Issuer::from_params(&ca_params, &ca_key);

        let server_key = KeyPair::generate().unwrap();
        let dns_name = match server_profile {
            ServerProfile::WrongDns => "other.converact.test",
            _ => SERVER_NAME,
        };
        let mut server_params = CertificateParams::new(vec![dns_name.to_owned()]).unwrap();
        server_params.not_before = match server_profile {
            ServerProfile::NotYetValid => date_time_ymd(2029, 1, 1),
            _ => date_time_ymd(2020, 1, 1),
        };
        server_params.not_after = match server_profile {
            ServerProfile::Expired => date_time_ymd(2021, 1, 1),
            _ => date_time_ymd(2030, 1, 1),
        };
        server_params.extended_key_usages = vec![match server_profile {
            ServerProfile::WrongPurpose => ExtendedKeyUsagePurpose::ClientAuth,
            _ => ExtendedKeyUsagePurpose::ServerAuth,
        }];
        let server = server_params.signed_by(&server_key, &issuer).unwrap();

        let crl = if matches!(crl_profile, CrlProfile::Missing) {
            String::new()
        } else {
            let crl = CertificateRevocationListParams {
                this_update: match crl_profile {
                    CrlProfile::NotYetValid => date_time_ymd(2029, 1, 1),
                    _ => date_time_ymd(2020, 1, 1),
                },
                next_update: match crl_profile {
                    CrlProfile::Expired => date_time_ymd(2021, 1, 1),
                    CrlProfile::NoNextUpdate => date_time_ymd(2030, 1, 1),
                    CrlProfile::Valid | CrlProfile::Missing | CrlProfile::NotYetValid => {
                        date_time_ymd(2030, 1, 1)
                    }
                },
                crl_number: SerialNumber::from(1),
                issuing_distribution_point: None,
                revoked_certs: Vec::new(),
                key_identifier_method: KeyIdMethod::Sha256,
            }
            .signed_by(&issuer)
            .unwrap();
            let der = if matches!(crl_profile, CrlProfile::NoNextUpdate) {
                without_next_update(crl.der())
            } else {
                crl.der().to_vec()
            };
            to_pem("X509 CRL", &der)
        };

        Self {
            server_chain: format!(
                "{}{}",
                to_pem("CERTIFICATE", server.der()),
                to_pem("CERTIFICATE", ca.der())
            ),
            server_key: to_pem("PRIVATE KEY", &server_key.serialize_der()),
            ca: to_pem("CERTIFICATE", ca.der()),
            crl,
        }
    }

    fn bundle(&self) -> InternalMtlsPemBundle {
        InternalMtlsPemBundle::new(
            self.server_chain.as_bytes().to_vec(),
            self.server_key.as_bytes().to_vec(),
            self.ca.as_bytes().to_vec(),
            self.crl.as_bytes().to_vec(),
        )
    }
}

fn without_next_update(der: &[u8]) -> Vec<u8> {
    use x509_cert::{
        certificate::Rfc5280,
        crl::CertificateList,
        der::{Decode, Encode},
    };

    let mut crl = CertificateList::<Rfc5280>::from_der(der).unwrap();
    crl.tbs_cert_list.next_update = None;
    crl.to_der().unwrap()
}

fn to_pem(label: &str, der: &[u8]) -> String {
    let encoded = STANDARD.encode(der);
    let mut result = format!("-----BEGIN {label}-----\n");
    for line in encoded.as_bytes().chunks(64) {
        result.push_str(std::str::from_utf8(line).unwrap());
        result.push('\n');
    }
    writeln!(&mut result, "-----END {label}-----").unwrap();
    result
}
