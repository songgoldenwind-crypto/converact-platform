use std::{env, time::Duration};

use converact_kernel_ids::{CellId, Generation, OwnerEpoch, TenantId};
use converact_migration_routing::{
    ActiveZeroCommand, AuthorityKind, CommitCommand, DrainCommand, Implementation, OperationId,
    OperationMeta, PartitionKey, PrepareCommand, RequestHash, RetireCommand, RouteError, RouteKey,
    RouteRevision, RouteState, SchemaRevision, WriterTarget,
};
use converact_migration_store::{
    DurableRouteCommand, LeaseToken, PostgresRouteStore, StoreConfig, StoreError,
};
use tokio_postgres::{NoTls, error::SqlState};

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database migrated through 117"]
async fn postgres_store_applies_replays_and_reconciles_the_full_route_lifecycle() {
    let database_url = env::var("CONVERACT_TEST_POSTGRES_URL")
        .expect("CONVERACT_TEST_POSTGRES_URL for isolated test database");
    let admin_database_url = env::var("CONVERACT_TEST_POSTGRES_ADMIN_URL")
        .expect("CONVERACT_TEST_POSTGRES_ADMIN_URL for isolated test database");
    let (mut client, connection) = tokio_postgres::connect(&database_url, NoTls)
        .await
        .expect("connect isolated PostgreSQL");
    let connection_task = tokio::spawn(connection);
    seed_shadow_route(&mut client).await;
    exercise_concurrent_claims(&database_url).await;
    assert_purge_rejects_unbounded_inputs(&mut client).await;
    backdate_released_claim(&admin_database_url, "concurrent-a").await;
    assert_eq!(purge_released_claims(&mut client).await, 0);

    let store = PostgresRouteStore::new(StoreConfig::new(30_000, 1).unwrap());
    let key = key();
    apply_prepare_and_replay(&store, &mut client, &key).await;

    apply_commit(&store, &mut client, &key).await;
    apply_drain(&store, &mut client, &key).await;
    reconcile_predecessor_claim(&mut client, true).await;
    seal_predecessor_claims(&mut client).await;
    let nonzero = store.apply(&mut client, &key, active_zero_command()).await;
    assert!(matches!(nonzero, Err(StoreError::ConcurrentMutation)));
    reconcile_predecessor_claim(&mut client, false).await;
    apply_active_zero(&store, &mut client, &key).await;
    tokio::time::sleep(Duration::from_millis(5)).await;
    let retired = apply_retire(&store, &mut client, &key).await;
    assert_eq!(retired.state(), RouteState::Retired);
    assert_eq!(retired.current_writer().generation(), generation(2));
    assert_eq!(retired.draining_generation(), None);
    assert_eq!(purge_released_claims(&mut client).await, 1);
    assert_eq!(purge_released_claims(&mut client).await, 0);

    let queried = store
        .query(&mut client, &key)
        .await
        .expect("query route")
        .expect("route exists");
    assert_eq!(queried, retired);
    let receipt = store
        .reconcile(&mut client, &key, &retire_command())
        .await
        .expect("reconcile receipt")
        .expect("receipt exists");
    assert_eq!(receipt.route(), &retired);

    drop(client);
    connection_task
        .await
        .expect("join PostgreSQL connection")
        .expect("PostgreSQL connection completed");
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database migrated through 117"]
async fn postgres_store_tracks_and_retires_multiple_predecessors() {
    let database_url = env::var("CONVERACT_TEST_POSTGRES_URL")
        .expect("CONVERACT_TEST_POSTGRES_URL for isolated test database");
    let (mut client, connection) = tokio_postgres::connect(&database_url, NoTls)
        .await
        .expect("connect isolated PostgreSQL");
    let connection_task = tokio::spawn(connection);
    seed_shadow_route_for_partition(&mut client, "partition-ledger", 'd').await;
    let key = ledger_key();
    let store = PostgresRouteStore::new(StoreConfig::new(30_000, 1).unwrap());
    migrate_route_twice(&store, &mut client, &key).await;
    seal_generation_claims(&mut client, "partition-ledger", 1).await;

    let page = store
        .query_predecessor_page(&mut client, &key, None)
        .await
        .unwrap();
    let predecessors = page.items();
    assert_eq!(predecessors.len(), 2);
    assert_eq!(predecessors[0].generation(), generation(1));
    assert_eq!(predecessors[1].generation(), generation(2));
    assert!(
        store
            .mark_unreferenced_active_zero(&mut client, &key, generation(1))
            .await
            .unwrap()
    );
    assert!(
        !store
            .mark_unreferenced_active_zero(&mut client, &key, generation(1))
            .await
            .unwrap()
    );
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert!(
        store
            .retire_unreferenced_generation(&mut client, &key, generation(1))
            .await
            .unwrap()
    );
    assert!(
        !store
            .retire_unreferenced_generation(&mut client, &key, generation(1))
            .await
            .unwrap()
    );
    let page = store
        .query_predecessor_page(&mut client, &key, None)
        .await
        .unwrap();
    let predecessors = page.items();
    assert_eq!(predecessors.len(), 1);
    assert_eq!(predecessors[0].generation(), generation(2));

    drop(client);
    connection_task.await.unwrap().unwrap();
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database migrated through 117"]
async fn postgres_store_pages_more_than_sixty_four_predecessors() {
    let database_url = env::var("CONVERACT_TEST_POSTGRES_URL")
        .expect("CONVERACT_TEST_POSTGRES_URL for isolated test database");
    let (mut client, connection) = tokio_postgres::connect(&database_url, NoTls)
        .await
        .expect("connect isolated PostgreSQL");
    let connection_task = tokio::spawn(connection);
    seed_shadow_route_for_partition(&mut client, "partition-page", 'c').await;
    let key = page_key();
    let store = PostgresRouteStore::new(StoreConfig::new(30_000, 1).unwrap());
    migrate_route_repeatedly(&store, &mut client, &key, 66).await;
    for predecessor in 1..=32 {
        seal_generation_claims(&mut client, "partition-page", predecessor).await;
        assert!(
            store
                .mark_unreferenced_active_zero(&mut client, &key, generation(predecessor))
                .await
                .unwrap()
        );
    }
    assert_predecessor_query_uses_bounded_index(&mut client, &key).await;

    let first = store
        .query_predecessor_page(&mut client, &key, None)
        .await
        .unwrap();
    assert_eq!(first.items().len(), 64);
    assert_eq!(first.items()[0].generation(), generation(1));
    assert_eq!(first.items()[63].generation(), generation(64));
    let cursor = first.next_after().unwrap();
    assert_eq!(cursor, generation(64));

    let second = store
        .query_predecessor_page(&mut client, &key, Some(cursor))
        .await
        .unwrap();
    assert_eq!(second.items().len(), 2);
    assert_eq!(second.items()[0].generation(), generation(65));
    assert_eq!(second.items()[1].generation(), generation(66));
    assert_eq!(second.next_after(), None);

    drop(client);
    connection_task.await.unwrap().unwrap();
}

async fn exercise_concurrent_claims(database_url: &str) {
    let claim_a = run_work_claim(database_url.to_owned(), "concurrent-a", false);
    let claim_b = run_work_claim(database_url.to_owned(), "concurrent-b", false);
    let (claim_a, claim_b) = tokio::join!(claim_a, claim_b);
    claim_a.unwrap();
    claim_b.unwrap();

    let release_a = run_work_claim(database_url.to_owned(), "concurrent-a", true);
    let release_b = run_work_claim(database_url.to_owned(), "concurrent-b", true);
    let (release_a, release_b) = tokio::join!(release_a, release_b);
    release_a.unwrap();
    release_b.unwrap();
}

async fn run_work_claim(
    database_url: String,
    claim_id: &'static str,
    release: bool,
) -> Result<(), tokio_postgres::Error> {
    let (mut client, connection) = tokio_postgres::connect(&database_url, NoTls).await?;
    let connection_task = tokio::spawn(connection);
    let transaction = client.transaction().await?;
    transaction
        .query_one(
            "SELECT set_config('app.current_tenant', 'tenant-a', true)",
            &[],
        )
        .await?;
    let sql = if release {
        "SELECT converact_authority_release_generation_work(
           'tenant-a', 'interaction', 'partition-1', 1, 7, repeat('a', 64),
           'durable_object', $1
         )"
    } else {
        "SELECT converact_authority_claim_generation_work(
           'tenant-a', 'interaction', 'partition-1', 1, 7, repeat('a', 64),
           'new', NULL, 'durable_object', $1
         )"
    };
    let changed: bool = transaction.query_one(sql, &[&claim_id]).await?.get(0);
    assert!(changed);
    transaction.commit().await?;
    drop(client);
    connection_task.await.expect("join claim connection")?;
    Ok(())
}

