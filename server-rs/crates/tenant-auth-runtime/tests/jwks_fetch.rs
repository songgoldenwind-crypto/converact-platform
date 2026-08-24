use std::{
    net::{IpAddr, Ipv4Addr},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use converact_tenant_auth::{
    JwksIssuerTransportPolicy, Rs256JwksResponseError, ValidatedJwksIssuer,
};
use converact_tenant_auth_runtime::{
    JwksDnsResolveError, JwksDnsResolver, JwksFetchError, JwksFetchPolicy, JwksFetcher,
    JwksResolvedAddressError, JwksResolvedAddressPolicy,
};
use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    time::timeout,
};

const KEY_FIXTURE: &str = include_str!("../../../tests/fixtures/platform-rs256-v1.json");
const FETCH_SOURCE: &str = include_str!("../src/jwks_fetch.rs");
const RUNTIME_MANIFEST: &str = include_str!("../Cargo.toml");
const WORKSPACE_MANIFEST: &str = include_str!("../../../Cargo.toml");

#[derive(Clone)]
struct FixedResolver {
    addresses: Arc<[IpAddr]>,
    calls: Arc<AtomicUsize>,
}

impl FixedResolver {
    fn new(addresses: impl Into<Arc<[IpAddr]>>) -> Self {
        Self {
            addresses: addresses.into(),
            calls: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl JwksDnsResolver for FixedResolver {
    async fn resolve<'a>(
        &'a self,
        _host: &'a str,
        _port: u16,
    ) -> Result<Box<[IpAddr]>, JwksDnsResolveError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.addresses.to_vec().into_boxed_slice())
    }
}

struct DropProbe(Arc<AtomicUsize>);

impl Drop for DropProbe {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

struct PendingResolver {
    dropped: Arc<AtomicUsize>,
}

impl JwksDnsResolver for PendingResolver {
    async fn resolve<'a>(
        &'a self,
        _host: &'a str,
        _port: u16,
    ) -> Result<Box<[IpAddr]>, JwksDnsResolveError> {
        let _probe = DropProbe(Arc::clone(&self.dropped));
        std::future::pending().await
    }
}

struct FailingResolver;

impl JwksDnsResolver for FailingResolver {
    async fn resolve<'a>(
        &'a self,
        _host: &'a str,
        _port: u16,
    ) -> Result<Box<[IpAddr]>, JwksDnsResolveError> {
        Err(JwksDnsResolveError)
    }
}

#[test]
fn fetch_policy_bounds_the_total_monotonic_deadline() {
    assert_eq!(
        JwksFetchPolicy::new(JwksResolvedAddressPolicy::public_internet(), Duration::ZERO,),
        Err(converact_tenant_auth_runtime::JwksFetchPolicyError)
    );
    assert_eq!(
        JwksFetchPolicy::new(
            JwksResolvedAddressPolicy::public_internet(),
            Duration::from_secs(31),
        ),
        Err(converact_tenant_auth_runtime::JwksFetchPolicyError)
    );
    assert_eq!(
        JwksFetchPolicy::current_default(JwksResolvedAddressPolicy::public_internet())
            .total_deadline(),
        Duration::from_secs(5)
    );
}

#[test]
fn fetcher_debug_and_failures_do_not_disclose_endpoint_values() {
    let fetcher = loopback_fetcher();

    assert_eq!(format!("{fetcher:?}"), "JwksFetcher([REDACTED])");
    for error in [
        JwksFetchError::Resolve,
        JwksFetchError::Timeout,
        JwksFetchError::Transport,
    ] {
        let diagnostic = format!("{error:?} {error}");
        assert!(!diagnostic.contains("http"));
        assert!(!diagnostic.contains("localhost"));
        assert!(!diagnostic.contains("127.0.0.1"));
    }
}

#[test]
fn transport_source_uses_fixed_local_roots_and_explicit_safety_controls() {
    for required in [
        "collect::<RootCertStore>()",
        "webpki_roots::TLS_SERVER_ROOTS",
        "resolve_to_addrs",
        "tls_backend_preconfigured(tls)",
        "redirect(reqwest::redirect::Policy::none())",
        "retry(reqwest::retry::never())",
        ".no_proxy()",
        ".http1_only()",
    ] {
        assert!(FETCH_SOURCE.contains(required), "missing {required}");
    }
    for forbidden in [
        "with_platform_verifier",
        "danger_accept_invalid_certs",
        "danger_accept_invalid_hostnames",
        "install_default",
        "Proxy::",
    ] {
        assert!(
            !FETCH_SOURCE.contains(forbidden),
            "fetch boundary must not contain {forbidden}"
        );
    }

    assert!(RUNTIME_MANIFEST.contains("webpki-roots.workspace = true"));
    assert!(!RUNTIME_MANIFEST.contains("rustls-platform-verifier"));
    assert!(WORKSPACE_MANIFEST.contains(
        "reqwest = { version = \"=0.13.4\", default-features = false, features = [\"rustls-no-provider\"] }"
    ));
    assert!(
        WORKSPACE_MANIFEST
            .contains("webpki-roots = { version = \"=1.0.9\", default-features = false }")
    );
}

