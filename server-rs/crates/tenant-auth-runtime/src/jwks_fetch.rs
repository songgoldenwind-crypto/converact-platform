use std::{error::Error, fmt, future::Future, net::IpAddr, sync::Arc, time::Duration};

use converact_tenant_auth::{
    JwksEndpointHost, Rs256JwksResponseCollector, Rs256JwksResponseError, Rs256JwksSnapshot,
    ValidatedJwksIssuer,
};
use reqwest::{
    Client, Response,
    header::{CONTENT_LENGTH, CONTENT_TYPE, HeaderMap, HeaderName},
};
use rustls::{ClientConfig, RootCertStore};
use tokio::time::timeout;

use crate::{
    JwksResolvedAddressError, JwksResolvedAddressPolicy, MAX_JWKS_RESOLVED_ADDRESSES,
    ValidatedJwksResolvedAddresses,
};

const CURRENT_TOTAL_DEADLINE: Duration = Duration::from_secs(5);
const MIN_TOTAL_DEADLINE: Duration = Duration::from_millis(1);
const MAX_TOTAL_DEADLINE: Duration = Duration::from_secs(30);
const ACCEPTED_JWKS_MEDIA_TYPES: &str = "application/jwk-set+json, application/json";
const JWKS_USER_AGENT: &str = "converact-jwks/1";

/// Bounded transport policy for one JWKS refresh attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct JwksFetchPolicy {
    address_policy: JwksResolvedAddressPolicy,
    total_deadline: Duration,
}

impl JwksFetchPolicy {
    /// Constructs an explicit address and total monotonic deadline policy.
    ///
    /// # Errors
    ///
    /// Rejects deadlines below 1 millisecond or above 30 seconds.
    pub fn new(
        address_policy: JwksResolvedAddressPolicy,
        total_deadline: Duration,
    ) -> Result<Self, JwksFetchPolicyError> {
        if !(MIN_TOTAL_DEADLINE..=MAX_TOTAL_DEADLINE).contains(&total_deadline) {
            return Err(JwksFetchPolicyError);
        }
        Ok(Self {
            address_policy,
            total_deadline,
        })
    }

    /// Replays the current five-second fetch timeout with an explicit address
    /// scope.
    #[must_use]
    pub const fn current_default(address_policy: JwksResolvedAddressPolicy) -> Self {
        Self {
            address_policy,
            total_deadline: CURRENT_TOTAL_DEADLINE,
        }
    }

    /// Returns the one deadline covering resolution, connection, response and
    /// body validation.
    #[must_use]
    pub const fn total_deadline(self) -> Duration {
        self.total_deadline
    }
}

/// Stable closed failure for fetch-policy construction.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct JwksFetchPolicyError;

impl fmt::Display for JwksFetchPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("platform_rs256_jwks_fetch_policy_invalid")
    }
}

impl Error for JwksFetchPolicyError {}

/// Stable value-free DNS failure returned by a resolver adapter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct JwksDnsResolveError;

impl fmt::Display for JwksDnsResolveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("platform_rs256_jwks_dns_resolve_failed")
    }
}

impl Error for JwksDnsResolveError {}

/// Vendor-neutral asynchronous DNS boundary used once per refresh attempt.
pub trait JwksDnsResolver: Send + Sync {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> impl Future<Output = Result<Box<[IpAddr]>, JwksDnsResolveError>> + Send + 'a;
}

/// Tokio-backed system resolver. Results remain untrusted until the fetcher
/// validates the complete set and pins it into the request client.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemJwksDnsResolver;

impl JwksDnsResolver for SystemJwksDnsResolver {
    async fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> Result<Box<[IpAddr]>, JwksDnsResolveError> {
        let answers = tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| JwksDnsResolveError)?;
        let addresses = answers
            .take(MAX_JWKS_RESOLVED_ADDRESSES + 1)
            .map(|address| address.ip())
            .collect::<Vec<_>>();
        Ok(addresses.into_boxed_slice())
    }
}

/// Closed value-free failure for one complete JWKS fetch attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JwksFetchError {
    Resolve,
    Address(JwksResolvedAddressError),
    Timeout,
    Transport,
    Response(Rs256JwksResponseError),
}

impl JwksFetchError {
    /// Returns a stable diagnostic code without issuer, address or key data.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Resolve => "platform_rs256_jwks_fetch_resolve_failed",
            Self::Address(error) => error.as_str(),
            Self::Timeout => "platform_rs256_jwks_fetch_timeout",
            Self::Transport => "platform_rs256_jwks_fetch_transport_failed",
            Self::Response(error) => error.as_str(),
        }
    }
}

impl fmt::Display for JwksFetchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Error for JwksFetchError {}

/// One bounded resolver plus HTTP/TLS adapter. A fresh client is built per
/// refresh so approved addresses cannot outlive their resolution generation.
/// HTTPS uses the exact-pinned Mozilla root snapshot and Rustls hostname
/// verification; it does not consult an ambient operating-system trust store.
pub struct JwksFetcher<Resolver> {
    policy: JwksFetchPolicy,
    resolver: Resolver,
}

