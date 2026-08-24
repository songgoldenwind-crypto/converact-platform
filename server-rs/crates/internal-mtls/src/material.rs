use std::{
    error::Error,
    fmt,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rustls::{
    CertificateError, DigitallySignedStruct, DistinguishedName, RootCertStore, ServerConfig,
    SignatureScheme,
    client::danger::HandshakeSignatureValid,
    pki_types::{
        CertificateDer, CertificateRevocationListDer, PrivateKeyDer, ServerName, UnixTime,
        pem::{PemObject, SectionKind},
    },
    server::{
        NoServerSessionStorage, WebPkiClientVerifier,
        danger::{ClientCertVerified, ClientCertVerifier},
    },
};
use x509_cert::{
    Certificate as ParsedCertificate,
    certificate::Rfc5280,
    crl::CertificateList,
    der::{Decode, asn1::ObjectIdentifier},
    ext::pkix::{ExtendedKeyUsage, SubjectAltName, name::GeneralName},
};

const MAX_CERTIFICATES: usize = 8;
const MAX_CERTIFICATE_BYTES: usize = 64 * 1024;
const MAX_CERTIFICATE_COLLECTION_BYTES: usize = 256 * 1024;
const MAX_PRIVATE_KEY_BYTES: usize = 64 * 1024;
const MAX_CRLS: usize = 8;
const MAX_CRL_BYTES: usize = 256 * 1024;
const MAX_CRL_COLLECTION_BYTES: usize = 1024 * 1024;
const MAX_SERVER_CHAIN_PEM_BYTES: usize = 512 * 1024;
const MAX_SERVER_PRIVATE_KEY_PEM_BYTES: usize = 128 * 1024;
const MAX_CLIENT_ROOTS_PEM_BYTES: usize = 512 * 1024;
const MAX_CLIENT_CRLS_PEM_BYTES: usize = 2 * 1024 * 1024;
const MAX_PEM_BUNDLE_BYTES: usize = 3_200 * 1024;
const MIN_VALIDITY_MARGIN: Duration = Duration::from_secs(60);
const MAX_VALIDITY_MARGIN: Duration = Duration::from_secs(24 * 60 * 60);
const SERVER_AUTH_OID: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.6.1.5.5.7.3.1");

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

/// Owned bounded PEM inputs. Private-key source bytes are overwritten on drop.
pub struct InternalMtlsPemBundle {
    server_chain: Vec<u8>,
    server_private_key: Vec<u8>,
    client_roots: Vec<u8>,
    client_crls: Vec<u8>,
}

impl InternalMtlsPemBundle {
    #[must_use]
    pub const fn new(
        server_chain: Vec<u8>,
        server_private_key: Vec<u8>,
        client_roots: Vec<u8>,
        client_crls: Vec<u8>,
    ) -> Self {
        Self {
            server_chain,
            server_private_key,
            client_roots,
            client_crls,
        }
    }
}

impl Drop for InternalMtlsPemBundle {
    fn drop(&mut self) {
        self.server_private_key.fill(0);
    }
}

impl fmt::Debug for InternalMtlsPemBundle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("InternalMtlsPemBundle([REDACTED])")
    }
}

/// Exact server identity and minimum remaining-validity policy.
pub struct MtlsPemPolicy {
    server_dns_name: Box<str>,
    validity_margin: Duration,
}

impl MtlsPemPolicy {
    /// Creates one bounded exact-DNS, required-CRL PEM policy.
    ///
    /// # Errors
    ///
    /// Rejects non-lowercase DNS identities and a validity margin outside
    /// `1 min..=24 h`.
    pub fn new(server_dns_name: &str, validity_margin: Duration) -> Result<Self, MtlsPemError> {
        let server_name = ServerName::try_from(server_dns_name.to_owned())
            .map_err(|_| MtlsPemError::PolicyInvalid)?;
        if !matches!(server_name, ServerName::DnsName(_))
            || server_dns_name
                .bytes()
                .any(|byte| byte.is_ascii_uppercase())
            || !(MIN_VALIDITY_MARGIN..=MAX_VALIDITY_MARGIN).contains(&validity_margin)
        {
            return Err(MtlsPemError::PolicyInvalid);
        }
        Ok(Self {
            server_dns_name: server_dns_name.into(),
            validity_margin,
        })
    }
}

