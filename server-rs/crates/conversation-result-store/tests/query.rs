use converact_conversation_result_core::{
    TranscriptSegment, TranscriptSegmentInput, TranscriptSpeaker,
};
use converact_conversation_result_store::{
    EntityCursor, QueryLimit, QueryPage, TranscriptHistoryLimit, TranscriptHistoryWindow,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId, EnvelopeContext,
    EnvelopeContextInput, EventId, ExecutionGeneration, InteractionId, TranscriptSegmentId,
    VOICE_AGENT_SCHEMA_VERSION,
};

#[test]
fn query_limit_and_entity_cursor_are_bounded_before_sql() {
    assert_eq!(QueryLimit::new(1).unwrap().get(), 1);
    assert_eq!(QueryLimit::new(100).unwrap().get(), 100);
    assert!(QueryLimit::new(0).is_err());
    assert!(QueryLimit::new(101).is_err());

    assert_eq!(
        EntityCursor::parse("segment-001").unwrap().as_str(),
        "segment-001"
    );
    assert!(EntityCursor::parse("").is_err());
    assert!(EntityCursor::parse("segment/invalid").is_err());
}

#[test]
fn understanding_history_limit_and_exact_current_anchor_fail_closed() {
    assert_eq!(TranscriptHistoryLimit::new(1).unwrap().get(), 1);
    assert_eq!(TranscriptHistoryLimit::new(32).unwrap().get(), 32);
    assert!(TranscriptHistoryLimit::new(0).is_err());
    assert!(TranscriptHistoryLimit::new(33).is_err());

    let first = segment(1, "segment-001", "event-001");
    let current = segment(2, "segment-002", "event-002");
    let limit = TranscriptHistoryLimit::new(2).unwrap();
    let window =
        TranscriptHistoryWindow::try_new(&current, vec![first.clone(), current.clone()], limit)
            .unwrap();
    assert_eq!(window.segments(), &[first.clone(), current.clone()]);

    assert!(
        TranscriptHistoryWindow::try_new(&first, vec![first.clone(), current.clone()], limit)
            .is_err()
    );
    assert!(
        TranscriptHistoryWindow::try_new(&current, vec![current.clone(), first], limit).is_err()
    );
    assert!(
        TranscriptHistoryWindow::try_new(
            &current,
            vec![segment(1, "segment-001", "event-001"), current.clone(),],
            TranscriptHistoryLimit::new(1).unwrap(),
        )
        .is_err()
    );
}

#[test]
fn query_pages_reject_unbounded_adapter_results() {
    assert!(QueryPage::try_new(vec![1_u8; 100], Some("cursor-100".to_owned())).is_ok());
    assert!(QueryPage::try_new(vec![1_u8; 101], None).is_err());
    assert!(QueryPage::<u8>::try_new(Vec::new(), Some("bad/cursor".to_owned())).is_err());
}

#[test]
fn postgres_query_contract_is_tenant_bound_cursor_verified_and_never_unbounded() {
    let source = include_str!("../src/query.rs");

    for required in [
        "load_latest_result",
        "list_transcript",
        "list_evaluations",
        "list_bad_cases",
        "tenant_id = $1",
        "LIMIT $",
        "cursor",
        "transcript_text",
        "ORDER BY execution_generation, segment_sequence, segment_id",
        "load_recent_transcript_window",
        "call_attempt_id = $3",
        "agent_release_id = $4",
        "execution_generation = $5",
        "segment_sequence <= $6",
        "speaker <> 'system'",
        "ORDER BY segment_sequence DESC LIMIT $7",
        "TranscriptHistoryWindow::try_new",
        "ORDER BY created_at DESC, bad_case_id DESC",
    ] {
        assert!(
            source.contains(required),
            "missing query invariant {required}"
        );
    }
}

fn segment(sequence: u64, segment_id: &str, event_id: &str) -> TranscriptSegment {
    TranscriptSegment::try_new(TranscriptSegmentInput {
        id: TranscriptSegmentId::parse(segment_id).unwrap(),
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
            execution_generation: ExecutionGeneration::new(1).unwrap(),
            trace_id: "trace-001".to_owned(),
        })
        .unwrap(),
        source_event_id: EventId::parse(event_id).unwrap(),
        sequence,
        speaker: TranscriptSpeaker::Customer,
        language: "zh-CN".to_owned(),
        text: format!("turn-{sequence}"),
        start_offset_ms: sequence * 100,
        end_offset_ms: sequence * 100 + 50,
        observed_at_ms: 1_000 + sequence,
        retention_policy_ref: "retention:voice-default-v1".to_owned(),
    })
    .unwrap()
}
