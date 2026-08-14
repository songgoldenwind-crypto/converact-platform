use converact_kernel_ids::{CellId, Generation, OwnerEpoch, TenantId};
use converact_migration_routing::{
    AuthorityKind, AuthorityRoute, Implementation, OperationId, PartitionKey, PreparedBinding,
    RequestHash, RouteError, RouteKey, RouteReceipt, RouteRevision, RouteState, SchemaRevision,
    WriterBinding,
};

#[test]
fn persisted_prepare_snapshot_restores_only_with_the_next_generation() {
    let prepared = PreparedBinding::restore(
        binding(2, Implementation::Rust),
        OperationId::parse("prepare-1").unwrap(),
        RouteState::Shadow,
    )
    .unwrap();
    let route = AuthorityRoute::restore(
        key(),
        binding(1, Implementation::TypeScript),
        Some(prepared.clone()),
        None,
        RouteState::Prepare,
        revision(2),
    )
    .unwrap();
    assert_eq!(route.prepared(), Some(&prepared));

    let skipped = PreparedBinding::restore(
        binding(3, Implementation::Rust),
        OperationId::parse("prepare-1").unwrap(),
        RouteState::Shadow,
    )
    .unwrap();
    assert_eq!(
        AuthorityRoute::restore(
            key(),
            binding(1, Implementation::TypeScript),
            Some(skipped),
            None,
            RouteState::Prepare,
            revision(2),
        ),
        Err(RouteError::InvalidState)
    );
}

#[test]
fn persisted_snapshot_rejects_dual_or_missing_authority_shapes() {
    assert_eq!(
        AuthorityRoute::restore(
            key(),
            binding(2, Implementation::Rust),
            None,
            None,
            RouteState::Committed,
            revision(3),
        ),
        Err(RouteError::InvalidState)
    );
    assert_eq!(
        AuthorityRoute::restore(
            key(),
            binding(2, Implementation::Rust),
            None,
            Some(generation(2)),
            RouteState::Draining,
            revision(4),
        ),
        Err(RouteError::InvalidState)
    );
    assert_eq!(
        PreparedBinding::restore(
            binding(2, Implementation::Rust),
            OperationId::parse("prepare-1").unwrap(),
            RouteState::Prepare,
        ),
        Err(RouteError::InvalidState)
    );
}

#[test]
fn receipt_restore_keeps_the_exact_prior_result() {
    let route = AuthorityRoute::restore(
        key(),
        binding(2, Implementation::Rust),
        None,
        Some(generation(1)),
        RouteState::Draining,
        revision(4),
    )
    .unwrap();
    let receipt = RouteReceipt::restore(
        OperationId::parse("drain-1").unwrap(),
        RequestHash::parse(&"a".repeat(64)).unwrap(),
        converact_migration_routing::RouteCommandKind::Drain,
        route.clone(),
    );
    assert_eq!(receipt.route(), &route);
}

fn key() -> RouteKey {
    RouteKey::new(
        TenantId::parse("tenant-a").unwrap(),
        AuthorityKind::parse("interaction").unwrap(),
        PartitionKey::parse("partition-1").unwrap(),
    )
}

fn binding(value: u64, implementation: Implementation) -> WriterBinding {
    WriterBinding::new(
        CellId::parse("cell-a").unwrap(),
        implementation,
        OwnerEpoch::parse("7").unwrap(),
        generation(value),
        SchemaRevision::new(1).unwrap(),
    )
}

fn generation(value: u64) -> Generation {
    Generation::new(value).unwrap()
}

fn revision(value: u64) -> RouteRevision {
    RouteRevision::new(value).unwrap()
}