impl fmt::Debug for MtlsPemPolicy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MtlsPemPolicy([REDACTED])")
    }
}

/// Stable value-free bounded PEM loading failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MtlsPemError {
    PolicyInvalid,
    BundleBoundsExceeded,
    ServerChainInvalid,
    PrivateKeyInvalid,
    ClientRootsInvalid,
    ClientCrlInvalid,
    ServerIdentityInvalid,
    ServerTimeInvalid,
    CrlTimeInvalid,
    ConfigurationInvalid,
}

impl MtlsPemError {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PolicyInvalid => "internal_mtls_pem_policy_invalid",
            Self::BundleBoundsExceeded => "internal_mtls_pem_bundle_bounds_exceeded",
            Self::ServerChainInvalid => "internal_mtls_pem_server_chain_invalid",
            Self::PrivateKeyInvalid => "internal_mtls_pem_private_key_invalid",
            Self::ClientRootsInvalid => "internal_mtls_pem_client_roots_invalid",
            Self::ClientCrlInvalid => "internal_mtls_pem_client_crl_invalid",
            Self::ServerIdentityInvalid => "internal_mtls_pem_server_identity_invalid",
            Self::ServerTimeInvalid => "internal_mtls_pem_server_time_invalid",
            Self::CrlTimeInvalid => "internal_mtls_pem_crl_time_invalid",
            Self::ConfigurationInvalid => "internal_mtls_pem_configuration_invalid",
        }
    }
}

impl fmt::Display for MtlsPemError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Error for MtlsPemError {}

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
    validated_until_epoch_seconds: Option<u64>,
}

impl InternalMtlsServerConfig {
    /// Builds one strict server config from an owned bounded PEM bundle.
    ///
    /// # Errors
    ///
    /// Rejects unexpected PEM sections, invalid counts, identity/purpose/time
    /// mismatch, absent or stale CRLs, and every existing DER material error.
    pub fn from_pem_bundle(
        bundle: InternalMtlsPemBundle,
        pem_policy: &MtlsPemPolicy,
        validation_time: SystemTime,
        material_policy: &MtlsMaterialPolicy,
    ) -> Result<Self, MtlsPemError> {
        validate_pem_bundle_bounds(&bundle)?;
        let validation_epoch_seconds = validation_time
            .duration_since(UNIX_EPOCH)
            .map_err(|_| MtlsPemError::ServerTimeInvalid)?
            .as_secs();
        let required_valid_until = validation_epoch_seconds
            .checked_add(pem_policy.validity_margin.as_secs())
            .ok_or(MtlsPemError::ServerTimeInvalid)?;

        let server_chain = parse_certificate_pem(
            &bundle.server_chain,
            MtlsPemError::ServerChainInvalid,
            material_policy.certificate_count,
        )?;
        let server_private_key = parse_private_key_pem(&bundle.server_private_key)?;
        let client_roots = parse_certificate_pem(
            &bundle.client_roots,
            MtlsPemError::ClientRootsInvalid,
            material_policy.certificate_count,
        )?;
        let client_crls = parse_crl_pem(&bundle.client_crls, material_policy.crl_count)?;

        let server_valid_until = validate_server_identity(
            server_chain
                .first()
                .ok_or(MtlsPemError::ServerChainInvalid)?,
            pem_policy,
            validation_epoch_seconds,
            required_valid_until,
        )?;
        let crl_valid_until =
            validate_crl_times(&client_crls, validation_epoch_seconds, required_valid_until)?;
        let server_refs = server_chain.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let root_refs = client_roots.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let crl_refs = client_crls.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let mut config = Self::from_der(
            &server_refs,
            server_private_key.as_slice(),
            &root_refs,
            &crl_refs,
            material_policy,
        )
        .map_err(MtlsPemError::from)?;
        config.validated_until_epoch_seconds = Some(server_valid_until.min(crl_valid_until));
        drop(bundle);
        Ok(config)
    }

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
            validated_until_epoch_seconds: None,
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

