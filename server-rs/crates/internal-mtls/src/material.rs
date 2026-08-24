use std::{error::Error, fmt, sync::Arc};

use rustls::{
    CertificateError, DigitallySignedStruct, DistinguishedName, RootCertStore, ServerConfig,
    SignatureScheme,
    client::danger::HandshakeSignatureValid,
    pki_types::{CertificateDer, CertificateRevocationListDer, PrivateKeyDer, UnixTime},
    server::{
        NoServerSessionStorage, WebPkiClientVerifier,
        danger::{ClientCertVerified, ClientCertVerifier},
    },
};
use x509_cert::{Certificate as ParsedCertificate, der::Decode};

const MAX_CERTIFICATES: usize = 8;
const MAX_CERTIFICATE_BYTES: usize = 64 * 1024;
const MAX_CERTIFICATE_COLLECTION_BYTES: usize = 256 * 1024;
const MAX_PRIVATE_KEY_BYTES: usize = 64 * 1024;
const MAX_CRLS: usize = 8;
const MAX_CRL_BYTES: usize = 256 * 1024;
const MAX_CRL_COLLECTION_BYTES: usize = 1024 * 1024;

/// Fixed resource limits for internal TLS identity and trust material.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MtlsMaterialPolicy {
    certificate_count: usize,
    certificate_bytes: usize,
    certificate_collection_bytes: usize,
    private_key_bytes: usize,
    crl_count: usize,
    crl_bytes: usize,
    crl_collection_bytes: usize,
}

impl MtlsMaterialPolicy {
    /// Returns the frozen strict internal mTLS material policy.
    #[must_use]
    pub const fn strict() -> Self {
        Self {
            certificate_count: MAX_CERTIFICATES,
            certificate_bytes: MAX_CERTIFICATE_BYTES,
            certificate_collection_bytes: MAX_CERTIFICATE_COLLECTION_BYTES,
            private_key_bytes: MAX_PRIVATE_KEY_BYTES,
            crl_count: MAX_CRLS,
            crl_bytes: MAX_CRL_BYTES,
            crl_collection_bytes: MAX_CRL_COLLECTION_BYTES,
        }
    }
}

/// Stable value-free failure while building internal mTLS material.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MtlsMaterialError {
    MaterialBoundsExceeded,
    ServerChainInvalid,
    PrivateKeyInvalid,
    ClientRootsInvalid,
    ClientCrlInvalid,
    ServerIdentityInvalid,
    ConfigurationInvalid,
}

impl MtlsMaterialError {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MaterialBoundsExceeded => "internal_mtls_material_bounds_exceeded",
            Self::ServerChainInvalid => "internal_mtls_server_chain_invalid",
            Self::PrivateKeyInvalid => "internal_mtls_private_key_invalid",
            Self::ClientRootsInvalid => "internal_mtls_client_roots_invalid",
            Self::ClientCrlInvalid => "internal_mtls_client_crl_invalid",
            Self::ServerIdentityInvalid => "internal_mtls_server_identity_invalid",
            Self::ConfigurationInvalid => "internal_mtls_configuration_invalid",
        }
    }
}

impl fmt::Display for MtlsMaterialError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Error for MtlsMaterialError {}

/// Complete server-side mTLS configuration without public rustls material.
#[derive(Clone)]
pub struct InternalMtlsServerConfig {
    inner: Arc<ServerConfig>,
    material_policy: MtlsMaterialPolicy,
}

