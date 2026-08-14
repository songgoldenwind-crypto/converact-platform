use std::env;

use converact_kernel_ids::{CellId, Generation, OwnerEpoch};
use converact_migration_routing::{
    CommitCommand, Implementation, OperationId, OperationMeta, PrepareCommand, RequestHash,
    RouteRevision, SchemaRevision, WriterTarget,
};
use converact_migration_store::{DurableRouteCommand, LeaseToken, PostgresRouteStore, StoreConfig};
use converact_migration_tooling::{MigrationRequest, OutcomeStatus, ValidationError, execute};
use tokio_postgres::NoTls;

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database migrated through 117"]
async fn dry_run_apply_replay_and_reconcile_never_blindly_retry() {
    let database_url = env::var("CONVERACT_TEST_POSTGRES_URL")
        .expect("CONVERACT_TEST_POSTGRES_URL for isolated test database");
    let (mut client, connection) = tokio_postgres::connect(&database_url, NoTls).await.unwrap();
    let connection_task = tokio::spawn(connection);
    seed_committed_route(&mut client).await;
    let store = PostgresRouteStore::new(StoreConfig::new(30_000, 1).unwrap());

    let dry_request = MigrationRequest::from_json(&drain_request()).unwrap();
    let confirmation = dry_request.required_confirmation_sha256().unwrap();
    let dry = execute(&store, &mut client, &dry_request).await.unwrap();
    assert_eq!(dry.status(), OutcomeStatus::DryRun);
    assert!(!dry.mutation_performed());
    assert_eq!(dry.confirmation_sha256(), Some(confirmation.as_str()));
    assert_eq!(
        route_state(&mut client).await,
        ("committed".into(), "3".into())
    );

    assert_eq!(
        dry_request.clone().with_apply_confirmation(&"f".repeat(64)),
        Err(ValidationError::ConfirmationMismatch)
    );
    assert_eq!(
        route_state(&mut client).await,
        ("committed".into(), "3".into())
    );

    let apply_request = dry_request
        .clone()
        .with_apply_confirmation(&confirmation)
        .unwrap();
    let applied = execute(&store, &mut client, &apply_request).await.unwrap();
    assert_eq!(applied.status(), OutcomeStatus::Applied);
    assert!(applied.mutation_performed());
    assert_eq!(
        route_state(&mut client).await,
        ("draining".into(), "4".into())
    );

    let replayed = execute(&store, &mut client, &apply_request).await.unwrap();
    assert_eq!(replayed.status(), OutcomeStatus::Replayed);
    assert!(!replayed.mutation_performed());
    assert_eq!(
        route_state(&mut client).await,
        ("draining".into(), "4".into())
    );

    let reconcile = MigrationRequest::from_json(&reconcile_request("drain-1")).unwrap();
    let reconciled = execute(&store, &mut client, &reconcile).await.unwrap();
    assert_eq!(reconciled.status(), OutcomeStatus::Reconciled);
    assert!(!reconciled.mutation_performed());
    let unknown = MigrationRequest::from_json(&reconcile_request("unknown-1")).unwrap();
    let unknown = execute(&store, &mut client, &unknown).await.unwrap();
    assert_eq!(unknown.status(), OutcomeStatus::Unknown);
    assert!(!unknown.mutation_performed());
    assert_eq!(
        route_state(&mut client).await,
        ("draining".into(), "4".into())
    );

    drop(client);
    connection_task.await.unwrap().unwrap();
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database migrated through 117"]
async fn prepare_dry_run_hashes_capability_before_atomic_apply() {
    let database_url = env::var("CONVERACT_TEST_POSTGRES_URL")
        .expect("CONVERACT_TEST_POSTGRES_URL for isolated test database");
    let (mut client, connection) = tokio_postgres::connect(&database_url, NoTls).await.unwrap();
    let connection_task = tokio::spawn(connection);
    seed_shadow_route(&mut client).await;
    let store = PostgresRouteStore::new(StoreConfig::new(30_000, 1).unwrap());

    let dry_request = MigrationRequest::from_json(&prepare_request()).unwrap();
    let confirmation = dry_request.required_confirmation_sha256().unwrap();
    let dry = execute(&store, &mut client, &dry_request).await.unwrap();
    assert_eq!(dry.status(), OutcomeStatus::DryRun);
    assert!(!dry.mutation_performed());
    assert_eq!(
        prepare_route_state(&store, &mut client).await,
        ("shadow", 1)
    );

    let apply = dry_request.with_apply_confirmation(&confirmation).unwrap();
    let applied = execute(&store, &mut client, &apply).await.unwrap();
    assert_eq!(applied.status(), OutcomeStatus::Applied);
    assert!(applied.mutation_performed());
    assert_eq!(
        prepare_route_state(&store, &mut client).await,
        ("prepare", 2)
    );

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
             ) VALUES ('tenant-a', 'interaction', 'tooling-1', 1, 1, 'shadow');
             INSERT INTO converact_authority_generations (
               tenant_id, authority_kind, partition_key, generation, cell_id,
               implementation, owner_epoch, schema_revision, generation_state,
               lease_token_sha256, lease_expires_at
             ) VALUES (
               'tenant-a', 'interaction', 'tooling-1', 1, 'cell-a',
               'typescript', 7, 1, 'accepting_new_work',
               encode(sha256(convert_to(repeat('a', 64), 'UTF8')), 'hex'),
               transaction_timestamp() + interval '1 hour'
             );",
        )
        .await
        .unwrap();
    transaction.commit().await.unwrap();

    let store = PostgresRouteStore::new(StoreConfig::new(30_000, 1).unwrap());
    let key = MigrationRequest::from_json(&query_request()).unwrap();
    store
        .apply(
            client,
            key.key(),
            DurableRouteCommand::prepare(
                PrepareCommand {
                    operation_id: operation("prepare-tooling-1"),
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
            key.key(),
            CommitCommand {
                operation: OperationMeta {
                    operation_id: operation("commit-tooling-1"),
                    request_hash: hash('c'),
                    expected_generation: generation(1),
                    expected_revision: revision(2),
                },
                prepare_operation_id: operation("prepare-tooling-1"),
            }
            .into(),
        )
        .await
        .unwrap();
}

async fn seed_shadow_route(client: &mut tokio_postgres::Client) {
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
             ) VALUES ('tenant-a', 'interaction', 'tooling-prepare', 1, 1, 'shadow');
             INSERT INTO converact_authority_generations (
               tenant_id, authority_kind, partition_key, generation, cell_id,
               implementation, owner_epoch, schema_revision, generation_state,
               lease_token_sha256, lease_expires_at
             ) VALUES (
               'tenant-a', 'interaction', 'tooling-prepare', 1, 'cell-a',
               'typescript', 7, 1, 'accepting_new_work',
               encode(sha256(convert_to(repeat('a', 64), 'UTF8')), 'hex'),
               transaction_timestamp() + interval '1 hour'
             );",
        )
        .await
        .unwrap();
    transaction.commit().await.unwrap();
}

