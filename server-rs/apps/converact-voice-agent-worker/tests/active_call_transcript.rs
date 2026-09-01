use std::sync::atomic::{AtomicUsize, Ordering};

use converact_active_call_adapter::{AdapterContext, NormalizedEvent, normalize_event};
use converact_conversation_result_core::{TranscriptSegment, TranscriptSegmentDraft};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    EnvelopeContext, EnvelopeContextInput, ExecutionGeneration, InteractionId,
    VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    ActiveCallTranscriptBinding, ActiveCallTranscriptBindingInput,
    ActiveCallTranscriptDurabilityPort, ActiveCallTranscriptIngestError,
    append_active_call_final_transcript,
};

#[test]
fn final_customer_transcript_has_stable_source_identity_and_absolute_offsets() {
    let binding = binding("customer-track", 1_000);
    let first = final_event(
        &context("session-001"),
        "customer-track",
        1_500,
        Some((1_100, 1_450)),
        0,
        "客户需要办理续费",
        false,
        Some(false),
    );
    let changed_payload = final_event(
        &context_with_trace("session-001", "trace-reconnected"),
        "customer-track",
        1_500,
        Some((1_100, 1_450)),
        0,
        "同一来源却被改写",
        false,
        Some(false),
    );

    let first_draft = binding.draft_for_event(&first).unwrap().unwrap();
    let changed_draft = binding.draft_for_event(&changed_payload).unwrap().unwrap();
    assert_eq!(first_draft.id(), changed_draft.id());
    assert_eq!(
        first_draft.source_event_id(),
        changed_draft.source_event_id()
    );

    let first_segment = first_draft.segment_with_sequence(1).unwrap();
    let changed_segment = changed_draft.segment_with_sequence(1).unwrap();
    assert_eq!(first_segment.start_offset_ms(), 100);
    assert_eq!(first_segment.end_offset_ms(), 450);
    assert_eq!(first_segment.observed_at_ms(), 1_500);
    assert_eq!(first_segment.text(), "客户需要办理续费");
    assert_ne!(first_segment.payload_hash(), changed_segment.payload_hash());
    assert!(!format!("{first_draft:?}").contains("客户需要办理续费"));
}

#[test]
fn sensvoice_index_zero_does_not_become_the_durable_sequence() {
    let binding = binding("customer-track", 1_000);
    let first = final_event(
        &context("session-001"),
        "customer-track",
        1_200,
        None,
        0,
        "第一轮",
        false,
        None,
    );
    let second = final_event(
        &context("session-001"),
        "customer-track",
        1_800,
        None,
        0,
        "第二轮",
        false,
        None,
    );

    let first = binding.draft_for_event(&first).unwrap().unwrap();
    let second = binding.draft_for_event(&second).unwrap().unwrap();
    assert_ne!(first.id(), second.id());
    assert_ne!(first.source_event_id(), second.source_event_id());

    let first = first.segment_with_sequence(41).unwrap();
    let second = second.segment_with_sequence(42).unwrap();
    assert_eq!(first.sequence(), 41);
    assert_eq!(second.sequence(), 42);
    assert_eq!(first.start_offset_ms(), 200);
    assert_eq!(first.end_offset_ms(), 200);
}

#[test]
fn non_customer_or_non_dialogue_finals_are_ignored() {
    let binding = binding("customer-track", 1_000);
    for event in [
        final_event(
            &context("session-001"),
            "agent-track",
            1_200,
            None,
            1,
            "AI output",
            false,
            None,
        ),
        final_event(
            &context("session-001"),
            "customer-track",
            1_300,
            None,
            2,
            "嗯",
            true,
            None,
        ),
        final_event(
            &context("session-001"),
            "customer-track",
            1_400,
            None,
            3,
            "referred-leg speech",
            false,
            Some(true),
        ),
    ] {
        assert!(binding.draft_for_event(&event).unwrap().is_none());
    }

    let media_ready = normalize_event(
        &AdapterContext::new(context("session-001")),
        r#"{"event":"mediaReady","trackId":"customer-track","timestamp":1200}"#,
    )
    .unwrap();
    assert!(binding.draft_for_event(&media_ready).unwrap().is_none());
}

