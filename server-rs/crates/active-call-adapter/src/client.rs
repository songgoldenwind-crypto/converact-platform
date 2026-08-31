use std::{error::Error, fmt, net::IpAddr, sync::Arc, time::Duration};

use converact_voice_agent_contracts::ChannelAgentSessionId;
use reqwest::{Client, Response};
use rustls::{ClientConfig as RustlsClientConfig, RootCertStore};
use serde::Deserialize;
use serde_json::Value;
use url::{Host, Url};

use crate::{AdapterCommand, AdapterError, encode_command};

const MAX_TIMEOUT_MS: u64 = 30_000;
const MIN_RESPONSE_BYTES: usize = 64;
const MAX_RESPONSE_BYTES: usize = 1_048_576;
const MAX_COMMAND_BYTES: usize = 65_536;
const MAX_PLAYBOOK_BYTES: usize = 65_536;
const MAX_PLAYBOOK_REQUEST_BYTES: usize = 131_072;
const MAX_SSE_OVERHEAD_BYTES: usize = 4_096;
const STATUS_QUERY_ATTEMPTS: usize = 2;
const CLIENT_USER_AGENT: &str = "converact-active-call-adapter/1";

/// Invalid local client configuration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClientConfigError {
    InvalidEndpoint,
    InvalidTimeout,
    InvalidResponseLimit,
}

impl ClientConfigError {
    /// Returns the stable machine code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidEndpoint => "active_call_endpoint_invalid",
            Self::InvalidTimeout => "active_call_timeout_invalid",
            Self::InvalidResponseLimit => "active_call_response_limit_invalid",
        }
    }
}

impl fmt::Display for ClientConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ClientConfigError {}

/// Validated bounded transport configuration.
#[derive(Clone)]
pub struct ClientConfig {
    endpoint: Url,
    timeout: Duration,
    max_response_bytes: usize,
}

impl ClientConfig {
    /// Parses the private process endpoint and bounded request policy.
    ///
    /// Plaintext placement policy is enforced by [`ActiveCallClient::connect`].
    ///
    /// # Errors
    ///
    /// Rejects malformed endpoints, credentials, non-root paths, fragments, queries, zero or
    /// excessive timeouts, and response limits outside the frozen bounds.
    pub fn new(
        endpoint: impl AsRef<str>,
        timeout_ms: u64,
        max_response_bytes: usize,
    ) -> Result<Self, ClientConfigError> {
        let endpoint =
            Url::parse(endpoint.as_ref()).map_err(|_| ClientConfigError::InvalidEndpoint)?;
        if !matches!(endpoint.scheme(), "http" | "https")
            || endpoint.cannot_be_a_base()
            || endpoint.host().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.path() != "/"
        {
            return Err(ClientConfigError::InvalidEndpoint);
        }
        if timeout_ms == 0 || timeout_ms > MAX_TIMEOUT_MS {
            return Err(ClientConfigError::InvalidTimeout);
        }
        if !(MIN_RESPONSE_BYTES..=MAX_RESPONSE_BYTES).contains(&max_response_bytes) {
            return Err(ClientConfigError::InvalidResponseLimit);
        }
        Ok(Self {
            endpoint,
            timeout: Duration::from_millis(timeout_ms),
            max_response_bytes,
        })
    }
}

impl fmt::Debug for ClientConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ClientConfig([REDACTED])")
    }
}

/// High-level failure category used for retry and reconciliation decisions.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClientFailureKind {
    InvalidConfiguration,
    Unavailable,
    OutcomeUnknown,
    Rejected,
    InvalidResponse,
}

/// Sanitized client failure that never embeds endpoint or response content.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ClientError {
    kind: ClientFailureKind,
    code: &'static str,
}

impl ClientError {
    const fn new(kind: ClientFailureKind, code: &'static str) -> Self {
        Self { kind, code }
    }

    /// Returns the retry/reconciliation category.
    #[must_use]
    pub const fn kind(self) -> ClientFailureKind {
        self.kind
    }

    /// Returns the stable machine code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for ClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for ClientError {}

/// Validated mutation sent to one Active Call session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveCallCommand {
    session_id: ChannelAgentSessionId,
    payload: Value,
}

