use converact_active_call_adapter::{AdapterContext, normalize_event};
use converact_conversation_result_core::{OutcomeSchema, OutcomeSchemaInput};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId, EnvelopeContext,
    EnvelopeContextInput, ExecutionGeneration, InteractionId, OutcomeSchemaRevisionId,
    VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::resolve_active_call_intent_evidence;

#[test]
fn terminal_active_call_intent_is_validated_by_the_exact_release_schema() {
    let event = normalize_event(
        &AdapterContext::new(context("release-001")),
        r#"{"event":"hangup","trackId":"track-001","timestamp":1300,"startTime":"2026-08-31T00:00:00Z","hangupTime":"2026-08-31T00:01:00Z","extra":{"intent":"support"}}"#,
    )
    .unwrap();

    let evidence = resolve_active_call_intent_evidence(&event, &schema("release-001"))
        .unwrap()
        .unwrap();

    assert_eq!(evidence.intent(), "support");
    assert!(!format!("{evidence:?}").contains("support"));
}

#[test]
fn absent_intent_stays_absent_and_unknown_or_cross_release_evidence_fails_closed() {
    let absent = normalize_event(
        &AdapterContext::new(context("release-001")),
        r#"{"event":"hangup","trackId":"track-001","timestamp":1300,"startTime":"2026-08-31T00:00:00Z","hangupTime":"2026-08-31T00:01:00Z"}"#,
    )
    .unwrap();
    assert!(
        resolve_active_call_intent_evidence(&absent, &schema("release-001"))
            .unwrap()
            .is_none()
    );

    let unknown = normalize_event(
        &AdapterContext::new(context("release-001")),
        r#"{"event":"hangup","trackId":"track-001","timestamp":1300,"startTime":"2026-08-31T00:00:00Z","hangupTime":"2026-08-31T00:01:00Z","extra":{"intent":"invented"}}"#,
    )
    .unwrap();
    assert_eq!(
        resolve_active_call_intent_evidence(&unknown, &schema("release-001"))
            .unwrap_err()
            .code(),
        "active_call_intent_outcome_schema_mismatch"
    );

    let cross_release = normalize_event(
        &AdapterContext::new(context("release-002")),
        r#"{"event":"hangup","trackId":"track-001","timestamp":1300,"startTime":"2026-08-31T00:00:00Z","hangupTime":"2026-08-31T00:01:00Z","extra":{"intent":"support"}}"#,
    )
    .unwrap();
    assert_eq!(
        resolve_active_call_intent_evidence(&cross_release, &schema("release-001"))
            .unwrap_err()
            .code(),
        "active_call_intent_release_mismatch"
    );
}

fn schema(release_id: &str) -> OutcomeSchema {
    OutcomeSchema::try_new(OutcomeSchemaInput {
        id: OutcomeSchemaRevisionId::parse("outcome-schema-001").unwrap(),
        agent_release_id: AgentReleaseId::parse(release_id).unwrap(),
        intents: vec!["support".to_owned()],
        dispositions: vec!["completed".to_owned()],
        outcome_codes: vec!["resolved".to_owned()],
        attribute_keys: Vec::new(),
    })
    .unwrap()
}

fn context(release_id: &str) -> EnvelopeContext {
    EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version: VOICE_AGENT_SCHEMA_VERSION,
        tenant_id: "tenant-a".to_owned(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        campaign_id: CampaignId::parse("campaign-001").unwrap(),
        campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
        call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        call_id: None,
        agent_release_id: AgentReleaseId::parse(release_id).unwrap(),
        channel_agent_session_id: None,
        execution_generation: ExecutionGeneration::new(1).unwrap(),
        trace_id: "trace-001".to_owned(),
    })
    .unwrap()
}
