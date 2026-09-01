use std::{
    error::Error,
    fmt,
    path::{Component, Path},
};

use converact_tenant_auth::{Rs256JwksSnapshot, Rs256PlatformTokenVerifier};
use tokio_postgres::{Config as PostgresConfig, config::SslMode};

const MAX_JWKS_BYTES: usize = 128 * 1_024;
const MAX_DATABASE_DOCUMENT_BYTES: usize = 8 * 1_024;
const MAX_DATABASE_IDENTITY_BYTES: usize = 255;

/// Stable, value-free failure while preparing external runtime authorities.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VoiceAgentStartupError {
    PlatformJwksUnavailable,
    PlatformJwksInvalid,
    PlatformTokenPolicyInvalid,
    DatabaseConfigurationInvalid,
}

impl fmt::Display for VoiceAgentStartupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::PlatformJwksUnavailable => "voice_agent_platform_jwks_unavailable",
            Self::PlatformJwksInvalid => "voice_agent_platform_jwks_invalid",
            Self::PlatformTokenPolicyInvalid => "voice_agent_platform_token_policy_invalid",
            Self::DatabaseConfigurationInvalid => "voice_agent_database_configuration_invalid",
        })
    }
}

impl Error for VoiceAgentStartupError {}

/// Loads one immutable public-key snapshot from a no-symlink, bounded regular file.
///
/// # Errors
///
/// Fails closed for unsafe file metadata, malformed keys or invalid token policy.
pub fn load_rs256_platform_verifier(
    path: &Path,
    expected_issuer: &str,
    expected_audience: &str,
    policy_version: u64,
    revocation_epoch: u64,
) -> Result<Rs256PlatformTokenVerifier, VoiceAgentStartupError> {
    let document = read_public_document(path)?;
    let snapshot = Rs256JwksSnapshot::parse_json(&document)
        .map_err(|_| VoiceAgentStartupError::PlatformJwksInvalid)?;
    Rs256PlatformTokenVerifier::new(
        snapshot,
        expected_issuer,
        expected_audience,
        policy_version,
        revocation_epoch,
    )
    .map_err(|_| VoiceAgentStartupError::PlatformTokenPolicyInvalid)
}

/// Parses the only currently supported database transport: one explicit local Unix socket without
/// inline passwords or TLS downgrade ambiguity.
///
/// # Errors
///
/// Rejects TCP, multiple/relative hosts, passwords, missing identities and non-disabled SSL mode.
pub fn parse_local_database_config(
    document: &str,
) -> Result<PostgresConfig, VoiceAgentStartupError> {
    if document.is_empty() || document.len() > MAX_DATABASE_DOCUMENT_BYTES {
        return Err(VoiceAgentStartupError::DatabaseConfigurationInvalid);
    }
    let config = document
        .parse::<PostgresConfig>()
        .map_err(|_| VoiceAgentStartupError::DatabaseConfigurationInvalid)?;
    let [tokio_postgres::config::Host::Unix(host)] = config.get_hosts() else {
        return Err(VoiceAgentStartupError::DatabaseConfigurationInvalid);
    };
    if !valid_absolute_path(host)
        || config.get_password().is_some()
        || config.get_ssl_mode() != SslMode::Disable
        || !config.get_hostaddrs().is_empty()
        || config.get_options().is_some()
        || !config.get_user().is_some_and(valid_database_identity)
        || !config.get_dbname().is_some_and(valid_database_identity)
    {
        return Err(VoiceAgentStartupError::DatabaseConfigurationInvalid);
    }
    Ok(config)
}

#[cfg(unix)]
fn read_public_document(path: &Path) -> Result<String, VoiceAgentStartupError> {
    use std::{
        fs::File,
        io::Read as _,
        os::unix::fs::{MetadataExt as _, PermissionsExt as _},
    };

    use rustix::fs::{Mode, OFlags, open};

    if !valid_absolute_path(path) {
        return Err(VoiceAgentStartupError::PlatformJwksUnavailable);
    }
    let descriptor = open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .map_err(|_| VoiceAgentStartupError::PlatformJwksUnavailable)?;
    let file = File::from(descriptor);
    let metadata = file
        .metadata()
        .map_err(|_| VoiceAgentStartupError::PlatformJwksUnavailable)?;
    let mode = metadata.permissions().mode();
    let owner = metadata.uid();
    if !metadata.file_type().is_file()
        || (owner != 0 && owner != rustix::process::geteuid().as_raw())
        || mode & 0o022 != 0
        || mode & 0o111 != 0
        || metadata.len() > MAX_JWKS_BYTES as u64
    {
        return Err(VoiceAgentStartupError::PlatformJwksUnavailable);
    }
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len())
            .unwrap_or(MAX_JWKS_BYTES)
            .min(MAX_JWKS_BYTES),
    );
    file.take((MAX_JWKS_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| VoiceAgentStartupError::PlatformJwksUnavailable)?;
    if bytes.len() > MAX_JWKS_BYTES {
        return Err(VoiceAgentStartupError::PlatformJwksInvalid);
    }
    String::from_utf8(bytes).map_err(|_| VoiceAgentStartupError::PlatformJwksInvalid)
}

#[cfg(not(unix))]
fn read_public_document(_path: &Path) -> Result<String, VoiceAgentStartupError> {
    Err(VoiceAgentStartupError::PlatformJwksUnavailable)
}

fn valid_absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && path != Path::new("/")
        && path.components().all(|component| {
            !matches!(
                component,
                Component::CurDir | Component::ParentDir | Component::Prefix(_)
            )
        })
}

fn valid_database_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_DATABASE_IDENTITY_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}
