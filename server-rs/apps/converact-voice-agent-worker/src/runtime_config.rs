use std::{
    error::Error,
    fmt,
    net::SocketAddr,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use converact_active_call_adapter::{ActiveCallClient, ClientConfig as ActiveCallClientConfig};
use converact_ai_outbound_store::StoreConfig;
use converact_kernel_ids::TenantId;
use converact_post_call_finalization_store::FinalizationStoreConfig;
use converact_postgres_store::{
    PostgresActiveCallArtifactStoreConfig, PostgresRuntimeLimits, PostgresRuntimeSettings,
};
use converact_rustpbx_rwi_adapter::{
    ClientConfig as RustPbxClientConfig, ClientError as RustPbxClientError, RustPbxTelephonyConfig,
    RwiSecretResolver, SecretRef, SecretValue,
};
use serde::Deserialize;

use crate::{ActiveCallChannelAgentConfig, ClaimLoopConfig, WorkerConfig, WorkerConfigError};

const CONFIG_SCHEMA_VERSION: u8 = 1;
const MAX_CONFIG_BYTES: usize = 64 * 1_024;
const MAX_IDENTIFIER_BYTES: usize = 255;
const MAX_POLICY_TEXT_BYTES: usize = 256;
const MAX_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(300);
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Stable, value-free runtime configuration failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VoiceAgentRuntimeConfigError {
    InvalidDocument,
    UnsupportedSchema,
    InvalidTenant,
    InvalidInstance,
    InvalidBindAddress,
    InvalidShutdownTimeout,
    InvalidWorker,
    InvalidDatabase,
    InvalidPostCall,
    InvalidPlatformAuth,
    InvalidActiveCall,
    InvalidRustPbx,
}

impl fmt::Display for VoiceAgentRuntimeConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidDocument => "voice_agent_runtime_document_invalid",
            Self::UnsupportedSchema => "voice_agent_runtime_schema_unsupported",
            Self::InvalidTenant => "voice_agent_runtime_tenant_invalid",
            Self::InvalidInstance => "voice_agent_runtime_instance_invalid",
            Self::InvalidBindAddress => "voice_agent_runtime_bind_invalid",
            Self::InvalidShutdownTimeout => "voice_agent_runtime_shutdown_timeout_invalid",
            Self::InvalidWorker => "voice_agent_runtime_worker_invalid",
            Self::InvalidDatabase => "voice_agent_runtime_database_invalid",
            Self::InvalidPostCall => "voice_agent_runtime_post_call_invalid",
            Self::InvalidPlatformAuth => "voice_agent_runtime_platform_auth_invalid",
            Self::InvalidActiveCall => "voice_agent_runtime_active_call_invalid",
            Self::InvalidRustPbx => "voice_agent_runtime_rustpbx_invalid",
        })
    }
}

impl Error for VoiceAgentRuntimeConfigError {}

/// Explicit database transport supported by this first executable composition.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseTransport {
    LocalNoTls,
}

/// Immutable public-key and platform-token policy inputs.
pub struct PlatformAuthRuntimeConfig {
    jwks_path: PathBuf,
    expected_issuer: Box<str>,
    expected_audience: Box<str>,
    policy_version: u64,
    revocation_epoch: u64,
}

impl PlatformAuthRuntimeConfig {
    #[must_use]
    pub fn jwks_path(&self) -> &Path {
        &self.jwks_path
    }

    #[must_use]
    pub fn expected_issuer(&self) -> &str {
        &self.expected_issuer
    }

    #[must_use]
    pub fn expected_audience(&self) -> &str {
        &self.expected_audience
    }

    #[must_use]
    pub const fn policy_version(&self) -> u64 {
        self.policy_version
    }

    #[must_use]
    pub const fn revocation_epoch(&self) -> u64 {
        self.revocation_epoch
    }
}

impl fmt::Debug for PlatformAuthRuntimeConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PlatformAuthRuntimeConfig([REDACTED])")
    }
}

/// Validated Active Call transport, artifact and session policy.
pub struct ActiveCallRuntimeConfig {
    client: ActiveCallClientConfig,
    artifact: PostgresActiveCallArtifactStoreConfig,
    compiler_revision: Box<str>,
    channel_agent: ActiveCallChannelAgentConfig,
}

impl ActiveCallRuntimeConfig {
    #[must_use]
    pub fn client_config(&self) -> ActiveCallClientConfig {
        self.client.clone()
    }

    #[must_use]
    pub fn artifact_config(&self) -> PostgresActiveCallArtifactStoreConfig {
        self.artifact.clone()
    }

    #[must_use]
    pub fn compiler_revision(&self) -> &str {
        &self.compiler_revision
    }

