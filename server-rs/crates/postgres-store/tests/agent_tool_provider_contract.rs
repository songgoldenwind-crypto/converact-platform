use converact_postgres_store::derive_agent_follow_up_task_id;
use converact_voice_agent_contracts::ToolCallId;

const MIGRATION: &str =
    include_str!("../../../../src/migrations/142_converact_agent_follow_up_tasks.sql");
const DEVELOPMENT_SCHEMA: &str = include_str!("../../../../src/schema.sql");
const PROVIDER_SOURCE: &str = include_str!("../src/agent_tool_provider.rs");

#[test]
fn follow_up_task_storage_is_tenant_scoped_idempotent_and_rls_protected() {
    for required in [
        "converact_agent_follow_up_tasks",
        "PRIMARY KEY (tenant_id, id)",
        "UNIQUE (tenant_id, tool_call_id)",
        "REFERENCES converact_tool_actions(tenant_id, tool_call_id) ON DELETE RESTRICT",
        "ENABLE ROW LEVEL SECURITY",
        "FORCE ROW LEVEL SECURITY",
        "GRANT SELECT, INSERT ON converact_agent_follow_up_tasks TO opc_runtime",
    ] {
        assert!(MIGRATION.contains(required), "missing invariant {required}");
    }
    assert!(DEVELOPMENT_SCHEMA.contains("converact_agent_follow_up_tasks"));
}

#[test]
fn follow_up_task_identity_is_stable_and_tenant_separated() {
    let call = ToolCallId::parse("tool-call-001").unwrap();
    let first = derive_agent_follow_up_task_id("tenant-a", &call).unwrap();
    let replay = derive_agent_follow_up_task_id("tenant-a", &call).unwrap();
    let other_tenant = derive_agent_follow_up_task_id("tenant-b", &call).unwrap();

    assert_eq!(first, replay);
    assert_ne!(first, other_tenant);
    assert!(first.as_str().starts_with("agent-follow-up-"));
}

#[test]
fn provider_uses_exact_tenant_queries_and_preserves_unknown_commit_outcomes() {
    for required in [
        "PostgresAgentToolProvider",
        "impl ToolActionPort for PostgresAgentToolProvider",
        "with_tenant_transaction",
        "converact_outbound_campaign_contacts",
        "contact.tenant_id = $1",
        "LIMIT 1",
        "INSERT INTO public.converact_agent_follow_up_tasks",
        "ON CONFLICT (tenant_id, tool_call_id) DO NOTHING",
        "TransactionError::CommitUnknown",
        "PostgresAgentFollowUpResult::OutcomeUnknown",
    ] {
        assert!(
            PROVIDER_SOURCE.contains(required),
            "missing Provider invariant {required}"
        );
    }
}
