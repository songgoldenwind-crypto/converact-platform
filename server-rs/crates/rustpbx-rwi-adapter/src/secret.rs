use std::{fmt, path::Component};

use url::Url;

use crate::{ClientError, RwiSecretResolver, SecretRef, SecretValue};

const MAX_SECRET_FILE_BYTES: usize = 4_096;

/// Owner-only, no-symlink resolver for an absolute `file://` bearer reference.
#[derive(Clone, Copy, Default)]
pub struct FileRwiSecretResolver;

impl RwiSecretResolver for FileRwiSecretResolver {
    fn resolve(&self, reference: &SecretRef) -> Result<SecretValue, ClientError> {
        resolve_file(reference)
    }
}

impl fmt::Debug for FileRwiSecretResolver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("FileRwiSecretResolver([REDACTED])")
    }
}

#[cfg(unix)]
fn resolve_file(reference: &SecretRef) -> Result<SecretValue, ClientError> {
    use std::{
        fs::File,
        io::Read as _,
        os::unix::fs::{MetadataExt as _, PermissionsExt as _},
    };

    use rustix::fs::{Mode, OFlags, open};
    use zeroize::Zeroize as _;

    let url = Url::parse(reference.as_str()).map_err(|_| ClientError::SecretUnavailable)?;
    if url.scheme() != "file"
        || url.host().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ClientError::SecretUnavailable);
    }
    let path = url
        .to_file_path()
        .map_err(|()| ClientError::SecretUnavailable)?;
    if !path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::CurDir | Component::ParentDir | Component::Prefix(_)
            )
        })
    {
        return Err(ClientError::SecretUnavailable);
    }
    let descriptor = open(
        &path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .map_err(|_| ClientError::SecretUnavailable)?;
    let file = File::from(descriptor);
    let metadata = file
        .metadata()
        .map_err(|_| ClientError::SecretUnavailable)?;
    let mode = metadata.permissions().mode() & 0o777;
    if !metadata.file_type().is_file()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || !matches!(mode, 0o400 | 0o600)
        || metadata.len() > MAX_SECRET_FILE_BYTES as u64
    {
        return Err(ClientError::SecretUnavailable);
    }
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len())
            .unwrap_or(MAX_SECRET_FILE_BYTES)
            .min(MAX_SECRET_FILE_BYTES),
    );
    file.take((MAX_SECRET_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ClientError::SecretUnavailable)?;
    if bytes.len() > MAX_SECRET_FILE_BYTES {
        return Err(ClientError::SecretUnavailable);
    }
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
    }
    let value = String::from_utf8(bytes).map_err(|error| {
        let mut bytes = error.into_bytes();
        bytes.zeroize();
        ClientError::SecretUnavailable
    })?;
    SecretValue::new(value)
}

#[cfg(not(unix))]
fn resolve_file(_reference: &SecretRef) -> Result<SecretValue, ClientError> {
    Err(ClientError::SecretUnavailable)
}