    #[must_use]
    pub fn channel_agent_config(&self) -> ActiveCallChannelAgentConfig {
        self.channel_agent.clone()
    }
}

impl fmt::Debug for ActiveCallRuntimeConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ActiveCallRuntimeConfig([REDACTED])")
    }
}

/// Validated `RustPBX` RWI and telephony policy without resolved bearer material.
pub struct RustPbxRuntimeConfig {
    endpoint: Box<str>,
    token_ref: SecretRef,
    internal_service: bool,
    command_timeout_ms: u64,
    telephony: RustPbxTelephonyConfig,
}

impl RustPbxRuntimeConfig {
    /// Rebuilds the inert client policy with the process-owned secret resolver.
    ///
    /// # Errors
    ///
    /// Returns a stable adapter configuration failure; no connection is opened.
    pub fn client_config(
        &self,
        resolver: Arc<dyn RwiSecretResolver>,
    ) -> Result<RustPbxClientConfig, RustPbxClientError> {
        RustPbxClientConfig::new(&self.endpoint, self.token_ref.clone(), resolver)?
            .with_command_timeout_ms(self.command_timeout_ms)
            .map(|config| config.with_internal_service(self.internal_service))
    }

    #[must_use]
    pub fn telephony_config(&self) -> RustPbxTelephonyConfig {
        self.telephony.clone()
    }
}

impl fmt::Debug for RustPbxRuntimeConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RustPbxRuntimeConfig([REDACTED])")
    }
}

/// Complete non-secret configuration for one tenant-local AI outbound Worker process.
pub struct VoiceAgentRuntimeConfig {
    tenant_id: TenantId,
    instance_id: Box<str>,
    bind_address: SocketAddr,
    shutdown_timeout: Duration,
    worker: WorkerConfig,
    claim_loop: ClaimLoopConfig,
    attempt_store: StoreConfig,
    database_url_environment: Box<str>,
    database_transport: DatabaseTransport,
    database: PostgresRuntimeSettings,
    post_call: FinalizationStoreConfig,
    platform_auth: PlatformAuthRuntimeConfig,
    active_call: ActiveCallRuntimeConfig,
    rustpbx: RustPbxRuntimeConfig,
}

impl VoiceAgentRuntimeConfig {
    /// Parses and validates the entire closed configuration before any network or database I/O.
    ///
    /// # Errors
    ///
    /// Rejects unknown fields, unsupported versions, inline secrets and unsafe bounds.
    pub fn from_json(document: &str) -> Result<Self, VoiceAgentRuntimeConfigError> {
        if document.is_empty() || document.len() > MAX_CONFIG_BYTES {
            return Err(VoiceAgentRuntimeConfigError::InvalidDocument);
        }
        let raw: RuntimeDocument = serde_json::from_str(document)
            .map_err(|_| VoiceAgentRuntimeConfigError::InvalidDocument)?;
        Self::try_from_document(raw)
    }

    fn try_from_document(raw: RuntimeDocument) -> Result<Self, VoiceAgentRuntimeConfigError> {
        if raw.schema_version != CONFIG_SCHEMA_VERSION {
            return Err(VoiceAgentRuntimeConfigError::UnsupportedSchema);
        }
        let tenant_id = TenantId::parse(raw.tenant_id)
            .map_err(|_| VoiceAgentRuntimeConfigError::InvalidTenant)?;
        if !valid_identifier(&raw.instance_id) {
            return Err(VoiceAgentRuntimeConfigError::InvalidInstance);
        }
        let bind_address = raw
            .bind_address
            .parse::<SocketAddr>()
            .ok()
            .filter(|address| address.ip().is_loopback())
            .ok_or(VoiceAgentRuntimeConfigError::InvalidBindAddress)?;
        let shutdown_timeout = millis(raw.shutdown_timeout_ms);
        if shutdown_timeout.is_zero() || shutdown_timeout > MAX_SHUTDOWN_TIMEOUT {
            return Err(VoiceAgentRuntimeConfigError::InvalidShutdownTimeout);
        }
        let worker = WorkerConfig::new(raw.worker.worker_count, raw.worker.claim_size)
            .map_err(map_worker_error)?;
        let claim_loop = ClaimLoopConfig::new(millis(raw.worker.claim_poll_interval_ms))
            .map_err(map_worker_error)?;
        let attempt_store =
            StoreConfig::new(raw.worker.attempt_lease_duration_ms, raw.worker.claim_size)
                .map_err(|_| VoiceAgentRuntimeConfigError::InvalidWorker)?;
        let (database_url_environment, database_transport, database) =
            parse_database(raw.database)?;
        let post_call = FinalizationStoreConfig::new(
            raw.post_call.lease_duration_ms,
            raw.post_call.max_claim_batch,
        )
        .map_err(|_| VoiceAgentRuntimeConfigError::InvalidPostCall)?;
        let platform_auth = parse_platform_auth(raw.platform_auth)?;
        let active_call = parse_active_call(raw.active_call)?;
        let rustpbx = parse_rustpbx(raw.rustpbx)?;
        Ok(Self {
            tenant_id,
            instance_id: raw.instance_id.into(),
            bind_address,
            shutdown_timeout,
            worker,
            claim_loop,
            attempt_store,
            database_url_environment: database_url_environment.into(),
            database_transport,
            database,
            post_call,
            platform_auth,
            active_call,
            rustpbx,
        })
    }

