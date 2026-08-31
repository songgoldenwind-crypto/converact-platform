use converact_contracts::canonical_sha256_with_max_bytes;
use converact_tool_broker_core::{ToolProposal, ToolProposalInput};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId, EnvelopeContext,
    EnvelopeContextInput, ExecutionGeneration, InteractionId, ToolCallId, ToolRevisionId,
    VOICE_AGENT_SCHEMA_VERSION,
};
use serde_json::json;

pub const NOW_MS: u64 = 2_000;

pub fn proposal() -> ToolProposal {
    let arguments = json!({"customer_id": "customer-001"});
    ToolProposal::try_new(ToolProposalInput {
        context: EnvelopeContext::try_new(EnvelopeContextInput {
            schema_version: VOICE_AGENT_SCHEMA_VERSION,
            tenant_id: "tenant-a".to_owned(),
            interaction_id: InteractionId::parse("interaction-001").unwrap(),
            campaign_id: CampaignId::parse("campaign-001").unwrap(),
            campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
            call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
            call_id: None,
            agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
            channel_agent_session_id: None,
            execution_generation: ExecutionGeneration::new(3).unwrap(),
            trace_id: "trace-001".to_owned(),
        })
        .unwrap(),
        tool_revision_id: ToolRevisionId::parse("crm.update-r1").unwrap(),
        tool_call_id: ToolCallId::parse("tool-call-001").unwrap(),
        tool_schema_hash: "a".repeat(64),
        arguments_hash: canonical_sha256_with_max_bytes(&arguments, 65_536).unwrap(),
        arguments,
        requested_at_ms: 1_000,
        deadline_ms: 10_000,
    })
    .unwrap()
}
