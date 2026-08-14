use converact_kernel_ids::{CellId, Generation, OwnerEpoch, TenantId};
use converact_migration_routing::{
    ActiveZeroCommand, AuthorityKind, AuthorityRoute, CommitCommand, DrainCommand,
    GenerationRecord, GenerationState, Implementation, LeaseToken, MutationScope, OperationId,
    OperationMeta, PartitionKey, PrepareCommand, RequestHash, RetireCommand, RouteCommand,
    RouteError, RouteKey, RouteRevision, RouteState, SchemaRevision, WriterBinding, WriterClaim,
    WriterTarget, apply, authorize_mutation,
};

#[test]
fn drain_requires_durable_quiescence_before_active_zero_and_retirement() {
    let committed = committed_route();
    let drained = apply(
        &committed,
        RouteCommand::Drain(DrainCommand {
            operation: meta("drain-1", 'd', 2, 3),
            predecessor_generation: generation(1),
        }),
        None,
    )
    .expect("begin drain")
    .route;
    assert_eq!(drained.state(), RouteState::Draining);
    assert_eq!(drained.revision(), revision(4));

    let not_quiescent = RouteCommand::MarkActiveZero(ActiveZeroCommand {
        operation: meta("zero-1", 'e', 2, 4),
        predecessor_generation: generation(1),
        durable_active_count: 1,
        nonterminal_claims: 0,
    });
    assert_eq!(
        apply(&drained, not_quiescent, None),
        Err(RouteError::GenerationNotQuiescent)
    );

    let active_zero = apply(
        &drained,
        RouteCommand::MarkActiveZero(ActiveZeroCommand {
            operation: meta("zero-1", 'f', 2, 4),
            predecessor_generation: generation(1),
            durable_active_count: 0,
            nonterminal_claims: 0,
        }),
        None,
    )
    .expect("active zero")
    .route;
    assert_eq!(active_zero.state(), RouteState::ActiveZero);
    assert_eq!(active_zero.revision(), revision(5));

    let window_open = RouteCommand::Retire(RetireCommand {
        operation: meta("retire-1", '1', 2, 5),
        rollback_window_expired: false,
    });
    assert_eq!(
        apply(&active_zero, window_open, None),
        Err(RouteError::RollbackWindowOpen)
    );

    let retired = apply(
        &active_zero,
        RouteCommand::Retire(RetireCommand {
            operation: meta("retire-1", '2', 2, 5),
            rollback_window_expired: true,
        }),
        None,
    )
    .expect("retire route")
    .route;
    assert_eq!(retired.state(), RouteState::Retired);
    assert_eq!(retired.revision(), revision(6));
    assert_eq!(retired.draining_generation(), None);
    let lease = LeaseToken::parse(&"c".repeat(64)).unwrap();
    let current_generation = GenerationRecord::new(
        retired.key().clone(),
        retired.current_writer().clone(),
        GenerationState::AcceptingNewWork,
        lease.clone(),
    )
    .unwrap();
    let current_claim = WriterClaim::new(
        retired.key().clone(),
        generation(2),
        OwnerEpoch::parse("8").unwrap(),
        lease,
    );
    assert!(
        authorize_mutation(
            &retired,
            &current_generation,
            &current_claim,
            MutationScope::NewObject,
        )
        .is_ok(),
        "retiring migration metadata must not stop the current domain writer"
    );
    assert_eq!(
        apply(
            &retired,
            RouteCommand::Prepare(PrepareCommand {
                operation_id: operation("late-prepare"),
                request_hash: hash('3'),
                expected_generation: generation(2),
                expected_revision: revision(6),
                target: target(Implementation::TypeScript, 9, 3),
            }),
            None,
        ),
        Err(RouteError::RouteRetired)
    );
}

#[test]
fn rollback_commits_a_new_generation_instead_of_reenabling_a_stale_writer() {
    let active_zero = active_zero_route();
    let prepared = apply(
        &active_zero,
        RouteCommand::Prepare(PrepareCommand {
            operation_id: operation("rollback-prepare"),
            request_hash: hash('4'),
            expected_generation: generation(2),
            expected_revision: revision(5),
            target: target(Implementation::TypeScript, 9, 3),
        }),
        None,
    )
    .expect("prepare rollback")
    .route;
    assert_eq!(
        prepared
            .prepared()
            .expect("rollback generation")
            .writer()
            .generation(),
        generation(3)
    );

    let rolled_back = apply(
        &prepared,
        RouteCommand::Commit(CommitCommand {
            operation: meta("rollback-commit", '5', 2, 6),
            prepare_operation_id: operation("rollback-prepare"),
        }),
        None,
    )
    .expect("commit rollback")
    .route;
    assert_eq!(rolled_back.current_writer().generation(), generation(3));
    assert_eq!(
        rolled_back.current_writer().implementation(),
        Implementation::TypeScript
    );
    assert_eq!(rolled_back.draining_generation(), Some(generation(2)));
}

