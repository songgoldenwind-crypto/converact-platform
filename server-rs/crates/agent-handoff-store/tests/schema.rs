#[test]
fn migration_freezes_handoff_context_commands_receipts_and_reconcile_claims() {
    let migration = include_str!("../../../../src/migrations/126_converact_agent_handoffs.sql");
    let development = include_str!("../../../../src/schema.sql");

    for required in [
        "converact_agent_handoff_context_packets",
        "converact_agent_handoffs",
        "converact_agent_handoff_commands",
        "converact_agent_handoff_receipts",
        "PRIMARY KEY (tenant_id, handoff_id)",
        "context_packet_digest",
        "execution_generation",
        "control_owner",
        "expected_revision",
        "expected_generation",
        "payload_hash",
        "resolution",
        "not_applied",
        "prepared",
        "state_observed",
        "reconcile_required",
        "FOR UPDATE SKIP LOCKED",
        "idx_converact_agent_handoff_reconcile_claim",
        "uq_converact_agent_handoff_active_interaction",
        "uq_converact_agent_handoff_applied_revision",
        "ENABLE ROW LEVEL SECURITY",
        "FORCE ROW LEVEL SECURITY",
        "receipts are immutable",
        "Context Packets are immutable",
    ] {
        assert!(
            migration.contains(required),
            "missing migration invariant {required}"
        );
    }

    for required in [
        "converact_agent_handoff_context_packets",
        "converact_agent_handoffs",
        "converact_agent_handoff_commands",
        "converact_agent_handoff_receipts",
        "context_packet_digest",
        "execution_generation",
        "control_owner",
        "payload_hash",
        "reconcile_required",
    ] {
        assert!(
            development.contains(required),
            "missing development invariant {required}"
        );
    }
}
