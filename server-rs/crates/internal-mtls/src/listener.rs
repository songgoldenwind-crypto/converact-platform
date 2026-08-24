use std::{
    error::Error,
    fmt, io,
    net::SocketAddr,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};

use axum::{
    extract::connect_info::Connected,
    serve::{IncomingStream, Listener},
};
use converact_tenant_auth::{MtlsPeerIdentity, SpiffeTrustDomain};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    task::{JoinError, JoinSet},
    time,
};
use tokio_rustls::{TlsAcceptor, server::TlsStream};

use crate::{
    InternalMtlsServerConfig, MtlsCertificatePolicy, peer_identity_from_verified_leaf_der,
};

const MIN_HANDSHAKE_CAPACITY: usize = 1;
const MAX_HANDSHAKE_CAPACITY: usize = 256;
const DEFAULT_HANDSHAKE_CAPACITY: usize = 64;
const MIN_HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);

/// Bounded listener policy for unauthenticated TLS handshakes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InternalMtlsListenerPolicy {
    handshake_capacity: usize,
    handshake_timeout: Duration,
}

impl InternalMtlsListenerPolicy {
    /// Validates the fixed listener policy range.
    ///
    /// # Errors
    ///
    /// Rejects a capacity outside `1..=256` or a timeout outside
    /// `100 ms..=10 s`.
    pub fn new(
        handshake_capacity: usize,
        handshake_timeout: Duration,
    ) -> Result<Self, InternalMtlsListenerPolicyError> {
        if !(MIN_HANDSHAKE_CAPACITY..=MAX_HANDSHAKE_CAPACITY).contains(&handshake_capacity)
            || !(MIN_HANDSHAKE_TIMEOUT..=MAX_HANDSHAKE_TIMEOUT).contains(&handshake_timeout)
        {
            return Err(InternalMtlsListenerPolicyError::Invalid);
        }
        Ok(Self {
            handshake_capacity,
            handshake_timeout,
        })
    }
}

impl Default for InternalMtlsListenerPolicy {
    fn default() -> Self {
        Self {
            handshake_capacity: DEFAULT_HANDSHAKE_CAPACITY,
            handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
        }
    }
}

/// Stable value-free listener-policy failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InternalMtlsListenerPolicyError {
    Invalid,
}

impl fmt::Display for InternalMtlsListenerPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("internal_mtls_listener_policy_invalid")
    }
}

impl Error for InternalMtlsListenerPolicyError {}

/// Stable value-free failure for one isolated handshake.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InternalMtlsHandshakeError {
    Timeout,
    PeerUntrusted,
    PeerCertificateInvalid,
    PeerIdentityInvalid,
}

impl InternalMtlsHandshakeError {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "internal_mtls_handshake_timeout",
            Self::PeerUntrusted => "internal_mtls_peer_untrusted",
            Self::PeerCertificateInvalid => "internal_mtls_peer_certificate_invalid",
            Self::PeerIdentityInvalid => "internal_mtls_peer_identity_invalid",
        }
    }
}

impl fmt::Display for InternalMtlsHandshakeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Error for InternalMtlsHandshakeError {}

/// Immutable authenticated connection metadata exposed to request handlers.
#[derive(Clone)]
pub struct InternalMtlsConnectionInfo {
    remote_address: SocketAddr,
    peer_identity: Arc<MtlsPeerIdentity>,
}

impl InternalMtlsConnectionInfo {
    #[must_use]
    pub const fn remote_address(&self) -> SocketAddr {
        self.remote_address
    }

    #[must_use]
    pub fn peer_identity(&self) -> &MtlsPeerIdentity {
        &self.peer_identity
    }
}

impl fmt::Debug for InternalMtlsConnectionInfo {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InternalMtlsConnectionInfo")
            .field("remote_address", &self.remote_address)
            .field("peer_identity", &"[REDACTED]")
            .finish()
    }
}

/// Authenticated TLS stream with immutable connection metadata.
pub struct InternalMtlsStream {
    inner: TlsStream<TcpStream>,
    connection_info: InternalMtlsConnectionInfo,
}

impl InternalMtlsStream {
    #[must_use]
    pub const fn connection_info(&self) -> &InternalMtlsConnectionInfo {
        &self.connection_info
    }
}

impl fmt::Debug for InternalMtlsStream {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("InternalMtlsStream([REDACTED])")
    }
}

impl AsyncRead for InternalMtlsStream {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_read(context, buffer)
    }
}

