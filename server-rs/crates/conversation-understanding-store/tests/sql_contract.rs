#[test]
fn adapter_serializes_only_one_attempt_generation_domain_and_rechecks_every_fence() {
    let source = include_str!("../src/postgres.rs");

    for required in [
        "pg_advisory_xact_lock(hashtextextended($1, 0))",
        "head.tenant_id = $1",
        "head.interaction_id = $2",
        "head.call_attempt_id = $3",
        "head.execution_generation = $4",
        "head.domain = $5",
        "FOR UPDATE OF head",
        "head_revision = $6",
        "record_id = $7",
        "payload_hash = $8",
        "head_revision = $9",
    ] {
        assert!(source.contains(required), "missing SQL fence {required}");
    }
}

#[test]
fn adapter_persists_complete_context_and_canonical_payload_then_loads_by_bounded_head_key() {
    let source = include_str!("../src/postgres.rs");

    for required in [
        "contract_schema_version",
        "campaign_id",
        "campaign_contact_id",
        "trace_id",
        "retention_policy_ref",
        "retention_until",
        "payload",
        "payload_hash",
        "converact_conversation_understanding_records",
        "converact_conversation_understanding_heads",
        "load_current",
    ] {
        assert!(
            source.contains(required),
            "missing persisted field {required}"
        );
    }
}

#[test]
fn adapter_has_no_unbounded_history_query_or_write_outside_the_caller_transaction() {
    let source = include_str!("../src/postgres.rs");

    assert!(!source.contains("SELECT *"));
    assert!(!source.contains("OFFSET"));
    assert!(!source.contains("Client::connect"));
    assert!(!source.contains("tokio::spawn"));
}

#[test]
fn recovery_loads_all_four_domains_with_one_bounded_sql_statement() {
    let source = include_str!("../src/postgres.rs");

    for required in [
        "load_consistent_heads",
        "head.domain IN ('intent', 'emotion', 'customer_state', 'dialogue')",
        "ORDER BY head.domain",
        "append_turn",
    ] {
        assert!(
            source.contains(required),
            "missing snapshot contract {required}"
        );
    }
}
