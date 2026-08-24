use converact_internal_mtls::{InternalMtlsServerConfig, MtlsMaterialError, MtlsMaterialPolicy};
use rcgen::{
    BasicConstraints, CertificateParams, CertificateRevocationListParams, ExtendedKeyUsagePurpose,
    IsCa, Issuer, KeyIdMethod, KeyPair, KeyUsagePurpose, SerialNumber, date_time_ymd,
};

#[test]
fn strict_der_material_builds_a_redacted_mandatory_client_auth_config() {
    let material = material();

    let config = build(&material).unwrap();

    assert_eq!(
        format!("{config:?}"),
        "InternalMtlsServerConfig([REDACTED])"
    );
    assert_eq!(config.alpn_protocols(), [b"h2".as_slice(), b"http/1.1"]);
    assert_eq!(config.validated_until_epoch_seconds(), None);
}

#[test]
fn missing_server_identity_or_client_roots_fails_closed() {
    let material = material();
    let server_chain = refs(&material.server_chain);
    let client_roots = refs(&material.client_roots);
    let policy = MtlsMaterialPolicy::strict();

    assert_eq!(
        InternalMtlsServerConfig::from_der(
            &[],
            &material.server_private_key,
            &client_roots,
            &[],
            &policy,
        )
        .unwrap_err(),
        MtlsMaterialError::ServerChainInvalid
    );
    assert_eq!(
        InternalMtlsServerConfig::from_der(&server_chain, &[], &client_roots, &[], &policy,)
            .unwrap_err(),
        MtlsMaterialError::PrivateKeyInvalid
    );
    assert_eq!(
        InternalMtlsServerConfig::from_der(
            &server_chain,
            &material.server_private_key,
            &[],
            &[],
            &policy,
        )
        .unwrap_err(),
        MtlsMaterialError::ClientRootsInvalid
    );
}

#[test]
fn certificate_count_and_byte_budgets_are_fixed_and_bounded() {
    let material = material();
    let client_roots = refs(&material.client_roots);
    let policy = MtlsMaterialPolicy::strict();
    let oversized = vec![0; 64 * 1024 + 1];
    let oversized_chain = vec![oversized.as_slice()];
    let repeated_chain = vec![material.server_chain[0].as_slice(); 9];

    for chain in [&oversized_chain, &repeated_chain] {
        assert_eq!(
            InternalMtlsServerConfig::from_der(
                chain,
                &material.server_private_key,
                &client_roots,
                &[],
                &policy,
            )
            .unwrap_err(),
            MtlsMaterialError::MaterialBoundsExceeded
        );
    }
}

#[test]
fn malformed_root_crl_key_or_key_mismatch_is_value_free() {
    let material = material();
    let server_chain = refs(&material.server_chain);
    let client_roots = refs(&material.client_roots);
    let policy = MtlsMaterialPolicy::strict();
    let malformed = [0x01];

    assert_eq!(
        InternalMtlsServerConfig::from_der(
            &[&malformed],
            &material.server_private_key,
            &client_roots,
            &[],
            &policy,
        )
        .unwrap_err(),
        MtlsMaterialError::ServerChainInvalid
    );
    assert_eq!(
        InternalMtlsServerConfig::from_der(
            &server_chain,
            &material.server_private_key,
            &[&malformed],
            &[],
            &policy,
        )
        .unwrap_err(),
        MtlsMaterialError::ClientRootsInvalid
    );
    assert_eq!(
        InternalMtlsServerConfig::from_der(
            &server_chain,
            &material.server_private_key,
            &client_roots,
            &[&malformed],
            &policy,
        )
        .unwrap_err(),
        MtlsMaterialError::ClientCrlInvalid
    );
    assert_eq!(
        InternalMtlsServerConfig::from_der(&server_chain, &malformed, &client_roots, &[], &policy,)
            .unwrap_err(),
        MtlsMaterialError::PrivateKeyInvalid
    );

    let wrong_key = KeyPair::generate().unwrap().serialize_der();
    assert_eq!(
        InternalMtlsServerConfig::from_der(&server_chain, &wrong_key, &client_roots, &[], &policy,)
            .unwrap_err(),
        MtlsMaterialError::ServerIdentityInvalid
    );
    assert_eq!(
        MtlsMaterialError::ServerIdentityInvalid.to_string(),
        "internal_mtls_server_identity_invalid"
    );
}

struct TestMaterial {
    server_chain: Vec<Vec<u8>>,
    server_private_key: Vec<u8>,
    client_roots: Vec<Vec<u8>>,
    client_crls: Vec<Vec<u8>>,
}

fn build(material: &TestMaterial) -> Result<InternalMtlsServerConfig, MtlsMaterialError> {
    InternalMtlsServerConfig::from_der(
        &refs(&material.server_chain),
        &material.server_private_key,
        &refs(&material.client_roots),
        &refs(&material.client_crls),
        &MtlsMaterialPolicy::strict(),
    )
}

fn refs(values: &[Vec<u8>]) -> Vec<&[u8]> {
    values.iter().map(Vec::as_slice).collect()
}

fn material() -> TestMaterial {
    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let issuer = Issuer::from_params(&ca_params, &ca_key);
    let crl = CertificateRevocationListParams {
        this_update: date_time_ymd(2020, 1, 1),
        next_update: date_time_ymd(2030, 1, 1),
        crl_number: SerialNumber::from(1),
        issuing_distribution_point: None,
        revoked_certs: Vec::new(),
        key_identifier_method: KeyIdMethod::Sha256,
    }
    .signed_by(&issuer)
    .unwrap();

    let server_key = KeyPair::generate().unwrap();
    let mut server_params =
        CertificateParams::new(vec!["internal.converact.test".to_owned()]).unwrap();
    server_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let server = server_params.signed_by(&server_key, &issuer).unwrap();

    TestMaterial {
        server_chain: vec![server.der().to_vec(), ca.der().to_vec()],
        server_private_key: server_key.serialize_der(),
        client_roots: vec![ca.der().to_vec()],
        client_crls: vec![crl.der().to_vec()],
    }
}
