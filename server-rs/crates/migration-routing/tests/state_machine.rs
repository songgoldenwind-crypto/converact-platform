use converact_kernel_ids::{CellId, Generation, OwnerEpoch, TenantId};
use converact_migration_routing::{
    AbortCommand, AuthorityKind, AuthorityRoute, CommitCommand, DrainCommand, Implementation,
    OperationId, OperationMeta, PartitionKey, PrepareCommand, RequestHash, RouteCommand,
    RouteError, RouteKey, RouteRevision, RouteState, SchemaRevision, WriterBinding, WriterTarget,
    apply,
};

#[test]
fn prepare_reserves_the_next_generation_without_changing_the_writer() {
    let route = initial_route();
    let transition = apply(
        &route,
        RouteCommand::Prepare(PrepareCommand {
            operation_id: operation("migrate-1-prepare"),
            request_hash: request_hash('a'),
            expected_generation: generation(1),
            expected_revision: revision(1),
            target: rust_target(),
        }),
        None,
    )
    .expect("prepare transition");

    assert_eq!(transition.route.current_writer(), route.current_writer());
    assert_eq!(transition.route.state(), RouteState::Prepare);
    assert_eq!(transition.route.revision(), revision(2));
    let prepared = transition.route.prepared().expect("prepared writer");
    assert_eq!(prepared.writer().generation(), generation(2));
    assert_eq!(prepared.writer().implementation(), Implementation::Rust);
    assert_eq!(prepared.resume_state(), RouteState::Shadow);
    assert!(!transition.replayed);
}

#[test]
fn same_receipt_replays_exactly_and_a_different_hash_conflicts() {
    let route = initial_route();
    let command = RouteCommand::Prepare(PrepareCommand {
        operation_id: operation("migrate-1-prepare"),
        request_hash: request_hash('a'),
        expected_generation: generation(1),
        expected_revision: revision(1),
        target: rust_target(),
    });
    let first = apply(&route, command.clone(), None).expect("first prepare");
    let replay = apply(&route, command, Some(&first.receipt)).expect("idempotent replay");

    assert!(replay.replayed);
    assert_eq!(replay.route, first.route);
    assert_eq!(replay.receipt, first.receipt);

    let conflict = RouteCommand::Prepare(PrepareCommand {
        operation_id: operation("migrate-1-prepare"),
        request_hash: request_hash('b'),
        expected_generation: generation(1),
        expected_revision: revision(1),
        target: rust_target(),
    });
    assert_eq!(
        apply(&route, conflict, Some(&first.receipt)),
        Err(RouteError::IdempotencyConflict)
    );
}

#[test]
fn receipt_replay_is_bound_to_route_key_and_command_kind() {
    let route = initial_route();
    let prepare = RouteCommand::Prepare(PrepareCommand {
        operation_id: operation("migrate-1-prepare"),
        request_hash: request_hash('a'),
        expected_generation: generation(1),
        expected_revision: revision(1),
        target: rust_target(),
    });
    let first = apply(&route, prepare, None).expect("first prepare");
    let other_route = AuthorityRoute::new(
        RouteKey::new(
            TenantId::parse("tenant-b").unwrap(),
            AuthorityKind::parse("interaction").unwrap(),
            PartitionKey::parse("partition-001").unwrap(),
        ),
        route.current_writer().clone(),
        revision(1),
    )
    .unwrap();
    let same_identity_prepare = RouteCommand::Prepare(PrepareCommand {
        operation_id: operation("migrate-1-prepare"),
        request_hash: request_hash('a'),
        expected_generation: generation(1),
        expected_revision: revision(1),
        target: rust_target(),
    });
    assert_eq!(
        apply(&other_route, same_identity_prepare, Some(&first.receipt)),
        Err(RouteError::ReceiptMismatch)
    );

    let wrong_kind = RouteCommand::Drain(DrainCommand {
        operation: operation_meta("migrate-1-prepare", 'a', generation(1), revision(1)),
        predecessor_generation: generation(1),
    });
    assert_eq!(
        apply(&route, wrong_kind, Some(&first.receipt)),
        Err(RouteError::ReceiptMismatch)
    );
}

#[test]
fn prepare_requires_a_strictly_newer_owner_epoch() {
    let route = initial_route();
    for owner_epoch in [6, 7] {
        let command = RouteCommand::Prepare(PrepareCommand {
            operation_id: operation("migrate-stale-owner"),
            request_hash: request_hash('e'),
            expected_generation: generation(1),
            expected_revision: revision(1),
            target: WriterTarget::new(
                CellId::parse("cell-b").unwrap(),
                Implementation::Rust,
                OwnerEpoch::parse(&owner_epoch.to_string()).unwrap(),
                SchemaRevision::new(2).unwrap(),
            ),
        });
        assert_eq!(
            apply(&route, command, None),
            Err(RouteError::StaleOwnerEpoch)
        );
    }
}