impl<Resolver> JwksFetcher<Resolver> {
    /// Composes an inert fetcher without starting a task or opening a socket.
    #[must_use]
    pub const fn new(policy: JwksFetchPolicy, resolver: Resolver) -> Self {
        Self { policy, resolver }
    }
}

impl JwksFetcher<SystemJwksDnsResolver> {
    /// Composes the production system resolver without starting work.
    #[must_use]
    pub const fn with_system_resolver(policy: JwksFetchPolicy) -> Self {
        Self::new(policy, SystemJwksDnsResolver)
    }
}

impl<Resolver: JwksDnsResolver> JwksFetcher<Resolver> {
    /// Resolves, validates, pins, fetches and parses one complete key set under
    /// a single monotonic deadline.
    ///
    /// # Errors
    ///
    /// Every DNS, destination, deadline, transport, response or key failure
    /// returns a closed value-free reason. Dropping this future cancels the
    /// in-flight resolver/request/body future.
    pub async fn fetch(
        &self,
        issuer: &ValidatedJwksIssuer,
    ) -> Result<Rs256JwksSnapshot, JwksFetchError> {
        match timeout(
            self.policy.total_deadline,
            self.fetch_within_deadline(issuer),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(JwksFetchError::Timeout),
        }
    }

    async fn fetch_within_deadline(
        &self,
        issuer: &ValidatedJwksIssuer,
    ) -> Result<Rs256JwksSnapshot, JwksFetchError> {
        let addresses = self.resolve_and_validate(issuer).await?;
        let client = build_client(issuer, &addresses, self.policy.total_deadline)?;
        let response = client
            .get(issuer.jwks_url())
            .header(reqwest::header::ACCEPT, ACCEPTED_JWKS_MEDIA_TYPES)
            .send()
            .await
            .map_err(|error| map_transport_error(&error))?;
        collect_response(response).await
    }

    async fn resolve_and_validate(
        &self,
        issuer: &ValidatedJwksIssuer,
    ) -> Result<ValidatedJwksResolvedAddresses, JwksFetchError> {
        let raw_addresses = match issuer.endpoint_host() {
            JwksEndpointHost::Domain(host) => self
                .resolver
                .resolve(host, issuer.endpoint_port())
                .await
                .map_err(|_| JwksFetchError::Resolve)?,
            JwksEndpointHost::Ip(address) => Box::new([address]),
        };
        self.policy
            .address_policy
            .validate(raw_addresses, issuer.endpoint_port())
            .map_err(JwksFetchError::Address)
    }
}

impl<Resolver> fmt::Debug for JwksFetcher<Resolver> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("JwksFetcher([REDACTED])")
    }
}

fn build_client(
    issuer: &ValidatedJwksIssuer,
    addresses: &ValidatedJwksResolvedAddresses,
    total_deadline: Duration,
) -> Result<Client, JwksFetchError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let roots = webpki_roots::TLS_SERVER_ROOTS
        .iter()
        .cloned()
        .collect::<RootCertStore>();
    let tls = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| JwksFetchError::Transport)?
        .with_root_certificates(roots)
        .with_no_client_auth();
    // Reqwest's public `rustls-no-provider` feature also compiles its platform
    // verifier. Passing this complete config selects Reqwest's BuiltRustls
    // branch, so certificate verification stays inside the fixed roots above.
    let mut builder = Client::builder()
        .tls_backend_preconfigured(tls)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .referer(false)
        .timeout(total_deadline)
        .connect_timeout(total_deadline)
        .pool_max_idle_per_host(0)
        .http1_only()
        .https_only(issuer.uses_https())
        .tls_sslkeylogfile(false)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .tcp_nodelay(true)
        .user_agent(JWKS_USER_AGENT);
    if let JwksEndpointHost::Domain(host) = issuer.endpoint_host() {
        builder = builder.resolve_to_addrs(host, addresses.as_slice());
    }
    builder.build().map_err(|_| JwksFetchError::Transport)
}

async fn collect_response(mut response: Response) -> Result<Rs256JwksSnapshot, JwksFetchError> {
    let content_type = single_header(
        response.headers(),
        &CONTENT_TYPE,
        Rs256JwksResponseError::ContentTypeRejected,
    )?;
    let content_length = single_header(
        response.headers(),
        &CONTENT_LENGTH,
        Rs256JwksResponseError::ContentLengthInvalid,
    )?;
    let mut collector =
        Rs256JwksResponseCollector::start(response.status().as_u16(), content_type, content_length)
            .map_err(JwksFetchError::Response)?;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| map_transport_error(&error))?
    {
        collector
            .push_chunk(&chunk)
            .map_err(JwksFetchError::Response)?;
    }
    collector.finish().map_err(JwksFetchError::Response)
}

fn single_header<'a>(
    headers: &'a HeaderMap,
    name: &HeaderName,
    invalid: Rs256JwksResponseError,
) -> Result<Option<&'a str>, JwksFetchError> {
    let mut values = headers.get_all(name).iter();
    let Some(first) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(JwksFetchError::Response(invalid));
    }
    first
        .to_str()
        .map(Some)
        .map_err(|_| JwksFetchError::Response(invalid))
}

fn map_transport_error(error: &reqwest::Error) -> JwksFetchError {
    if error.is_timeout() {
        JwksFetchError::Timeout
    } else {
        JwksFetchError::Transport
    }
}
