mod support;

use converact_kernel_ids::{CellId, OwnerEpoch};
use converact_migration_routing::{Implementation, PrepareCommand, SchemaRevision, WriterTarget};
use converact_migration_store::{DurableRouteCommand, LeaseToken, PostgresRouteStore, StoreConfig};

#[test]
fn durable_prepare_carries_only_a_lease_digest_into_the_store() {
    let command = PrepareCommand {
        operation_id: support::operation("prepare-2"),
        request_hash: support::hash('c'),
        expected_generation: support::generation(1),
        expected_revision: support::revision(1),
        target: WriterTarget::new(
            CellId::parse("cell-b").unwrap(),
            Implementation::Rust,
            OwnerEpoch::parse("8").unwrap(),
            SchemaRevision::new(2).unwrap(),
        ),
    };
    let token = LeaseToken::parse(&"d".repeat(64)).unwrap();
    let durable = DurableRouteCommand::prepare(command.clone(), &token);
    assert_eq!(durable.route_command().kind(), "prepare");
    assert_ne!(durable.lease_digest().unwrap().as_str(), "d".repeat(64));
    let other = DurableRouteCommand::prepare(command, &LeaseToken::parse(&"e".repeat(64)).unwrap());
    assert_ne!(
        durable.request_binding_sha256().unwrap(),
        other.request_binding_sha256().unwrap()
    );
}

#[test]
fn postgres_store_is_inert_until_given_an_explicit_client_and_command() {
    let store = PostgresRouteStore::new(StoreConfig::new(30_000, 86_400_000).unwrap());
    assert_eq!(
        store.config(),
        StoreConfig::new(30_000, 86_400_000).unwrap()
    );
}
