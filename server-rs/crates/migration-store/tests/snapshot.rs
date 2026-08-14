use converact_kernel_ids::{CellId, Generation, OwnerEpoch, TenantId};
use converact_migration_routing::{
    AuthorityKind, AuthorityRoute, Implementation, OperationId, PartitionKey, PreparedBinding,
    RouteKey, RouteRevision, RouteState, SchemaRevision, WriterBinding,
};
use converact_migration_store::{SnapshotError, decode_route_snapshot, encode_route_snapshot};

#[test]
fn route_snapshot_round_trips_without_numeric_precision_loss() {
    let prepared = PreparedBinding::restore(
        binding(2, Implementation::Rust, u64::MAX),
        OperationId::parse("prepare-1").unwrap(),
        RouteState::Shadow,
    )
    .unwrap();
    let route = AuthorityRoute::restore(
        key(),
        binding(1, Implementation::TypeScript, u64::MAX),
        Some(prepared),
        None,
        RouteState::Prepare,
        RouteRevision::new(u64::MAX).unwrap(),
    )
    .unwrap();

    let encoded = encode_route_snapshot(&route).unwrap();
    assert_eq!(
        encoded.payload()["revision"],
        serde_json::Value::String(u64::MAX.to_string())
    );
    assert_eq!(
        decode_route_snapshot(encoded.payload(), encoded.sha256()).unwrap(),
        route
    );
}

#[test]
fn route_snapshot_fails_closed_on_digest_or_shape_tampering() {
    let route = AuthorityRoute::new(
        key(),
        binding(1, Implementation::TypeScript, 7),
        RouteRevision::new(1).unwrap(),
    )
    .unwrap();
    let encoded = encode_route_snapshot(&route).unwrap();
    assert_eq!(
        decode_route_snapshot(encoded.payload(), &"0".repeat(64)),
        Err(SnapshotError::DigestMismatch)
    );

    let mut tampered = encoded.payload().clone();
    tampered["state"] = serde_json::Value::String("unknown".to_owned());
    let digest = converact_contracts::canonical_sha256(&tampered).unwrap();
    assert_eq!(
        decode_route_snapshot(&tampered, &digest),
        Err(SnapshotError::InvalidPayload)
    );
}

fn key() -> RouteKey {
    RouteKey::new(
        TenantId::parse("tenant-a").unwrap(),
        AuthorityKind::parse("interaction").unwrap(),
        PartitionKey::parse("partition-1").unwrap(),
    )
}

fn binding(generation: u64, implementation: Implementation, epoch: u64) -> WriterBinding {
    WriterBinding::new(
        CellId::parse("cell-a").unwrap(),
        implementation,
        OwnerEpoch::parse(&epoch.to_string()).unwrap(),
        Generation::new(generation).unwrap(),
        SchemaRevision::new(1).unwrap(),
    )
}
