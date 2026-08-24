use std::{error::Error, fmt};

use converact_tenant_auth::{MtlsPeerIdentity, SpiffeTrustDomain};
use x509_cert::{
    Certificate,
    der::Decode,
    ext::pkix::{SubjectAltName, name::GeneralName},
};

const MAX_LEAF_CERTIFICATE_BYTES: usize = 64 * 1024;
const MAX_URI_SUBJECT_ALT_NAMES: usize = 64;
const MAX_URI_SUBJECT_ALT_NAME_BYTES: usize = 2_048;

/// Fixed resource limits for parsing a cryptographically verified peer leaf.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MtlsCertificatePolicy {
    leaf_der_bytes: usize,
    uri_count: usize,
    uri_bytes: usize,
}

impl MtlsCertificatePolicy {
    /// Returns the frozen strict internal workload certificate policy.
    #[must_use]
    pub const fn strict() -> Self {
        Self {
            leaf_der_bytes: MAX_LEAF_CERTIFICATE_BYTES,
            uri_count: MAX_URI_SUBJECT_ALT_NAMES,
            uri_bytes: MAX_URI_SUBJECT_ALT_NAME_BYTES,
        }
    }
}

/// Stable value-free failure while projecting a verified peer certificate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PeerCertificateError {
    CertificateTooLarge,
    CertificateInvalid,
    SubjectAltNamesInvalid,
    IdentityInvalid,
}

impl PeerCertificateError {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CertificateTooLarge => "internal_mtls_peer_certificate_too_large",
            Self::CertificateInvalid => "internal_mtls_peer_certificate_invalid",
            Self::SubjectAltNamesInvalid => "internal_mtls_peer_sans_invalid",
            Self::IdentityInvalid => "internal_mtls_peer_identity_invalid",
        }
    }
}

impl fmt::Display for PeerCertificateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Error for PeerCertificateError {}

/// Projects one already verified leaf certificate into a workload identity.
///
/// Certificate-chain, time, purpose, revocation and signature verification
/// must succeed in the TLS adapter before this function is called.
///
/// # Errors
///
/// Rejects oversized or malformed DER, an invalid/duplicate subjectAltName
/// extension, an oversized URI projection, or anything other than one valid
/// SPIFFE identity under `trust_domain`.
pub fn peer_identity_from_verified_leaf_der(
    leaf_der: &[u8],
    trust_domain: &SpiffeTrustDomain,
    policy: &MtlsCertificatePolicy,
) -> Result<MtlsPeerIdentity, PeerCertificateError> {
    if leaf_der.len() > policy.leaf_der_bytes {
        return Err(PeerCertificateError::CertificateTooLarge);
    }
    let certificate =
        Certificate::from_der(leaf_der).map_err(|_| PeerCertificateError::CertificateInvalid)?;
    let subject_alt_name = certificate
        .tbs_certificate()
        .get_extension::<SubjectAltName>()
        .map_err(|_| PeerCertificateError::CertificateInvalid)?;
    let mut uri_subject_alt_names = [""; MAX_URI_SUBJECT_ALT_NAMES];
    let mut uri_count = 0;
    if let Some((_critical, subject_alt_name)) = &subject_alt_name {
        for general_name in &subject_alt_name.0 {
            let GeneralName::UniformResourceIdentifier(uri) = general_name else {
                continue;
            };
            let uri = uri.as_str();
            if uri.len() > policy.uri_bytes || uri_count == policy.uri_count {
                return Err(PeerCertificateError::SubjectAltNamesInvalid);
            }
            uri_subject_alt_names[uri_count] = uri;
            uri_count += 1;
        }
    }
    MtlsPeerIdentity::from_tls_peer(true, &uri_subject_alt_names[..uri_count], trust_domain)
        .map_err(|_| PeerCertificateError::IdentityInvalid)
}
