#[test]
fn migration_freezes_tool_action_authority_receipts_and_claims() {
    let migration = include_str!("../../../../src/migrations/125_converact_tool_actions.sql");
    let development = include_str!("../../../../src/schema.sql");

    for required in [
        "converact_tool_actions",
        "converact_tool_action_receipts",
        "converact_tool_action_outbox",
        "PRIMARY KEY (tenant_id, tool_call_id)",
        "interaction_id",
        "call_attempt_id",
        "execution_generation",
        "agent_release_id",
        "tool_revision_id",
        "tool_schema_hash",
        "arguments_hash",
        "proposal_digest",
        "approval_id",
        "approval_expires_at",
        "accepted",
        "completed",
        "state_observed",
        "lease_owner",
        "lease_token_hash",
        "lease_expires_at",
        "ENABLE ROW LEVEL SECURITY",
        "FORCE ROW LEVEL SECURITY",
        "FOR UPDATE SKIP LOCKED",
        "idx_converact_tool_action_reconcile_claim",
    ] {
        assert!(
            migration.contains(required),
            "missing migration invariant {required}"
        );
    }

    for required in [
        "converact_tool_actions",
        "converact_tool_action_receipts",
        "converact_tool_action_outbox",
        "proposal_digest",
        "execution_generation",
        "approval_id",
        "state_observed",
    ] {
        assert!(
            development.contains(required),
            "missing development invariant {required}"
        );
    }
}
