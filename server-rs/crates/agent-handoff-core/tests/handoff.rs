use converact_agent_handoff_core::{
    ContextPacket, ContextPacketInput, ContextRevision, ControlOwner, HandoffError, HandoffSession,
    HandoffState, HandoffTarget,
};
use converact_voice_agent_contracts::{
    ActionReceiptId, AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId,
    ChannelAgentSessionId, ContextPacketId, EnvelopeContext, EnvelopeContextInput,
    ExecutionGeneration, HandoffId, HumanLegId, InteractionId, VOICE_AGENT_SCHEMA_VERSION,
};

#[test]
fn answered_human_commit_and_ai_resume_rotate_single_owner_generation() {
    let requested = HandoffSession::request(
        HandoffId::parse("handoff-001").unwrap(),
        context(1, Some("call-001"), Some("agent-session-001")),
        packet(),
        HandoffTarget::try_new("support", ["billing"], None::<&str>).unwrap(),
    )
    .unwrap();
    assert_snapshot(&requested, HandoffState::Requested, ControlOwner::Ai, 1, 1);

    let prepared = requested.prepare(1, generation(1)).unwrap();
    let dialing = prepared
        .observe_human_leg_dialing(
            2,
            generation(1),
            HumanLegId::parse("human-leg-001").unwrap(),
        )
        .unwrap();
    let answered = dialing
        .observe_human_leg_answered(3, generation(1))
        .unwrap();
    let committed = answered.commit_human(4, generation(1)).unwrap();
    assert_snapshot(
        &committed,
        HandoffState::Committed,
        ControlOwner::Human,
        2,
        5,
    );

    let active = committed.mark_human_active(5, generation(2)).unwrap();
    let preparing = active
        .prepare_ai_resume(
            6,
            generation(2),
            ChannelAgentSessionId::parse("agent-session-002").unwrap(),
        )
        .unwrap();
    let resumed = preparing.commit_ai_resume(7, generation(2)).unwrap();
    assert_snapshot(&resumed, HandoffState::AiResumed, ControlOwner::Ai, 3, 8);
    assert_eq!(resumed.ai_session_id().as_str(), "agent-session-002");
}

#[test]
fn unobserved_stale_and_unresolved_transitions_fail_closed() {
    let requested = HandoffSession::request(
        HandoffId::parse("handoff-002").unwrap(),
        context(1, Some("call-002"), Some("agent-session-001")),
        packet(),
        HandoffTarget::try_new("support", ["billing"], None::<&str>).unwrap(),
    )
    .unwrap();
    assert_eq!(
        requested.commit_human(1, generation(1)).unwrap_err(),
        HandoffError::InvalidTransition
    );

    let prepared = requested.prepare(1, generation(1)).unwrap();
    assert_eq!(
        prepared
            .observe_human_leg_dialing(
                1,
                generation(1),
                HumanLegId::parse("human-leg-stale").unwrap(),
            )
            .unwrap_err(),
        HandoffError::StaleRevision
    );
    assert_eq!(
        prepared.abort(2, generation(2)).unwrap_err(),
        HandoffError::StaleGeneration
    );

    let unresolved = prepared.require_reconcile(2, generation(1)).unwrap();
    assert_eq!(
        unresolved.abort(3, generation(1)).unwrap_err(),
        HandoffError::ReconcileRequired
    );
}

#[test]
fn request_requires_call_and_ai_session_and_generation_never_wraps() {
    let target = HandoffTarget::try_new("support", ["billing"], None::<&str>).unwrap();
    assert_eq!(
        HandoffSession::request(
            HandoffId::parse("handoff-no-call").unwrap(),
            context(1, None, Some("agent-session-001")),
            packet(),
            target.clone(),
        )
        .unwrap_err(),
        HandoffError::CallRequired
    );
    assert_eq!(
        HandoffSession::request(
            HandoffId::parse("handoff-no-agent").unwrap(),
            context(1, Some("call-003"), None),
            packet(),
            target,
        )
        .unwrap_err(),
        HandoffError::AiSessionRequired
    );

    let requested = HandoffSession::request(
        HandoffId::parse("handoff-overflow").unwrap(),
        context(u64::MAX, Some("call-overflow"), Some("agent-session-max")),
        packet(),
        HandoffTarget::try_new("support", ["billing"], None::<&str>).unwrap(),
    )
    .unwrap();
    let prepared = requested.prepare(1, generation(u64::MAX)).unwrap();
    let dialing = prepared
        .observe_human_leg_dialing(
            2,
            generation(u64::MAX),
            HumanLegId::parse("human-leg-max").unwrap(),
        )
        .unwrap();
    let answered = dialing
        .observe_human_leg_answered(3, generation(u64::MAX))
        .unwrap();
    assert_eq!(
        answered.commit_human(4, generation(u64::MAX)).unwrap_err(),
        HandoffError::GenerationExhausted
    );
}

fn assert_snapshot(
    handoff: &HandoffSession,
    state: HandoffState,
    owner: ControlOwner,
    generation_value: u64,
    revision: u64,
) {
    assert_eq!(handoff.state(), state);
    assert_eq!(handoff.owner(), owner);
    assert_eq!(handoff.execution_generation().get(), generation_value);
    assert_eq!(handoff.revision(), revision);
}

fn packet() -> ContextPacket {
    ContextPacket::try_new(ContextPacketInput {
        id: ContextPacketId::parse("context-packet-001").unwrap(),
        revision: ContextRevision::new(7).unwrap(),
        digest: "a".repeat(64),
        summary_artifact_ref: "summary:interaction-001:v7".to_owned(),
        transcript_artifact_ref: Some("transcript:interaction-001:v7".to_owned()),
        unresolved_item_refs: vec!["issue:payment-001".to_owned()],
        action_receipt_refs: vec![ActionReceiptId::parse("receipt:tool-001").unwrap()],
        disclosure_completed: true,
        recording_active: true,
        data_region_policy_ref: "region:cn-mainland".to_owned(),
        created_at_ms: 1_000,
    })
    .unwrap()
}

fn context(
    generation_value: u64,
    call_id: Option<&str>,
    ai_session_id: Option<&str>,
) -> EnvelopeContext {
    EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version: VOICE_AGENT_SCHEMA_VERSION,
        tenant_id: "tenant-a".to_owned(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        campaign_id: CampaignId::parse("campaign-001").unwrap(),
        campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
        call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        call_id: call_id.map(|value| CallId::parse(value).unwrap()),
        agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
        channel_agent_session_id: ai_session_id
            .map(|value| ChannelAgentSessionId::parse(value).unwrap()),
        execution_generation: generation(generation_value),
        trace_id: "trace-001".to_owned(),
    })
    .unwrap()
}

fn generation(value: u64) -> ExecutionGeneration {
    ExecutionGeneration::new(value).unwrap()
}
