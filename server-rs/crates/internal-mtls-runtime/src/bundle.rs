use std::{error::Error, fmt, path::PathBuf};

use converact_internal_mtls::{InternalMtlsConfigFingerprint, InternalMtlsPemBundle};
use sha2::{Digest as _, Sha256};

#[cfg(unix)]
use rustix::fs::{FileType, Mode, OFlags, fstat, open, openat, readlinkat};
#[cfg(unix)]
use std::{
    ffi::OsStr,
    fs::File,
    io::Read as _,
    os::{fd::OwnedFd, unix::ffi::OsStrExt as _},
    path::Path,
};

const MAX_SOURCE_PATH_BYTES: usize = 4096;
const MAX_GENERATION_COMPONENT_BYTES: usize = 255;
const MAX_TLS_CERT_BYTES: usize = 512 * 1024;
const MAX_TLS_KEY_BYTES: usize = 128 * 1024;
const MAX_CLIENT_CA_BYTES: usize = 512 * 1024;
const MAX_CLIENT_CRL_BYTES: usize = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES: usize = 3_200 * 1024;
const TLS_CERT: &str = "tls.crt";
const TLS_KEY: &str = "tls.key";
const CLIENT_CA: &str = "client-ca.crt";
const CLIENT_CRL: &str = "client-ca.crl";
const REVISION_DOMAIN: &[u8] = b"converact-internal-mtls-bundle-v1";

/// Supported offline bundle layouts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InternalMtlsBundleLayout {
    /// Kubernetes `AtomicWriter` root containing one `..data` symlink.
    KubernetesAtomicWriter,
    /// One already immutable generation directory.
    ImmutableDirectory,
}

/// Validated absolute bundle source without public path projection.
pub struct InternalMtlsBundleSource {
    root: PathBuf,
    layout: InternalMtlsBundleLayout,
}

impl InternalMtlsBundleSource {
    /// Creates one bounded absolute source.
    ///
    /// # Errors
    ///
    /// Returns [`InternalMtlsBundleLoadError::SourceInvalid`] for relative,
    /// empty, NUL-containing or overlong paths.
    pub fn new(
        root: impl Into<PathBuf>,
        layout: InternalMtlsBundleLayout,
    ) -> Result<Self, InternalMtlsBundleLoadError> {
        let root = root.into();
        let encoded = root.as_os_str().as_encoded_bytes();
        if !root.is_absolute()
            || encoded.is_empty()
            || encoded.len() > MAX_SOURCE_PATH_BYTES
            || encoded.contains(&0)
        {
            return Err(InternalMtlsBundleLoadError::SourceInvalid);
        }
        Ok(Self { root, layout })
    }
}

impl fmt::Debug for InternalMtlsBundleSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("InternalMtlsBundleSource([REDACTED])")
    }
}

/// Expected service ownership for opened secret files.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InternalMtlsBundleAccessPolicy {
    service_uid: u32,
    service_gid: Option<u32>,
}

impl InternalMtlsBundleAccessPolicy {
    /// Creates one exact owner/group policy.
    ///
    /// Root or `service_uid` may own entries. Group-readable entries require
    /// the exact configured `service_gid`.
    ///
    /// # Errors
    ///
    /// Rejects the reserved all-ones UID or GID.
    pub const fn new(
        expected_owner_uid: u32,
        allowed_group_gid: Option<u32>,
    ) -> Result<Self, InternalMtlsBundleLoadError> {
        if expected_owner_uid == u32::MAX || matches!(allowed_group_gid, Some(u32::MAX)) {
            return Err(InternalMtlsBundleLoadError::AccessPolicyInvalid);
        }
        Ok(Self {
            service_uid: expected_owner_uid,
            service_gid: allowed_group_gid,
        })
    }
}

/// Stable value-free filesystem boundary failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InternalMtlsBundleLoadError {
    UnsupportedPlatform,
    SourceInvalid,
    AccessPolicyInvalid,
    SourceUnavailable,
    GenerationInvalid,
    GenerationUnavailable,
    PermissionsInvalid,
    EntryInvalid,
    EntryTooLarge,
    EntryReadFailed,
    BundleTooLarge,
}

impl InternalMtlsBundleLoadError {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedPlatform => "internal_mtls_bundle_platform_unsupported",
            Self::SourceInvalid => "internal_mtls_bundle_source_invalid",
            Self::AccessPolicyInvalid => "internal_mtls_bundle_access_policy_invalid",
            Self::SourceUnavailable => "internal_mtls_bundle_source_unavailable",
            Self::GenerationInvalid => "internal_mtls_bundle_generation_invalid",
            Self::GenerationUnavailable => "internal_mtls_bundle_generation_unavailable",
            Self::PermissionsInvalid => "internal_mtls_bundle_permissions_invalid",
            Self::EntryInvalid => "internal_mtls_bundle_entry_invalid",
            Self::EntryTooLarge => "internal_mtls_bundle_entry_too_large",
            Self::EntryReadFailed => "internal_mtls_bundle_entry_read_failed",
            Self::BundleTooLarge => "internal_mtls_bundle_total_too_large",
        }
    }
}