async fn assert_purge_rejects_unbounded_inputs(client: &mut tokio_postgres::Client) {
    for limit in [None, Some(0_i32), Some(257_i32)] {
        let transaction = client.transaction().await.unwrap();
        transaction
            .query_one(
                "SELECT set_config('app.current_tenant', 'tenant-a', true)",
                &[],
            )
            .await
            .unwrap();
        let error = transaction
            .query_one(
                "SELECT converact_authority_purge_released_claims(
                   'tenant-a', 'interaction', 'partition-1', 1,
                   transaction_timestamp(), $1
                 )",
                &[&limit],
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), Some(&SqlState::INSUFFICIENT_PRIVILEGE));
        transaction.rollback().await.unwrap();
    }

    let transaction = client.transaction().await.unwrap();
    transaction
        .query_one(
            "SELECT set_config('app.current_tenant', 'tenant-a', true)",
            &[],
        )
        .await
        .unwrap();
    let error = transaction
        .query_one(
            "SELECT converact_authority_purge_released_claims(
               'tenant-a', 'interaction', 'partition-1', 1, NULL, 1
             )",
            &[],
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), Some(&SqlState::INSUFFICIENT_PRIVILEGE));
    transaction.rollback().await.unwrap();

    let transaction = client.transaction().await.unwrap();
    transaction
        .query_one(
            "SELECT set_config('app.current_tenant', 'tenant-a', true)",
            &[],
        )
        .await
        .unwrap();
    let error = transaction
        .query_one(
            "SELECT converact_authority_purge_released_claims(
               'tenant-a', 'interaction', 'partition-1', NULL,
               transaction_timestamp(), 1
             )",
            &[],
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), Some(&SqlState::INSUFFICIENT_PRIVILEGE));
    transaction.rollback().await.unwrap();
}