impl InternalMtlsServerConfig {
    /// Builds one client-auth-mandatory server configuration from DER inputs.
    ///
    /// # Errors
    ///
    /// Rejects missing, malformed, oversized or mismatched material. Errors
    /// never contain certificate, key, root or CRL values.
    pub fn from_der(
        server_chain: &[&[u8]],
        server_private_key: &[u8],
        client_roots: &[&[u8]],
        client_crls: &[&[u8]],
        policy: &MtlsMaterialPolicy,
    ) -> Result<Self, MtlsMaterialError> {
        if server_chain.is_empty() {
            return Err(MtlsMaterialError::ServerChainInvalid);
        }
        if client_roots.is_empty() {
            return Err(MtlsMaterialError::ClientRootsInvalid);
        }
        validate_collection(
            server_chain,
            policy.certificate_count,
            policy.certificate_bytes,
            policy.certificate_collection_bytes,
        )?;
        validate_collection(
            client_roots,
            policy.certificate_count,
            policy.certificate_bytes,
            policy.certificate_collection_bytes,
        )?;
        validate_collection(
            client_crls,
            policy.crl_count,
            policy.crl_bytes,
            policy.crl_collection_bytes,
        )?;
        for certificate in server_chain {
            ParsedCertificate::from_der(certificate)
                .map_err(|_| MtlsMaterialError::ServerChainInvalid)?;
        }
        if server_private_key.is_empty() {
            return Err(MtlsMaterialError::PrivateKeyInvalid);
        }
        if server_private_key.len() > policy.private_key_bytes {
            return Err(MtlsMaterialError::MaterialBoundsExceeded);
        }

        let mut roots = RootCertStore::empty();
        for root in client_roots {
            roots
                .add(CertificateDer::from((*root).to_vec()))
                .map_err(|_| MtlsMaterialError::ClientRootsInvalid)?;
        }
        let crls = client_crls
            .iter()
            .map(|crl| CertificateRevocationListDer::from((*crl).to_vec()))
            .collect::<Vec<_>>();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let verifier =
            WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider.clone())
                .with_crls(crls)
                .enforce_revocation_expiration()
                .build()
                .map_err(|_| {
                    if client_crls.is_empty() {
                        MtlsMaterialError::ClientRootsInvalid
                    } else {
                        MtlsMaterialError::ClientCrlInvalid
                    }
                })?;
        let bounded_verifier: Arc<dyn ClientCertVerifier> =
            Arc::new(BoundedClientCertVerifier::new(verifier, *policy));
        let private_key = PrivateKeyDer::try_from(server_private_key.to_vec())
            .map_err(|_| MtlsMaterialError::PrivateKeyInvalid)?;
        let server_chain = server_chain
            .iter()
            .map(|certificate| CertificateDer::from((*certificate).to_vec()))
            .collect::<Vec<_>>();
        let mut config = ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
            .map_err(|_| MtlsMaterialError::ConfigurationInvalid)?
            .with_client_cert_verifier(bounded_verifier)
            .with_single_cert(server_chain, private_key)
            .map_err(|_| MtlsMaterialError::ServerIdentityInvalid)?;
        config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        config.session_storage = Arc::new(NoServerSessionStorage {});
        config.send_tls13_tickets = 0;
        config.max_tls13_tickets = 0;

        Ok(Self {
            inner: Arc::new(config),
            material_policy: *policy,
        })
    }

    /// Returns the fixed ALPN order without exposing rustls state.
    #[must_use]
    pub fn alpn_protocols(&self) -> [&[u8]; 2] {
        [
            self.inner.alpn_protocols[0].as_slice(),
            self.inner.alpn_protocols[1].as_slice(),
        ]
    }

    pub(crate) fn rustls_config(&self) -> Arc<ServerConfig> {
        self.inner.clone()
    }

    pub(crate) fn verified_peer_chain_is_bounded(
        &self,
        certificates: &[CertificateDer<'_>],
    ) -> bool {
        certificate_chain_is_bounded(
            certificates.iter(),
            certificates.len(),
            &self.material_policy,
        )
    }
}

impl fmt::Debug for InternalMtlsServerConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("InternalMtlsServerConfig([REDACTED])")
    }
}

struct BoundedClientCertVerifier {
    inner: Arc<dyn ClientCertVerifier>,
    policy: MtlsMaterialPolicy,
}

impl BoundedClientCertVerifier {
    fn new(inner: Arc<dyn ClientCertVerifier>, policy: MtlsMaterialPolicy) -> Self {
        Self { inner, policy }
    }

    fn validate_chain(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
    ) -> Result<(), rustls::Error> {
        let certificate_count = intermediates
            .len()
            .checked_add(1)
            .ok_or_else(chain_bounds_error)?;
        if !certificate_chain_is_bounded(
            std::iter::once(end_entity).chain(intermediates),
            certificate_count,
            &self.policy,
        ) {
            return Err(chain_bounds_error());
        }
        Ok(())
    }
}