#[test]
fn session_and_call_clock_mismatches_fail_closed() {
    let binding = binding("customer-track", 1_000);
    let wrong_session = final_event(
        &context("session-other"),
        "customer-track",
        1_200,
        None,
        1,
        "private transcript",
        false,
        None,
    );
    assert_eq!(
        binding.draft_for_event(&wrong_session).unwrap_err(),
        ActiveCallTranscriptIngestError::AuthorityMismatch
    );

    let before_call = final_event(
        &context("session-001"),
        "customer-track",
        900,
        None,
        1,
        "private transcript",
        false,
        None,
    );
    let error = binding.draft_for_event(&before_call).unwrap_err();
    assert_eq!(error, ActiveCallTranscriptIngestError::InvalidTiming);
    assert_eq!(error.code(), "active_call_transcript_timing_invalid");
    assert!(!format!("{error:?}").contains("private transcript"));
}

#[tokio::test]
async fn eligible_final_reaches_the_sequence_store_once_and_ignored_audio_does_not() {
    let binding = binding("customer-track", 1_000);
    let store = Store::default();
    let eligible = final_event(
        &context("session-001"),
        "customer-track",
        1_200,
        None,
        0,
        "客户最终转写",
        false,
        None,
    );
    let ignored = final_event(
        &context("session-001"),
        "agent-track",
        1_300,
        None,
        0,
        "AI output",
        false,
        None,
    );

    let appended = append_active_call_final_transcript(
        &store,
        &binding,
        &eligible,
        ExecutionGeneration::new(7).unwrap(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(appended.sequence(), 77);
    assert_eq!(appended.text(), "客户最终转写");
    assert!(
        append_active_call_final_transcript(
            &store,
            &binding,
            &ignored,
            ExecutionGeneration::new(7).unwrap(),
        )
        .await
        .unwrap()
        .is_none()
    );
    assert_eq!(store.append_count.load(Ordering::Relaxed), 1);
}

#[derive(Default)]
struct Store {
    append_count: AtomicUsize,
}

impl ActiveCallTranscriptDurabilityPort for Store {
    type Append = TranscriptSegment;

    async fn append_sequenced_final_segment(
        &self,
        draft: &TranscriptSegmentDraft,
        current_generation: ExecutionGeneration,
    ) -> Result<Self::Append, ActiveCallTranscriptIngestError> {
        assert_eq!(current_generation.get(), 7);
        self.append_count.fetch_add(1, Ordering::Relaxed);
        draft
            .segment_with_sequence(77)
            .map_err(|_| ActiveCallTranscriptIngestError::StoreUnavailable)
    }
}

fn binding(customer_track_id: &str, call_started_at_ms: u64) -> ActiveCallTranscriptBinding {
    ActiveCallTranscriptBinding::try_new(ActiveCallTranscriptBindingInput {
        channel_agent_session_id: ChannelAgentSessionId::parse("session-001").unwrap(),
        customer_track_id: customer_track_id.to_owned(),
        call_started_at_ms,
        language: "zh-CN".to_owned(),
        retention_policy_ref: "retention:voice-default-v1".to_owned(),
    })
    .unwrap()
}

#[allow(clippy::too_many_arguments)]
fn final_event(
    context: &EnvelopeContext,
    track_id: &str,
    timestamp: u64,
    timing: Option<(u64, u64)>,
    index: u32,
    text: &str,
    is_filler: bool,
    refer: Option<bool>,
) -> NormalizedEvent {
    let timing = timing.map_or_else(String::new, |(start, end)| {
        format!(r#","startTime":{start},"endTime":{end}"#)
    });
    let refer = refer.map_or_else(String::new, |refer| format!(r#", "refer":{refer}"#));
    let wire = format!(
        r#"{{"event":"asrFinal","trackId":"{track_id}","timestamp":{timestamp},"index":{index}{timing},"text":"{text}","isFiller":{is_filler}{refer}}}"#
    );
    normalize_event(&AdapterContext::new(context.clone()), &wire).unwrap()
}

fn context(session_id: &str) -> EnvelopeContext {
    context_with_trace(session_id, "trace-001")
}

fn context_with_trace(session_id: &str, trace_id: &str) -> EnvelopeContext {
    EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version: VOICE_AGENT_SCHEMA_VERSION,
        tenant_id: "tenant-001".to_owned(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        campaign_id: CampaignId::parse("campaign-001").unwrap(),
        campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
        call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        call_id: Some(CallId::parse("call-001").unwrap()),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        channel_agent_session_id: Some(ChannelAgentSessionId::parse(session_id).unwrap()),
        execution_generation: ExecutionGeneration::new(7).unwrap(),
        trace_id: trace_id.to_owned(),
    })
    .unwrap()
}