#[test]
fn abort_restores_the_pre_prepare_state_and_commit_fences_the_predecessor() {
    let route = prepared_route();
    let abort = abort_command("migrate-1-abort", 'b', generation(1), revision(2));
    let aborted = apply(&route, abort, None).expect("abort transition");
    assert_eq!(aborted.route.state(), RouteState::Shadow);
    assert_eq!(aborted.route.current_writer().generation(), generation(1));
    assert!(aborted.route.prepared().is_none());

    let commit = commit_command("migrate-1-commit", 'c', generation(1), revision(2));
    let committed = apply(&route, commit, None).expect("commit transition");
    assert_eq!(committed.route.state(), RouteState::Committed);
    assert_eq!(committed.route.current_writer().generation(), generation(2));
    assert_eq!(committed.route.draining_generation(), Some(generation(1)));
    assert!(committed.route.prepared().is_none());
}

#[test]
fn stale_generation_or_revision_has_no_effect() {
    let route = prepared_route();
    let stale_generation = commit_command("migrate-1-commit", 'c', generation(2), revision(2));
    assert_eq!(
        apply(&route, stale_generation, None),
        Err(RouteError::StaleGeneration)
    );
    let stale_revision = commit_command("migrate-1-commit", 'c', generation(1), revision(1));
    assert_eq!(
        apply(&route, stale_revision, None),
        Err(RouteError::StaleRevision)
    );
    assert_eq!(route.current_writer().generation(), generation(1));
}

fn initial_route() -> AuthorityRoute {
    AuthorityRoute::new(
        RouteKey::new(
            TenantId::parse("tenant-a").unwrap(),
            AuthorityKind::parse("interaction").unwrap(),
            converact_migration_routing::PartitionKey::parse("partition-001").unwrap(),
        ),
        WriterBinding::new(
            CellId::parse("cell-a").unwrap(),
            Implementation::TypeScript,
            OwnerEpoch::parse("7").unwrap(),
            generation(1),
            SchemaRevision::new(1).unwrap(),
        ),
        revision(1),
    )
    .unwrap()
}

fn prepared_route() -> AuthorityRoute {
    apply(
        &initial_route(),
        RouteCommand::Prepare(PrepareCommand {
            operation_id: operation("migrate-1-prepare"),
            request_hash: request_hash('a'),
            expected_generation: generation(1),
            expected_revision: revision(1),
            target: rust_target(),
        }),
        None,
    )
    .unwrap()
    .route
}

fn rust_target() -> WriterTarget {
    WriterTarget::new(
        CellId::parse("cell-b").unwrap(),
        Implementation::Rust,
        OwnerEpoch::parse("8").unwrap(),
        SchemaRevision::new(2).unwrap(),
    )
}

fn commit_command(
    operation_id: &str,
    hash: char,
    expected_generation: Generation,
    expected_revision: RouteRevision,
) -> RouteCommand {
    RouteCommand::Commit(CommitCommand {
        operation: operation_meta(operation_id, hash, expected_generation, expected_revision),
        prepare_operation_id: operation("migrate-1-prepare"),
    })
}

fn abort_command(
    operation_id: &str,
    hash: char,
    expected_generation: Generation,
    expected_revision: RouteRevision,
) -> RouteCommand {
    RouteCommand::Abort(AbortCommand {
        operation: operation_meta(operation_id, hash, expected_generation, expected_revision),
        prepare_operation_id: operation("migrate-1-prepare"),
    })
}

fn operation_meta(
    operation_id: &str,
    hash: char,
    expected_generation: Generation,
    expected_revision: RouteRevision,
) -> OperationMeta {
    OperationMeta {
        operation_id: operation(operation_id),
        request_hash: request_hash(hash),
        expected_generation,
        expected_revision,
    }
}

fn operation(value: &str) -> OperationId {
    OperationId::parse(value).unwrap()
}

fn request_hash(value: char) -> RequestHash {
    RequestHash::parse(&value.to_string().repeat(64)).unwrap()
}

fn generation(value: u64) -> Generation {
    Generation::new(value).unwrap()
}

fn revision(value: u64) -> RouteRevision {
    RouteRevision::new(value).unwrap()
}