impl ActiveCallCommand {
    /// Encodes the safe command subset and binds it to a bounded session identifier.
    ///
    /// # Errors
    ///
    /// Returns an adapter error when command fields violate the frozen bounds.
    pub fn try_new(
        session_id: ChannelAgentSessionId,
        command: AdapterCommand,
    ) -> Result<Self, AdapterError> {
        Ok(Self {
            session_id,
            payload: encode_command(command)?,
        })
    }
}

/// Acknowledgement that the pinned process accepted a command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandAccepted {
    pub session_id: ChannelAgentSessionId,
}

/// Bounded inline Active Call Playbook prepared by the platform artifact boundary.
#[derive(Clone, Eq, PartialEq)]
pub struct InlinePlaybook(Box<str>);

impl InlinePlaybook {
    /// Validates the minimum upstream Playbook framing without parsing tenant configuration.
    ///
    /// # Errors
    ///
    /// Rejects missing YAML front matter, control-bearing input and content over 64 KiB.
    pub fn try_new(content: impl AsRef<str>) -> Result<Self, ClientError> {
        let content = content.as_ref();
        let has_front_matter = content.starts_with("---\n") || content.starts_with("---\r\n");
        if content.is_empty()
            || content.len() > MAX_PLAYBOOK_BYTES
            || !has_front_matter
            || content
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        {
            return Err(invalid_configuration("active_call_playbook_invalid"));
        }
        Ok(Self(content.into()))
    }
}

impl fmt::Debug for InlinePlaybook {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("InlinePlaybook([REDACTED])")
    }
}

/// Session identity reserved by Active Call for one future media connection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReservedPlaybookSession {
    pub session_id: ChannelAgentSessionId,
}

/// Acknowledgement that an attached Playbook conversation is started.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationStarted {
    pub session_id: ChannelAgentSessionId,
}

/// Current process-local Playbook reservation observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlaybookReservationState {
    Pending,
    Attached,
    MediaReady,
    DisclosureCompleted,
    Started,
    Active,
    Terminal,
    NotFound,
}

/// Current session status from Active Call's `/list` authority surface.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveCallSessionState {
    Active,
    NotFound,
}

/// Kind of bounded server-sent event returned by the pinned process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveCallEventKind {
    Event,
    Command,
}

/// One bounded SSE frame without leaking Reqwest types across the adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveCallEvent {
    pub kind: ActiveCallEventKind,
    pub data: Box<str>,
}

/// Bounded Active Call private-process client.
pub struct ActiveCallClient {
    config: ClientConfig,
    client: Client,
}

impl ActiveCallClient {
    /// Builds a client after enforcing plaintext loopback and fixed TLS roots.
    ///
    /// # Errors
    ///
    /// Rejects non-loopback plaintext endpoints and transport construction failures.
    pub fn connect(config: ClientConfig) -> Result<Self, ClientError> {
        validate_transport(&config.endpoint)?;
        let client = build_client(config.timeout)?;
        Ok(Self { config, client })
    }

    /// Sends one mutation exactly once.
    ///
    /// # Errors
    ///
    /// Any timeout or ambiguous response is `OutcomeUnknown`; callers must query before deciding
    /// whether to retry. Deterministic 4xx rejection is returned as `Rejected`.
    pub async fn send_command(
        &self,
        command: ActiveCallCommand,
    ) -> Result<CommandAccepted, ClientError> {
        let encoded = serde_json::to_vec(&command.payload).map_err(|_| {
            ClientError::new(
                ClientFailureKind::InvalidConfiguration,
                "active_call_command_invalid",
            )
        })?;
        if encoded.len() > MAX_COMMAND_BYTES {
            return Err(ClientError::new(
                ClientFailureKind::InvalidConfiguration,
                "active_call_command_too_large",
            ));
        }
        let url = endpoint_url(&self.config.endpoint, "command", Some(&command.session_id))?;
        let operation = async {
            let response = self
                .client
                .post(url)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(encoded)
                .send()
                .await
                .map_err(|_| command_unknown("active_call_command_transport_unknown"))?;
            self.accept_command_response(response, command.session_id)
                .await
        };
        tokio::time::timeout(self.config.timeout, operation)
            .await
            .map_err(|_| command_unknown("active_call_command_timeout"))?
    }

