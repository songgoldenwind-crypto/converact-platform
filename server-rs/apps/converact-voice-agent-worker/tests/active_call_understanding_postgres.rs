use converact_conversation_result_core::{
    TranscriptGenerationStatus, TranscriptSegment, TranscriptSegmentInput, TranscriptSpeaker,
};
use converact_conversation_result_store::{TranscriptHistoryLimit, TranscriptHistoryWindow};
use converact_postgres_store::PostgresTranscriptAppendDecision;
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId, EnvelopeContext,
    EnvelopeContextInput, EventId, ExecutionGeneration, InteractionId, TranscriptSegmentId,
    VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    TranscriptUnderstandingDisposition, TranscriptUnderstandingHistoryPort,
    TranscriptUnderstandingSourceError, map_postgres_transcript_understanding_disposition,
    prepare_postgres_transcript_understanding_source,
};

#[test]
fn postgres_append_receipt_maps_to_one_closed_understanding_disposition() {
    assert_eq!(
        map_postgres_transcript_understanding_disposition(
            PostgresTranscriptAppendDecision::Appended(TranscriptGenerationStatus::Current)
        ),
        TranscriptUnderstandingDisposition::AppendedCurrent
    );
    assert_eq!(
        map_postgres_transcript_understanding_disposition(
            PostgresTranscriptAppendDecision::Replayed(TranscriptGenerationStatus::Current)
        ),
        TranscriptUnderstandingDisposition::ReplayedCurrent
    );
    for decision in [
        PostgresTranscriptAppendDecision::Appended(TranscriptGenerationStatus::Historical),
        PostgresTranscriptAppendDecision::Replayed(TranscriptGenerationStatus::Historical),
    ] {
        assert_eq!(
            map_postgres_transcript_understanding_disposition(decision),
            TranscriptUnderstandingDisposition::Historical
        );
    }
}

#[test]
fn typed_history_contract_remains_bounded_and_ends_at_the_append_receipt_segment() {
    let current = segment();
    let window = TranscriptHistoryWindow::try_new(
        &current,
        vec![current.clone()],
        TranscriptHistoryLimit::new(16).unwrap(),
    )
    .unwrap();

    assert_eq!(window.segments(), &[current]);
}

#[tokio::test]
async fn only_a_new_current_append_loads_the_bounded_history_window() {
    let current = segment();
    let history = History {
        calls: AtomicUsize::new(0),
        window: TranscriptHistoryWindow::try_new(
            &current,
            vec![current.clone()],
            TranscriptHistoryLimit::new(16).unwrap(),
        )
        .unwrap(),
    };
    let limit = TranscriptHistoryLimit::new(16).unwrap();

    let source = prepare_postgres_transcript_understanding_source(
        &history,
        &current,
        PostgresTranscriptAppendDecision::Appended(TranscriptGenerationStatus::Current),
        limit,
    )
    .await
    .unwrap();
    assert_eq!(
        source.disposition(),
        TranscriptUnderstandingDisposition::AppendedCurrent
    );
    assert_eq!(source.history(), std::slice::from_ref(&current));
    assert_eq!(history.calls.load(Ordering::Relaxed), 1);

    for decision in [
        PostgresTranscriptAppendDecision::Replayed(TranscriptGenerationStatus::Current),
        PostgresTranscriptAppendDecision::Appended(TranscriptGenerationStatus::Historical),
        PostgresTranscriptAppendDecision::Replayed(TranscriptGenerationStatus::Historical),
    ] {
        let source =
            prepare_postgres_transcript_understanding_source(&history, &current, decision, limit)
                .await
                .unwrap();
        assert!(source.history().is_empty());
    }
    assert_eq!(history.calls.load(Ordering::Relaxed), 1);
}

struct History {
    calls: AtomicUsize,
    window: TranscriptHistoryWindow,
}

impl TranscriptUnderstandingHistoryPort for History {
    async fn load_recent_transcript_window(
        &self,
        current: &TranscriptSegment,
        limit: TranscriptHistoryLimit,
    ) -> Result<TranscriptHistoryWindow, TranscriptUnderstandingSourceError> {
        assert_eq!(current, self.window.segments().last().unwrap());
        assert_eq!(limit.get(), 16);
        self.calls.fetch_add(1, Ordering::Relaxed);
        Ok(self.window.clone())
    }
}

fn segment() -> TranscriptSegment {
    TranscriptSegment::try_new(TranscriptSegmentInput {
        id: TranscriptSegmentId::parse("segment-current").unwrap(),
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
        source_event_id: EventId::parse("event-current").unwrap(),
        sequence: 1,
        speaker: TranscriptSpeaker::Customer,
        language: "zh-CN".to_owned(),
        text: "客户最终转写".to_owned(),
        start_offset_ms: 100,
        end_offset_ms: 500,
        observed_at_ms: 1_500,
        retention_policy_ref: "retention:voice-default-v1".to_owned(),
    })
    .unwrap()
}
use std::sync::atomic::{AtomicUsize, Ordering};
