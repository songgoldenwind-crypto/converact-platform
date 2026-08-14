//! Restricted one-shot Authority migration CLI boundary.

use std::{
    env,
    error::Error,
    ffi::OsString,
    fmt, fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

use converact_migration_tooling::MigrationRequest;
use serde_json::{Value, json};
use tokio_postgres::Config;

/// Hard request document limit for the one-shot operator process.
pub const MAX_REQUEST_BYTES: usize = 65_536;
const MAX_LOCAL_PATH_BYTES: usize = 4_096;
const MAX_POSTGRES_IDENTIFIER_BYTES: usize = 63;
const DEFAULT_POSTGRES_PORT: u16 = 5_432;

/// Stable CLI boundary failure without request, path, database or secret data.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CliError {
    InvalidArguments,
    RequestPathInvalid,
    RequestTooLarge,
    RequestReadFailed,
    RequestEncodingInvalid,
    RequestPermissionsInvalid,
    DatabaseConfigInvalid,
    DatabaseExternalConfigForbidden,
    DatabaseSecretForbidden,
    DatabaseConnectionFailed,
    DatabaseSessionFailed,
    ExecutionTimedOut,
    StoreConfigInvalid,
    OutputFailed,
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidArguments => "authority_migration_cli_arguments_invalid",
            Self::RequestPathInvalid => "authority_migration_cli_request_path_invalid",
            Self::RequestTooLarge => "authority_migration_cli_request_too_large",
            Self::RequestReadFailed => "authority_migration_cli_request_read_failed",
            Self::RequestEncodingInvalid => "authority_migration_cli_request_encoding_invalid",
            Self::RequestPermissionsInvalid => {
                "authority_migration_cli_request_permissions_invalid"
            }
            Self::DatabaseConfigInvalid => "authority_migration_cli_database_config_invalid",
            Self::DatabaseExternalConfigForbidden => {
                "authority_migration_cli_database_external_config_forbidden"
            }
            Self::DatabaseSecretForbidden => "authority_migration_cli_database_secret_forbidden",
            Self::DatabaseConnectionFailed => "authority_migration_cli_database_connect_failed",
            Self::DatabaseSessionFailed => "authority_migration_cli_database_session_failed",
            Self::ExecutionTimedOut => "authority_migration_cli_execution_timed_out",
            Self::StoreConfigInvalid => "authority_migration_cli_store_config_invalid",
            Self::OutputFailed => "authority_migration_cli_output_failed",
        })
    }
}

impl Error for CliError {}

/// Closed one-shot invocation. Mutation confirmation is deliberately kept
/// outside the request document.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CliInvocation {
    request_path: PathBuf,
    apply_confirmation: Option<Box<str>>,
}

impl CliInvocation {
    #[must_use]
    pub fn request_path(&self) -> &Path {
        &self.request_path
    }

    /// Rejects direct apply documents and promotes only a dry-run transition
    /// using the separately supplied exact confirmation flag.
    ///
    /// # Errors
    ///
    /// Read-only, already-applying and mismatched requests fail closed.
    pub fn prepare_request(
        &self,
        request: MigrationRequest,
    ) -> Result<MigrationRequest, converact_migration_tooling::ValidationError> {
        match self.apply_confirmation.as_deref() {
            Some(confirmation) => request.with_apply_confirmation(confirmation),
            None if request.execution() == converact_migration_tooling::ExecutionMode::DryRun => {
                Ok(request)
            }
            None => Err(converact_migration_tooling::ValidationError::InvalidRequest),
        }
    }
}

