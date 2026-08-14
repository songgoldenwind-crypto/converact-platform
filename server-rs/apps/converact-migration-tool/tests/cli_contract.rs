use std::{ffi::OsString, fs, path::Path, process::Command};

use converact_migration_tool::{
    CliError, LocalDatabaseSettings, MAX_REQUEST_BYTES, parse_invocation, read_request_file,
    unknown_apply_outcome,
};
use converact_migration_tooling::{MigrationRequest, ValidationError};

#[test]
fn requires_one_explicit_absolute_request_file() {
    let invocation = parse_invocation([
        OsString::from("--request-file"),
        OsString::from("/tmp/rm01-request.json"),
    ])
    .unwrap();
    assert_eq!(
        invocation.request_path(),
        Path::new("/tmp/rm01-request.json")
    );

    assert_eq!(parse_invocation([]), Err(CliError::InvalidArguments));
    assert_eq!(
        parse_invocation([
            OsString::from("--request-file"),
            OsString::from("relative.json"),
        ]),
        Err(CliError::RequestPathInvalid)
    );
    assert_eq!(
        parse_invocation([
            OsString::from("--request-file"),
            OsString::from("/tmp/a"),
            OsString::from("extra"),
        ]),
        Err(CliError::InvalidArguments)
    );
}

#[test]
fn apply_requires_a_separate_exact_confirmation_flag() {
    let document = r#"{
      "schema_version": 1,
      "tenant_id": "tenant-a",
      "authority_kind": "interaction",
      "partition_key": "partition-1",
      "action": { "kind": "transition", "command": {
        "kind": "drain",
        "operation_id": "drain-1",
        "request_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "expected_generation": "2",
        "expected_revision": "3",
        "predecessor_generation": "1"
      } }
    }"#;
    let dry_request = MigrationRequest::from_json(document).unwrap();
    let confirmation = dry_request.required_confirmation_sha256().unwrap();
    let invocation = parse_invocation([
        OsString::from("--request-file"),
        OsString::from("/tmp/rm01-request.json"),
        OsString::from("--apply"),
        OsString::from("--confirmation-sha256"),
        OsString::from(&confirmation),
    ])
    .unwrap();
    assert_eq!(
        invocation.request_path(),
        Path::new("/tmp/rm01-request.json")
    );
    let apply_request = invocation.prepare_request(dry_request).unwrap();
    assert!(apply_request.authorize_apply().is_ok());
    let unknown = unknown_apply_outcome(&apply_request).unwrap();
    assert_eq!(unknown["status"], "unknown");
    assert_eq!(unknown["mutation_performed"], serde_json::Value::Null);
    assert_eq!(unknown["reconcile_required"], true);
    assert_eq!(unknown["operation_id"], "drain-1");

    assert_eq!(
        parse_invocation([
            OsString::from("--request-file"),
            OsString::from("/tmp/rm01-request.json"),
            OsString::from("--apply"),
        ]),
        Err(CliError::InvalidArguments)
    );
    let direct_apply = MigrationRequest::from_json(
        &document
            .replace(r#""partition_key": "partition-1","#, &format!(
                r#""partition_key": "partition-1", "execution": "apply", "confirmation_sha256": "{confirmation}","#
            )),
    );
    assert_eq!(direct_apply, Err(ValidationError::InvalidRequest));
}

#[test]
fn reads_only_a_bounded_regular_utf8_file() {
    let directory =
        std::env::temp_dir().join(format!("converact-migration-tool-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    let request = directory.join("request.json");
    fs::write(&request, br#"{"schema_version":1}"#).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&request, fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert_eq!(
        read_request_file(&request).unwrap(),
        r#"{"schema_version":1}"#
    );
    fs::write(&request, vec![b'a'; MAX_REQUEST_BYTES + 1]).unwrap();
    assert_eq!(read_request_file(&request), Err(CliError::RequestTooLarge));
    assert_eq!(
        read_request_file(&directory),
        Err(CliError::RequestPathInvalid)
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;

        let link = directory.join("request-link.json");
        symlink(&request, &link).unwrap();
        assert_eq!(read_request_file(&link), Err(CliError::RequestPathInvalid));
        fs::remove_file(link).unwrap();
    }
    fs::remove_file(&request).unwrap();
    fs::remove_dir(&directory).unwrap();
}

#[test]
fn permits_only_canonical_local_passwordless_postgres_configuration() {
    let settings = LocalDatabaseSettings::parse(
        "/tmp/postgres-socket",
        "rm01_operator",
        "converact",
        Some("5433"),
        false,
    )
    .unwrap();
    assert_eq!(settings.host(), Path::new("/tmp/postgres-socket"));
    assert_eq!(settings.user(), "rm01_operator");
    assert_eq!(settings.database(), "converact");
    assert_eq!(settings.port(), 5433);

    assert_eq!(
        LocalDatabaseSettings::parse("127.0.0.1", "rm01_operator", "converact", None, false,),
        Err(CliError::DatabaseConfigInvalid)
    );
    assert_eq!(
        LocalDatabaseSettings::parse(
            "/tmp/postgres-socket",
            "rm01_operator",
            "converact",
            None,
            true,
        ),
        Err(CliError::DatabaseSecretForbidden)
    );
    assert_eq!(
        LocalDatabaseSettings::parse(
            "/tmp/postgres-socket",
            "rm01_operator",
            "converact",
            Some("05432"),
            false,
        ),
        Err(CliError::DatabaseConfigInvalid)
    );
}

#[test]
fn process_emits_only_a_stable_value_free_failure_document() {
    let directory = std::env::temp_dir().join(format!(
        "converact-migration-tool-process-{}",
        std::process::id()
    ));
    fs::create_dir_all(&directory).unwrap();
    let request = directory.join("invalid.json");
    fs::write(&request, b"{}").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&request, fs::Permissions::from_mode(0o600)).unwrap();
    }

    let output = Command::new(env!("CARGO_BIN_EXE_converact-migration-tool"))
        .arg("--request-file")
        .arg(&request)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let failure: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(
        failure,
        serde_json::json!({
            "schema_version": 1,
            "status": "failed",
            "mutation_performed": false,
            "error_code": "authority_migration_tool_request_invalid"
        })
    );

    fs::remove_file(&request).unwrap();
    fs::remove_dir(&directory).unwrap();
}

#[cfg(unix)]
#[test]
fn every_request_requires_an_owner_only_file_descriptor() {
    use std::os::unix::fs::PermissionsExt;

    let directory = std::env::temp_dir().join(format!(
        "converact-migration-tool-secret-{}",
        std::process::id()
    ));
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("prepare.json");
    let document = format!(
        r#"{{
          "schema_version": 1,
          "tenant_id": "tenant-a",
          "authority_kind": "interaction",
          "partition_key": "partition-1",
          "action": {{ "kind": "transition", "command": {{
            "kind": "prepare",
            "operation_id": "prepare-1",
            "request_hash": "{}",
            "expected_generation": "1",
            "expected_revision": "1",
            "cell_id": "cell-b",
            "implementation": "rust",
            "owner_epoch": "8",
            "schema_revision": "2",
            "lease_token": "{}"
          }} }}
        }}"#,
        "a".repeat(64),
        "b".repeat(64)
    );
    fs::write(&path, &document).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        read_request_file(&path),
        Err(CliError::RequestPermissionsInvalid)
    );
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(read_request_file(&path).unwrap(), document);

    fs::remove_file(&path).unwrap();
    fs::remove_dir(&directory).unwrap();
}