impl fmt::Debug for BoundedClientCertVerifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("BoundedClientCertVerifier([REDACTED])")
    }
}

impl ClientCertVerifier for BoundedClientCertVerifier {
    fn offer_client_auth(&self) -> bool {
        true
    }

    fn client_auth_mandatory(&self) -> bool {
        true
    }

    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        self.inner.root_hint_subjects()
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        now: UnixTime,
    ) -> Result<ClientCertVerified, rustls::Error> {
        self.validate_chain(end_entity, intermediates)?;
        self.inner
            .verify_client_cert(end_entity, intermediates, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }

    fn requires_raw_public_keys(&self) -> bool {
        self.inner.requires_raw_public_keys()
    }
}

fn validate_collection(
    values: &[&[u8]],
    count_limit: usize,
    value_bytes_limit: usize,
    collection_bytes_limit: usize,
) -> Result<(), MtlsMaterialError> {
    if values.len() > count_limit {
        return Err(MtlsMaterialError::MaterialBoundsExceeded);
    }
    let mut total_bytes = 0usize;
    for value in values {
        if value.len() > value_bytes_limit {
            return Err(MtlsMaterialError::MaterialBoundsExceeded);
        }
        total_bytes = total_bytes
            .checked_add(value.len())
            .ok_or(MtlsMaterialError::MaterialBoundsExceeded)?;
        if total_bytes > collection_bytes_limit {
            return Err(MtlsMaterialError::MaterialBoundsExceeded);
        }
    }
    Ok(())
}

fn chain_bounds_error() -> rustls::Error {
    rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure)
}

