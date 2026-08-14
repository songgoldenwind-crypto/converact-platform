use std::{env, fs, path::Path, process::Command, time::Instant};

use converact_kernel_ids::{CellId, Generation, OwnerEpoch};
use converact_migration_routing::{
    CommitCommand, Implementation, OperationId, OperationMeta, PrepareCommand, RequestHash,
    RouteRevision, SchemaRevision, WriterTarget,
};
use converact_migration_store::{DurableRouteCommand, LeaseToken, PostgresRouteStore, StoreConfig};
use serde_json::Value;
use tokio_postgres::NoTls;

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database migrated through 117"]
async fn external_confirmation_and_lock_timeout_reconcile_without_blind_retry() {
    let database_url = required("CONVERACT_TEST_POSTGRES_URL");
    let (mut client, connection) = tokio_postgres::connect(&database_url, NoTls).await.unwrap();
    let connection_task = tokio::spawn(connection);
    seed_committed_route(&mut client).await;

    let directory = env::temp_dir().join(format!(
        "converact-migration-cli-postgres-{}",
        std::process::id()
    ));
    fs::create_dir_all(&directory).unwrap();
    let transition_path = directory.join("drain.json");
    write_owner_only(&transition_path, &drain_request("transition"));

    let dry = run_cli(&transition_path, None);
    assert!(dry.status.success());
    let dry: Value = serde_json::from_slice(&dry.stdout).unwrap();
    assert_eq!(dry["status"], "dry_run");
    assert_eq!(dry["mutation_performed"], false);
    let confirmation = dry["confirmation_sha256"].as_str().unwrap();

    let applied = run_cli(&transition_path, Some(confirmation));
    assert!(applied.status.success());
    let applied: Value = serde_json::from_slice(&applied.stdout).unwrap();
    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["mutation_performed"], true);

    let (mut lock_client, lock_connection) =
        tokio_postgres::connect(&database_url, NoTls).await.unwrap();
    let lock_task = tokio::spawn(lock_connection);
    let lock = lock_client.transaction().await.unwrap();
    lock.query_one(
        "SELECT set_config('app.current_tenant', 'tenant-a', true)",
        &[],
    )
    .await
    .unwrap();
    lock.query_one(
        "SELECT tenant_id FROM converact_authority_routes
         WHERE tenant_id = 'tenant-a' AND authority_kind = 'interaction'
           AND partition_key = 'cli-timeout' FOR UPDATE",
        &[],
    )
    .await
    .unwrap();

    let started = Instant::now();
    let unknown = run_cli(&transition_path, Some(confirmation));
    assert!(!unknown.status.success());
    assert_eq!(unknown.status.code(), Some(2));
    assert!(started.elapsed().as_secs() < 8);
    assert!(unknown.stdout.is_empty());
    let unknown: Value = serde_json::from_slice(&unknown.stderr).unwrap();
    assert_eq!(unknown["status"], "unknown");
    assert_eq!(unknown["mutation_performed"], Value::Null);
    assert_eq!(unknown["reconcile_required"], true);
    assert_eq!(unknown["operation_id"], "drain-cli-timeout");

    lock.rollback().await.unwrap();
    drop(lock_client);
    lock_task.await.unwrap().unwrap();

    let reconcile_path = directory.join("reconcile.json");
    write_owner_only(&reconcile_path, &drain_request("reconcile"));
    let reconciled = run_cli(&reconcile_path, None);
    assert!(reconciled.status.success());
    let reconciled: Value = serde_json::from_slice(&reconciled.stdout).unwrap();
    assert_eq!(reconciled["status"], "reconciled");
    assert_eq!(reconciled["mutation_performed"], false);

    let store = PostgresRouteStore::new(StoreConfig::new(30_000, 1).unwrap());
    let route = store
        .query(
            &mut client,
            converact_migration_tooling::MigrationRequest::from_json(&query_request())
                .unwrap()
                .key(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(route.state().as_str(), "draining");
    assert_eq!(route.revision().get(), 4);

    fs::remove_file(transition_path).unwrap();
    fs::remove_file(reconcile_path).unwrap();
    fs::remove_dir(directory).unwrap();
    drop(client);
    connection_task.await.unwrap().unwrap();
}

async fn seed_committed_route(client: &mut tokio_postgres::Client) {
    let transaction = client.transaction().await.unwrap();
    transaction
        .query_one(
            "SELECT set_config('app.current_tenant', 'tenant-a', true)",
            &[],
        )
        .await
        .unwrap();
    transaction
        .batch_execute(
            "INSERT INTO converact_authority_routes (
               tenant_id, authority_kind, partition_key, current_generation,
               route_revision, route_state
             ) VALUES ('tenant-a', 'interaction', 'cli-timeout', 1, 1, 'shadow');
             INSERT INTO converact_authority_generations (
               tenant_id, authority_kind, partition_key, generation, cell_id,
               implementation, owner_epoch, schema_revision, generation_state,
               lease_token_sha256, lease_expires_at
             ) VALUES (
               'tenant-a', 'interaction', 'cli-timeout', 1, 'cell-a',
               'typescript', 7, 1, 'accepting_new_work',
               encode(sha256(convert_to(repeat('a', 64), 'UTF8')), 'hex'),
               transaction_timestamp() + interval '1 hour'
             );",
        )
        .await
        .unwrap();
    transaction.commit().await.unwrap();

    let store = PostgresRouteStore::new(StoreConfig::new(30_000, 1).unwrap());
    let request =
        converact_migration_tooling::MigrationRequest::from_json(&query_request()).unwrap();
    store
        .apply(
            client,
            request.key(),
            DurableRouteCommand::prepare(
                PrepareCommand {
                    operation_id: operation("prepare-cli-timeout"),
                    request_hash: hash('b'),
                    expected_generation: generation(1),
                    expected_revision: revision(1),
                    target: WriterTarget::new(
                        CellId::parse("cell-b").unwrap(),
                        Implementation::Rust,
                        OwnerEpoch::parse("8").unwrap(),
                        SchemaRevision::new(2).unwrap(),
                    ),
                },
                &LeaseToken::parse(&"b".repeat(64)).unwrap(),
            ),
        )
        .await
        .unwrap();
    store
        .apply(
            client,
            request.key(),
            CommitCommand {
                operation: OperationMeta {
                    operation_id: operation("commit-cli-timeout"),
                    request_hash: hash('c'),
                    expected_generation: generation(1),
                    expected_revision: revision(2),
                },
                prepare_operation_id: operation("prepare-cli-timeout"),
            }
            .into(),
        )
        .await
        .unwrap();
}

