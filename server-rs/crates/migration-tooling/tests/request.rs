use converact_migration_store::DurableRouteCommand;
use converact_migration_tooling::{ActionKind, ExecutionMode, MigrationRequest, ValidationError};

#[test]
fn mutation_defaults_to_dry_run_and_binds_every_exact_target_field() {
    let request = MigrationRequest::from_json(&drain_request("partition-1")).unwrap();
    assert_eq!(request.execution(), ExecutionMode::DryRun);
    assert_eq!(request.action_kind(), ActionKind::Transition);
    let confirmation = request.required_confirmation_sha256().unwrap();
    assert_eq!(confirmation.len(), 64);

    let changed_partition = MigrationRequest::from_json(&drain_request("partition-2")).unwrap();
    assert_ne!(
        changed_partition.required_confirmation_sha256().unwrap(),
        confirmation
    );
    let changed_hash = drain_request("partition-1").replace(&"a".repeat(64), &"b".repeat(64));
    let changed_hash = MigrationRequest::from_json(&changed_hash).unwrap();
    assert_ne!(
        changed_hash.required_confirmation_sha256().unwrap(),
        confirmation
    );
}

#[test]
fn apply_requires_the_exact_dry_run_confirmation() {
    let dry_run = MigrationRequest::from_json(&drain_request("partition-1")).unwrap();
    let confirmation = dry_run.required_confirmation_sha256().unwrap();
    assert_eq!(
        dry_run.authorize_apply(),
        Err(ValidationError::ApplyModeRequired)
    );
    let apply = dry_run
        .clone()
        .with_apply_confirmation(&confirmation)
        .unwrap();
    assert_eq!(apply.execution(), ExecutionMode::Apply);
    assert!(apply.authorize_apply().is_ok());

    assert_eq!(
        dry_run.clone().with_apply_confirmation(&"f".repeat(64)),
        Err(ValidationError::ConfirmationMismatch)
    );
    assert_eq!(
        dry_run.with_apply_confirmation("NOT-A-SHA256"),
        Err(ValidationError::InvalidRequest)
    );
}

#[test]
fn query_and_reconcile_can_never_enter_apply_mode() {
    let query = MigrationRequest::from_json(
        r#"{
          "schema_version": 1,
          "tenant_id": "tenant-a",
          "authority_kind": "interaction",
          "partition_key": "partition-1",
          "action": { "kind": "query" }
        }"#,
    )
    .unwrap();
    assert_eq!(query.action_kind(), ActionKind::Query);
    assert_eq!(query.execution(), ExecutionMode::DryRun);
    assert_eq!(
        query.authorize_apply(),
        Err(ValidationError::ReadOnlyAction)
    );

    let invalid = MigrationRequest::from_json(&drain_request("partition-1").replace(
        r#""partition_key": "partition-1","#,
        r#""partition_key": "partition-1", "execution": "apply","#,
    ));
    assert_eq!(invalid, Err(ValidationError::InvalidRequest));
}

#[test]
fn wire_contract_rejects_unknown_fields_numbers_and_mismatched_confirmation_use() {
    let unknown = drain_request("partition-1").replace(
        r#""schema_version": 1,"#,
        r#""schema_version": 1, "surprise": true,"#,
    );
    assert_eq!(
        MigrationRequest::from_json(&unknown),
        Err(ValidationError::InvalidRequest)
    );
    let numeric_generation = drain_request("partition-1").replace(
        r#""expected_generation": "2""#,
        r#""expected_generation": 2"#,
    );
    assert_eq!(
        MigrationRequest::from_json(&numeric_generation),
        Err(ValidationError::InvalidRequest)
    );
    let dry_with_confirmation = drain_request("partition-1").replace(
        r#""partition_key": "partition-1","#,
        &format!(
            r#""partition_key": "partition-1", "confirmation_sha256": "{}","#,
            "f".repeat(64)
        ),
    );
    assert_eq!(
        MigrationRequest::from_json(&dry_with_confirmation),
        Err(ValidationError::InvalidRequest)
    );

    let embedded_apply = drain_request("partition-1").replace(
        r#""partition_key": "partition-1","#,
        r#""partition_key": "partition-1", "execution": "apply","#,
    );
    assert_eq!(
        MigrationRequest::from_json(&embedded_apply),
        Err(ValidationError::InvalidRequest)
    );
}

#[test]
fn prepare_hashes_the_raw_capability_and_binds_rollback_target_fields() {
    let raw_token = "e".repeat(64);
    let request = MigrationRequest::from_json(&prepare_request(&raw_token)).unwrap();
    assert!(matches!(
        request.command(),
        Some(DurableRouteCommand::Prepare { .. })
    ));
    let debug = format!("{request:?}");
    assert!(!debug.contains(&raw_token));

    let confirmation = request.required_confirmation_sha256().unwrap();
    let changed_token = MigrationRequest::from_json(&prepare_request(&"f".repeat(64))).unwrap();
    assert_ne!(
        changed_token.required_confirmation_sha256().unwrap(),
        confirmation
    );
    let changed_target = MigrationRequest::from_json(&prepare_request(&raw_token).replace(
        r#""implementation": "rust""#,
        r#""implementation": "typescript""#,
    ))
    .unwrap();
    assert_ne!(
        changed_target.required_confirmation_sha256().unwrap(),
        confirmation
    );
}

#[test]
fn dry_run_request_can_only_be_promoted_by_the_exact_external_confirmation() {
    let dry_run = MigrationRequest::from_json(&drain_request("partition-1")).unwrap();
    let confirmation = dry_run.required_confirmation_sha256().unwrap();
    let apply = dry_run
        .clone()
        .with_apply_confirmation(&confirmation)
        .unwrap();
    assert_eq!(apply.execution(), ExecutionMode::Apply);
    assert!(apply.authorize_apply().is_ok());
    assert_eq!(
        dry_run.with_apply_confirmation(&"f".repeat(64)),
        Err(ValidationError::ConfirmationMismatch)
    );

    let query = MigrationRequest::from_json(
        r#"{
          "schema_version": 1,
          "tenant_id": "tenant-a",
          "authority_kind": "interaction",
          "partition_key": "partition-1",
          "action": { "kind": "query" }
        }"#,
    )
    .unwrap();
    assert_eq!(
        query.with_apply_confirmation(&confirmation),
        Err(ValidationError::ReadOnlyAction)
    );
}

fn drain_request(partition: &str) -> String {
    format!(
        r#"{{
          "schema_version": 1,
          "tenant_id": "tenant-a",
          "authority_kind": "interaction",
          "partition_key": "{partition}",
          "action": {{
            "kind": "transition",
            "command": {{
              "kind": "drain",
              "operation_id": "drain-1",
              "request_hash": "{}",
              "expected_generation": "2",
              "expected_revision": "3",
              "predecessor_generation": "1"
            }}
          }}
        }}"#,
        "a".repeat(64)
    )
}

fn prepare_request(lease_token: &str) -> String {
    format!(
        r#"{{
          "schema_version": 1,
          "tenant_id": "tenant-a",
          "authority_kind": "interaction",
          "partition_key": "partition-1",
          "action": {{
            "kind": "transition",
            "command": {{
              "kind": "prepare",
              "operation_id": "prepare-1",
              "request_hash": "{}",
              "expected_generation": "1",
              "expected_revision": "1",
              "cell_id": "cell-b",
              "implementation": "rust",
              "owner_epoch": "8",
              "schema_revision": "2",
              "lease_token": "{lease_token}"
            }}
          }}
        }}"#,
        "a".repeat(64)
    )
}
