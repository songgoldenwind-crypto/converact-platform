use std::{
    collections::HashMap,
    error::Error,
    fmt,
    net::{Ipv4Addr, Ipv6Addr},
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use serde_json::Value;
use tokio::{net::TcpStream, sync::oneshot, task::JoinHandle};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        http::{HeaderValue, header::AUTHORIZATION},
        protocol::WebSocketConfig,
    },
};
use url::{Host, Url};
use zeroize::Zeroizing;

use crate::{OriginateRequest, RwiCommand, RwiError, encode_command};

const MIN_TIMEOUT_MS: u64 = 10;
const MAX_TIMEOUT_MS: u64 = 300_000;
const MIN_MESSAGE_BYTES: usize = 64;
const MAX_MESSAGE_BYTES: usize = 4 * 1_024 * 1_024;
const MAX_PENDING_ACTIONS: usize = 4_096;
const MAX_SECRET_REF_BYTES: usize = 512;
const MAX_SECRET_BYTES: usize = 4_096;
const RWI_PATH: &str = "/rwi/v1";

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type SocketWriter = SplitSink<Socket, Message>;
type PendingActions = Arc<Mutex<HashMap<Box<str>, oneshot::Sender<CommandOutcome>>>>;

/// Sanitized RWI client failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClientError {
    ConfigInvalid,
    PlaintextRejected,
    SecretUnavailable,
    ConnectFailed,
    ConnectTimeout,
    CapacityUnavailable,
    CommandInvalid(RwiError),
}

impl ClientError {
    /// Returns a stable machine-readable code without endpoint or secret material.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::ConfigInvalid => "rustpbx_rwi_config_invalid",
            Self::PlaintextRejected => "rustpbx_rwi_plaintext_rejected",
            Self::SecretUnavailable => "rustpbx_rwi_secret_unavailable",
            Self::ConnectFailed => "rustpbx_rwi_connect_failed",
            Self::ConnectTimeout => "rustpbx_rwi_connect_timeout",
            Self::CapacityUnavailable => "rustpbx_rwi_pending_capacity_unavailable",
            Self::CommandInvalid(error) => error.code(),
        }
    }
}

impl fmt::Display for ClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ClientError {}

/// Opaque reference resolved at connection time rather than embedded in envelopes.
#[derive(Clone, Eq, PartialEq)]
pub struct SecretRef(Box<str>);

impl SecretRef {
    /// Parses a bounded non-inline secret reference.
    ///
    /// # Errors
    ///
    /// Rejects control characters, oversized values and references without a scheme.
    pub fn parse(value: impl AsRef<str>) -> Result<Self, ClientError> {
        let value = value.as_ref();
        if value.is_empty()
            || value.len() > MAX_SECRET_REF_BYTES
            || value.chars().any(char::is_control)
            || !value.contains("://")
            || value.starts_with("inline://")
        {
            return Err(ClientError::ConfigInvalid);
        }
        Ok(Self(value.into()))
    }
}

impl fmt::Debug for SecretRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretRef([REDACTED])")
    }
}

/// Ephemeral bearer material zeroized on drop after request construction.
pub struct SecretValue(Zeroizing<String>);

impl SecretValue {
    /// Creates bounded bearer material.
    ///
    /// # Errors
    ///
    /// Rejects empty, oversized or header-breaking values.
    pub fn new(value: impl Into<String>) -> Result<Self, ClientError> {
        let value = value.into();
        if value.is_empty() || value.len() > MAX_SECRET_BYTES || value.chars().any(char::is_control)
        {
            return Err(ClientError::SecretUnavailable);
        }
        Ok(Self(Zeroizing::new(value)))
    }

    fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretValue([REDACTED])")
    }
}

/// Existing secret-reference boundary used by the RWI client.
pub trait RwiSecretResolver: Send + Sync {
    /// Resolves one reference for the short-lived handshake.
    ///
    /// # Errors
    ///
    /// Returns a sanitized failure when the configured source is unavailable.
    fn resolve(&self, reference: &SecretRef) -> Result<SecretValue, ClientError>;
}

