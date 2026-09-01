use converact_ai_outbound_store::AdminCommandKind;

#[test]
fn admin_command_kind_has_a_closed_wire_identity() {
    assert_eq!(AdminCommandKind::PublishAgent.as_str(), "publish_agent");
    assert_eq!(AdminCommandKind::CreateCampaign.as_str(), "create_campaign");
    assert_eq!(AdminCommandKind::ImportContacts.as_str(), "import_contacts");
    assert_eq!(
        AdminCommandKind::TransitionCampaign.as_str(),
        "transition_campaign"
    );
}

#[test]
fn admin_receipt_migration_is_tenant_scoped_immutable_and_content_free() {
    let sql = include_str!("../../../../src/migrations/130_converact_outbound_admin_receipts.sql");
    for required in [
        "converact_outbound_admin_receipts",
        "PRIMARY KEY (tenant_id, idempotency_key)",
        "request_hash",
        "result_state",
        "result_revision",
        "result_count",
        "ENABLE ROW LEVEL SECURITY",
        "FORCE ROW LEVEL SECURITY",
        "converact_outbound_immutable_history_guard",
        "GRANT SELECT, INSERT",
    ] {
        assert!(
            sql.contains(required),
            "missing receipt invariant {required}"
        );
    }
    for forbidden in [
        "destination",
        "consent_id",
        "transcript",
        "prompt",
        "credential",
    ] {
        assert!(!sql.contains(forbidden), "receipt schema leaks {forbidden}");
    }
}

#[test]
fn postgres_authoring_path_preserves_single_authority_and_atomic_import() {
    let source = include_str!("../src/authoring.rs");
    for required in [
        "publish_agent_release",
        "create_campaign",
        "import_contacts",
        "transition_campaign",
        "converact_outbound_admin_receipts",
        "command_kind = $3",
        "request_hash = $4",
        "converact_agent_releases",
        "state = 'published'",
        "converact_outbound_campaign_contacts",
        "converact_outbound_call_attempts",
        "attempt_number",
        "execution_generation",
        "FOR UPDATE",
        "expected_campaign_revision",
        "lock_campaign",
        "persist_campaign_transition",
        "replay_admin_command",
        "dial_policy_content_hash",
        "dial_destination",
        "dial_timeout_secs",
    ] {
        assert!(
            source.contains(required),
            "missing authoring invariant {required}"
        );
    }
}

#[test]
fn millisecond_inputs_keep_their_i64_postgres_parameter_type() {
    let source = include_str!("../src/authoring.rs");

    assert!(source.contains("to_timestamp($8::bigint / 1000.0)"));
    assert!(source.contains("to_timestamp($9::bigint / 1000.0)"));
    assert!(source.contains("to_timestamp($10::bigint / 1000.0)"));
    assert!(source.contains("to_timestamp($17::bigint / 1000.0)"));
    assert!(!source.contains("::double precision / 1000.0"));
}

#[test]
fn campaign_counter_keeps_its_i32_postgres_parameter_type() {
    let source = include_str!("../src/authoring.rs");

    assert!(source.contains("i32::try_from(command.expected_active_attempts)"));
    assert!(!source.contains("i64::from(command.expected_active_attempts)"));
}

#[test]
fn development_schema_carries_the_same_admin_receipt_contract() {
    let sql = include_str!("../../../../src/schema.sql");
    for required in [
        "converact_outbound_admin_receipts",
        "PRIMARY KEY (tenant_id, idempotency_key)",
        "request_hash",
        "result_revision",
        "result_count",
    ] {
        assert!(
            sql.contains(required),
            "missing development receipt {required}"
        );
    }
}