    /// Associates one bounded inline Playbook with a platform-owned future session identity.
    ///
    /// The request deliberately omits upstream `to` and `type` fields. Telephony and media-leg
    /// selection remain `RustPBX` responsibilities.
    ///
    /// # Errors
    ///
    /// Any timeout, server failure, ambiguous response or response-identity drift is
    /// `OutcomeUnknown`. Callers query the reservation before any later reconciliation decision.
    pub async fn reserve_playbook(
        &self,
        session_id: ChannelAgentSessionId,
        playbook: InlinePlaybook,
    ) -> Result<ReservedPlaybookSession, ClientError> {
        let encoded = serde_json::to_vec(&serde_json::json!({
            "content": playbook.0,
            "session_id": session_id.as_str(),
        }))
        .map_err(|_| invalid_configuration("active_call_playbook_request_invalid"))?;
        if encoded.len() > MAX_PLAYBOOK_REQUEST_BYTES {
            return Err(invalid_configuration(
                "active_call_playbook_request_too_large",
            ));
        }
        let url = playbook_reservation_url(&self.config.endpoint)?;
        let operation = async {
            let response = self
                .client
                .post(url)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(encoded)
                .send()
                .await
                .map_err(|_| reservation_unknown("active_call_playbook_transport_unknown"))?;
            self.accept_playbook_response(response, session_id).await
        };
        tokio::time::timeout(self.config.timeout, operation)
            .await
            .map_err(|_| reservation_unknown("active_call_playbook_timeout"))?
    }

    /// Starts an already attached platform-owned Playbook conversation exactly once.
    ///
    /// The overlay treats a repeated start for the same started session as an idempotent replay.
    /// A timeout or ambiguous response remains `OutcomeUnknown`; callers must query the
    /// reservation state and must not issue a blind retry.
    ///
    /// # Errors
    ///
    /// Returns `Rejected` when the session is still pending or absent and `OutcomeUnknown` for
    /// transport, timeout, server, malformed-response or identity-drift failures.
    pub async fn start_playbook_conversation(
        &self,
        session_id: ChannelAgentSessionId,
    ) -> Result<ConversationStarted, ClientError> {
        let url = playbook_reservation_start_url(&self.config.endpoint, &session_id)?;
        let operation = async {
            let response =
                self.client.post(url).send().await.map_err(|_| {
                    reservation_unknown("active_call_playbook_start_transport_unknown")
                })?;
            self.accept_playbook_start_response(response, session_id)
                .await
        };
        tokio::time::timeout(self.config.timeout, operation)
            .await
            .map_err(|_| reservation_unknown("active_call_playbook_start_timeout"))?
    }