/// Validated client policy. Debug output is always redacted.
#[derive(Clone)]
pub struct ClientConfig {
    endpoint: Url,
    token_ref: SecretRef,
    secret_resolver: Arc<dyn RwiSecretResolver>,
    internal_service: bool,
    connect_timeout_ms: u64,
    command_timeout_ms: u64,
    heartbeat_timeout_ms: u64,
    max_message_bytes: usize,
    max_pending_actions: usize,
}

impl ClientConfig {
    /// Creates the conservative RWI client policy.
    ///
    /// # Errors
    ///
    /// Rejects credentials, queries, fragments, wrong paths and non-WebSocket schemes.
    pub fn new(
        endpoint: impl AsRef<str>,
        token_ref: SecretRef,
        secret_resolver: Arc<dyn RwiSecretResolver>,
    ) -> Result<Self, ClientError> {
        let endpoint = Url::parse(endpoint.as_ref()).map_err(|_| ClientError::ConfigInvalid)?;
        if !matches!(endpoint.scheme(), "ws" | "wss")
            || endpoint.host().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.path() != RWI_PATH
        {
            return Err(ClientError::ConfigInvalid);
        }
        Ok(Self {
            endpoint,
            token_ref,
            secret_resolver,
            internal_service: false,
            connect_timeout_ms: 5_000,
            command_timeout_ms: 10_000,
            heartbeat_timeout_ms: 30_000,
            max_message_bytes: 256 * 1_024,
            max_pending_actions: 1_024,
        })
    }

    /// Changes the command receipt deadline.
    ///
    /// # Errors
    ///
    /// Rejects a deadline outside 10 ms through 300 seconds.
    pub fn with_command_timeout_ms(mut self, timeout_ms: u64) -> Result<Self, ClientError> {
        validate_timeout(timeout_ms)?;
        self.command_timeout_ms = timeout_ms;
        Ok(self)
    }

    /// Explicitly allows plaintext for a private internal-service endpoint.
    #[must_use]
    pub const fn with_internal_service(mut self, internal_service: bool) -> Self {
        self.internal_service = internal_service;
        self
    }

    /// Validates the complete transport policy without opening a connection.
    ///
    /// # Errors
    ///
    /// Rejects unsafe plaintext placement or runtime bounds outside the closed envelope.
    pub fn validate(&self) -> Result<(), ClientError> {
        validate_config(self)
    }
}

impl fmt::Debug for ClientConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ClientConfig([REDACTED])")
    }
}

/// Deterministic or uncertain outcome for one exact action ID.
#[derive(Clone, Debug, PartialEq)]
pub enum CommandOutcome {
    Succeeded {
        action_id: Box<str>,
        data: Value,
    },
    Failed {
        action_id: Box<str>,
        error_code: Box<str>,
    },
    Uncertain {
        action_id: Box<str>,
        error_code: &'static str,
    },
}

/// Bounded asynchronous RWI v1 client with one lifecycle-owned reader task.
pub struct RustPbxRwiClient {
    config: ClientConfig,
    writer: tokio::sync::Mutex<SocketWriter>,
    pending: PendingActions,
    reader: JoinHandle<()>,
}