impl fmt::Display for InternalMtlsBundleLoadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Error for InternalMtlsBundleLoadError {}

/// Content-derived revision used only for atomic idempotency comparison.
pub type InternalMtlsBundleRevision = InternalMtlsConfigFingerprint;

/// One complete single-generation PEM bundle.
pub struct LoadedInternalMtlsPemBundle {
    bundle: InternalMtlsPemBundle,
    revision: InternalMtlsBundleRevision,
    byte_lengths: [usize; 4],
}

impl LoadedInternalMtlsPemBundle {
    #[must_use]
    pub const fn revision(&self) -> InternalMtlsBundleRevision {
        self.revision
    }

    #[must_use]
    pub const fn byte_lengths(&self) -> [usize; 4] {
        self.byte_lengths
    }

    #[must_use]
    pub fn into_pem_bundle(self) -> InternalMtlsPemBundle {
        self.bundle
    }
}

impl fmt::Debug for LoadedInternalMtlsPemBundle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LoadedInternalMtlsPemBundle([REDACTED])")
    }
}

/// Synchronous bounded loader intended to run in one supervised blocking job.
pub struct InternalMtlsBundleLoader {
    source: InternalMtlsBundleSource,
    access: InternalMtlsBundleAccessPolicy,
}

impl InternalMtlsBundleLoader {
    #[must_use]
    pub const fn new(
        source: InternalMtlsBundleSource,
        access: InternalMtlsBundleAccessPolicy,
    ) -> Self {
        Self { source, access }
    }

    /// Loads exactly one immutable generation.
    ///
    /// # Errors
    ///
    /// Returns a stable value-free error for invalid paths, descriptors,
    /// permissions, ownership, sizes or reads.
    pub fn load(&self) -> Result<LoadedInternalMtlsPemBundle, InternalMtlsBundleLoadError> {
        #[cfg(unix)]
        {
            self.load_unix()
        }
        #[cfg(not(unix))]
        {
            Err(InternalMtlsBundleLoadError::UnsupportedPlatform)
        }
    }
}

impl fmt::Debug for InternalMtlsBundleLoader {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("InternalMtlsBundleLoader([REDACTED])")
    }
}

#[cfg(unix)]
impl InternalMtlsBundleLoader {
    fn load_unix(&self) -> Result<LoadedInternalMtlsPemBundle, InternalMtlsBundleLoadError> {
        let source = open_directory(&self.source.root)
            .map_err(|_| InternalMtlsBundleLoadError::SourceUnavailable)?;
        validate_directory(&source)?;
        let generation = match self.source.layout {
            InternalMtlsBundleLayout::ImmutableDirectory => source,
            InternalMtlsBundleLayout::KubernetesAtomicWriter => {
                let target = readlinkat(&source, "..data", Vec::new())
                    .map_err(|_| InternalMtlsBundleLoadError::GenerationUnavailable)?;
                let target = target.to_bytes();
                validate_generation_target(target)?;
                let generation = openat(
                    &source,
                    OsStr::from_bytes(target),
                    directory_open_flags(),
                    Mode::empty(),
                )
                .map_err(|_| InternalMtlsBundleLoadError::GenerationUnavailable)?;
                validate_directory(&generation)?;
                generation
            }
        };

        let server_chain = read_entry(
            &generation,
            TLS_CERT,
            MAX_TLS_CERT_BYTES,
            false,
            &self.access,
        )?;
        let server_private_key =
            read_entry(&generation, TLS_KEY, MAX_TLS_KEY_BYTES, true, &self.access)?;
        let client_roots = read_entry(
            &generation,
            CLIENT_CA,
            MAX_CLIENT_CA_BYTES,
            false,
            &self.access,
        )?;
        let client_crls = read_entry(
            &generation,
            CLIENT_CRL,
            MAX_CLIENT_CRL_BYTES,
            false,
            &self.access,
        )?;
        let byte_lengths = [
            server_chain.len(),
            server_private_key.len(),
            client_roots.len(),
            client_crls.len(),
        ];
        validate_total_bytes(byte_lengths)?;
        let revision = bundle_revision([
            (TLS_CERT, server_chain.as_slice()),
            (TLS_KEY, server_private_key.as_slice()),
            (CLIENT_CA, client_roots.as_slice()),
            (CLIENT_CRL, client_crls.as_slice()),
        ]);
        Ok(LoadedInternalMtlsPemBundle {
            bundle: InternalMtlsPemBundle::new(
                server_chain,
                server_private_key,
                client_roots,
                client_crls,
            ),
            revision,
            byte_lengths,
        })
    }
}

