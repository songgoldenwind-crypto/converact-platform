use converact_active_call_adapter::AdapterContext;
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    EnvelopeContext, EnvelopeContextInput, ExecutionGeneration, InteractionId,
};

pub fn adapter_context(generation: u64) -> AdapterContext {
    AdapterContext::new(
        EnvelopeContext::try_new(EnvelopeContextInput {
            schema_version: 1,
            tenant_id: "tenant-001".to_owned(),
            interaction_id: InteractionId::parse("interaction-001").unwrap(),
            campaign_id: CampaignId::parse("campaign-001").unwrap(),
            campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
            call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
            call_id: None,
            agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
            channel_agent_session_id: Some(
                ChannelAgentSessionId::parse("agent-session-001").unwrap(),
            ),
            execution_generation: ExecutionGeneration::new(generation).unwrap(),
            trace_id: "trace-001".to_owned(),
        })
        .unwrap(),
    )
}