impl RustPbxRwiClient {
    /// Resolves bearer material, connects within deadline and starts one bounded reader.
    ///
    /// # Errors
    ///
    /// Rejects unsafe plaintext placement, secret failures, handshake failures and timeouts.
    pub async fn connect(config: ClientConfig) -> Result<Self, ClientError> {
        validate_config(&config)?;
        let secret = config.secret_resolver.resolve(&config.token_ref)?;
        let mut request = config
            .endpoint
            .as_str()
            .into_client_request()
            .map_err(|_| ClientError::ConfigInvalid)?;
        let bearer = Zeroizing::new(format!("Bearer {}", secret.expose()));
        request.headers_mut().insert(
            AUTHORIZATION,
            HeaderValue::from_str(&bearer).map_err(|_| ClientError::SecretUnavailable)?,
        );
        let websocket_config = WebSocketConfig::default()
            .read_buffer_size(config.max_message_bytes.min(128 * 1_024))
            .write_buffer_size(8 * 1_024)
            .max_write_buffer_size(config.max_message_bytes.saturating_add(8 * 1_024))
            .max_message_size(Some(config.max_message_bytes))
            .max_frame_size(Some(config.max_message_bytes));
        let connection = tokio::time::timeout(
            Duration::from_millis(config.connect_timeout_ms),
            connect_async_with_config(request, Some(websocket_config), true),
        )
        .await
        .map_err(|_| ClientError::ConnectTimeout)?
        .map_err(|_| ClientError::ConnectFailed)?;
        let (socket, _response) = connection;
        let (writer, reader) = socket.split();
        let pending = Arc::new(Mutex::new(HashMap::with_capacity(
            config.max_pending_actions.min(64),
        )));
        let reader_pending = Arc::clone(&pending);
        let heartbeat = Duration::from_millis(config.heartbeat_timeout_ms);
        let max_message_bytes = config.max_message_bytes;
        let reader = tokio::spawn(async move {
            reader_loop(reader, reader_pending, heartbeat, max_message_bytes).await;
        });
        Ok(Self {
            config,
            writer: tokio::sync::Mutex::new(writer),
            pending,
            reader,
        })
    }

    /// Sends one originate action and waits only for its matching receipt.
    ///
    /// # Errors
    ///
    /// Returns envelope validation or bounded pending-capacity failures. Timeouts and disconnects
    /// after send are successful `Uncertain` results and must be reconciled, never replayed blindly.
    pub async fn originate(
        &self,
        request: OriginateRequest,
    ) -> Result<CommandOutcome, ClientError> {
        self.execute(RwiCommand::Originate(request)).await
    }

    /// Sends one command from the closed RWI subset.
    ///
    /// # Errors
    ///
    /// Returns envelope validation or bounded pending-capacity failures.
    pub async fn execute(&self, command: RwiCommand) -> Result<CommandOutcome, ClientError> {
        let envelope = encode_command(command).map_err(ClientError::CommandInvalid)?;
        let action_id = envelope
            .get("action_id")
            .and_then(Value::as_str)
            .ok_or(ClientError::ConfigInvalid)?
            .to_owned()
            .into_boxed_str();
        let encoded = serde_json::to_string(&envelope)
            .map_err(|_| ClientError::CommandInvalid(RwiError::PayloadTooLarge))?;
        if encoded.len() > self.config.max_message_bytes {
            return Err(ClientError::CommandInvalid(RwiError::PayloadTooLarge));
        }
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| ClientError::ConnectFailed)?;
            if pending.len() >= self.config.max_pending_actions {
                return Err(ClientError::CapacityUnavailable);
            }
            if pending.contains_key(action_id.as_ref()) {
                return Err(ClientError::CommandInvalid(RwiError::InvalidIdentifier));
            }
            pending.insert(action_id.clone(), sender);
        }
        let send_result = tokio::time::timeout(
            Duration::from_millis(self.config.command_timeout_ms),
            self.writer.lock().await.send(Message::Text(encoded.into())),
        )
        .await;
        if !matches!(send_result, Ok(Ok(()))) {
            remove_pending(&self.pending, &action_id);
            return Ok(uncertain(action_id, "provider_unavailable"));
        }
        match tokio::time::timeout(
            Duration::from_millis(self.config.command_timeout_ms),
            receiver,
        )
        .await
        {
            Ok(Ok(outcome)) => Ok(outcome),
            Ok(Err(_)) => {
                remove_pending(&self.pending, &action_id);
                Ok(uncertain(action_id, "provider_unavailable"))
            }
            Err(_) => {
                remove_pending(&self.pending, &action_id);
                Ok(uncertain(action_id, "provider_timeout"))
            }
        }
    }
}

impl fmt::Debug for RustPbxRwiClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RustPbxRwiClient([REDACTED])")
    }
}

impl Drop for RustPbxRwiClient {
    fn drop(&mut self) {
        self.reader.abort();
        drain_pending(&self.pending, "provider_unavailable");
    }
}