#[tokio::test]
async fn total_deadline_cancels_the_resolver_future() {
    let dropped = Arc::new(AtomicUsize::new(0));
    let policy = JwksFetchPolicy::new(
        JwksResolvedAddressPolicy::loopback_development(),
        Duration::from_millis(20),
    )
    .unwrap();
    let fetcher = JwksFetcher::new(
        policy,
        PendingResolver {
            dropped: Arc::clone(&dropped),
        },
    );

    assert_eq!(
        fetcher.fetch(&loopback_domain_issuer(8080)).await,
        Err(JwksFetchError::Timeout)
    );
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn resolver_failure_is_closed_and_value_free() {
    let fetcher = JwksFetcher::new(
        JwksFetchPolicy::current_default(JwksResolvedAddressPolicy::public_internet()),
        FailingResolver,
    );
    let issuer = ValidatedJwksIssuer::parse(
        "https://identity.example.test/tenant",
        JwksIssuerTransportPolicy::HttpsOnly,
    )
    .unwrap();

    assert_eq!(fetcher.fetch(&issuer).await, Err(JwksFetchError::Resolve));
    assert_eq!(
        JwksFetchError::Resolve.to_string(),
        "platform_rs256_jwks_fetch_resolve_failed"
    );
}

#[tokio::test]
async fn fetches_chunked_jwks_through_one_pinned_dns_generation() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind loopback listener");
    let port = listener.local_addr().unwrap().port();
    let body = valid_jwks();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accept request");
        let request = read_request(&mut stream).await;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/jwk-set+json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.shutdown().await.unwrap();
        request
    });

    let resolver = FixedResolver::new(Arc::from([IpAddr::V4(Ipv4Addr::LOCALHOST)]));
    let fetcher = JwksFetcher::new(
        JwksFetchPolicy::current_default(JwksResolvedAddressPolicy::loopback_development()),
        resolver.clone(),
    );
    let issuer = loopback_domain_issuer(port);
    let snapshot = fetcher.fetch(&issuer).await.expect("valid JWKS fetch");

    assert_eq!(snapshot.len(), 1);
    assert_eq!(resolver.calls(), 1);
    let request = String::from_utf8(server.await.unwrap()).unwrap();
    let request_lower = request.to_ascii_lowercase();
    assert!(request.starts_with("GET /tenant/.well-known/jwks.json HTTP/1.1\r\n"));
    assert!(request_lower.contains("host: localhost:"));
    assert!(request_lower.contains("accept: application/jwk-set+json, application/json\r\n"));
    assert!(!request_lower.contains("accept-encoding"));
    assert!(!request_lower.contains("authorization"));
    assert!(!request_lower.contains("cookie:"));
    assert!(!request_lower.contains("proxy-authorization"));
}

#[tokio::test]
async fn mixed_dns_answers_are_rejected_before_any_connection() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind loopback listener");
    let port = listener.local_addr().unwrap().port();
    let resolver = FixedResolver::new(Arc::from([
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)),
    ]));
    let fetcher = JwksFetcher::new(
        JwksFetchPolicy::current_default(JwksResolvedAddressPolicy::loopback_development()),
        resolver,
    );

    assert_eq!(
        fetcher.fetch(&loopback_domain_issuer(port)).await,
        Err(JwksFetchError::Address(
            JwksResolvedAddressError::AddressRejected
        ))
    );
    assert!(
        timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err(),
        "rejected resolution must not open a connection"
    );
}

#[tokio::test]
async fn redirect_is_not_followed_and_non_200_status_is_closed() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind loopback listener");
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.expect("accept first request");
        read_request(&mut first).await;
        first
            .write_all(
                b"HTTP/1.1 302 Found\r\nLocation: http://localhost/redirected\r\nContent-Length: 0\r\n\r\n",
            )
            .await
            .unwrap();
        timeout(Duration::from_millis(150), listener.accept())
            .await
            .is_ok()
    });
    let fetcher = loopback_fetcher();

    assert_eq!(
        fetcher.fetch(&loopback_domain_issuer(port)).await,
        Err(JwksFetchError::Response(
            Rs256JwksResponseError::StatusRejected
        ))
    );
    assert!(
        !server.await.unwrap(),
        "redirect target must not be requested"
    );
}

