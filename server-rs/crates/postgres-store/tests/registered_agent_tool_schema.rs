use converact_contracts::canonical_sha256_with_max_bytes;
use converact_postgres_store::PostgresAgentToolSchema;
use converact_tool_broker_core::{
    ToolDefinition, ToolEffectClass, ToolProposal, ToolProposalInput, ToolRisk, ToolSchemaPort,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId, EnvelopeContext,
    EnvelopeContextInput, ExecutionGeneration, InteractionId, ToolCallId, ToolRevisionId,
    VOICE_AGENT_SCHEMA_VERSION,
};
use serde_json::{Value, json};

#[tokio::test]
async fn registered_postgres_tools_accept_only_their_exact_schema_and_arguments() {
    let schemas = PostgresAgentToolSchema::new();
    for (capability, effect, arguments) in [
        (
            "customer.lookup",
            ToolEffectClass::Query,
            json!({"customer_id": "customer-001"}),
        ),
        (
            "task.create_follow_up",
            ToolEffectClass::Mutation,
            json!({
                "customer_id": "customer-001",
                "reason": "Send requested proposal",
                "due_at_ms": 10_000,
            }),
        ),
    ] {
        let hash = schemas.schema_hash(capability).unwrap();
        schemas
            .validate(
                &definition(capability, effect, &hash),
                &proposal(capability, &hash, arguments),
            )
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn schema_drift_unknown_fields_and_past_due_follow_up_fail_closed() {
    let schemas = PostgresAgentToolSchema::new();
    let hash = schemas.schema_hash("task.create_follow_up").unwrap();
    let tool_definition = definition("task.create_follow_up", ToolEffectClass::Mutation, &hash);
    for arguments in [
        json!({
            "customer_id": "customer-001",
            "reason": "Send proposal",
            "due_at_ms": 999,
        }),
        json!({
            "customer_id": "customer-001",
            "reason": "Send proposal",
            "due_at_ms": 10_000,
            "unexpected": true,
        }),
    ] {
        assert_eq!(
            schemas
                .validate(
                    &tool_definition,
                    &proposal("task.create_follow_up", &hash, arguments),
                )
                .await
                .unwrap_err()
                .code(),
            "agent_tool_schema_rejected"
        );
    }
    let drift = definition(
        "task.create_follow_up",
        ToolEffectClass::Mutation,
        &"a".repeat(64),
    );
    assert!(
        schemas
            .validate(
                &drift,
                &proposal(
                    "task.create_follow_up",
                    &hash,
                    json!({
                        "customer_id": "customer-001",
                        "reason": "Send proposal",
                        "due_at_ms": 10_000,
                    }),
                ),
            )
            .await
            .is_err()
    );
}

fn definition(capability: &str, effect: ToolEffectClass, schema_hash: &str) -> ToolDefinition {
    ToolDefinition::try_new(
        ToolRevisionId::parse(format!("{capability}-r1")).unwrap(),
        AgentReleaseId::parse("release-001").unwrap(),
        schema_hash,
        effect,
        ToolRisk::Low,
        capability,
    )
    .unwrap()
}

fn proposal(capability: &str, schema_hash: &str, arguments: Value) -> ToolProposal {
    ToolProposal::try_new(ToolProposalInput {
        context: EnvelopeContext::try_new(EnvelopeContextInput {
            schema_version: VOICE_AGENT_SCHEMA_VERSION,
            tenant_id: "tenant-a".to_owned(),
            interaction_id: InteractionId::parse("interaction-001").unwrap(),
            campaign_id: CampaignId::parse("campaign-001").unwrap(),
            campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
            call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
            call_id: None,
            agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
            channel_agent_session_id: None,
            execution_generation: ExecutionGeneration::new(1).unwrap(),
            trace_id: "trace-001".to_owned(),
        })
        .unwrap(),
        tool_revision_id: ToolRevisionId::parse(format!("{capability}-r1")).unwrap(),
        tool_call_id: ToolCallId::parse("tool-call-001").unwrap(),
        tool_schema_hash: schema_hash.to_owned(),
        arguments_hash: canonical_sha256_with_max_bytes(&arguments, 65_536).unwrap(),
        arguments,
        requested_at_ms: 1_000,
        deadline_ms: 5_000,
    })
    .unwrap()
}
