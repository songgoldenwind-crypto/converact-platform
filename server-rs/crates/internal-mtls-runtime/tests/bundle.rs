#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::{PermissionsExt as _, symlink},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    thread,
};

use converact_internal_mtls_runtime::{
    InternalMtlsBundleAccessPolicy, InternalMtlsBundleLayout, InternalMtlsBundleLoadError,
    InternalMtlsBundleLoader, InternalMtlsBundleSource,
};

const TLS_CERT: &str = "tls.crt";
const TLS_KEY: &str = "tls.key";
const CLIENT_CA: &str = "client-ca.crt";
const CLIENT_CRL: &str = "client-ca.crl";
const FILES: [&str; 4] = [TLS_CERT, TLS_KEY, CLIENT_CA, CLIENT_CRL];
const LIMITS: [usize; 4] = [512 * 1024, 128 * 1024, 512 * 1024, 2 * 1024 * 1024];

#[test]
fn source_and_access_policy_are_bounded_before_filesystem_access() {
    assert_eq!(
        InternalMtlsBundleSource::new("relative", InternalMtlsBundleLayout::ImmutableDirectory)
            .unwrap_err(),
        InternalMtlsBundleLoadError::SourceInvalid
    );
    let oversized = format!("/{}", "a".repeat(4096));
    assert_eq!(
        InternalMtlsBundleSource::new(oversized, InternalMtlsBundleLayout::ImmutableDirectory,)
            .unwrap_err(),
        InternalMtlsBundleLoadError::SourceInvalid
    );
    assert_eq!(
        InternalMtlsBundleAccessPolicy::new(u32::MAX, None).unwrap_err(),
        InternalMtlsBundleLoadError::AccessPolicyInvalid
    );
    assert_eq!(
        InternalMtlsBundleAccessPolicy::new(current_uid(), Some(u32::MAX)).unwrap_err(),
        InternalMtlsBundleLoadError::AccessPolicyInvalid
    );
}

#[test]
fn immutable_directory_loads_one_bounded_bundle_and_stable_revision() {
    let directory = TestDirectory::new();
    write_bundle(directory.path(), b'a', 0o400);
    let loader = immutable_loader(directory.path(), access_policy());

    let first = loader.load().unwrap();
    let second = loader.load().unwrap();

    assert_eq!(first.revision(), second.revision());
    assert_eq!(first.byte_lengths(), [1, 1, 1, 1]);
    assert_eq!(
        format!("{first:?}"),
        "LoadedInternalMtlsPemBundle([REDACTED])"
    );
    let _ = first.into_pem_bundle();
}

#[test]
fn atomic_writer_resolves_data_once_and_never_mixes_generations() {
    let mount = Arc::new(TestDirectory::new());
    let old = mount.path().join("..old");
    let new = mount.path().join("..new");
    fs::create_dir(&old).unwrap();
    fs::create_dir(&new).unwrap();
    set_mode(&old, 0o700);
    set_mode(&new, 0o700);
    write_bundle(&old, b'o', 0o400);
    write_bundle(&new, b'n', 0o400);
    symlink("..old", mount.path().join("..data")).unwrap();
    let old_revision = immutable_loader(&old, access_policy())
        .load()
        .unwrap()
        .revision();
    let new_revision = immutable_loader(&new, access_policy())
        .load()
        .unwrap()
        .revision();
    let loader = Arc::new(atomic_loader(mount.path(), access_policy()));
    let writer_mount = Arc::clone(&mount);

    let writer = thread::spawn(move || {
        let next = writer_mount.path().join("..data-next");
        symlink("..new", &next).unwrap();
        fs::rename(&next, writer_mount.path().join("..data")).unwrap();
        fs::remove_dir_all(writer_mount.path().join("..old")).unwrap();
    });
    let mut successful_loads = 0usize;
    for _ in 0..64 {
        if let Ok(bundle) = loader.load() {
            assert!(
                matches!(bundle.revision(), revision if revision == old_revision || revision == new_revision)
            );
            assert!(matches!(bundle.byte_lengths(), [1, 1, 1, 1]));
            successful_loads += 1;
        }
        thread::yield_now();
    }
    writer.join().unwrap();

    assert!(successful_loads > 0);
    assert_eq!(loader.load().unwrap().revision(), new_revision);
}

#[test]
fn atomic_writer_rejects_escape_and_unbounded_generation_targets() {
    for target in [".", "..", "..data", "/escape", "nested/escape"] {
        let mount = TestDirectory::new();
        symlink(target, mount.path().join("..data")).unwrap();
        assert_eq!(
            atomic_loader(mount.path(), access_policy())
                .load()
                .unwrap_err(),
            InternalMtlsBundleLoadError::GenerationInvalid
        );
    }

    let mount = TestDirectory::new();
    symlink("a".repeat(256), mount.path().join("..data")).unwrap();
    assert_eq!(
        atomic_loader(mount.path(), access_policy())
            .load()
            .unwrap_err(),
        InternalMtlsBundleLoadError::GenerationInvalid
    );
}

