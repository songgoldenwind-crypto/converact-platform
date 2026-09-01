use converact_agent_tool_adapters::AgentToolSchema;
use converact_contracts::canonical_sha256_with_max_bytes;
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
async fn exact_registered_schemas_accept_valid_arguments() {
    let schemas = AgentToolSchema::new();
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
        let schema_hash = schemas.schema_hash(capability).unwrap();
        let definition = definition(capability, effect, &schema_hash);
        let proposal = proposal(capability, &schema_hash, arguments);

        schemas.validate(&definition, &proposal).await.unwrap();
    }
}

#[tokio::test]
async fn unknown_fields_and_invalid_bounded_values_fail_before_execution() {
    let schemas = AgentToolSchema::new();
    let lookup_hash = schemas.schema_hash("customer.lookup").unwrap();
    let lookup = definition("customer.lookup", ToolEffectClass::Query, &lookup_hash);
    let follow_up_hash = schemas.schema_hash("task.create_follow_up").unwrap();
    let follow_up = definition(
        "task.create_follow_up",
        ToolEffectClass::Mutation,
        &follow_up_hash,
    );

    for proposal in [
        proposal(
            "customer.lookup",
            &lookup_hash,
            json!({"customer_id": "customer-001", "secret": "exfiltrate"}),
        ),
        proposal("customer.lookup", &lookup_hash, json!({"customer_id": " "})),
    ] {
        assert_eq!(
            schemas
                .validate(&lookup, &proposal)
                .await
                .unwrap_err()
                .code(),
            "agent_tool_schema_rejected"
        );
    }
    for arguments in [
        json!({"customer_id": "customer-001", "reason": "", "due_at_ms": 10_000}),
        json!({"customer_id": "customer-001", "reason": "Later", "due_at_ms": 0}),
    ] {
        let proposal = proposal("task.create_follow_up", &follow_up_hash, arguments);
        assert_eq!(
            schemas
                .validate(&follow_up, &proposal)
                .await
                .unwrap_err()
                .code(),
            "agent_tool_schema_rejected"
        );
    }
}

#[tokio::test]
async fn schema_hash_effect_or_capability_drift_fails_closed() {
    let schemas = AgentToolSchema::new();
    let hash = schemas.schema_hash("customer.lookup").unwrap();
    let valid = proposal(
        "customer.lookup",
        &hash,
        json!({"customer_id": "customer-001"}),
    );
    let wrong_hash = definition("customer.lookup", ToolEffectClass::Query, &"a".repeat(64));
    let wrong_effect = definition("customer.lookup", ToolEffectClass::Mutation, &hash);
    let unknown = definition("customer.export", ToolEffectClass::Query, &hash);

    for definition in [wrong_hash, wrong_effect, unknown] {
        assert_eq!(
            schemas
                .validate(&definition, &valid)
                .await
                .unwrap_err()
                .code(),
            "agent_tool_schema_rejected"
        );
    }
    assert!(schemas.schema_hash("customer.export").is_none());
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