async fn assert_predecessor_query_uses_bounded_index(
    client: &mut tokio_postgres::Client,
    key: &RouteKey,
) {
    let transaction = client.transaction().await.unwrap();
    transaction
        .query_one(
            "SELECT set_config('app.current_tenant', $1, true)",
            &[&key.tenant_id().as_str()],
        )
        .await
        .unwrap();
    let rows = transaction
        .query(
            "EXPLAIN (FORMAT TEXT, COSTS OFF)
             SELECT generation.generation::text, generation.generation_state
             FROM converact_authority_generations AS generation
             INNER JOIN converact_authority_routes AS route
               ON route.tenant_id = generation.tenant_id
              AND route.authority_kind = generation.authority_kind
              AND route.partition_key = generation.partition_key
             WHERE route.tenant_id = $1
               AND route.authority_kind = $2
               AND route.partition_key = $3
               AND generation.generation <> route.current_generation
               AND generation.generation > $4::text::numeric
               AND generation.generation_state IN ('draining', 'active_zero')
             ORDER BY generation.generation
             LIMIT $5",
            &[
                &key.tenant_id().as_str(),
                &key.authority_kind().as_str(),
                &key.partition_key().as_str(),
                &"0",
                &65_i64,
            ],
        )
        .await
        .unwrap();
    let plan = rows
        .into_iter()
        .map(|row| row.get::<_, String>(0))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(plan.contains("converact_authority_nonterminal_predecessor_page"));
    assert!(
        !plan.contains("Sort"),
        "unexpected predecessor sort:\n{plan}"
    );
    transaction.commit().await.unwrap();
}

async fn backdate_released_claim(database_url: &str, claim_id: &str) {
    let (mut client, connection) = tokio_postgres::connect(database_url, NoTls).await.unwrap();
    let connection_task = tokio::spawn(connection);
    let transaction = client.transaction().await.unwrap();
    transaction
        .batch_execute("SET LOCAL session_replication_role = replica")
        .await
        .unwrap();
    let changed = transaction
        .execute(
            "UPDATE converact_authority_generation_claims
             SET released_at = transaction_timestamp() - interval '8 days',
                 idempotency_expires_at = transaction_timestamp() - interval '1 day'
             WHERE tenant_id = 'tenant-a'
               AND authority_kind = 'interaction'
               AND partition_key = 'partition-1'
               AND generation = 1
               AND claim_kind = 'durable_object'
               AND claim_id = $1
               AND claim_state = 'released'",
            &[&claim_id],
        )
        .await
        .unwrap();
    assert_eq!(changed, 1);
    transaction.commit().await.unwrap();
    drop(client);
    connection_task.await.unwrap().unwrap();
}

