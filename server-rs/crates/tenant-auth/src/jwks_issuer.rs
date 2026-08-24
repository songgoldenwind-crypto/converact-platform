use std::{error::Error, fmt, net::IpAddr};

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
    endpoint_host: OwnedJwksEndpointHost,
    endpoint_port: u16,
    uses_https: bool,
}

#[derive(Clone, Eq, PartialEq)]
enum OwnedJwksEndpointHost {
    Domain(Box<str>),
    Ip(IpAddr),
}

/// Vendor-neutral network host coordinates derived from a validated issuer.
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum JwksEndpointHost<'a> {
    /// Canonical ASCII domain name requiring an approved DNS resolution.
    Domain(&'a str),
    /// Parsed IP literal that does not require DNS resolution.
    Ip(IpAddr),
}

impl fmt::Debug for JwksEndpointHost<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Domain(_) => formatter.write_str("JwksEndpointHost::Domain([REDACTED])"),
            Self::Ip(_) => formatter.write_str("JwksEndpointHost::Ip([REDACTED])"),
        }
    }
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
        let endpoint_host = match host {
            Host::Domain(domain) => OwnedJwksEndpointHost::Domain(domain.into()),
            Host::Ipv4(address) => OwnedJwksEndpointHost::Ip(address.into()),
            Host::Ipv6(address) => OwnedJwksEndpointHost::Ip(address.into()),
        };
        let endpoint_port = endpoint.port_or_known_default().ok_or(JwksIssuerError)?;
        let uses_https = endpoint.scheme() == "https";

        endpoint
            .path_segments_mut()
            .map_err(|()| JwksIssuerError)?
            .pop_if_empty()
            .push(".well-known")
            .push("jwks.json");

        Ok(Self {
            claim_issuer: input.into(),
            jwks_url: endpoint.as_str().into(),
            endpoint_host,
            endpoint_port,
            uses_https,
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

    /// Returns the canonical domain or parsed IP without exposing URL parser
    /// types to the runtime adapter.
    #[must_use]
    pub fn endpoint_host(&self) -> JwksEndpointHost<'_> {
        match &self.endpoint_host {
            OwnedJwksEndpointHost::Domain(domain) => JwksEndpointHost::Domain(domain),
            OwnedJwksEndpointHost::Ip(address) => JwksEndpointHost::Ip(*address),
        }
    }

    /// Returns the explicit or scheme-default endpoint port.
    #[must_use]
    pub const fn endpoint_port(&self) -> u16 {
        self.endpoint_port
    }

    /// Reports whether the canonical endpoint requires TLS.
    #[must_use]
    pub const fn uses_https(&self) -> bool {
        self.uses_https
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