#[tokio::test]
async fn stalled_body_hits_total_deadline_and_closes_the_connection() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind loopback listener");
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accept request");
        read_request(&mut stream).await;
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
            )
            .await
            .unwrap();
        connection_closed(&mut stream).await
    });
    let policy = JwksFetchPolicy::new(
        JwksResolvedAddressPolicy::loopback_development(),
        Duration::from_millis(50),
    )
    .unwrap();
    let fetcher = JwksFetcher::new(
        policy,
        FixedResolver::new(Arc::from([IpAddr::V4(Ipv4Addr::LOCALHOST)])),
    );

    assert_eq!(
        fetcher.fetch(&loopback_domain_issuer(port)).await,
        Err(JwksFetchError::Timeout)
    );
    assert!(
        server.await.unwrap(),
        "deadline cancellation must close the response connection"
    );
}

#[tokio::test]
async fn caller_cancellation_closes_the_response_connection() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind loopback listener");
    let port = listener.local_addr().unwrap().port();
    let (head_sent, head_received) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accept request");
        read_request(&mut stream).await;
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
            )
            .await
            .unwrap();
        head_sent.send(()).unwrap();
        connection_closed(&mut stream).await
    });
    let fetcher = loopback_fetcher();
    let issuer = loopback_domain_issuer(port);
    let request = tokio::spawn(async move { fetcher.fetch(&issuer).await });

    head_received.await.unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    assert!(
        server.await.unwrap(),
        "dropping the caller future must close the response connection"
    );
}

#[tokio::test]
async fn response_head_rejection_closes_without_consuming_the_body() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind loopback listener");
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accept request");
        read_request(&mut stream).await;
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 131073\r\n\r\n",
            )
            .await
            .unwrap();
        connection_closed(&mut stream).await
    });

    assert_eq!(
        loopback_fetcher()
            .fetch(&loopback_domain_issuer(port))
            .await,
        Err(JwksFetchError::Response(
            Rs256JwksResponseError::BodyTooLarge
        ))
    );
    assert!(
        server.await.unwrap(),
        "rejected response head must close the connection"
    );
}

#[tokio::test]
async fn transport_failure_is_not_retried() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind loopback listener");
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.expect("accept first request");
        read_request(&mut first).await;
        first.shutdown().await.unwrap();
        timeout(Duration::from_millis(150), listener.accept())
            .await
            .is_ok()
    });

    assert_eq!(
        loopback_fetcher()
            .fetch(&loopback_domain_issuer(port))
            .await,
        Err(JwksFetchError::Transport)
    );
    assert!(!server.await.unwrap(), "transport failure must not retry");
}

#[tokio::test]
async fn direct_ip_issuer_skips_dns_and_transport_errors_are_value_free() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind loopback listener");
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accept request");
        read_request(&mut stream).await;
        stream.shutdown().await.unwrap();
    });
    let resolver = FixedResolver::new(Arc::from([IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))]));
    let fetcher = JwksFetcher::new(
        JwksFetchPolicy::current_default(JwksResolvedAddressPolicy::loopback_development()),
        resolver.clone(),
    );
    let issuer = ValidatedJwksIssuer::parse(
        &format!("http://127.0.0.1:{port}/tenant"),
        JwksIssuerTransportPolicy::ExplicitLoopbackHttp,
    )
    .unwrap();

    assert_eq!(fetcher.fetch(&issuer).await, Err(JwksFetchError::Transport));
    assert_eq!(resolver.calls(), 0);
    assert_eq!(
        JwksFetchError::Transport.to_string(),
        "platform_rs256_jwks_fetch_transport_failed"
    );
    server.await.unwrap();
}

fn loopback_fetcher() -> JwksFetcher<FixedResolver> {
    JwksFetcher::new(
        JwksFetchPolicy::current_default(JwksResolvedAddressPolicy::loopback_development()),
        FixedResolver::new(Arc::from([IpAddr::V4(Ipv4Addr::LOCALHOST)])),
    )
}

fn loopback_domain_issuer(port: u16) -> ValidatedJwksIssuer {
    ValidatedJwksIssuer::parse(
        &format!("http://localhost:{port}/tenant"),
        JwksIssuerTransportPolicy::ExplicitLoopbackHttp,
    )
    .expect("valid explicit loopback issuer")
}

fn valid_jwks() -> String {
    let fixture: Value = serde_json::from_str(KEY_FIXTURE).unwrap();
    serde_json::json!({ "keys": [fixture["public_jwk"].clone()] }).to_string()
}

async fn read_request(stream: &mut TcpStream) -> Vec<u8> {
    let mut request = Vec::with_capacity(1_024);
    loop {
        let mut chunk = [0_u8; 512];
        let read = stream.read(&mut chunk).await.expect("read request");
        assert!(read > 0, "request closed before complete headers");
        request.extend_from_slice(&chunk[..read]);
        assert!(
            request.len() <= 8_192,
            "request headers are unexpectedly large"
        );
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            return request;
        }
    }
}

async fn connection_closed(stream: &mut TcpStream) -> bool {
    let mut byte = [0_u8; 1];
    matches!(
        timeout(Duration::from_secs(1), stream.read(&mut byte)).await,
        Ok(Ok(0) | Err(_))
    )
}
