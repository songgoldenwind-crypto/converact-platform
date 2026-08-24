use std::{error::Error, fmt};

use url::Url;

const MAX_TRUST_DOMAIN_BYTES: usize = 253;
const MAX_URI_SUBJECT_ALT_NAMES: usize = 64;
const MAX_URI_SUBJECT_ALT_NAME_BYTES: usize = 2_048;
const MAX_IDENTITY_COMPONENT_BYTES: usize = 128;

/// A bounded canonical SPIFFE trust domain selected by configuration.
#[derive(Clone, Eq, PartialEq)]
pub struct SpiffeTrustDomain(Box<str>);

impl SpiffeTrustDomain {
    /// Parses a lowercase DNS-like SPIFFE trust domain.
    ///
    /// # Errors
    ///
    /// Rejects empty, oversized, non-canonical or repeated-dot input.
    pub fn parse(input: &str) -> Result<Self, MtlsPeerIdentityError> {
        let bytes = input.as_bytes();
        if bytes.is_empty()
            || bytes.len() > MAX_TRUST_DOMAIN_BYTES
            || input.contains("..")
            || !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit()
            || !bytes[bytes.len() - 1].is_ascii_lowercase()
                && !bytes[bytes.len() - 1].is_ascii_digit()
            || !bytes.iter().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'.' || *byte == b'-'
            })
        {
            return Err(MtlsPeerIdentityError::TrustDomainInvalid);
        }
        Ok(Self(input.into()))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SpiffeTrustDomain {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SpiffeTrustDomain([REDACTED])")
    }
}

/// Stable value-free mTLS peer-mapping failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MtlsPeerIdentityError {
    TrustDomainInvalid,
    PeerUnverified,
    SubjectAltNamesInvalid,
    IdentityCountInvalid,
    IdentityInvalid,
}

impl MtlsPeerIdentityError {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TrustDomainInvalid => "platform_mtls_trust_domain_invalid",
            Self::PeerUnverified => "platform_mtls_peer_unverified",
            Self::SubjectAltNamesInvalid => "platform_mtls_peer_sans_invalid",
            Self::IdentityCountInvalid => "platform_mtls_spiffe_identity_count_invalid",
            Self::IdentityInvalid => "platform_mtls_spiffe_identity_invalid",
        }
    }
}

impl fmt::Display for MtlsPeerIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Error for MtlsPeerIdentityError {}

/// Identity projected from exactly one policy-approved SPIFFE URI SAN after
/// the transport adapter has verified the peer certificate chain.
#[derive(Eq, PartialEq)]
pub struct MtlsPeerIdentity {
    spiffe_id: Box<str>,
    cell_id: Box<str>,
    fault_domain: Box<str>,
    node_id: Box<str>,
}

impl MtlsPeerIdentity {
    /// Maps one TLS adapter projection into a bounded peer identity.
    ///
    /// This function does not verify certificates. `authorized` must be the
    /// result of the trusted TLS adapter's chain and client-auth checks.
    ///
    /// # Errors
    ///
    /// Rejects an unverified peer, an oversized SAN projection, anything other
    /// than one SPIFFE URI, or an identity outside the configured trust domain
    /// and exact Cell/fault-domain/node path grammar.
    pub fn from_tls_peer(
        authorized: bool,
        uri_subject_alt_names: &[&str],
        trust_domain: &SpiffeTrustDomain,
    ) -> Result<Self, MtlsPeerIdentityError> {
        if !authorized {
            return Err(MtlsPeerIdentityError::PeerUnverified);
        }
        if uri_subject_alt_names.len() > MAX_URI_SUBJECT_ALT_NAMES
            || uri_subject_alt_names
                .iter()
                .any(|value| value.len() > MAX_URI_SUBJECT_ALT_NAME_BYTES)
        {
            return Err(MtlsPeerIdentityError::SubjectAltNamesInvalid);
        }
        let mut identities = uri_subject_alt_names
            .iter()
            .copied()
            .filter(|value| value.starts_with("spiffe://"));
        let identity = identities
            .next()
            .ok_or(MtlsPeerIdentityError::IdentityCountInvalid)?;
        if identities.next().is_some() {
            return Err(MtlsPeerIdentityError::IdentityCountInvalid);
        }
        Self::parse_identity(identity, trust_domain)
    }

    fn parse_identity(
        input: &str,
        trust_domain: &SpiffeTrustDomain,
    ) -> Result<Self, MtlsPeerIdentityError> {
        let parsed = Url::parse(input).map_err(|_| MtlsPeerIdentityError::IdentityInvalid)?;
        if parsed.cannot_be_a_base()
            || parsed.scheme() != "spiffe"
            || parsed.host_str() != Some(trust_domain.as_str())
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.port().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.path().contains('%')
        {
            return Err(MtlsPeerIdentityError::IdentityInvalid);
        }
        let mut segments = parsed
            .path()
            .strip_prefix('/')
            .ok_or(MtlsPeerIdentityError::IdentityInvalid)?
            .split('/');
        if segments.next() != Some("cells") {
            return Err(MtlsPeerIdentityError::IdentityInvalid);
        }
        let cell_id = segments
            .next()
            .ok_or(MtlsPeerIdentityError::IdentityInvalid)?;
        if segments.next() != Some("fault-domains") {
            return Err(MtlsPeerIdentityError::IdentityInvalid);
        }
        let fault_domain = segments
            .next()
            .ok_or(MtlsPeerIdentityError::IdentityInvalid)?;
        if segments.next() != Some("nodes") {
            return Err(MtlsPeerIdentityError::IdentityInvalid);
        }
        let node_id = segments
            .next()
            .ok_or(MtlsPeerIdentityError::IdentityInvalid)?;
        if segments.next().is_some() {
            return Err(MtlsPeerIdentityError::IdentityInvalid);
        }
        if !identity_component(cell_id)
            || !identity_component(fault_domain)
            || !identity_component(node_id)
        {
            return Err(MtlsPeerIdentityError::IdentityInvalid);
        }
        Ok(Self {
            spiffe_id: parsed.as_str().into(),
            cell_id: cell_id.into(),
            fault_domain: fault_domain.into(),
            node_id: node_id.into(),
        })
    }

    #[must_use]
    pub fn spiffe_id(&self) -> &str {
        &self.spiffe_id
    }

    #[must_use]
    pub fn cell_id(&self) -> &str {
        &self.cell_id
    }

    #[must_use]
    pub fn fault_domain(&self) -> &str {
        &self.fault_domain
    }

    #[must_use]
    pub fn node_id(&self) -> &str {
        &self.node_id
    }
}

impl fmt::Debug for MtlsPeerIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MtlsPeerIdentity([REDACTED])")
    }
}

fn identity_component(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_IDENTITY_COMPONENT_BYTES
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