async fn purge_released_claims(client: &mut tokio_postgres::Client) -> i32 {
    let transaction = client.transaction().await.unwrap();
    transaction
        .query_one(
            "SELECT set_config('app.current_tenant', 'tenant-a', true)",
            &[],
        )
        .await
        .unwrap();
    let purged = transaction
        .query_one(
            "SELECT converact_authority_purge_released_claims(
               'tenant-a', 'interaction', 'partition-1', 1,
               transaction_timestamp(), 256
             )",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    transaction.commit().await.unwrap();
    purged
}

async fn apply_prepare_and_replay(
    store: &PostgresRouteStore,
    client: &mut tokio_postgres::Client,
    key: &RouteKey,
) {
    let prepare = PrepareCommand {
        operation_id: operation("prepare-1"),
        request_hash: hash('1'),
        expected_generation: generation(1),
        expected_revision: revision(1),
        target: WriterTarget::new(
            CellId::parse("cell-b").unwrap(),
            Implementation::Rust,
            OwnerEpoch::parse("8").unwrap(),
            SchemaRevision::new(2).unwrap(),
        ),
    };
    let first = store
        .apply(
            client,
            key,
            DurableRouteCommand::prepare(
                prepare.clone(),
                &LeaseToken::parse(&"b".repeat(64)).unwrap(),
            ),
        )
        .await
        .expect("prepare route");
    assert_eq!(first.route.state(), RouteState::Prepare);
    assert!(!first.replayed);

    let replay = store
        .apply(
            client,
            key,
            DurableRouteCommand::prepare(
                prepare.clone(),
                &LeaseToken::parse(&"b".repeat(64)).unwrap(),
            ),
        )
        .await
        .expect("replay prepare receipt");
    assert!(replay.replayed);
    assert_eq!(replay.route, first.route);

    let capability_conflict = store
        .apply(
            client,
            key,
            DurableRouteCommand::prepare(
                prepare.clone(),
                &LeaseToken::parse(&"c".repeat(64)).unwrap(),
            ),
        )
        .await;
    assert!(matches!(
        capability_conflict,
        Err(StoreError::Domain(RouteError::ReceiptMismatch))
    ));

    let conflict = store
        .apply(
            client,
            key,
            DurableRouteCommand::prepare(
                PrepareCommand {
                    request_hash: hash('2'),
                    ..prepare
                },
                &LeaseToken::parse(&"c".repeat(64)).unwrap(),
            ),
        )
        .await;
    assert!(matches!(
        conflict,
        Err(StoreError::Domain(RouteError::IdempotencyConflict))
    ));
}

async fn seed_shadow_route(client: &mut tokio_postgres::Client) {
    seed_shadow_route_for_partition(client, "partition-1", 'a').await;
}

async fn seed_shadow_route_for_partition(
    client: &mut tokio_postgres::Client,
    partition_key: &str,
    lease_token: char,
) {
    let transaction = client.transaction().await.unwrap();
    transaction
        .query_one(
            "SELECT set_config('app.current_tenant', 'tenant-a', true)",
            &[],
        )
        .await
        .unwrap();
    transaction
        .execute(
            "INSERT INTO converact_authority_routes (
               tenant_id, authority_kind, partition_key, current_generation,
               route_revision, route_state
             ) VALUES ('tenant-a', 'interaction', $1, 1, 1, 'shadow')",
            &[&partition_key],
        )
        .await
        .unwrap();
    transaction
        .execute(
            "INSERT INTO converact_authority_generations (
               tenant_id, authority_kind, partition_key, generation, cell_id,
               implementation, owner_epoch, schema_revision, generation_state,
               lease_token_sha256, lease_expires_at
             ) VALUES (
               'tenant-a', 'interaction', $1, 1, 'cell-a',
               'typescript', 7, 1, 'accepting_new_work',
               encode(sha256(convert_to(repeat($2, 64), 'UTF8')), 'hex'),
               transaction_timestamp() + interval '1 hour'
             )",
            &[&partition_key, &lease_token.to_string()],
        )
        .await
        .unwrap();
    transaction.commit().await.unwrap();
}

