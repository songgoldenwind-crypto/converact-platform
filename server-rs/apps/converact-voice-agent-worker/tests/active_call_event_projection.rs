use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use converact_active_call_adapter::{AdapterContext, NormalizedEvent, normalize_event};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    EnvelopeContext, EnvelopeContextInput, ExecutionGeneration, InteractionId,
    VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    ActiveCallEventProcessingError, ActiveCallEventProcessorPort, ActiveCallEventProjectionRouter,
    ActiveCallToolProjectionPort, ActiveCallTranscriptProjectionPort,
    RejectUnconfiguredActiveCallTools,
};

#[tokio::test]
async fn router_sends_each_effectful_event_to_exactly_one_required_projection() {
    let authority = context("attempt-001");
    let transcripts = Arc::new(TranscriptProjection::default());
    let tools = Arc::new(ToolProjection::default());
    let router = ActiveCallEventProjectionRouter::new(Arc::clone(&transcripts), Arc::clone(&tools));

    for wire in [
        r#"{"event":"mediaReady","trackId":"customer-track","timestamp":1000}"#,
        r#"{"event":"asrFinal","trackId":"customer-track","timestamp":1200,"index":0,"text":"需要回访"}"#,
    ] {
        let event = normalize_event(&AdapterContext::new(authority.clone()), wire).unwrap();
        router.process(&authority, &event).await.unwrap();
    }
    let tool = normalize_event(
        &AdapterContext::new(authority.clone()),
        r#"{"event":"functionCall","trackId":"customer-track","timestamp":1300,"callId":"tool-call-001","name":"customer.lookup","arguments":"{\"customer_id\":\"c-1\"}"}"#,
    )
    .unwrap();
    router.process(&authority, &tool).await.unwrap();
    let hold = normalize_event(
        &AdapterContext::new(authority.clone()),
        r#"{"event":"hold","trackId":"customer-track","timestamp":1400,"onHold":true}"#,
    )
    .unwrap();
    router.process(&authority, &hold).await.unwrap();

    assert_eq!(transcripts.calls.load(Ordering::Relaxed), 2);
    assert_eq!(tools.calls.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn unconfigured_tool_projection_fails_closed_instead_of_acknowledging_the_event() {
    let authority = context("attempt-001");
    let router = ActiveCallEventProjectionRouter::new(
        Arc::new(TranscriptProjection::default()),
        Arc::new(RejectUnconfiguredActiveCallTools),
    );
    let event = normalize_event(
        &AdapterContext::new(authority.clone()),
        r#"{"event":"functionCall","trackId":"customer-track","timestamp":1300,"callId":"tool-call-001","name":"customer.lookup","arguments":"{\"customer_id\":\"c-1\"}"}"#,
    )
    .unwrap();

    let error = router.process(&authority, &event).await.unwrap_err();

    assert_eq!(error.code(), "active_call_tool_projection_not_configured");
}

#[derive(Default)]
struct TranscriptProjection {
    calls: AtomicUsize,
}

impl ActiveCallTranscriptProjectionPort for TranscriptProjection {
    async fn project_transcript_event(
        &self,
        context: &EnvelopeContext,
        event: &NormalizedEvent,
    ) -> Result<(), ActiveCallEventProcessingError> {
        assert_eq!(context, event.authority());
        assert!(matches!(
            event,
            NormalizedEvent::MediaReady { .. } | NormalizedEvent::TranscriptFinal { .. }
        ));
        self.calls.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

#[derive(Default)]
struct ToolProjection {
    calls: AtomicUsize,
}

impl ActiveCallToolProjectionPort for ToolProjection {
    async fn project_tool_event(
        &self,
        context: &EnvelopeContext,
        event: &NormalizedEvent,
    ) -> Result<(), ActiveCallEventProcessingError> {
        assert_eq!(context, event.authority());
        assert!(matches!(event, NormalizedEvent::ToolProposed { .. }));
        self.calls.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

fn context(attempt_id: &str) -> EnvelopeContext {
    EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version: VOICE_AGENT_SCHEMA_VERSION,
        tenant_id: "tenant-001".to_owned(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        campaign_id: CampaignId::parse("campaign-001").unwrap(),
        campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
        call_attempt_id: CallAttemptId::parse(attempt_id).unwrap(),
        call_id: Some(CallId::parse("call-001").unwrap()),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        channel_agent_session_id: Some(ChannelAgentSessionId::parse("session-001").unwrap()),
        execution_generation: ExecutionGeneration::new(7).unwrap(),
        trace_id: "trace-001".to_owned(),
    })
    .unwrap()
}
