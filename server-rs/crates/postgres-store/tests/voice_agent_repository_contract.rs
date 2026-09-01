use converact_postgres_store::PostgresVoiceAgentStore;

#[test]
fn voice_agent_store_is_shareable_and_exposes_only_domain_methods() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<PostgresVoiceAgentStore>();

    let source = include_str!("../src/voice_agent.rs");
    for required in [
        "load_release",
        "load_campaign",
        "load_attempt",
        "request_reconcile",
        "with_tenant_transaction",
        "FinalizationSqlStore",
        "converact_outbound_reconcile_requests",
    ] {
        assert!(
            source.contains(required),
            "missing repository boundary {required}"
        );
    }
}

#[test]
fn reconcile_request_schema_is_tenant_scoped_content_free_and_idempotent() {
    let migration =
        include_str!("../../../../src/migrations/138_converact_outbound_reconcile_requests.sql");
    let schema = include_str!("../../../../src/schema.sql");

    for required in [
        "PRIMARY KEY (tenant_id, idempotency_key)",
        "FOREIGN KEY (tenant_id, call_attempt_id)",
        "request_hash",
        "ENABLE ROW LEVEL SECURITY",
        "GRANT SELECT, INSERT",
    ] {
        assert!(
            migration.contains(required),
            "missing migration invariant {required}"
        );
    }
    for forbidden in ["destination", "transcript", "audio", "prompt", "provider"] {
        assert!(
            !migration.contains(forbidden),
            "reconcile request stores forbidden field {forbidden}"
        );
    }
    assert!(schema.contains("converact_outbound_reconcile_requests"));
}
