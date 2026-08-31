use converact_contracts::canonical_sha256_with_max_bytes;
use converact_tool_broker_core::{ProposalError, ToolProposal, ToolProposalInput};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId, EnvelopeContext,
    EnvelopeContextInput, ExecutionGeneration, InteractionId, ToolCallId, ToolRevisionId,
    VOICE_AGENT_SCHEMA_VERSION,
};
use serde_json::{Value, json};

const MAX_ARGUMENT_BYTES: usize = 65_536;

#[test]
fn proposal_rejects_digest_deadline_and_argument_bound_violations() {
    let arguments = json!({"customer_id": "customer-001"});
    let proposal = ToolProposal::try_new(input(
        arguments.clone(),
        canonical_sha256_with_max_bytes(&arguments, MAX_ARGUMENT_BYTES).unwrap(),
        1_000,
        2_000,
    ))
    .unwrap();
    assert_eq!(proposal.tool_revision_id().as_str(), "crm.lookup-r1");
    assert_eq!(proposal.arguments(), &arguments);

    assert_eq!(
        ToolProposal::try_new(input(arguments.clone(), "0".repeat(64), 1_000, 2_000)),
        Err(ProposalError::ArgumentsDigestMismatch),
    );
    assert_eq!(
        ToolProposal::try_new(input(
            arguments,
            canonical_sha256_with_max_bytes(
                &json!({"customer_id": "customer-001"}),
                MAX_ARGUMENT_BYTES,
            )
            .unwrap(),
            2_000,
            2_000,
        )),
        Err(ProposalError::InvalidDeadline),
    );

    let oversized = Value::String("x".repeat(MAX_ARGUMENT_BYTES + 1));
    assert_eq!(
        ToolProposal::try_new(input(oversized, "0".repeat(64), 1_000, 2_000)),
        Err(ProposalError::InvalidArguments),
    );
}

fn input(
    arguments: Value,
    arguments_hash: String,
    requested_at_ms: u64,
    deadline_ms: u64,
) -> ToolProposalInput {
    ToolProposalInput {
        context: context(),
        tool_revision_id: ToolRevisionId::parse("crm.lookup-r1").unwrap(),
        tool_call_id: ToolCallId::parse("tool-call-001").unwrap(),
        tool_schema_hash: "a".repeat(64),
        arguments_hash,
        arguments,
        requested_at_ms,
        deadline_ms,
    }
}

fn context() -> EnvelopeContext {
    EnvelopeContext::try_new(EnvelopeContextInput {
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
    .unwrap()
}
