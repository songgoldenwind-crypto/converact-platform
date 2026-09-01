const MIGRATION: &str =
    include_str!("../../../../src/migrations/136_converact_active_call_event_inbox.sql");
const DEVELOPMENT_SCHEMA: &str = include_str!("../../../../src/schema.sql");
const STORE_SOURCE: &str = include_str!("../src/active_call_event.rs");

#[test]
fn migration_freezes_one_tenant_scoped_contiguous_event_stream() {
    for required in [
        "converact_active_call_event_sessions",
        "converact_active_call_event_inbox",
        "PRIMARY KEY (tenant_id, interaction_id, execution_generation)",
        "UNIQUE (tenant_id, channel_agent_session_id, execution_generation)",
        "last_applied_cursor <= last_received_cursor",
        "terminal_cursor IS NULL OR terminal_cursor = last_received_cursor",
        "event_cursor > 0",
        "payload_digest ~ '^[0-9a-f]{64}$'",
        "octet_length(event_payload) BETWEEN 1 AND 131072",
        "ENABLE ROW LEVEL SECURITY",
        "FORCE ROW LEVEL SECURITY",
    ] {
        assert!(
            MIGRATION.contains(required),
            "missing migration invariant {required}"
        );
    }
}

#[test]
fn migration_exposes_atomic_append_apply_and_reconcile_transitions() {
    for required in [
        "converact_active_call_event_append",
        "converact_active_call_event_mark_applied",
        "converact_active_call_event_require_reconcile",
        "FOR UPDATE",
        "expected_previous_cursor",
        "replayed_pending",
        "replayed_applied",
        "Active Call event stream requires reconciliation",
        "event cursor is not contiguous",
        "event replay conflicts with durable payload",
        "GRANT EXECUTE ON FUNCTION converact_active_call_event_append",
        "GRANT EXECUTE ON FUNCTION converact_active_call_event_mark_applied",
        "GRANT EXECUTE ON FUNCTION converact_active_call_event_require_reconcile",
    ] {
        assert!(
            MIGRATION.contains(required),
            "missing transition invariant {required}"
        );
    }
}

#[test]
fn development_schema_and_rust_adapter_preserve_the_same_bounded_contract() {
    for required in [
        "converact_active_call_event_sessions",
        "converact_active_call_event_inbox",
        "last_received_cursor INTEGER NOT NULL",
        "last_applied_cursor INTEGER NOT NULL",
        "event_payload TEXT NOT NULL",
    ] {
        assert!(
            DEVELOPMENT_SCHEMA.contains(required),
            "missing development schema invariant {required}"
        );
    }
    for required in [
        "PostgresActiveCallEventStore",
        "load_snapshot",
        "append_event",
        "mark_event_applied",
        "require_reconcile",
        "FOR SHARE",
        "LIMIT 1025",
    ] {
        assert!(
            STORE_SOURCE.contains(required),
            "missing adapter invariant {required}"
        );
    }
}