/// Parses either a dry-run invocation or the exact external apply guard:
/// `--request-file PATH --apply --confirmation-sha256 DIGEST`.
///
/// # Errors
///
/// Rejects reordered, missing, extra, malformed or relative arguments.
pub fn parse_invocation<I>(arguments: I) -> Result<CliInvocation, CliError>
where
    I: IntoIterator<Item = OsString>,
{
    let mut arguments = arguments.into_iter();
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--request-file")) {
        return Err(CliError::InvalidArguments);
    }
    let request_path = PathBuf::from(arguments.next().ok_or(CliError::InvalidArguments)?);
    if !valid_absolute_path(&request_path)
        || request_path.as_os_str().as_encoded_bytes().len() > MAX_LOCAL_PATH_BYTES
    {
        return Err(CliError::RequestPathInvalid);
    }
    let apply_confirmation = match arguments.next() {
        None => None,
        Some(flag) if flag == "--apply" => {
            if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--confirmation-sha256")) {
                return Err(CliError::InvalidArguments);
            }
            let confirmation = arguments
                .next()
                .ok_or(CliError::InvalidArguments)?
                .into_string()
                .map_err(|_| CliError::InvalidArguments)?;
            if !is_lower_sha256(&confirmation) {
                return Err(CliError::InvalidArguments);
            }
            Some(confirmation.into_boxed_str())
        }
        Some(_) => return Err(CliError::InvalidArguments),
    };
    if arguments.next().is_some() {
        return Err(CliError::InvalidArguments);
    }
    Ok(CliInvocation {
        request_path,
        apply_confirmation,
    })
}

/// Reads a bounded, owner-only regular UTF-8 request through one non-following
/// file descriptor. Apply confirmation is still required out of band.
///
/// # Errors
///
/// Rejects invalid paths, non-regular files, symlinks, foreign owners,
/// group/other permissions, files over 64 KiB, read failures and invalid
/// UTF-8.
pub fn read_request_file(path: &Path) -> Result<String, CliError> {
    if !valid_absolute_path(path) {
        return Err(CliError::RequestPathInvalid);
    }
    let file = open_request_file(path)?;
    let metadata = file.metadata().map_err(|_| CliError::RequestReadFailed)?;
    validate_request_metadata(&metadata)?;
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len())
            .unwrap_or(MAX_REQUEST_BYTES)
            .min(MAX_REQUEST_BYTES),
    );
    file.take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| CliError::RequestReadFailed)?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(CliError::RequestTooLarge);
    }
    String::from_utf8(bytes).map_err(|_| CliError::RequestEncodingInvalid)
}

/// Builds the secret-free fail-closed result for an apply whose durable
/// commit outcome cannot be known. It explicitly requires receipt reconcile
/// and never claims that no mutation occurred.
///
/// # Errors
///
/// Rejects non-apply/read-only requests or invalid confirmation state.
pub fn unknown_apply_outcome(
    request: &MigrationRequest,
) -> Result<Value, converact_migration_tooling::ValidationError> {
    request.authorize_apply()?;
    let command = request
        .command()
        .ok_or(converact_migration_tooling::ValidationError::ReadOnlyAction)?
        .route_command();
    Ok(json!({
        "schema_version": 1,
        "status": "unknown",
        "mutation_performed": null,
        "reconcile_required": true,
        "confirmation_sha256": request.required_confirmation_sha256()?,
        "tenant_id": request.key().tenant_id().as_str(),
        "authority_kind": request.key().authority_kind().as_str(),
        "partition_key": request.key().partition_key().as_str(),
        "operation_id": command.operation_id().as_str(),
        "command_kind": command.kind()
    }))
}

#[cfg(unix)]
fn open_request_file(path: &Path) -> Result<fs::File, CliError> {
    use rustix::fs::{Mode, OFlags, open};

    let descriptor = open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .map_err(|error| {
        if error == rustix::io::Errno::LOOP {
            CliError::RequestPathInvalid
        } else {
            CliError::RequestReadFailed
        }
    })?;
    Ok(fs::File::from(descriptor))
}

#[cfg(not(unix))]
fn open_request_file(_path: &Path) -> Result<fs::File, CliError> {
    Err(CliError::RequestPermissionsInvalid)
}

#[cfg(unix)]
fn validate_request_metadata(metadata: &fs::Metadata) -> Result<(), CliError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    if !metadata.file_type().is_file() {
        return Err(CliError::RequestPathInvalid);
    }
    if metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(CliError::RequestPermissionsInvalid);
    }
    if metadata.len() > MAX_REQUEST_BYTES as u64 {
        return Err(CliError::RequestTooLarge);
    }
    Ok(())
}