fn certificate_chain_is_bounded<'a>(
    certificates: impl Iterator<Item = &'a CertificateDer<'a>>,
    certificate_count: usize,
    policy: &MtlsMaterialPolicy,
) -> bool {
    if certificate_count == 0 || certificate_count > policy.certificate_count {
        return false;
    }
    let mut total_bytes = 0usize;
    for certificate in certificates {
        if certificate.len() > policy.certificate_bytes {
            return false;
        }
        let Some(next_total) = total_bytes.checked_add(certificate.len()) else {
            return false;
        };
        if next_total > policy.certificate_collection_bytes {
            return false;
        }
        total_bytes = next_total;
    }
    true
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use rcgen::{
        BasicConstraints, CertificateParams, CertificateRevocationListParams,
        ExtendedKeyUsagePurpose, IsCa, Issuer, KeyIdMethod, KeyPair, KeyUsagePurpose,
        RevocationReason, RevokedCertParams, SerialNumber, date_time_ymd,
    };

    use super::*;

    const VERIFICATION_TIME: u64 = 1_735_689_600;

    #[test]
    fn bounded_verifier_requires_the_trusted_client_purpose_and_time_window() {
        let trusted_ca = TestCa::new();
        let untrusted_ca = TestCa::new();
        let verifier = verifier(&trusted_ca);
        let valid = trusted_ca.issue(ExtendedKeyUsagePurpose::ClientAuth, Validity::Current);
        let wrong_purpose =
            trusted_ca.issue(ExtendedKeyUsagePurpose::ServerAuth, Validity::Current);
        let expired = trusted_ca.issue(ExtendedKeyUsagePurpose::ClientAuth, Validity::Expired);
        let wrong_ca = untrusted_ca.issue(ExtendedKeyUsagePurpose::ClientAuth, Validity::Current);

        assert!(verify(&verifier, valid.der()).is_ok());
        assert!(matches!(
            verify(&verifier, wrong_purpose.der()),
            Err(rustls::Error::InvalidCertificate(
                CertificateError::InvalidPurpose | CertificateError::InvalidPurposeContext { .. }
            ))
        ));
        assert!(matches!(
            verify(&verifier, expired.der()),
            Err(rustls::Error::InvalidCertificate(
                CertificateError::Expired | CertificateError::ExpiredContext { .. }
            ))
        ));
        let wrong_ca_error = verify(&verifier, wrong_ca.der()).unwrap_err();
        assert!(
            matches!(
                wrong_ca_error,
                rustls::Error::InvalidCertificate(
                    CertificateError::UnknownIssuer | CertificateError::BadSignature
                )
            ),
            "{wrong_ca_error:?}"
        );
    }

    #[test]
    fn client_chain_bounds_run_before_certificate_parsing() {
        let ca = TestCa::new();
        let verifier = verifier(&ca);
        let oversized = CertificateDer::from(vec![0; MAX_CERTIFICATE_BYTES + 1]);
        let too_many = vec![CertificateDer::from(vec![0]); MAX_CERTIFICATES];

        for result in [
            verifier.verify_client_cert(&oversized, &[], verification_time()),
            verifier.verify_client_cert(
                &CertificateDer::from(vec![0]),
                &too_many,
                verification_time(),
            ),
        ] {
            assert!(matches!(
                result,
                Err(rustls::Error::InvalidCertificate(
                    CertificateError::ApplicationVerificationFailure
                ))
            ));
        }
        assert!(verifier.client_auth_mandatory());
        assert_eq!(
            format!("{verifier:?}"),
            "BoundedClientCertVerifier([REDACTED])"
        );
    }

    #[test]
    fn configured_crl_rejects_a_revoked_client_certificate() {
        let ca = TestCa::new();
        let client = ca.issue(ExtendedKeyUsagePurpose::ClientAuth, Validity::Current);
        let crl = CertificateRevocationListParams {
            this_update: date_time_ymd(2020, 1, 1),
            next_update: date_time_ymd(2030, 1, 1),
            crl_number: SerialNumber::from(1),
            issuing_distribution_point: None,
            revoked_certs: vec![RevokedCertParams {
                serial_number: SerialNumber::from(42),
                revocation_time: date_time_ymd(2024, 1, 1),
                reason_code: Some(RevocationReason::KeyCompromise),
                invalidity_date: None,
            }],
            key_identifier_method: KeyIdMethod::Sha256,
        }
        .signed_by(&Issuer::from_params(&ca.params, &ca.key))
        .unwrap();
        let verifier = verifier_with_crls(
            &ca,
            vec![CertificateRevocationListDer::from(crl.der().to_vec())],
        );

        assert!(matches!(
            verify(&verifier, client.der()),
            Err(rustls::Error::InvalidCertificate(CertificateError::Revoked))
        ));
    }

    fn verify(
        verifier: &BoundedClientCertVerifier,
        certificate: &CertificateDer<'_>,
    ) -> Result<ClientCertVerified, rustls::Error> {
        verifier.verify_client_cert(certificate, &[], verification_time())
    }

    fn verification_time() -> UnixTime {
        UnixTime::since_unix_epoch(Duration::from_secs(VERIFICATION_TIME))
    }

    fn verifier(ca: &TestCa) -> BoundedClientCertVerifier {
        verifier_with_crls(ca, Vec::new())
    }

    fn verifier_with_crls(
        ca: &TestCa,
        crls: Vec<CertificateRevocationListDer<'static>>,
    ) -> BoundedClientCertVerifier {
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from(ca.certificate.der().to_vec()))
            .unwrap();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let inner = WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider)
            .with_crls(crls)
            .enforce_revocation_expiration()
            .build()
            .unwrap();
        BoundedClientCertVerifier::new(inner, MtlsMaterialPolicy::strict())
    }

    struct TestCa {
        params: CertificateParams,
        key: KeyPair,
        certificate: rcgen::Certificate,
    }

    impl TestCa {
        fn new() -> Self {
            let key = KeyPair::generate().unwrap();
            let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
            params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
            params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
            let certificate = params.self_signed(&key).unwrap();
            Self {
                params,
                key,
                certificate,
            }
        }

        fn issue(
            &self,
            purpose: ExtendedKeyUsagePurpose,
            validity: Validity,
        ) -> rcgen::Certificate {
            let key = KeyPair::generate().unwrap();
            let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
            params.not_before = date_time_ymd(2020, 1, 1);
            params.not_after = match validity {
                Validity::Current => date_time_ymd(2030, 1, 1),
                Validity::Expired => date_time_ymd(2021, 1, 1),
            };
            params.serial_number = Some(SerialNumber::from(42));
            params.extended_key_usages = vec![purpose];
            params
                .signed_by(&key, &Issuer::from_params(&self.params, &self.key))
                .unwrap()
        }
    }

    #[derive(Clone, Copy)]
    enum Validity {
        Current,
        Expired,
    }
}
