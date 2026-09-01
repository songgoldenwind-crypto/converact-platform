use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};

use converact_rustpbx_rwi_adapter::{
    ClientError, FileRwiSecretResolver, RwiSecretResolver, SecretRef,
};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);

#[test]
fn owner_only_regular_file_resolves_without_exposing_secret_in_debug() {
    let directory = test_directory();
    let secret_path = directory.join("rwi-token");
    fs::write(&secret_path, b"bounded-bearer\n").unwrap();
    fs::set_permissions(&secret_path, fs::Permissions::from_mode(0o600)).unwrap();
    let reference = SecretRef::parse(format!("file://{}", secret_path.display())).unwrap();

    let secret = FileRwiSecretResolver.resolve(&reference).unwrap();

    assert_eq!(format!("{secret:?}"), "SecretValue([REDACTED])");
    fs::remove_file(secret_path).unwrap();
    fs::remove_dir(directory).unwrap();
}

#[test]
fn symlink_and_group_readable_secret_files_fail_closed() {
    let directory = test_directory();
    let target = directory.join("target-token");
    let linked = directory.join("linked-token");
    fs::write(&target, b"bounded-bearer").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
    let target_ref = SecretRef::parse(format!("file://{}", target.display())).unwrap();
    assert_eq!(
        FileRwiSecretResolver.resolve(&target_ref).unwrap_err(),
        ClientError::SecretUnavailable
    );

    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    symlink(&target, &linked).unwrap();
    let linked_ref = SecretRef::parse(format!("file://{}", linked.display())).unwrap();
    assert_eq!(
        FileRwiSecretResolver.resolve(&linked_ref).unwrap_err(),
        ClientError::SecretUnavailable
    );
    fs::remove_file(linked).unwrap();
    fs::remove_file(target).unwrap();
    fs::remove_dir(directory).unwrap();
}

fn test_directory() -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "converact-rwi-secret-{}-{}",
        std::process::id(),
        NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&path).unwrap();
    path
}