#[test]
fn entry_symlinks_and_non_files_fail_without_blocking() {
    let directory = TestDirectory::new();
    write_bundle(directory.path(), b'a', 0o400);
    fs::remove_file(directory.path().join(TLS_CERT)).unwrap();
    symlink(TLS_KEY, directory.path().join(TLS_CERT)).unwrap();
    assert_eq!(
        immutable_loader(directory.path(), access_policy())
            .load()
            .unwrap_err(),
        InternalMtlsBundleLoadError::EntryInvalid
    );

    fs::remove_file(directory.path().join(TLS_CERT)).unwrap();
    #[cfg(not(target_vendor = "apple"))]
    rustix::fs::mkfifoat(
        rustix::fs::CWD,
        directory.path().join(TLS_CERT),
        rustix::fs::Mode::RUSR,
    )
    .unwrap();
    #[cfg(target_vendor = "apple")]
    fs::create_dir(directory.path().join(TLS_CERT)).unwrap();
    assert_eq!(
        immutable_loader(directory.path(), access_policy())
            .load()
            .unwrap_err(),
        InternalMtlsBundleLoadError::EntryInvalid
    );
}

#[test]
fn directory_file_owner_and_group_policy_fail_closed() {
    let directory = TestDirectory::new();
    write_bundle(directory.path(), b'a', 0o400);
    set_mode(directory.path(), 0o722);
    assert_eq!(
        immutable_loader(directory.path(), access_policy())
            .load()
            .unwrap_err(),
        InternalMtlsBundleLoadError::PermissionsInvalid
    );

    set_mode(directory.path(), 0o700);
    set_mode(&directory.path().join(TLS_KEY), 0o444);
    assert_eq!(
        immutable_loader(directory.path(), access_policy())
            .load()
            .unwrap_err(),
        InternalMtlsBundleLoadError::PermissionsInvalid
    );

    set_mode(&directory.path().join(TLS_KEY), 0o400);
    let unexpected_owner = current_uid().checked_add(1).unwrap();
    assert_eq!(
        immutable_loader(
            directory.path(),
            InternalMtlsBundleAccessPolicy::new(unexpected_owner, None).unwrap(),
        )
        .load()
        .unwrap_err(),
        InternalMtlsBundleLoadError::PermissionsInvalid
    );

    set_mode(&directory.path().join(TLS_KEY), 0o440);
    let unrelated_group = current_gid().checked_add(1).unwrap();
    assert_eq!(
        immutable_loader(
            directory.path(),
            InternalMtlsBundleAccessPolicy::new(current_uid(), Some(unrelated_group)).unwrap(),
        )
        .load()
        .unwrap_err(),
        InternalMtlsBundleLoadError::PermissionsInvalid
    );
    assert!(
        immutable_loader(
            directory.path(),
            InternalMtlsBundleAccessPolicy::new(current_uid(), Some(current_gid())).unwrap(),
        )
        .load()
        .is_ok()
    );
}

#[test]
fn every_file_budget_is_enforced_before_unbounded_reading() {
    for (file, limit) in FILES.into_iter().zip(LIMITS) {
        let directory = TestDirectory::new();
        write_bundle(directory.path(), b'a', 0o400);
        set_file_mode(directory.path(), file, 0o600);
        fs::write(directory.path().join(file), vec![0; limit + 1]).unwrap();
        set_file_mode(
            directory.path(),
            file,
            if file == TLS_KEY { 0o400 } else { 0o600 },
        );

        assert_eq!(
            immutable_loader(directory.path(), access_policy())
                .load()
                .unwrap_err(),
            InternalMtlsBundleLoadError::EntryTooLarge
        );
    }
}

fn immutable_loader(
    path: &Path,
    policy: InternalMtlsBundleAccessPolicy,
) -> InternalMtlsBundleLoader {
    InternalMtlsBundleLoader::new(
        InternalMtlsBundleSource::new(path, InternalMtlsBundleLayout::ImmutableDirectory).unwrap(),
        policy,
    )
}

fn atomic_loader(path: &Path, policy: InternalMtlsBundleAccessPolicy) -> InternalMtlsBundleLoader {
    InternalMtlsBundleLoader::new(
        InternalMtlsBundleSource::new(path, InternalMtlsBundleLayout::KubernetesAtomicWriter)
            .unwrap(),
        policy,
    )
}

fn access_policy() -> InternalMtlsBundleAccessPolicy {
    InternalMtlsBundleAccessPolicy::new(current_uid(), None).unwrap()
}

fn current_uid() -> u32 {
    rustix::process::geteuid().as_raw()
}

fn current_gid() -> u32 {
    rustix::process::getegid().as_raw()
}

fn write_bundle(directory: &Path, marker: u8, key_mode: u32) {
    for file in FILES {
        fs::write(directory.join(file), [marker]).unwrap();
        set_file_mode(
            directory,
            file,
            if file == TLS_KEY { key_mode } else { 0o600 },
        );
    }
}

fn set_file_mode(directory: &Path, file: &str, mode: u32) {
    set_mode(&directory.join(file), mode);
}

fn set_mode(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

static NEXT_TEMP_DIRECTORY: AtomicU64 = AtomicU64::new(1);

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let sequence = NEXT_TEMP_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "converact-mtls-bundle-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        set_mode(&path, 0o700);
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