fn bundle_revision(files: [(&str, &[u8]); 4]) -> InternalMtlsBundleRevision {
    let mut digest = Sha256::new();
    digest.update(REVISION_DOMAIN);
    for (name, contents) in files {
        digest.update((name.len() as u64).to_be_bytes());
        digest.update(name.as_bytes());
        digest.update((contents.len() as u64).to_be_bytes());
        digest.update(contents);
    }
    InternalMtlsConfigFingerprint::from_sha256(digest.finalize().into())
}

fn validate_total_bytes(lengths: [usize; 4]) -> Result<(), InternalMtlsBundleLoadError> {
    let mut total = 0usize;
    for length in lengths {
        total = total
            .checked_add(length)
            .ok_or(InternalMtlsBundleLoadError::BundleTooLarge)?;
    }
    if total > MAX_BUNDLE_BYTES {
        return Err(InternalMtlsBundleLoadError::BundleTooLarge);
    }
    Ok(())
}

#[cfg(unix)]
fn open_directory(path: &Path) -> Result<OwnedFd, rustix::io::Errno> {
    open(path, directory_open_flags(), Mode::empty())
}

#[cfg(unix)]
fn directory_open_flags() -> OFlags {
    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW
}

#[cfg(unix)]
fn validate_generation_target(target: &[u8]) -> Result<(), InternalMtlsBundleLoadError> {
    if target.is_empty()
        || target.len() > MAX_GENERATION_COMPONENT_BYTES
        || target.contains(&b'/')
        || matches!(target, b"." | b".." | b"..data")
    {
        return Err(InternalMtlsBundleLoadError::GenerationInvalid);
    }
    Ok(())
}

#[cfg(unix)]
fn validate_directory(directory: &OwnedFd) -> Result<(), InternalMtlsBundleLoadError> {
    let stat = fstat(directory).map_err(|_| InternalMtlsBundleLoadError::SourceUnavailable)?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::Directory {
        return Err(InternalMtlsBundleLoadError::SourceUnavailable);
    }
    let mode = Mode::from_raw_mode(stat.st_mode);
    if mode.intersects(Mode::WGRP | Mode::WOTH) {
        return Err(InternalMtlsBundleLoadError::PermissionsInvalid);
    }
    Ok(())
}

#[cfg(unix)]
fn read_entry(
    directory: &OwnedFd,
    name: &str,
    byte_limit: usize,
    private_key: bool,
    access: &InternalMtlsBundleAccessPolicy,
) -> Result<Vec<u8>, InternalMtlsBundleLoadError> {
    let descriptor = openat(
        directory,
        name,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .map_err(|_| InternalMtlsBundleLoadError::EntryInvalid)?;
    let stat = fstat(&descriptor).map_err(|_| InternalMtlsBundleLoadError::EntryInvalid)?;
    validate_entry_metadata(&stat, private_key, access)?;
    let reported_size =
        usize::try_from(stat.st_size).map_err(|_| InternalMtlsBundleLoadError::EntryInvalid)?;
    if reported_size > byte_limit {
        return Err(InternalMtlsBundleLoadError::EntryTooLarge);
    }
    let capacity = reported_size.min(byte_limit);
    let mut contents = Vec::with_capacity(capacity);
    File::from(descriptor)
        .take((byte_limit as u64) + 1)
        .read_to_end(&mut contents)
        .map_err(|_| InternalMtlsBundleLoadError::EntryReadFailed)?;
    if contents.len() > byte_limit {
        return Err(InternalMtlsBundleLoadError::EntryTooLarge);
    }
    Ok(contents)
}

#[cfg(unix)]
fn validate_entry_metadata(
    stat: &rustix::fs::Stat,
    private_key: bool,
    access: &InternalMtlsBundleAccessPolicy,
) -> Result<(), InternalMtlsBundleLoadError> {
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(InternalMtlsBundleLoadError::EntryInvalid);
    }
    let mode = Mode::from_raw_mode(stat.st_mode);
    let forbidden = Mode::WGRP
        | Mode::WOTH
        | Mode::XUSR
        | Mode::XGRP
        | Mode::XOTH
        | Mode::SUID
        | Mode::SGID
        | Mode::SVTX;
    if !mode.contains(Mode::RUSR)
        || mode.intersects(forbidden)
        || (stat.st_uid != 0 && stat.st_uid != access.service_uid)
    {
        return Err(InternalMtlsBundleLoadError::PermissionsInvalid);
    }
    if mode.contains(Mode::RGRP) && access.service_gid != Some(stat.st_gid) {
        return Err(InternalMtlsBundleLoadError::PermissionsInvalid);
    }
    if private_key {
        let allowed = if mode.contains(Mode::RGRP) {
            Mode::RUSR | Mode::RGRP
        } else {
            Mode::RUSR
        };
        if mode != allowed {
            return Err(InternalMtlsBundleLoadError::PermissionsInvalid);
        }
    }
    Ok(())
}