impl AsyncWrite for InternalMtlsStream {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<Result<usize, io::Error>> {
        Pin::new(&mut self.get_mut().inner).poll_write(context, buffer)
    }

    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Result<(), io::Error>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(context)
    }

    fn poll_shutdown(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), io::Error>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(context)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffers: &[io::IoSlice<'_>],
    ) -> Poll<Result<usize, io::Error>> {
        Pin::new(&mut self.get_mut().inner).poll_write_vectored(context, buffers)
    }
}

#[derive(Default)]
struct ListenerStatsInner {
    in_flight: AtomicUsize,
    maximum_in_flight: AtomicUsize,
    failures: AtomicUsize,
    timeouts: AtomicUsize,
}

/// Read-only process-local counters for one listener instance.
#[derive(Clone, Default)]
pub struct InternalMtlsListenerStats {
    inner: Arc<ListenerStatsInner>,
}

impl InternalMtlsListenerStats {
    #[must_use]
    pub fn in_flight_handshakes(&self) -> usize {
        self.inner.in_flight.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn maximum_in_flight_handshakes(&self) -> usize {
        self.inner.maximum_in_flight.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn failed_handshakes(&self) -> usize {
        self.inner.failures.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn timed_out_handshakes(&self) -> usize {
        self.inner.timeouts.load(Ordering::Relaxed)
    }
}

impl fmt::Debug for InternalMtlsListenerStats {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InternalMtlsListenerStats")
            .field("in_flight_handshakes", &self.in_flight_handshakes())
            .field(
                "maximum_in_flight_handshakes",
                &self.maximum_in_flight_handshakes(),
            )
            .field("failed_handshakes", &self.failed_handshakes())
            .field("timed_out_handshakes", &self.timed_out_handshakes())
            .finish()
    }
}

/// Axum listener that admits only bounded, authenticated mTLS streams.
pub struct InternalMtlsListener {
    listener: TcpListener,
    tls_acceptor: TlsAcceptor,
    server_config: InternalMtlsServerConfig,
    trust_domain: Arc<SpiffeTrustDomain>,
    certificate_policy: MtlsCertificatePolicy,
    policy: InternalMtlsListenerPolicy,
    handshakes: JoinSet<Result<InternalMtlsStream, InternalMtlsHandshakeError>>,
    stats: InternalMtlsListenerStats,
}

impl InternalMtlsListener {
    /// Binds a new offline-capable internal mTLS listener.
    ///
    /// # Errors
    ///
    /// Returns the operating-system bind error without changing any runtime
    /// route or spawning background work.
    pub async fn bind(
        address: SocketAddr,
        server_config: InternalMtlsServerConfig,
        trust_domain: SpiffeTrustDomain,
        policy: InternalMtlsListenerPolicy,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind(address).await?;
        Ok(Self::from_listener(
            listener,
            server_config,
            trust_domain,
            policy,
        ))
    }

    fn from_listener(
        listener: TcpListener,
        server_config: InternalMtlsServerConfig,
        trust_domain: SpiffeTrustDomain,
        policy: InternalMtlsListenerPolicy,
    ) -> Self {
        Self {
            listener,
            tls_acceptor: TlsAcceptor::from(server_config.rustls_config()),
            server_config,
            trust_domain: Arc::new(trust_domain),
            certificate_policy: MtlsCertificatePolicy::strict(),
            policy,
            handshakes: JoinSet::new(),
            stats: InternalMtlsListenerStats::default(),
        }
    }

    #[must_use]
    pub fn stats(&self) -> InternalMtlsListenerStats {
        self.stats.clone()
    }

    fn spawn_handshake(&mut self, socket: TcpStream, remote_address: SocketAddr) {
        let acceptor = self.tls_acceptor.clone();
        let server_config = self.server_config.clone();
        let trust_domain = self.trust_domain.clone();
        let certificate_policy = self.certificate_policy;
        let timeout = self.policy.handshake_timeout;
        let stats = self.stats.inner.clone();
        let guard = InFlightHandshake::start(stats.clone());
        self.handshakes.spawn(async move {
            let _guard = guard;
            let result = perform_handshake(
                socket,
                remote_address,
                acceptor,
                server_config,
                trust_domain,
                certificate_policy,
                timeout,
            )
            .await;
            if let Err(error) = result {
                stats.failures.fetch_add(1, Ordering::Relaxed);
                if error == InternalMtlsHandshakeError::Timeout {
                    stats.timeouts.fetch_add(1, Ordering::Relaxed);
                }
            }
            result
        });
    }

    fn take_completed(
        result: Option<Result<Result<InternalMtlsStream, InternalMtlsHandshakeError>, JoinError>>,
    ) -> Option<InternalMtlsStream> {
        match result {
            Some(Ok(Ok(stream))) => Some(stream),
            Some(Ok(Err(_)) | Err(_)) | None => None,
        }
    }
}

impl fmt::Debug for InternalMtlsListener {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("InternalMtlsListener([REDACTED])")
    }
}

impl Drop for InternalMtlsListener {
    fn drop(&mut self) {
        self.handshakes.abort_all();
    }
}

impl Listener for InternalMtlsListener {
    type Io = InternalMtlsStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            if self.handshakes.is_empty() {
                match self.listener.accept().await {
                    Ok((socket, remote_address)) => {
                        self.spawn_handshake(socket, remote_address);
                    }
                    Err(error) => handle_accept_error(&error).await,
                }
                continue;
            }