fn run_cli(path: &Path, confirmation: Option<&str>) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_converact-migration-tool"));
    command
        .env_clear()
        .env("PGHOST", required("CONVERACT_TEST_POSTGRES_HOST"))
        .env("PGPORT", required("CONVERACT_TEST_POSTGRES_PORT"))
        .env("PGUSER", required("CONVERACT_TEST_POSTGRES_USER"))
        .env("PGDATABASE", required("CONVERACT_TEST_POSTGRES_DATABASE"))
        .arg("--request-file")
        .arg(path);
    if let Some(confirmation) = confirmation {
        command
            .arg("--apply")
            .arg("--confirmation-sha256")
            .arg(confirmation);
    }
    command.output().unwrap()
}

fn write_owner_only(path: &Path, document: &str) {
    fs::write(path, document).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
}

fn drain_request(action_kind: &str) -> String {
    format!(
        r#"{{
          "schema_version": 1,
          "tenant_id": "tenant-a",
          "authority_kind": "interaction",
          "partition_key": "cli-timeout",
          "action": {{ "kind": "{action_kind}", "command": {{
            "kind": "drain",
            "operation_id": "drain-cli-timeout",
            "request_hash": "{}",
            "expected_generation": "2",
            "expected_revision": "3",
            "predecessor_generation": "1"
          }} }}
        }}"#,
        "d".repeat(64)
    )
}

fn query_request() -> String {
    r#"{
      "schema_version": 1,
      "tenant_id": "tenant-a",
      "authority_kind": "interaction",
      "partition_key": "cli-timeout",
      "action": { "kind": "query" }
    }"#
    .into()
}

fn required(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("{name} for isolated PostgreSQL test"))
}

fn operation(value: &str) -> OperationId {
    OperationId::parse(value).unwrap()
}

fn hash(value: char) -> RequestHash {
    RequestHash::parse(&value.to_string().repeat(64)).unwrap()
}

fn generation(value: u64) -> Generation {
    Generation::new(value).unwrap()
}

fn revision(value: u64) -> RouteRevision {
    RouteRevision::new(value).unwrap()
}