async fn reader_loop(
    mut reader: futures_util::stream::SplitStream<Socket>,
    pending: PendingActions,
    heartbeat: Duration,
    max_message_bytes: usize,
) {
    loop {
        let Ok(Some(Ok(message))) = tokio::time::timeout(heartbeat, reader.next()).await else {
            break;
        };
        let Message::Text(text) = message else {
            if matches!(message, Message::Close(_)) {
                break;
            }
            continue;
        };
        if text.len() > max_message_bytes {
            break;
        }
        let Ok(message): Result<Value, _> = serde_json::from_str(&text) else {
            break;
        };
        let Some(kind) = message.get("type").and_then(Value::as_str) else {
            continue;
        };
        if !matches!(kind, "command_completed" | "command_failed") {
            continue;
        }
        let Some(action_id) = message.get("action_id").and_then(Value::as_str) else {
            break;
        };
        let sender = pending
            .lock()
            .ok()
            .and_then(|mut actions| actions.remove(action_id));
        let Some(sender) = sender else {
            continue;
        };
        let action_id: Box<str> = action_id.to_owned().into();
        let outcome = if kind == "command_completed" {
            CommandOutcome::Succeeded {
                action_id,
                data: message.get("data").cloned().unwrap_or(Value::Null),
            }
        } else {
            CommandOutcome::Failed {
                action_id,
                error_code: bounded_error_code(message.get("error_code")).into(),
            }
        };
        let _ = sender.send(outcome);
    }
    drain_pending(&pending, "provider_unavailable");
}

fn validate_config(config: &ClientConfig) -> Result<(), ClientError> {
    validate_timeout(config.connect_timeout_ms)?;
    validate_timeout(config.command_timeout_ms)?;
    validate_timeout(config.heartbeat_timeout_ms)?;
    if !(MIN_MESSAGE_BYTES..=MAX_MESSAGE_BYTES).contains(&config.max_message_bytes)
        || config.max_pending_actions == 0
        || config.max_pending_actions > MAX_PENDING_ACTIONS
    {
        return Err(ClientError::ConfigInvalid);
    }
    if config.endpoint.scheme() == "wss" {
        return Ok(());
    }
    let allowed = match config.endpoint.host() {
        Some(Host::Ipv4(address)) => {
            address.is_loopback() || (config.internal_service && is_private_v4(address))
        }
        Some(Host::Ipv6(address)) => {
            address.is_loopback() || (config.internal_service && is_private_v6(address))
        }
        Some(Host::Domain(_)) => config.internal_service,
        None => false,
    };
    allowed.then_some(()).ok_or(ClientError::PlaintextRejected)
}

const fn validate_timeout(timeout_ms: u64) -> Result<(), ClientError> {
    if timeout_ms < MIN_TIMEOUT_MS || timeout_ms > MAX_TIMEOUT_MS {
        Err(ClientError::ConfigInvalid)
    } else {
        Ok(())
    }
}

const fn is_private_v4(address: Ipv4Addr) -> bool {
    address.is_private() || address.is_link_local()
}

const fn is_private_v6(address: Ipv6Addr) -> bool {
    let first = address.octets()[0];
    address.is_unique_local() || (first == 0xfe && address.octets()[1] & 0xc0 == 0x80)
}

fn remove_pending(pending: &PendingActions, action_id: &str) {
    if let Ok(mut actions) = pending.lock() {
        actions.remove(action_id);
    }
}

fn drain_pending(pending: &PendingActions, error_code: &'static str) {
    let actions = pending
        .lock()
        .ok()
        .map(|mut actions| std::mem::take(&mut *actions))
        .unwrap_or_default();
    for (action_id, sender) in actions {
        let _ = sender.send(uncertain(action_id, error_code));
    }
}

const fn uncertain(action_id: Box<str>, error_code: &'static str) -> CommandOutcome {
    CommandOutcome::Uncertain {
        action_id,
        error_code,
    }
}

fn bounded_error_code(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("not_implemented") => "capability_unavailable",
        Some("provider_unavailable") => "provider_unavailable",
        _ => "provider_rejected",
    }
}
