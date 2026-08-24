use converact_internal_mtls::{
    MtlsCertificatePolicy, PeerCertificateError, peer_identity_from_verified_leaf_der,
};
use converact_tenant_auth::SpiffeTrustDomain;
use rcgen::{CertificateParams, CustomExtension, KeyPair, SanType, string::Ia5String};
use x509_cert::{
    der::{Encode, asn1::Ia5String as X509Ia5String},
    ext::pkix::{SubjectAltName, name::GeneralName},
};

const TRUST_DOMAIN: &str = "identity.converact.test";
const VALID_SPIFFE_ID: &str =
    "spiffe://identity.converact.test/cells/cell-a/fault-domains/az-1/nodes/node-1";

#[test]
fn verified_leaf_projects_exactly_one_spiffe_workload_identity() {
    let certificate = certificate(&[
        SanType::DnsName(Ia5String::try_from("client.example.test").unwrap()),
        uri("urn:example:unrelated"),
        uri(VALID_SPIFFE_ID),
    ]);

    let identity = peer_identity_from_verified_leaf_der(
        certificate.der(),
        &trust_domain(),
        &MtlsCertificatePolicy::strict(),
    )
    .unwrap();

    assert_eq!(identity.spiffe_id(), VALID_SPIFFE_ID);
    assert_eq!(identity.cell_id(), "cell-a");
    assert_eq!(identity.fault_domain(), "az-1");
    assert_eq!(identity.node_id(), "node-1");
    assert_eq!(format!("{identity:?}"), "MtlsPeerIdentity([REDACTED])");
}

#[test]
fn missing_or_ambiguous_spiffe_identity_fails_closed() {
    for sans in [
        vec![uri("urn:example:unrelated")],
        vec![
            uri(VALID_SPIFFE_ID),
            uri("spiffe://identity.converact.test/cells/cell-b/fault-domains/az-2/nodes/node-2"),
        ],
    ] {
        assert_eq!(
            peer_identity_from_verified_leaf_der(
                certificate(&sans).der(),
                &trust_domain(),
                &MtlsCertificatePolicy::strict(),
            ),
            Err(PeerCertificateError::IdentityInvalid)
        );
    }
}

#[test]
fn malformed_trailing_and_oversized_der_is_rejected_without_values() {
    let certificate = certificate(&[uri(VALID_SPIFFE_ID)]);
    let mut trailing = certificate.der().to_vec();
    trailing.push(0);
    assert_eq!(
        peer_identity_from_verified_leaf_der(
            &trailing,
            &trust_domain(),
            &MtlsCertificatePolicy::strict(),
        ),
        Err(PeerCertificateError::CertificateInvalid)
    );
    assert_eq!(
        peer_identity_from_verified_leaf_der(
            &vec![0; 64 * 1024 + 1],
            &trust_domain(),
            &MtlsCertificatePolicy::strict(),
        ),
        Err(PeerCertificateError::CertificateTooLarge)
    );
    assert_eq!(
        PeerCertificateError::CertificateInvalid.to_string(),
        "internal_mtls_peer_certificate_invalid"
    );
}

#[test]
fn uri_san_count_and_bytes_are_bounded_before_identity_mapping() {
    let too_many = (0..65)
        .map(|index| uri(&format!("urn:example:{index}")))
        .collect::<Vec<_>>();
    assert_eq!(
        peer_identity_from_verified_leaf_der(
            certificate(&too_many).der(),
            &trust_domain(),
            &MtlsCertificatePolicy::strict(),
        ),
        Err(PeerCertificateError::SubjectAltNamesInvalid)
    );
    assert_eq!(
        peer_identity_from_verified_leaf_der(
            certificate(&[uri(&format!("urn:example:{}", "x".repeat(2_049)))]).der(),
            &trust_domain(),
            &MtlsCertificatePolicy::strict(),
        ),
        Err(PeerCertificateError::SubjectAltNamesInvalid)
    );
}

#[test]
fn duplicate_or_malformed_subject_alt_name_extension_is_rejected() {
    let mut duplicate = certificate_params(&[uri(VALID_SPIFFE_ID)]);
    let second_subject_alt_name = SubjectAltName(vec![GeneralName::UniformResourceIdentifier(
        X509Ia5String::try_from(String::from("urn:example:duplicate")).unwrap(),
    )]);
    duplicate
        .custom_extensions
        .push(CustomExtension::from_oid_content(
            &[2, 5, 29, 17],
            second_subject_alt_name.to_der().unwrap(),
        ));
    let malformed = {
        let mut params = certificate_params(&[]);
        params
            .custom_extensions
            .push(CustomExtension::from_oid_content(
                &[2, 5, 29, 17],
                vec![0x01],
            ));
        self_signed(&params)
    };

    for certificate in [self_signed(&duplicate), malformed] {
        assert_eq!(
            peer_identity_from_verified_leaf_der(
                certificate.der(),
                &trust_domain(),
                &MtlsCertificatePolicy::strict(),
            ),
            Err(PeerCertificateError::CertificateInvalid)
        );
    }
}

fn trust_domain() -> SpiffeTrustDomain {
    SpiffeTrustDomain::parse(TRUST_DOMAIN).unwrap()
}

fn uri(value: &str) -> SanType {
    SanType::URI(Ia5String::try_from(value).unwrap())
}

fn certificate(subject_alt_names: &[SanType]) -> rcgen::Certificate {
    self_signed(&certificate_params(subject_alt_names))
}

fn certificate_params(subject_alt_names: &[SanType]) -> CertificateParams {
    let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
    params.subject_alt_names = subject_alt_names.to_vec();
    params
}

fn self_signed(params: &CertificateParams) -> rcgen::Certificate {
    let key = KeyPair::generate().unwrap();
    params.self_signed(&key).unwrap()
}