    #[must_use]
    pub const fn tenant_id(&self) -> &TenantId {
        &self.tenant_id
    }

    #[must_use]
    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    #[must_use]
    pub const fn bind_address(&self) -> SocketAddr {
        self.bind_address
    }

    #[must_use]
    pub const fn shutdown_timeout(&self) -> Duration {
        self.shutdown_timeout
    }

    #[must_use]
    pub const fn worker_config(&self) -> WorkerConfig {
        self.worker
    }

    #[must_use]
    pub const fn claim_loop_config(&self) -> ClaimLoopConfig {
        self.claim_loop
    }

    #[must_use]
    pub const fn attempt_store_config(&self) -> StoreConfig {
        self.attempt_store
    }

    #[must_use]
    pub fn database_url_environment(&self) -> &str {
        &self.database_url_environment
    }

    #[must_use]
    pub const fn database_transport(&self) -> DatabaseTransport {
        self.database_transport
    }

    #[must_use]
    pub const fn database_settings(&self) -> PostgresRuntimeSettings {
        self.database
    }

    #[must_use]
    pub const fn post_call_config(&self) -> FinalizationStoreConfig {
        self.post_call
    }

    #[must_use]
    pub const fn platform_auth(&self) -> &PlatformAuthRuntimeConfig {
        &self.platform_auth
    }

    #[must_use]
    pub const fn active_call(&self) -> &ActiveCallRuntimeConfig {
        &self.active_call
    }

    #[must_use]
    pub const fn rustpbx(&self) -> &RustPbxRuntimeConfig {
        &self.rustpbx
    }
}