    /// Queries the process-local Playbook reservation overlay, retrying only this read operation.
    ///
    /// `NotFound` is an observation, not proof that no call-side effect exists. Reconciliation
    /// policy remains with the durable worker.
    ///
    /// # Errors
    ///
    /// Returns `Unavailable` after bounded retries, `Rejected` for deterministic non-404 client
    /// responses, or `InvalidResponse` for an unbounded, malformed or identity-drifting response.
    pub async fn query_playbook_reservation(
        &self,
        session_id: &ChannelAgentSessionId,
    ) -> Result<PlaybookReservationState, ClientError> {
        let url = playbook_reservation_status_url(&self.config.endpoint, session_id)?;
        let mut last_error = status_unavailable("active_call_playbook_status_unavailable");
        for _ in 0..STATUS_QUERY_ATTEMPTS {
            let result = tokio::time::timeout(
                self.config.timeout,
                self.fetch_playbook_reservation(url.clone(), session_id),
            )
            .await
            .map_err(|_| status_unavailable("active_call_playbook_status_timeout"));
            match result.and_then(std::convert::identity) {
                Ok(state) => return Ok(state),
                Err(error) if error.kind() == ClientFailureKind::Unavailable => {
                    last_error = error;
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_error)
    }

    /// Queries one session through `/list`, retrying only this read-only operation.
    ///
    /// # Errors
    ///
    /// Returns `Unavailable` after bounded status retries or `InvalidResponse` for malformed or
    /// oversized authority output.
    pub async fn query_session(
        &self,
        session_id: &ChannelAgentSessionId,
    ) -> Result<ActiveCallSessionState, ClientError> {
        let url = endpoint_url(&self.config.endpoint, "list", None)?;
        let mut last_error = ClientError::new(
            ClientFailureKind::Unavailable,
            "active_call_status_unavailable",
        );
        for _ in 0..STATUS_QUERY_ATTEMPTS {
            let result = tokio::time::timeout(
                self.config.timeout,
                self.fetch_status(url.clone(), session_id),
            )
            .await
            .map_err(|_| status_unavailable("active_call_status_timeout"));
            match result.and_then(std::convert::identity) {
                Ok(state) => return Ok(state),
                Err(error) if error.kind() == ClientFailureKind::Unavailable => {
                    last_error = error;
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_error)
    }

    /// Opens the bounded `/events/{id}` SSE surface without automatic retry.
    ///
    /// # Errors
    ///
    /// Returns a sanitized transport or response failure. Reconnection policy belongs to the
    /// durable worker so gaps can be reconciled against `/list`.
    pub async fn events(
        &self,
        session_id: &ChannelAgentSessionId,
    ) -> Result<ActiveCallEventStream, ClientError> {
        let url = endpoint_url(&self.config.endpoint, "events", Some(session_id))?;
        let response = tokio::time::timeout(self.config.timeout, self.client.get(url).send())
            .await
            .map_err(|_| {
                ClientError::new(ClientFailureKind::Unavailable, "active_call_events_timeout")
            })?
            .map_err(|_| {
                ClientError::new(
                    ClientFailureKind::Unavailable,
                    "active_call_events_transport_failed",
                )
            })?;
        if !response.status().is_success() {
            return Err(ClientError::new(
                ClientFailureKind::Rejected,
                "active_call_events_rejected",
            ));
        }
        let is_event_stream = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"));
        if !is_event_stream {
            return Err(invalid_response("active_call_events_content_type_invalid"));
        }
        Ok(ActiveCallEventStream {
            response,
            buffer: Vec::with_capacity(self.config.max_response_bytes.min(8_192)),
            max_event_bytes: self.config.max_response_bytes,
            read_timeout: self.config.timeout,
        })
    }

    async fn accept_command_response(
        &self,
        response: Response,
        session_id: ChannelAgentSessionId,
    ) -> Result<CommandAccepted, ClientError> {
        let status = response.status();
        let body = collect_bounded(response, self.config.max_response_bytes)
            .await
            .map_err(|_| command_unknown("active_call_command_response_unbounded"))?;
        if status.is_success() {
            let acknowledgement: CommandResponse = serde_json::from_slice(&body)
                .map_err(|_| command_unknown("active_call_command_response_invalid"))?;
            if acknowledgement.status == "sent" && acknowledgement.id == session_id.as_str() {
                return Ok(CommandAccepted { session_id });
            }
            return Err(command_unknown("active_call_command_ack_invalid"));
        }
        if status.is_client_error() {
            return Err(ClientError::new(
                ClientFailureKind::Rejected,
                "active_call_command_rejected",
            ));
        }
        Err(command_unknown("active_call_command_server_unknown"))
    }

    async fn accept_playbook_response(
        &self,
        response: Response,
        expected_session_id: ChannelAgentSessionId,
    ) -> Result<ReservedPlaybookSession, ClientError> {
        let status = response.status();
        let body = collect_bounded(response, self.config.max_response_bytes)
            .await
            .map_err(|_| reservation_unknown("active_call_playbook_response_unbounded"))?;
        if status.is_success() {
            let acknowledgement: PlaybookResponse = serde_json::from_slice(&body)
                .map_err(|_| reservation_unknown("active_call_playbook_response_invalid"))?;
            let session_id = ChannelAgentSessionId::parse(acknowledgement.session_id)
                .map_err(|_| reservation_unknown("active_call_playbook_session_invalid"))?;
            if session_id != expected_session_id {
                return Err(reservation_unknown("active_call_playbook_session_mismatch"));
            }
            return Ok(ReservedPlaybookSession { session_id });
        }
        if status.is_client_error() {
            return Err(ClientError::new(
                ClientFailureKind::Rejected,
                "active_call_playbook_rejected",
            ));
        }
        Err(reservation_unknown("active_call_playbook_server_unknown"))
    }

    async fn accept_playbook_start_response(
        &self,
        response: Response,
        expected_session_id: ChannelAgentSessionId,
    ) -> Result<ConversationStarted, ClientError> {
        let status = response.status();
        let body = collect_bounded(response, self.config.max_response_bytes)
            .await
            .map_err(|_| reservation_unknown("active_call_playbook_start_response_unbounded"))?;
        if status.is_success() {
            let acknowledgement: PlaybookReservationResponse = serde_json::from_slice(&body)
                .map_err(|_| reservation_unknown("active_call_playbook_start_response_invalid"))?;
            if acknowledgement.session_id != expected_session_id.as_str()
                || acknowledgement.state != "started"
            {
                return Err(reservation_unknown(
                    "active_call_playbook_start_ack_invalid",
                ));
            }
            return Ok(ConversationStarted {
                session_id: expected_session_id,
            });
        }
        if status.is_client_error() {
            return Err(ClientError::new(
                ClientFailureKind::Rejected,
                "active_call_playbook_start_rejected",
            ));
        }
        Err(reservation_unknown(
            "active_call_playbook_start_server_unknown",
        ))
    }

    async fn fetch_playbook_reservation(
        &self,
        url: Url,
        expected_session_id: &ChannelAgentSessionId,
    ) -> Result<PlaybookReservationState, ClientError> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|_| status_unavailable("active_call_playbook_status_transport_failed"))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(PlaybookReservationState::NotFound);
        }
        if response.status().is_server_error() {
            return Err(status_unavailable(
                "active_call_playbook_status_server_failed",
            ));
        }
        if !response.status().is_success() {
            return Err(ClientError::new(
                ClientFailureKind::Rejected,
                "active_call_playbook_status_rejected",
            ));
        }
        let body = collect_bounded(response, self.config.max_response_bytes).await?;
        let observation: PlaybookReservationResponse = serde_json::from_slice(&body)
            .map_err(|_| invalid_response("active_call_playbook_status_response_invalid"))?;
        if observation.session_id != expected_session_id.as_str() {
            return Err(invalid_response(
                "active_call_playbook_status_session_mismatch",
            ));
        }
        match observation.state.as_str() {
            "pending" => Ok(PlaybookReservationState::Pending),
            "attached" => Ok(PlaybookReservationState::Attached),
            "media_ready" => Ok(PlaybookReservationState::MediaReady),
            "disclosure_completed" => Ok(PlaybookReservationState::DisclosureCompleted),
            "started" => Ok(PlaybookReservationState::Started),
            "active" => Ok(PlaybookReservationState::Active),
            "terminal" => Ok(PlaybookReservationState::Terminal),
            _ => Err(invalid_response("active_call_playbook_status_unknown")),
        }
    }

    async fn fetch_status(
        &self,
        url: Url,
        session_id: &ChannelAgentSessionId,
    ) -> Result<ActiveCallSessionState, ClientError> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|_| status_unavailable("active_call_status_transport_failed"))?;
        if response.status().is_server_error() {
            return Err(status_unavailable("active_call_status_server_failed"));
        }
        if !response.status().is_success() {
            return Err(ClientError::new(
                ClientFailureKind::Rejected,
                "active_call_status_rejected",
            ));
        }
        let body = collect_bounded(response, self.config.max_response_bytes).await?;
        let list: ListResponse = serde_json::from_slice(&body).map_err(|_| {
            ClientError::new(
                ClientFailureKind::InvalidResponse,
                "active_call_status_response_invalid",
            )
        })?;
        Ok(
            if list
                .active_calls
                .iter()
                .any(|call| call.id == session_id.as_str())
            {
                ActiveCallSessionState::Active
            } else {
                ActiveCallSessionState::NotFound
            },
        )
    }
}