async fn prepare_route_state(
    store: &PostgresRouteStore,
    client: &mut tokio_postgres::Client,
) -> (&'static str, u64) {
    let request = MigrationRequest::from_json(&prepare_query_request()).unwrap();
    let route = store.query(client, request.key()).await.unwrap().unwrap();
    (route.state().as_str(), route.revision().get())
}

async fn route_state(client: &mut tokio_postgres::Client) -> (String, String) {
    let request = MigrationRequest::from_json(&query_request()).unwrap();
    let store = PostgresRouteStore::new(StoreConfig::new(30_000, 1).unwrap());
    let route = store.query(client, request.key()).await.unwrap().unwrap();
    (
        route.state().as_str().into(),
        route.revision().get().to_string(),
    )
}

fn query_request() -> String {
    r#"{
      "schema_version": 1,
      "tenant_id": "tenant-a",
      "authority_kind": "interaction",
      "partition_key": "tooling-1",
      "action": { "kind": "query" }
    }"#
    .into()
}

fn prepare_query_request() -> String {
    r#"{
      "schema_version": 1,
      "tenant_id": "tenant-a",
      "authority_kind": "interaction",
      "partition_key": "tooling-prepare",
      "action": { "kind": "query" }
    }"#
    .into()
}

fn drain_request() -> String {
    format!(
        r#"{{
          "schema_version": 1,
          "tenant_id": "tenant-a",
          "authority_kind": "interaction",
          "partition_key": "tooling-1",
          "action": {{ "kind": "transition", "command": {{
            "kind": "drain",
            "operation_id": "drain-1",
            "request_hash": "{}",
            "expected_generation": "2",
            "expected_revision": "3",
            "predecessor_generation": "1"
          }} }}
        }}"#,
        "d".repeat(64)
    )
}

fn reconcile_request(operation_id: &str) -> String {
    drain_request()
        .replace(r#""kind": "transition""#, r#""kind": "reconcile""#)
        .replace("drain-1", operation_id)
}

fn prepare_request() -> String {
    format!(
        r#"{{
          "schema_version": 1,
          "tenant_id": "tenant-a",
          "authority_kind": "interaction",
          "partition_key": "tooling-prepare",
          "action": {{ "kind": "transition", "command": {{
            "kind": "prepare",
            "operation_id": "prepare-tooling-2",
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
        "e".repeat(64),
        "f".repeat(64)
    )
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
