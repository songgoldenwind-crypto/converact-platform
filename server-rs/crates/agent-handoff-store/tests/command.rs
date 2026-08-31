use converact_agent_handoff_core::{
    ContextPacket, ContextPacketInput, ContextRevision, HandoffSession, HandoffTarget,
};
use converact_agent_handoff_store::{
    HandoffStoreCommand, HandoffStoreCommandInput, HandoffStoreError, HandoffTransitionWrite,
    canonical_transition_payload_hash,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    ContextPacketId, EnvelopeContext, EnvelopeContextInput, ExecutionGeneration, HandoffCommandId,
    HandoffId, InteractionId, VOICE_AGENT_SCHEMA_VERSION,
};

#[test]
fn transition_write_requires_exact_command_fence_and_consecutive_snapshot() {
    let current = requested("handoff-001");
    let next = current.prepare(1, generation(1)).unwrap();
    let command = HandoffStoreCommand::try_new(HandoffStoreCommandInput {
        id: HandoffCommandId::parse("handoff-command-001").unwrap(),
        kind: "prepare".to_owned(),
        payload_hash: canonical_transition_payload_hash("prepare", &current, &next).unwrap(),
        expected_revision: 1,
        expected_generation: generation(1),
    })
    .unwrap();

    let write = HandoffTransitionWrite::try_new(command, &current, &next).unwrap();

    assert_eq!(write.handoff_id().as_str(), "handoff-001");
    assert_eq!(write.command().kind(), "prepare");
    assert_eq!(write.next().revision(), 2);
}

#[test]
fn malformed_command_and_cross_handoff_transition_fail_closed() {
    let current = requested("handoff-001");
    let same_handoff_next = current.prepare(1, generation(1)).unwrap();
    let next = requested("handoff-002").prepare(1, generation(1)).unwrap();
    assert_eq!(
        HandoffStoreCommand::try_new(HandoffStoreCommandInput {
            id: HandoffCommandId::parse("handoff-command-invalid").unwrap(),
            kind: "prepare".to_owned(),
            payload_hash: "NOT-A-HASH".to_owned(),
            expected_revision: 1,
            expected_generation: generation(1),
        })
        .unwrap_err(),
        HandoffStoreError::InvalidInput
    );
    let wrong_payload = HandoffStoreCommand::try_new(HandoffStoreCommandInput {
        id: HandoffCommandId::parse("handoff-command-wrong-payload").unwrap(),
        kind: "prepare".to_owned(),
        payload_hash: "c".repeat(64),
        expected_revision: 1,
        expected_generation: generation(1),
    })
    .unwrap();
    assert_eq!(
        HandoffTransitionWrite::try_new(wrong_payload, &current, &same_handoff_next).unwrap_err(),
        HandoffStoreError::InvalidTransitionWrite
    );

    let command = HandoffStoreCommand::try_new(HandoffStoreCommandInput {
        id: HandoffCommandId::parse("handoff-command-cross").unwrap(),
        kind: "prepare".to_owned(),
        payload_hash: canonical_transition_payload_hash("prepare", &current, &next).unwrap(),
        expected_revision: 1,
        expected_generation: generation(1),
    })
    .unwrap();
    assert_eq!(
        HandoffTransitionWrite::try_new(command, &current, &next).unwrap_err(),
        HandoffStoreError::InvalidTransitionWrite
    );
}

fn requested(id: &str) -> HandoffSession {
    HandoffSession::request(
        HandoffId::parse(id).unwrap(),
        EnvelopeContext::try_new(EnvelopeContextInput {
            schema_version: VOICE_AGENT_SCHEMA_VERSION,
            tenant_id: "tenant-a".to_owned(),
            interaction_id: InteractionId::parse(format!("interaction-{id}")).unwrap(),
            campaign_id: CampaignId::parse("campaign-001").unwrap(),
            campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
            call_attempt_id: CallAttemptId::parse(format!("attempt-{id}")).unwrap(),
            call_id: Some(CallId::parse(format!("call-{id}")).unwrap()),
            agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
            channel_agent_session_id: Some(
                ChannelAgentSessionId::parse("agent-session-001").unwrap(),
            ),
            execution_generation: generation(1),
            trace_id: "trace-001".to_owned(),
        })
        .unwrap(),
        ContextPacket::try_new(ContextPacketInput {
            id: ContextPacketId::parse(format!("packet-{id}")).unwrap(),
            revision: ContextRevision::new(1).unwrap(),
            digest: "a".repeat(64),
            summary_artifact_ref: "summary:001".to_owned(),
            transcript_artifact_ref: None,
            unresolved_item_refs: Vec::new(),
            action_receipt_refs: Vec::new(),
            disclosure_completed: true,
            recording_active: true,
            data_region_policy_ref: "region:cn-mainland".to_owned(),
            created_at_ms: 1_000,
        })
        .unwrap(),
        HandoffTarget::try_new("support", ["billing"], None::<&str>).unwrap(),
    )
    .unwrap()
}

fn generation(value: u64) -> ExecutionGeneration {
    ExecutionGeneration::new(value).unwrap()
}
