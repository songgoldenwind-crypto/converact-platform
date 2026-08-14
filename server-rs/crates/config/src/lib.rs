//! Strict runtime configuration for Converact-owned Rust services.

use std::{error::Error, fmt, net::SocketAddr, time::Duration};

use converact_kernel_ids::{CellId, TenantId};
use serde::Deserialize;

const MAX_CONFIG_BYTES: usize = 16_384;
const MAX_SECRET_BYTES: usize = 4_096;
const MAX_SHUTDOWN_TIMEOUT_MS: u64 = 60_000;

/// A stable, non-sensitive runtime configuration error.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigError {
    /// The JSON document is malformed, oversized or contains an unknown field.
    InvalidDocument,
    /// The listener address is not a socket address.
    InvalidBindAddress,
    /// A tenant or Cell identity is invalid.
    InvalidIdentity,
    /// The shutdown timeout is outside the fixed supported range.
    InvalidShutdownTimeout,
    /// The source revision is not an exact lowercase Git commit.
    InvalidSourceCommit,
    /// A required secret is empty, oversized or contains control bytes.
    InvalidSecret,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidDocument => "runtime_config_invalid",
            Self::InvalidBindAddress => "runtime_bind_address_invalid",
            Self::InvalidIdentity => "runtime_identity_invalid",
            Self::InvalidShutdownTimeout => "runtime_shutdown_timeout_invalid",
            Self::InvalidSourceCommit => "runtime_source_commit_invalid",
            Self::InvalidSecret => "runtime_secret_invalid",
        })
    }
}

impl Error for ConfigError {}

/// A secret whose debug representation never contains its value.
pub struct SecretString(Box<str>);

impl SecretString {
    fn parse(value: String) -> Result<Self, ConfigError> {
        if value.is_empty() || value.len() > MAX_SECRET_BYTES || value.chars().any(char::is_control)
        {
            return Err(ConfigError::InvalidSecret);
        }
        Ok(Self(value.into_boxed_str()))
    }

    /// Exposes the secret only at the adapter boundary that consumes it.
    #[must_use]
    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretString([REDACTED])")
    }
}

/// Validated process configuration for the first Rust API runtime.
pub struct RuntimeConfig {
    bind_address: SocketAddr,
    tenant_id: TenantId,
    cell_id: CellId,
    source_commit: Box<str>,
    shutdown_timeout: Duration,
    service_token: SecretString,
}

impl RuntimeConfig {
    /// Parses a bounded JSON document and rejects every unknown field.
    ///
    /// # Errors
    ///
    /// Returns a stable [`ConfigError`] for malformed, unbounded or invalid
    /// configuration. No input value is retained in the error.
    pub fn from_json(document: &str) -> Result<Self, ConfigError> {
        if document.len() > MAX_CONFIG_BYTES {
            return Err(ConfigError::InvalidDocument);
        }
        let raw: RawRuntimeConfig =
            serde_json::from_str(document).map_err(|_| ConfigError::InvalidDocument)?;
        let shutdown_timeout = match raw.shutdown_timeout_ms {
            1..=MAX_SHUTDOWN_TIMEOUT_MS => Duration::from_millis(raw.shutdown_timeout_ms),
            _ => return Err(ConfigError::InvalidShutdownTimeout),
        };
        if raw.source_commit.len() != 40
            || !raw
                .source_commit
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || raw
                .source_commit
                .bytes()
                .any(|byte| byte.is_ascii_uppercase())
        {
            return Err(ConfigError::InvalidSourceCommit);
        }
        Ok(Self {
            bind_address: raw
                .bind_address
                .parse()
                .map_err(|_| ConfigError::InvalidBindAddress)?,
            tenant_id: TenantId::parse(raw.tenant_id).map_err(|_| ConfigError::InvalidIdentity)?,
            cell_id: CellId::parse(raw.cell_id).map_err(|_| ConfigError::InvalidIdentity)?,
            source_commit: raw.source_commit.into_boxed_str(),
            shutdown_timeout,
            service_token: SecretString::parse(raw.service_token)?,
        })
    }

    /// Returns the listener address.
    #[must_use]
    pub const fn bind_address(&self) -> SocketAddr {
        self.bind_address
    }

    /// Returns the tenant identity.
    #[must_use]
    pub const fn tenant_id(&self) -> &TenantId {
        &self.tenant_id
    }

    /// Returns the Cell identity.
    #[must_use]
    pub const fn cell_id(&self) -> &CellId {
        &self.cell_id
    }

    /// Returns the exact lowercase source commit for this process image.
    #[must_use]
    pub fn source_commit(&self) -> &str {
        &self.source_commit
    }

    /// Returns the bounded graceful-shutdown deadline.
    #[must_use]
    pub const fn shutdown_timeout(&self) -> Duration {
        self.shutdown_timeout
    }

    /// Returns the protected service token.
    #[must_use]
    pub const fn service_token(&self) -> &SecretString {
        &self.service_token
    }
}

impl fmt::Debug for RuntimeConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeConfig")
            .field("bind_address", &self.bind_address)
            .field("tenant_id", &self.tenant_id)
            .field("cell_id", &self.cell_id)
            .field("source_commit", &self.source_commit)
            .field("shutdown_timeout", &self.shutdown_timeout)
            .field("service_token", &self.service_token)
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRuntimeConfig {
    bind_address: String,
    tenant_id: String,
    cell_id: String,
    source_commit: String,
    shutdown_timeout_ms: u64,
    service_token: String,
}
