mod support;

use converact_kernel_ids::{CellId, OwnerEpoch, TenantId};
use converact_migration_routing::{
    AuthorityKind, AuthorityRoute, CommitCommand, Implementation, OperationMeta, PartitionKey,
    PrepareCommand, RouteCommand, RouteKey, SchemaRevision, WriterBinding, WriterTarget, apply,
};
use converact_migration_store::{GenerationStep, plan_transition};

#[test]
fn commit_plan_drains_predecessor_before_activating_the_successor() {
    let prepared = prepared_route();
    let command = RouteCommand::Commit(CommitCommand {
        operation: OperationMeta {
            operation_id: support::operation("commit-1"),
            request_hash: support::hash('b'),
            expected_generation: support::generation(1),
            expected_revision: support::revision(2),
        },
        prepare_operation_id: support::operation("prepare-1"),
    });
    let transition = apply(&prepared, command.clone(), None).unwrap();
    let plan = plan_transition(&prepared, &command, &transition.route).unwrap();

    assert_eq!(
        plan.generation_steps(),
        &[
            GenerationStep::BeginDrain(support::generation(1)),
            GenerationStep::ActivatePrepared(support::generation(2)),
        ]
    );
}

fn prepared_route() -> AuthorityRoute {
    let initial = AuthorityRoute::new(
        RouteKey::new(
            TenantId::parse("tenant-a").unwrap(),
            AuthorityKind::parse("interaction").unwrap(),
            PartitionKey::parse("partition-1").unwrap(),
        ),
        WriterBinding::new(
            CellId::parse("cell-a").unwrap(),
            Implementation::TypeScript,
            OwnerEpoch::parse("7").unwrap(),
            support::generation(1),
            SchemaRevision::new(1).unwrap(),
        ),
        support::revision(1),
    )
    .unwrap();
    apply(
        &initial,
        RouteCommand::Prepare(PrepareCommand {
            operation_id: support::operation("prepare-1"),
            request_hash: support::hash('a'),
            expected_generation: support::generation(1),
            expected_revision: support::revision(1),
            target: WriterTarget::new(
                CellId::parse("cell-b").unwrap(),
                Implementation::Rust,
                OwnerEpoch::parse("8").unwrap(),
                SchemaRevision::new(2).unwrap(),
            ),
        }),
        None,
    )
    .unwrap()
    .route
}