impl fmt::Debug for ActiveCallClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ActiveCallClient([REDACTED])")
    }
}

/// Streaming bounded SSE reader owned by one worker.
pub struct ActiveCallEventStream {
    response: Response,
    buffer: Vec<u8>,
    max_event_bytes: usize,
    read_timeout: Duration,
}

impl ActiveCallEventStream {
    /// Returns the next complete `event` or `command` frame.
    ///
    /// # Errors
    ///
    /// Rejects unknown frame kinds, invalid UTF-8, oversized frames, read timeouts and transport
    /// failures. It never retries or hides a possible event gap.
    pub async fn next_event(&mut self) -> Result<Option<ActiveCallEvent>, ClientError> {
        loop {
            if let Some(frame) = take_sse_frame(&mut self.buffer) {
                if let Some(event) = parse_sse_frame(&frame, self.max_event_bytes)? {
                    return Ok(Some(event));
                }
                continue;
            }
            let chunk = tokio::time::timeout(self.read_timeout, self.response.chunk())
                .await
                .map_err(|_| {
                    ClientError::new(
                        ClientFailureKind::Unavailable,
                        "active_call_events_read_timeout",
                    )
                })?
                .map_err(|_| {
                    ClientError::new(
                        ClientFailureKind::Unavailable,
                        "active_call_events_read_failed",
                    )
                })?;
            let Some(chunk) = chunk else {
                if self.buffer.is_empty() {
                    return Ok(None);
                }
                return Err(invalid_response("active_call_events_truncated"));
            };
            let max_buffer = self
                .max_event_bytes
                .checked_add(MAX_SSE_OVERHEAD_BYTES)
                .ok_or_else(|| invalid_response("active_call_events_too_large"))?;
            if self.buffer.len().saturating_add(chunk.len()) > max_buffer {
                return Err(invalid_response("active_call_events_too_large"));
            }
            self.buffer.extend_from_slice(&chunk);
        }
    }
}