impl fmt::Debug for VoiceAgentRuntimeConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("VoiceAgentRuntimeConfig([REDACTED])")
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeDocument {
    schema_version: u8,
    tenant_id: String,
    instance_id: String,
    bind_address: String,
    shutdown_timeout_ms: u64,
    worker: WorkerDocument,
    database: DatabaseDocument,
    post_call: PostCallDocument,
    platform_auth: PlatformAuthDocument,
    active_call: ActiveCallDocument,
    rustpbx: RustPbxDocument,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerDocument {
    worker_count: u16,
    claim_size: u16,
    claim_poll_interval_ms: u64,
    attempt_lease_duration_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DatabaseDocument {
    url_environment: String,
    transport: DatabaseTransport,
    max_connections: usize,
    max_waiters: usize,
    pool_wait_timeout_ms: u64,
    connect_timeout_ms: u64,
    recycle_timeout_ms: u64,
    statement_timeout_ms: u64,
    lock_timeout_ms: u64,
    transaction_timeout_ms: u64,
    rollback_timeout_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PostCallDocument {
    lease_duration_ms: u64,
    max_claim_batch: u16,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlatformAuthDocument {
    jwks_path: PathBuf,
    expected_issuer: String,
    expected_audience: String,
    policy_version: u64,
    revocation_epoch: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ActiveCallDocument {
    endpoint: String,
    timeout_ms: u64,
    max_response_bytes: usize,
    compiler_revision: String,
    disclosure: String,
    max_sessions: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RustPbxDocument {
    endpoint: String,
    token_ref: String,
    internal_service: bool,
    command_timeout_ms: u64,
    agent_target: String,
    poll_interval_ms: u64,
    max_answer_wait_ms: u64,
}

fn parse_database(
    raw: DatabaseDocument,
) -> Result<(String, DatabaseTransport, PostgresRuntimeSettings), VoiceAgentRuntimeConfigError> {
    if !valid_environment_name(&raw.url_environment) {
        return Err(VoiceAgentRuntimeConfigError::InvalidDatabase);
    }
    let settings = PostgresRuntimeSettings::new(PostgresRuntimeLimits {
        max_connections: raw.max_connections,
        max_waiters: raw.max_waiters,
        pool_wait_timeout: millis(raw.pool_wait_timeout_ms),
        connect_timeout: millis(raw.connect_timeout_ms),
        recycle_timeout: millis(raw.recycle_timeout_ms),
        statement_timeout: millis(raw.statement_timeout_ms),
        lock_timeout: millis(raw.lock_timeout_ms),
        transaction_timeout: millis(raw.transaction_timeout_ms),
        rollback_timeout: millis(raw.rollback_timeout_ms),
    })
    .map_err(|_| VoiceAgentRuntimeConfigError::InvalidDatabase)?;
    Ok((raw.url_environment, raw.transport, settings))
}

fn parse_platform_auth(
    raw: PlatformAuthDocument,
) -> Result<PlatformAuthRuntimeConfig, VoiceAgentRuntimeConfigError> {
    if !valid_absolute_file(&raw.jwks_path)
        || !valid_policy_text(&raw.expected_issuer)
        || !valid_policy_text(&raw.expected_audience)
        || raw.policy_version == 0
        || raw.policy_version > JS_MAX_SAFE_INTEGER
        || raw.revocation_epoch > JS_MAX_SAFE_INTEGER
    {
        return Err(VoiceAgentRuntimeConfigError::InvalidPlatformAuth);
    }
    Ok(PlatformAuthRuntimeConfig {
        jwks_path: raw.jwks_path,
        expected_issuer: raw.expected_issuer.into(),
        expected_audience: raw.expected_audience.into(),
        policy_version: raw.policy_version,
        revocation_epoch: raw.revocation_epoch,
    })
}

fn parse_active_call(
    raw: ActiveCallDocument,
) -> Result<ActiveCallRuntimeConfig, VoiceAgentRuntimeConfigError> {
    let client = ActiveCallClientConfig::new(&raw.endpoint, raw.timeout_ms, raw.max_response_bytes)
        .map_err(|_| VoiceAgentRuntimeConfigError::InvalidActiveCall)?;
    ActiveCallClient::connect(client.clone())
        .map_err(|_| VoiceAgentRuntimeConfigError::InvalidActiveCall)?;
    let artifact = PostgresActiveCallArtifactStoreConfig::new(&raw.compiler_revision)
        .map_err(|_| VoiceAgentRuntimeConfigError::InvalidActiveCall)?;
    let channel_agent = ActiveCallChannelAgentConfig::new(&raw.disclosure, raw.max_sessions)
        .map_err(|_| VoiceAgentRuntimeConfigError::InvalidActiveCall)?;
    Ok(ActiveCallRuntimeConfig {
        client,
        artifact,
        compiler_revision: raw.compiler_revision.into(),
        channel_agent,
    })
}

fn parse_rustpbx(
    raw: RustPbxDocument,
) -> Result<RustPbxRuntimeConfig, VoiceAgentRuntimeConfigError> {
    let token_ref = SecretRef::parse(&raw.token_ref)
        .map_err(|_| VoiceAgentRuntimeConfigError::InvalidRustPbx)?;
    let client = RustPbxClientConfig::new(
        &raw.endpoint,
        token_ref.clone(),
        Arc::new(UnavailableSecretResolver),
    )
    .and_then(|config| config.with_command_timeout_ms(raw.command_timeout_ms))
    .map(|config| config.with_internal_service(raw.internal_service))
    .map_err(|_| VoiceAgentRuntimeConfigError::InvalidRustPbx)?;
    client
        .validate()
        .map_err(|_| VoiceAgentRuntimeConfigError::InvalidRustPbx)?;
    let telephony = RustPbxTelephonyConfig::new(
        &raw.agent_target,
        millis(raw.poll_interval_ms),
        millis(raw.max_answer_wait_ms),
    )
    .map_err(|_| VoiceAgentRuntimeConfigError::InvalidRustPbx)?;
    Ok(RustPbxRuntimeConfig {
        endpoint: raw.endpoint.into(),
        token_ref,
        internal_service: raw.internal_service,
        command_timeout_ms: raw.command_timeout_ms,
        telephony,
    })
}

struct UnavailableSecretResolver;

impl RwiSecretResolver for UnavailableSecretResolver {
    fn resolve(&self, _reference: &SecretRef) -> Result<SecretValue, RustPbxClientError> {
        Err(RustPbxClientError::SecretUnavailable)
    }
}

const fn millis(value: u64) -> Duration {
    Duration::from_millis(value)
}

fn valid_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_IDENTIFIER_BYTES
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_environment_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= 128
        && (first.is_ascii_uppercase() || first == b'_')
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn valid_absolute_file(path: &Path) -> bool {
    path.is_absolute()
        && path != Path::new("/")
        && path.components().all(|component| {
            !matches!(
                component,
                Component::CurDir | Component::ParentDir | Component::Prefix(_)
            )
        })
}

fn valid_policy_text(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_POLICY_TEXT_BYTES
        && !value.chars().any(char::is_control)
}

const fn map_worker_error(_error: WorkerConfigError) -> VoiceAgentRuntimeConfigError {
    VoiceAgentRuntimeConfigError::InvalidWorker
}
