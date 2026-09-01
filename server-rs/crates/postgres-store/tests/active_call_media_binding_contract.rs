const MIGRATION: &str =
    include_str!("../../../../src/migrations/140_converact_active_call_media_binding.sql");
const DEVELOPMENT_SCHEMA: &str = include_str!("../../../../src/schema.sql");
const STORE_SOURCE: &str = include_str!("../src/active_call_event.rs");

#[test]
fn migration_freezes_one_complete_media_binding_per_session_generation() {
    for required in [
        "customer_track_id",
        "call_started_at_ms",
        "language",
        "retention_policy_ref",
        "converact_active_call_event_bind_media",
        "FOR UPDATE",
        "IS NOT DISTINCT FROM",
        "retention_until",
        "bound",
        "replayed",
        "Active Call media binding conflicts with durable state",
        "GRANT EXECUTE ON FUNCTION converact_active_call_event_bind_media",
    ] {
        assert!(
            MIGRATION.contains(required),
            "missing media binding invariant {required}"
        );
    }
}

#[test]
fn development_schema_and_rust_adapter_expose_the_same_binding() {
    for required in [
        "customer_track_id TEXT",
        "call_started_at_ms INTEGER",
        "language TEXT",
        "retention_policy_ref TEXT",
    ] {
        assert!(
            DEVELOPMENT_SCHEMA.contains(required),
            "missing development binding field {required}"
        );
    }
    for required in [
        "PostgresActiveCallMediaBinding",
        "bind_media",
        "load_media_binding",
        "converact_active_call_event_bind_media",
    ] {
        assert!(
            STORE_SOURCE.contains(required),
            "missing Rust binding adapter {required}"
        );
    }
}