impl fmt::Debug for ActiveCallEventStream {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ActiveCallEventStream([REDACTED])")
    }
}

#[derive(Deserialize)]
struct CommandResponse {
    status: String,
    id: String,
}

#[derive(Deserialize)]
struct PlaybookResponse {
    session_id: String,
}

#[derive(Deserialize)]
struct PlaybookReservationResponse {
    session_id: String,
    state: String,
}

#[derive(Deserialize)]
struct ListResponse {
    active_calls: Vec<ListCall>,
}

#[derive(Deserialize)]
struct ListCall {
    id: String,
}

fn validate_transport(endpoint: &Url) -> Result<(), ClientError> {
    if endpoint.scheme() == "https" {
        return Ok(());
    }
    let loopback = match endpoint.host() {
        Some(Host::Ipv4(address)) => IpAddr::V4(address).is_loopback(),
        Some(Host::Ipv6(address)) => IpAddr::V6(address).is_loopback(),
        Some(Host::Domain(_)) | None => false,
    };
    if loopback {
        Ok(())
    } else {
        Err(ClientError::new(
            ClientFailureKind::InvalidConfiguration,
            "active_call_plaintext_not_loopback",
        ))
    }
}

fn build_client(timeout: Duration) -> Result<Client, ClientError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let roots = webpki_roots::TLS_SERVER_ROOTS
        .iter()
        .cloned()
        .collect::<RootCertStore>();
    let tls = RustlsClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| invalid_configuration("active_call_tls_invalid"))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Client::builder()
        .tls_backend_preconfigured(tls)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .referer(false)
        .connect_timeout(timeout)
        .pool_max_idle_per_host(1)
        .http1_only()
        .tls_sslkeylogfile(false)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .tcp_nodelay(true)
        .user_agent(CLIENT_USER_AGENT)
        .build()
        .map_err(|_| invalid_configuration("active_call_client_build_failed"))
}