async fn seal_predecessor_claims(client: &mut tokio_postgres::Client) {
    seal_generation_claims(client, "partition-1", 1).await;
}

async fn seal_generation_claims(
    client: &mut tokio_postgres::Client,
    partition_key: &str,
    generation: u64,
) {
    let transaction = client.transaction().await.unwrap();
    transaction
        .query_one(
            "SELECT set_config('app.current_tenant', 'tenant-a', true)",
            &[],
        )
        .await
        .unwrap();
    let sealed: bool = transaction
        .query_one(
            "SELECT converact_authority_seal_generation_claims(
               'tenant-a', 'interaction', $1, $2::text::numeric
             )",
            &[&partition_key, &generation.to_string()],
        )
        .await
        .unwrap()
        .get(0);
    assert!(sealed);
    transaction.commit().await.unwrap();
}

async fn migrate_route_twice(
    store: &PostgresRouteStore,
    client: &mut tokio_postgres::Client,
    key: &RouteKey,
) {
    store
        .apply(
            client,
            key,
            DurableRouteCommand::prepare(
                PrepareCommand {
                    operation_id: operation("ledger-prepare-1"),
                    request_hash: hash('7'),
                    expected_generation: generation(1),
                    expected_revision: revision(1),
                    target: WriterTarget::new(
                        CellId::parse("cell-b").unwrap(),
                        Implementation::Rust,
                        OwnerEpoch::parse("8").unwrap(),
                        SchemaRevision::new(2).unwrap(),
                    ),
                },
                &LeaseToken::parse(&"e".repeat(64)).unwrap(),
            ),
        )
        .await
        .unwrap();
    store
        .apply(
            client,
            key,
            CommitCommand {
                operation: meta("ledger-commit-1", '8', 1, 2),
                prepare_operation_id: operation("ledger-prepare-1"),
            }
            .into(),
        )
        .await
        .unwrap();
    store
        .apply(
            client,
            key,
            DurableRouteCommand::prepare(
                PrepareCommand {
                    operation_id: operation("ledger-prepare-2"),
                    request_hash: hash('9'),
                    expected_generation: generation(2),
                    expected_revision: revision(3),
                    target: WriterTarget::new(
                        CellId::parse("cell-c").unwrap(),
                        Implementation::Rust,
                        OwnerEpoch::parse("9").unwrap(),
                        SchemaRevision::new(3).unwrap(),
                    ),
                },
                &LeaseToken::parse(&"f".repeat(64)).unwrap(),
            ),
        )
        .await
        .unwrap();
    store
        .apply(
            client,
            key,
            CommitCommand {
                operation: meta("ledger-commit-2", 'a', 2, 4),
                prepare_operation_id: operation("ledger-prepare-2"),
            }
            .into(),
        )
        .await
        .unwrap();
}

async fn migrate_route_repeatedly(
    store: &PostgresRouteStore,
    client: &mut tokio_postgres::Client,
    key: &RouteKey,
    count: u64,
) {
    for migration_index in 0..count {
        let current_generation = migration_index + 1;
        let prepare_revision = migration_index * 2 + 1;
        let prepare_operation = format!("page-prepare-{current_generation}");
        let commit_operation = format!("page-commit-{current_generation}");
        let owner_epoch = current_generation + 7;
        store
            .apply(
                client,
                key,
                DurableRouteCommand::prepare(
                    PrepareCommand {
                        operation_id: operation(&prepare_operation),
                        request_hash: numbered_hash(prepare_revision),
                        expected_generation: generation(current_generation),
                        expected_revision: revision(prepare_revision),
                        target: WriterTarget::new(
                            CellId::parse("cell-page").unwrap(),
                            Implementation::Rust,
                            OwnerEpoch::parse(&owner_epoch.to_string()).unwrap(),
                            SchemaRevision::new(current_generation + 1).unwrap(),
                        ),
                    },
                    &LeaseToken::parse(&format!("{current_generation:064x}")).unwrap(),
                ),
            )
            .await
            .unwrap();
        store
            .apply(
                client,
                key,
                CommitCommand {
                    operation: OperationMeta {
                        operation_id: operation(&commit_operation),
                        request_hash: numbered_hash(prepare_revision + 1),
                        expected_generation: generation(current_generation),
                        expected_revision: revision(prepare_revision + 1),
                    },
                    prepare_operation_id: operation(&prepare_operation),
                }
                .into(),
            )
            .await
            .unwrap();
    }
}

