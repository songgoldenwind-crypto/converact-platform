use converact_voice_agent_contracts::{
    AgentReleaseId, AgentReleaseState, AttemptCommand, CallAttemptId, CallAttemptState, CampaignId,
    CampaignState, CommandEnvelope, EnvelopeContext, EnvelopeContextInput, EnvelopeError,
    EventEnvelope, EventId, ExecutionGeneration, IdempotencyKey, InteractionId,
};

#[test]
fn states_use_closed_lower_snake_case_values() {
    assert_eq!(
        serde_json::to_string(&AgentReleaseState::Published).unwrap(),
        "\"published\"",
    );
    assert_eq!(
        serde_json::to_string(&CampaignState::Running).unwrap(),
        "\"running\"",
    );
    assert_eq!(
        serde_json::to_string(&CallAttemptState::DisclosurePending).unwrap(),
        "\"disclosure_pending\"",
    );
    assert!(serde_json::from_str::<CallAttemptState>("\"future_state\"").is_err());
}

fn context(schema_version: u16, tenant_id: &str, trace_id: &str) -> EnvelopeContext {
    EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version,
        tenant_id: tenant_id.to_owned(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        campaign_id: CampaignId::parse("campaign-001").unwrap(),
        campaign_contact_id: converact_voice_agent_contracts::CampaignContactId::parse(
            "contact-001",
        )
        .unwrap(),
        call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        call_id: None,
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        channel_agent_session_id: None,
        execution_generation: ExecutionGeneration::new(1).unwrap(),
        trace_id: trace_id.to_owned(),
    })
    .unwrap()
}

#[test]
fn command_envelope_is_versioned_and_serializes_closed_commands() {
    let envelope = CommandEnvelope::new(
        context(1, "tenant-001", "trace-001"),
        IdempotencyKey::parse("dial:attempt-001").unwrap(),
        AttemptCommand::Dial,
    );
    let value = serde_json::to_value(&envelope).unwrap();
    assert_eq!(value["schema_version"], 1);
    assert_eq!(value["campaign_id"], "campaign-001");
    assert_eq!(value["command"], "dial");
    assert_eq!(
        serde_json::from_value::<CommandEnvelope<AttemptCommand>>(value).unwrap(),
        envelope,
    );
    assert!(
        serde_json::from_str::<CommandEnvelope<AttemptCommand>>(
            &serde_json::to_string(&envelope)
                .unwrap()
                .replace("\"dial\"", "\"future_command\""),
        )
        .is_err()
    );
}

#[test]
fn envelope_context_rejects_unknown_versions_and_unbounded_authority_text() {
    assert_eq!(
        EnvelopeContext::try_new(EnvelopeContextInput {
            schema_version: 2,
            tenant_id: "tenant-001".to_owned(),
            interaction_id: InteractionId::parse("interaction-001").unwrap(),
            campaign_id: CampaignId::parse("campaign-001").unwrap(),
            campaign_contact_id: converact_voice_agent_contracts::CampaignContactId::parse(
                "contact-001",
            )
            .unwrap(),
            call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
            call_id: None,
            agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
            channel_agent_session_id: None,
            execution_generation: ExecutionGeneration::new(1).unwrap(),
            trace_id: "trace-001".to_owned(),
        }),
        Err(EnvelopeError::UnsupportedSchemaVersion),
    );
    assert_eq!(
        EnvelopeContext::try_new(EnvelopeContextInput {
            schema_version: 1,
            tenant_id: "tenant 001".to_owned(),
            interaction_id: InteractionId::parse("interaction-001").unwrap(),
            campaign_id: CampaignId::parse("campaign-001").unwrap(),
            campaign_contact_id: converact_voice_agent_contracts::CampaignContactId::parse(
                "contact-001",
            )
            .unwrap(),
            call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
            call_id: None,
            agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
            channel_agent_session_id: None,
            execution_generation: ExecutionGeneration::new(1).unwrap(),
            trace_id: "trace-001".to_owned(),
        }),
        Err(EnvelopeError::InvalidTenantId),
    );
}

#[test]
fn event_envelope_rejects_inverted_clock_evidence() {
    assert_eq!(
        EventEnvelope::try_new(
            context(1, "tenant-001", "trace-001"),
            EventId::parse("event-001").unwrap(),
            101,
            100,
            CallAttemptState::Answered,
        ),
        Err(EnvelopeError::InvalidTimestampOrder),
    );

    let serialized = serde_json::json!({
        "schema_version": 1,
        "tenant_id": "tenant-001",
        "interaction_id": "interaction-001",
        "campaign_id": "campaign-001",
        "campaign_contact_id": "contact-001",
        "call_attempt_id": "attempt-001",
        "agent_release_id": "release-001",
        "execution_generation": 1,
        "trace_id": "trace-001",
        "event_id": "event-001",
        "occurred_at_ms": 101,
        "received_at_ms": 100,
        "event": "answered"
    });
    assert!(
        serde_json::from_value::<EventEnvelope<CallAttemptState>>(serialized).is_err(),
        "deserialization must not bypass timestamp validation",
    );
}