fn endpoint_url(
    base: &Url,
    route: &str,
    session_id: Option<&ChannelAgentSessionId>,
) -> Result<Url, ClientError> {
    let mut url = base.clone();
    let mut segments = url
        .path_segments_mut()
        .map_err(|()| invalid_configuration("active_call_endpoint_invalid"))?;
    segments.pop_if_empty().push(route);
    if let Some(session_id) = session_id {
        segments.push(session_id.as_str());
    }
    drop(segments);
    Ok(url)
}

fn playbook_reservation_url(base: &Url) -> Result<Url, ClientError> {
    let mut url = base.clone();
    let mut segments = url
        .path_segments_mut()
        .map_err(|()| invalid_configuration("active_call_endpoint_invalid"))?;
    segments
        .pop_if_empty()
        .push("api")
        .push("playbook")
        .push("run");
    drop(segments);
    Ok(url)
}

fn playbook_reservation_status_url(
    base: &Url,
    session_id: &ChannelAgentSessionId,
) -> Result<Url, ClientError> {
    let mut url = base.clone();
    let mut segments = url
        .path_segments_mut()
        .map_err(|()| invalid_configuration("active_call_endpoint_invalid"))?;
    segments
        .pop_if_empty()
        .push("api")
        .push("playbook")
        .push("reservations")
        .push(session_id.as_str());
    drop(segments);
    Ok(url)
}

fn playbook_reservation_start_url(
    base: &Url,
    session_id: &ChannelAgentSessionId,
) -> Result<Url, ClientError> {
    let mut url = playbook_reservation_status_url(base, session_id)?;
    url.path_segments_mut()
        .map_err(|()| invalid_configuration("active_call_endpoint_invalid"))?
        .push("start");
    Ok(url)
}

async fn collect_bounded(mut response: Response, max_bytes: usize) -> Result<Vec<u8>, ClientError> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(invalid_response("active_call_response_too_large"));
    }
    let mut body = Vec::with_capacity(
        response
            .content_length()
            .and_then(|length| usize::try_from(length).ok())
            .unwrap_or(0)
            .min(max_bytes),
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| invalid_response("active_call_response_read_failed"))?
    {
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(invalid_response("active_call_response_too_large"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn take_sse_frame(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
    let delimiter = buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| (index, 2))
        .or_else(|| {
            buffer
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|index| (index, 4))
        })?;
    let tail = buffer.split_off(delimiter.0 + delimiter.1);
    let mut frame = std::mem::replace(buffer, tail);
    frame.truncate(delimiter.0);
    Some(frame)
}

fn parse_sse_frame(
    frame: &[u8],
    max_event_bytes: usize,
) -> Result<Option<ActiveCallEvent>, ClientError> {
    let text = std::str::from_utf8(frame)
        .map_err(|_| invalid_response("active_call_events_utf8_invalid"))?;
    let mut event_name = None;
    let mut data = String::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.starts_with(':') || line.is_empty() {
            continue;
        }
        if let Some(value) = line.strip_prefix("event:") {
            event_name = Some(value.trim());
        } else if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.strip_prefix(' ').unwrap_or(value));
        }
    }
    if event_name.is_none() && data.is_empty() {
        return Ok(None);
    }
    if data.is_empty() || data.len() > max_event_bytes {
        return Err(invalid_response("active_call_events_data_invalid"));
    }
    let kind = match event_name {
        Some("event") => ActiveCallEventKind::Event,
        Some("command") => ActiveCallEventKind::Command,
        _ => return Err(invalid_response("active_call_events_kind_unknown")),
    };
    Ok(Some(ActiveCallEvent {
        kind,
        data: data.into(),
    }))
}

const fn invalid_configuration(code: &'static str) -> ClientError {
    ClientError::new(ClientFailureKind::InvalidConfiguration, code)
}

const fn invalid_response(code: &'static str) -> ClientError {
    ClientError::new(ClientFailureKind::InvalidResponse, code)
}

const fn status_unavailable(code: &'static str) -> ClientError {
    ClientError::new(ClientFailureKind::Unavailable, code)
}

const fn command_unknown(code: &'static str) -> ClientError {
    ClientError::new(ClientFailureKind::OutcomeUnknown, code)
}

const fn reservation_unknown(code: &'static str) -> ClientError {
    ClientError::new(ClientFailureKind::OutcomeUnknown, code)
}