            if self.handshakes.len() >= self.policy.handshake_capacity {
                if let Some(stream) = Self::take_completed(self.handshakes.join_next().await) {
                    let remote_address = stream.connection_info.remote_address;
                    return (stream, remote_address);
                }
                continue;
            }

            tokio::select! {
                biased;
                result = self.handshakes.join_next() => {
                    if let Some(stream) = Self::take_completed(result) {
                        let remote_address = stream.connection_info.remote_address;
                        return (stream, remote_address);
                    }
                }
                accepted = self.listener.accept() => {
                    match accepted {
                        Ok((socket, remote_address)) => self.spawn_handshake(socket, remote_address),
                        Err(error) => handle_accept_error(&error).await,
                    }
                }
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.listener.local_addr()
    }
}

impl Connected<IncomingStream<'_, InternalMtlsListener>> for InternalMtlsConnectionInfo {
    fn connect_info(stream: IncomingStream<'_, InternalMtlsListener>) -> Self {
        stream.io().connection_info.clone()
    }
}

struct InFlightHandshake {
    stats: Arc<ListenerStatsInner>,
}

impl InFlightHandshake {
    fn start(stats: Arc<ListenerStatsInner>) -> Self {
        let in_flight = stats.in_flight.fetch_add(1, Ordering::Relaxed) + 1;
        stats
            .maximum_in_flight
            .fetch_max(in_flight, Ordering::Relaxed);
        Self { stats }
    }
}

impl Drop for InFlightHandshake {
    fn drop(&mut self) {
        self.stats.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

async fn perform_handshake(
    socket: TcpStream,
    remote_address: SocketAddr,
    acceptor: TlsAcceptor,
    server_config: InternalMtlsServerConfig,
    trust_domain: Arc<SpiffeTrustDomain>,
    certificate_policy: MtlsCertificatePolicy,
    timeout: Duration,
) -> Result<InternalMtlsStream, InternalMtlsHandshakeError> {
    let stream = time::timeout(timeout, acceptor.accept(socket))
        .await
        .map_err(|_| InternalMtlsHandshakeError::Timeout)?
        .map_err(|_| InternalMtlsHandshakeError::PeerUntrusted)?;
    let peer_certificates = stream
        .get_ref()
        .1
        .peer_certificates()
        .ok_or(InternalMtlsHandshakeError::PeerUntrusted)?;
    if !server_config.verified_peer_chain_is_bounded(peer_certificates) {
        return Err(InternalMtlsHandshakeError::PeerCertificateInvalid);
    }
    let leaf = peer_certificates
        .first()
        .ok_or(InternalMtlsHandshakeError::PeerCertificateInvalid)?;
    let peer_identity =
        peer_identity_from_verified_leaf_der(leaf.as_ref(), &trust_domain, &certificate_policy)
            .map_err(|error| match error {
                crate::PeerCertificateError::CertificateTooLarge
                | crate::PeerCertificateError::CertificateInvalid
                | crate::PeerCertificateError::SubjectAltNamesInvalid => {
                    InternalMtlsHandshakeError::PeerCertificateInvalid
                }
                crate::PeerCertificateError::IdentityInvalid => {
                    InternalMtlsHandshakeError::PeerIdentityInvalid
                }
            })?;

    Ok(InternalMtlsStream {
        inner: stream,
        connection_info: InternalMtlsConnectionInfo {
            remote_address,
            peer_identity: Arc::new(peer_identity),
        },
    })
}

async fn handle_accept_error(error: &io::Error) {
    if !matches!(
        error.kind(),
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
    ) {
        time::sleep(Duration::from_secs(1)).await;
    }
}