#[test]
fn generation_and_revision_exhaustion_fail_closed() {
    let maximum_generation = route_with(Generation::new(u64::MAX).unwrap(), revision(1));
    assert_eq!(
        apply(
            &maximum_generation,
            RouteCommand::Prepare(PrepareCommand {
                operation_id: operation("exhaust-generation"),
                request_hash: hash('6'),
                expected_generation: Generation::new(u64::MAX).unwrap(),
                expected_revision: revision(1),
                target: target(Implementation::Rust, 8, 2),
            }),
            None,
        ),
        Err(RouteError::GenerationExhausted)
    );

    let maximum_revision = route_with(generation(1), RouteRevision::new(u64::MAX).unwrap());
    assert_eq!(
        apply(
            &maximum_revision,
            RouteCommand::Prepare(PrepareCommand {
                operation_id: operation("exhaust-revision"),
                request_hash: hash('7'),
                expected_generation: generation(1),
                expected_revision: RouteRevision::new(u64::MAX).unwrap(),
                target: target(Implementation::Rust, 8, 2),
            }),
            None,
        ),
        Err(RouteError::RevisionExhausted)
    );
}

fn active_zero_route() -> AuthorityRoute {
    let committed = committed_route();
    let drained = apply(
        &committed,
        RouteCommand::Drain(DrainCommand {
            operation: meta("drain-1", '8', 2, 3),
            predecessor_generation: generation(1),
        }),
        None,
    )
    .unwrap()
    .route;
    apply(
        &drained,
        RouteCommand::MarkActiveZero(ActiveZeroCommand {
            operation: meta("zero-1", '9', 2, 4),
            predecessor_generation: generation(1),
            durable_active_count: 0,
            nonterminal_claims: 0,
        }),
        None,
    )
    .unwrap()
    .route
}

fn committed_route() -> AuthorityRoute {
    let initial = route_with(generation(1), revision(1));
    let prepared = apply(
        &initial,
        RouteCommand::Prepare(PrepareCommand {
            operation_id: operation("prepare-1"),
            request_hash: hash('a'),
            expected_generation: generation(1),
            expected_revision: revision(1),
            target: target(Implementation::Rust, 8, 2),
        }),
        None,
    )
    .unwrap()
    .route;
    apply(
        &prepared,
        RouteCommand::Commit(CommitCommand {
            operation: meta("commit-1", 'b', 1, 2),
            prepare_operation_id: operation("prepare-1"),
        }),
        None,
    )
    .unwrap()
    .route
}

fn route_with(generation: Generation, revision: RouteRevision) -> AuthorityRoute {
    AuthorityRoute::new(
        RouteKey::new(
            TenantId::parse("tenant-a").unwrap(),
            AuthorityKind::parse("interaction").unwrap(),
            PartitionKey::parse("partition-001").unwrap(),
        ),
        WriterBinding::new(
            CellId::parse("cell-a").unwrap(),
            Implementation::TypeScript,
            OwnerEpoch::parse("7").unwrap(),
            generation,
            SchemaRevision::new(1).unwrap(),
        ),
        revision,
    )
    .unwrap()
}

fn target(implementation: Implementation, owner_epoch: u64, schema_revision: u64) -> WriterTarget {
    WriterTarget::new(
        CellId::parse("cell-b").unwrap(),
        implementation,
        OwnerEpoch::parse(&owner_epoch.to_string()).unwrap(),
        SchemaRevision::new(schema_revision).unwrap(),
    )
}

fn meta(
    operation_id: &str,
    hash_value: char,
    generation_value: u64,
    revision_value: u64,
) -> OperationMeta {
    OperationMeta {
        operation_id: operation(operation_id),
        request_hash: hash(hash_value),
        expected_generation: generation(generation_value),
        expected_revision: revision(revision_value),
    }
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
