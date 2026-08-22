use std::{error::Error, fmt};

use url::{Host, Url};

const MAX_ISSUER_BYTES: usize = 2_048;

/// Transport policy chosen explicitly by the runtime composition root.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JwksIssuerTransportPolicy {
    /// Require an HTTPS authority.
    HttpsOnly,
    /// Additionally permit HTTP for a parsed loopback authority in development.
    ExplicitLoopbackHttp,
}

/// Stable closed failure for issuer parsing and endpoint derivation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct JwksIssuerError;

impl fmt::Display for JwksIssuerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("platform_rs256_jwks_issuer_invalid")
    }
}

impl Error for JwksIssuerError {}

/// A bounded issuer claim and its canonical, policy-approved JWKS endpoint.
#[derive(Clone, Eq, PartialEq)]
pub struct ValidatedJwksIssuer {
    claim_issuer: Box<str>,
    jwks_url: Box<str>,
}

impl ValidatedJwksIssuer {
    /// Validates one exact issuer claim and derives its canonical JWKS URL.
    ///
    /// The original issuer string remains unchanged for exact JWT claim
    /// matching. URL normalization is applied only to the network endpoint.
    ///
    /// # Errors
    ///
    /// Returns a closed error for unbounded or non-canonical input, forbidden
    /// transport, user information, query/fragment data, or a missing host.
    pub fn parse(
        input: &str,
        transport_policy: JwksIssuerTransportPolicy,
    ) -> Result<Self, JwksIssuerError> {
        if input.is_empty()
            || input.len() > MAX_ISSUER_BYTES
            || input.chars().any(char::is_whitespace)
            || raw_authority(input).is_none_or(|authority| authority.contains('@'))
        {
            return Err(JwksIssuerError);
        }

        let mut endpoint = Url::parse(input).map_err(|_| JwksIssuerError)?;
        if endpoint.cannot_be_a_base()
            || !endpoint.has_host()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.port() == Some(0)
        {
            return Err(JwksIssuerError);
        }

        let host = endpoint.host().ok_or(JwksIssuerError)?;
        if matches!(host, Host::Domain(domain) if domain.ends_with('.'))
            || !transport_allowed(endpoint.scheme(), &host, transport_policy)
        {
            return Err(JwksIssuerError);
        }

        endpoint
            .path_segments_mut()
            .map_err(|()| JwksIssuerError)?
            .pop_if_empty()
            .push(".well-known")
            .push("jwks.json");

        Ok(Self {
            claim_issuer: input.into(),
            jwks_url: endpoint.as_str().into(),
        })
    }

    /// Returns the exact issuer text used for JWT claim matching.
    #[must_use]
    pub fn claim_issuer(&self) -> &str {
        &self.claim_issuer
    }

    /// Returns the canonical policy-approved JWKS endpoint.
    #[must_use]
    pub fn jwks_url(&self) -> &str {
        &self.jwks_url
    }
}

impl fmt::Debug for ValidatedJwksIssuer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ValidatedJwksIssuer([REDACTED])")
    }
}

fn raw_authority(input: &str) -> Option<&str> {
    let (_, remainder) = input.split_once("://")?;
    let authority_end = remainder.find(['/', '?', '#']).unwrap_or(remainder.len());
    Some(&remainder[..authority_end])
}

fn transport_allowed(scheme: &str, host: &Host<&str>, policy: JwksIssuerTransportPolicy) -> bool {
    if scheme == "https" {
        return true;
    }
    if scheme != "http" || policy != JwksIssuerTransportPolicy::ExplicitLoopbackHttp {
        return false;
    }

    match host {
        Host::Domain(domain) => *domain == "localhost",
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    }
}