#[cfg(not(unix))]
fn validate_request_metadata(_metadata: &fs::Metadata) -> Result<(), CliError> {
    Err(CliError::RequestPermissionsInvalid)
}

/// Local Unix-socket `PostgreSQL` target. It cannot contain a password or TCP
/// host and its debug form therefore contains no credential material. The
/// server's peer/HBA policy is a separate deployment prerequisite; a client
/// cannot prove the server-selected authentication method.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalDatabaseSettings {
    host: PathBuf,
    user: Box<str>,
    database: Box<str>,
    port: u16,
}

impl LocalDatabaseSettings {
    /// Validates explicit local `PostgreSQL` settings.
    ///
    /// # Errors
    ///
    /// Rejects TCP/relative hosts, noncanonical identifiers/ports and any
    /// password-bearing configuration.
    pub fn parse(
        host: &str,
        user: &str,
        database: &str,
        port: Option<&str>,
        password_present: bool,
    ) -> Result<Self, CliError> {
        if password_present {
            return Err(CliError::DatabaseSecretForbidden);
        }
        let host = PathBuf::from(host);
        if !valid_absolute_path(&host)
            || host.as_os_str().as_encoded_bytes().len() > MAX_LOCAL_PATH_BYTES
            || !valid_postgres_identifier(user)
            || !valid_postgres_identifier(database)
        {
            return Err(CliError::DatabaseConfigInvalid);
        }
        let port = port.map_or(Ok(DEFAULT_POSTGRES_PORT), parse_port)?;
        Ok(Self {
            host,
            user: user.into(),
            database: database.into(),
            port,
        })
    }

    /// Reads the closed `PGHOST`, `PGUSER`, `PGDATABASE` and optional `PGPORT`
    /// environment contract. URL, service, host-address and password inputs
    /// are rejected even when the local fields are also present.
    ///
    /// # Errors
    ///
    /// Returns a value-free configuration error for missing, non-Unicode or
    /// forbidden environment input.
    pub fn from_environment() -> Result<Self, CliError> {
        if ["PGPASSWORD", "PGPASSFILE"]
            .iter()
            .any(|name| env::var_os(name).is_some())
        {
            return Err(CliError::DatabaseSecretForbidden);
        }
        if ["DATABASE_URL", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"]
            .iter()
            .any(|name| env::var_os(name).is_some())
        {
            return Err(CliError::DatabaseExternalConfigForbidden);
        }
        let host = unicode_environment("PGHOST")?;
        let user = unicode_environment("PGUSER")?;
        let database = unicode_environment("PGDATABASE")?;
        let port = optional_unicode_environment("PGPORT")?;
        Self::parse(&host, &user, &database, port.as_deref(), false)
    }

    #[must_use]
    pub fn host(&self) -> &Path {
        &self.host
    }

    #[must_use]
    pub fn user(&self) -> &str {
        &self.user
    }

    #[must_use]
    pub fn database(&self) -> &str {
        &self.database
    }

    #[must_use]
    pub const fn port(&self) -> u16 {
        self.port
    }

    /// Builds a connection configuration solely from the validated fields.
    #[must_use]
    pub fn postgres_config(&self) -> Config {
        let mut config = Config::new();
        config
            .host_path(&self.host)
            .user(self.user.as_ref())
            .dbname(self.database.as_ref())
            .port(self.port);
        config
    }
}

fn valid_absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
}

fn valid_postgres_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_POSTGRES_IDENTIFIER_BYTES
        && (first.is_ascii_alphanumeric() || first == b'_')
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn parse_port(value: &str) -> Result<u16, CliError> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(CliError::DatabaseConfigInvalid);
    }
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or(CliError::DatabaseConfigInvalid)
}

fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn unicode_environment(name: &str) -> Result<String, CliError> {
    env::var(name).map_err(|_| CliError::DatabaseConfigInvalid)
}

fn optional_unicode_environment(name: &str) -> Result<Option<String>, CliError> {
    match env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err(CliError::DatabaseConfigInvalid),
    }
}
