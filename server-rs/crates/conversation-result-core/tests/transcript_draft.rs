use converact_conversation_result_core::{
    ResultError, TranscriptGenerationStatus, TranscriptSegmentDraft, TranscriptSegmentDraftInput,
    TranscriptSpeaker,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    EnvelopeContext, EnvelopeContextInput, EventId, ExecutionGeneration, InteractionId,
    TranscriptSegmentId, VOICE_AGENT_SCHEMA_VERSION,
};

#[test]
fn validated_draft_accepts_only_store_allocated_positive_sequence() {
    let draft = TranscriptSegmentDraft::try_new(draft_input("customer final transcript")).unwrap();

    assert_eq!(
        draft
            .generation_status(ExecutionGeneration::new(7).unwrap())
            .unwrap(),
        TranscriptGenerationStatus::Current
    );
    assert_eq!(
        draft
            .generation_status(ExecutionGeneration::new(8).unwrap())
            .unwrap(),
        TranscriptGenerationStatus::Historical
    );
    assert_eq!(
        draft.generation_status(ExecutionGeneration::new(6).unwrap()),
        Err(ResultError::FutureGeneration)
    );
    assert_eq!(
        draft.segment_with_sequence(0),
        Err(ResultError::InvalidTranscriptSegment)
    );

    let segment = draft.segment_with_sequence(3).unwrap();
    assert_eq!(segment.sequence(), 3);
    assert_eq!(segment.text(), "customer final transcript");
    assert_eq!(segment.source_event_id().as_str(), "active-call-final-001");
    assert!(!format!("{draft:?}").contains("customer final transcript"));
}

#[test]
fn draft_rejects_invalid_content_before_sequence_allocation() {
    let mut invalid = draft_input("customer final transcript");
    invalid.text = "customer\nsecret".to_owned();
    assert_eq!(
        TranscriptSegmentDraft::try_new(invalid),
        Err(ResultError::InvalidTranscriptSegment)
    );

    let mut invalid = draft_input("customer final transcript");
    invalid.start_offset_ms = 501;
    assert_eq!(
        TranscriptSegmentDraft::try_new(invalid),
        Err(ResultError::InvalidTranscriptSegment)
    );
}

fn draft_input(text: &str) -> TranscriptSegmentDraftInput {
    TranscriptSegmentDraftInput {
        id: TranscriptSegmentId::parse("segment-active-call-final-001").unwrap(),
        context: context(),
        source_event_id: EventId::parse("active-call-final-001").unwrap(),
        speaker: TranscriptSpeaker::Customer,
        language: "zh-CN".to_owned(),
        text: text.to_owned(),
        start_offset_ms: 100,
        end_offset_ms: 500,
        observed_at_ms: 1_000,
        retention_policy_ref: "retention:voice-default-v1".to_owned(),
    }
}

fn context() -> EnvelopeContext {
    EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version: VOICE_AGENT_SCHEMA_VERSION,
        tenant_id: "tenant-001".to_owned(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        campaign_id: CampaignId::parse("campaign-001").unwrap(),
        campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
        call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        call_id: Some(CallId::parse("call-001").unwrap()),
        agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
        channel_agent_session_id: Some(ChannelAgentSessionId::parse("agent-session-001").unwrap()),
        trace_id: "trace-001".to_owned(),
        execution_generation: ExecutionGeneration::new(7).unwrap(),
    })
    .unwrap()
}