async fn reconcile_predecessor_claim(client: &mut tokio_postgres::Client, is_active: bool) {
    let transaction = client.transaction().await.unwrap();
    transaction
        .query_one(
            "SELECT set_config('app.current_tenant', 'tenant-a', true)",
            &[],
        )
        .await
        .unwrap();
    let changed: bool = transaction
        .query_one(
            "SELECT converact_authority_reconcile_generation_claim(
               'tenant-a', 'interaction', 'partition-1', 1,
               'durable_object', 'interaction-crash-1', $1
             )",
            &[&is_active],
        )
        .await
        .unwrap()
        .get(0);
    assert!(changed);
    transaction.commit().await.unwrap();
}

async fn apply_commit(
    store: &PostgresRouteStore,
    client: &mut tokio_postgres::Client,
    key: &RouteKey,
) {
    store
        .apply(
            client,
            key,
            CommitCommand {
                operation: meta("commit-1", '3', 1, 2),
                prepare_operation_id: operation("prepare-1"),
            }
            .into(),
        )
        .await
        .expect("commit writer");
}

async fn apply_drain(
    store: &PostgresRouteStore,
    client: &mut tokio_postgres::Client,
    key: &RouteKey,
) {
    store
        .apply(
            client,
            key,
            DrainCommand {
                operation: meta("drain-1", '4', 2, 3),
                predecessor_generation: generation(1),
            }
            .into(),
        )
        .await
        .expect("begin drain");
}

async fn apply_active_zero(
    store: &PostgresRouteStore,
    client: &mut tokio_postgres::Client,
    key: &RouteKey,
) {
    store
        .apply(client, key, active_zero_command())
        .await
        .expect("mark active zero");
}

fn active_zero_command() -> DurableRouteCommand {
    ActiveZeroCommand {
        operation: meta("zero-1", '5', 2, 4),
        predecessor_generation: generation(1),
        durable_active_count: 0,
        nonterminal_claims: 0,
    }
    .into()
}

async fn apply_retire(
    store: &PostgresRouteStore,
    client: &mut tokio_postgres::Client,
    key: &RouteKey,
) -> converact_migration_routing::AuthorityRoute {
    store
        .apply(client, key, retire_command())
        .await
        .expect("retire migration metadata")
        .route
}

fn retire_command() -> DurableRouteCommand {
    RetireCommand {
        operation: meta("retire-1", '6', 2, 5),
        rollback_window_expired: true,
    }
    .into()
}

fn key() -> RouteKey {
    RouteKey::new(
        TenantId::parse("tenant-a").unwrap(),
        AuthorityKind::parse("interaction").unwrap(),
        PartitionKey::parse("partition-1").unwrap(),
    )
}

fn ledger_key() -> RouteKey {
    RouteKey::new(
        TenantId::parse("tenant-a").unwrap(),
        AuthorityKind::parse("interaction").unwrap(),
        PartitionKey::parse("partition-ledger").unwrap(),
    )
}

fn page_key() -> RouteKey {
    RouteKey::new(
        TenantId::parse("tenant-a").unwrap(),
        AuthorityKind::parse("interaction").unwrap(),
        PartitionKey::parse("partition-page").unwrap(),
    )
}

fn meta(operation_id: &str, hash_value: char, generation: u64, revision: u64) -> OperationMeta {
    OperationMeta {
        operation_id: operation(operation_id),
        request_hash: hash(hash_value),
        expected_generation: self::generation(generation),
        expected_revision: self::revision(revision),
    }
}

fn operation(value: &str) -> OperationId {
    OperationId::parse(value).unwrap()
}

fn hash(value: char) -> RequestHash {
    RequestHash::parse(&value.to_string().repeat(64)).unwrap()
}

fn numbered_hash(value: u64) -> RequestHash {
    RequestHash::parse(&format!("{value:064x}")).unwrap()
}

fn generation(value: u64) -> Generation {
    Generation::new(value).unwrap()
}

fn revision(value: u64) -> RouteRevision {
    RouteRevision::new(value).unwrap()
}