    /// Returns the earliest server-certificate/CRL deadline only for configs
    /// built by the time-qualified PEM boundary.
    #[must_use]
    pub const fn validated_until_epoch_seconds(&self) -> Option<u64> {
        self.validated_until_epoch_seconds
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

impl From<MtlsMaterialError> for MtlsPemError {
    fn from(error: MtlsMaterialError) -> Self {
        match error {
            MtlsMaterialError::MaterialBoundsExceeded => Self::BundleBoundsExceeded,
            MtlsMaterialError::ServerChainInvalid => Self::ServerChainInvalid,
            MtlsMaterialError::PrivateKeyInvalid => Self::PrivateKeyInvalid,
            MtlsMaterialError::ClientRootsInvalid => Self::ClientRootsInvalid,
            MtlsMaterialError::ClientCrlInvalid => Self::ClientCrlInvalid,
            MtlsMaterialError::ServerIdentityInvalid => Self::ServerIdentityInvalid,
            MtlsMaterialError::ConfigurationInvalid => Self::ConfigurationInvalid,
        }
    }
}

struct SecretDer(Vec<u8>);

impl SecretDer {
    fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for SecretDer {
    fn drop(&mut self) {
        self.0.fill(0);
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

fn validate_pem_bundle_bounds(bundle: &InternalMtlsPemBundle) -> Result<(), MtlsPemError> {
    let lengths = [
        (bundle.server_chain.len(), MAX_SERVER_CHAIN_PEM_BYTES),
        (
            bundle.server_private_key.len(),
            MAX_SERVER_PRIVATE_KEY_PEM_BYTES,
        ),
        (bundle.client_roots.len(), MAX_CLIENT_ROOTS_PEM_BYTES),
        (bundle.client_crls.len(), MAX_CLIENT_CRLS_PEM_BYTES),
    ];
    let mut total = 0usize;
    for (length, limit) in lengths {
        if length > limit {
            return Err(MtlsPemError::BundleBoundsExceeded);
        }
        total = total
            .checked_add(length)
            .ok_or(MtlsPemError::BundleBoundsExceeded)?;
    }
    if total > MAX_PEM_BUNDLE_BYTES {
        return Err(MtlsPemError::BundleBoundsExceeded);
    }
    Ok(())
}

fn parse_certificate_pem(
    pem: &[u8],
    invalid_error: MtlsPemError,
    count_limit: usize,
) -> Result<Vec<Vec<u8>>, MtlsPemError> {
    let sections = parse_pem_sections(pem, invalid_error)?;
    if sections.is_empty() {
        return Err(invalid_error);
    }
    if sections.len() > count_limit {
        return Err(MtlsPemError::BundleBoundsExceeded);
    }
    sections
        .into_iter()
        .map(|(kind, der)| {
            if kind == SectionKind::Certificate {
                Ok(der)
            } else {
                Err(invalid_error)
            }
        })
        .collect()
}

fn parse_private_key_pem(pem: &[u8]) -> Result<SecretDer, MtlsPemError> {
    let mut sections = parse_pem_sections(pem, MtlsPemError::PrivateKeyInvalid)?;
    if sections.len() != 1 {
        return Err(MtlsPemError::PrivateKeyInvalid);
    }
    let (kind, der) = sections.pop().ok_or(MtlsPemError::PrivateKeyInvalid)?;
    if matches!(
        kind,
        SectionKind::RsaPrivateKey | SectionKind::PrivateKey | SectionKind::EcPrivateKey
    ) {
        Ok(SecretDer(der))
    } else {
        Err(MtlsPemError::PrivateKeyInvalid)
    }
}

fn parse_crl_pem(pem: &[u8], count_limit: usize) -> Result<Vec<Vec<u8>>, MtlsPemError> {
    if pem.is_empty() {
        return Ok(Vec::new());
    }
    let sections = parse_pem_sections(pem, MtlsPemError::ClientCrlInvalid)?;
    if sections.len() > count_limit {
        return Err(MtlsPemError::BundleBoundsExceeded);
    }
    sections
        .into_iter()
        .map(|(kind, der)| {
            if kind == SectionKind::Crl {
                Ok(der)
            } else {
                Err(MtlsPemError::ClientCrlInvalid)
            }
        })
        .collect()
}

fn parse_pem_sections(
    pem: &[u8],
    invalid_error: MtlsPemError,
) -> Result<Vec<(SectionKind, Vec<u8>)>, MtlsPemError> {
    let declared_sections = pem
        .split(|byte| *byte == b'\n' || *byte == b'\r')
        .filter(|line| line.starts_with(b"-----BEGIN "))
        .count();
    let sections = <(SectionKind, Vec<u8>)>::pem_slice_iter(pem)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid_error)?;
    if declared_sections != sections.len() {
        return Err(invalid_error);
    }
    Ok(sections)
}

fn validate_server_identity(
    leaf_der: &[u8],
    policy: &MtlsPemPolicy,
    validation_time: u64,
    required_valid_until: u64,
) -> Result<u64, MtlsPemError> {
    let certificate =
        ParsedCertificate::from_der(leaf_der).map_err(|_| MtlsPemError::ServerIdentityInvalid)?;
    let validity = certificate.tbs_certificate().validity();
    let not_before = validity.not_before.to_unix_duration().as_secs();
    let not_after = validity.not_after.to_unix_duration().as_secs();
    if validation_time < not_before || required_valid_until > not_after {
        return Err(MtlsPemError::ServerTimeInvalid);
    }

    let (_, subject_alt_name) = certificate
        .tbs_certificate()
        .get_extension::<SubjectAltName>()
        .map_err(|_| MtlsPemError::ServerIdentityInvalid)?
        .ok_or(MtlsPemError::ServerIdentityInvalid)?;
    let [GeneralName::DnsName(dns_name)] = subject_alt_name.0.as_slice() else {
        return Err(MtlsPemError::ServerIdentityInvalid);
    };
    if !dns_name
        .as_str()
        .eq_ignore_ascii_case(&policy.server_dns_name)
    {
        return Err(MtlsPemError::ServerIdentityInvalid);
    }

    let (_, extended_key_usage) = certificate
        .tbs_certificate()
        .get_extension::<ExtendedKeyUsage>()
        .map_err(|_| MtlsPemError::ServerIdentityInvalid)?
        .ok_or(MtlsPemError::ServerIdentityInvalid)?;
    if !extended_key_usage.0.contains(&SERVER_AUTH_OID) {
        return Err(MtlsPemError::ServerIdentityInvalid);
    }
    Ok(not_after)
}

fn validate_crl_times(
    crls: &[Vec<u8>],
    validation_time: u64,
    required_valid_until: u64,
) -> Result<u64, MtlsPemError> {
    if crls.is_empty() {
        return Err(MtlsPemError::CrlTimeInvalid);
    }
    let mut earliest_next_update = u64::MAX;
    for crl_der in crls {
        let crl = CertificateList::<Rfc5280>::from_der(crl_der)
            .map_err(|_| MtlsPemError::ClientCrlInvalid)?;
        let this_update = crl.tbs_cert_list.this_update.to_unix_duration().as_secs();
        let next_update = crl
            .tbs_cert_list
            .next_update
            .ok_or(MtlsPemError::CrlTimeInvalid)?
            .to_unix_duration()
            .as_secs();
        if this_update > validation_time || next_update < required_valid_until {
            return Err(MtlsPemError::CrlTimeInvalid);
        }
        earliest_next_update = earliest_next_update.min(next_update);
    }
    Ok(earliest_next_update)
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
