use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};

use converact_active_call_adapter::{AdapterContext, NormalizedEvent, normalize_event};
use converact_conversation_result_core::{TranscriptSegment, TranscriptSegmentDraft};
use converact_conversation_result_store::{TranscriptHistoryLimit, TranscriptHistoryWindow};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    EnvelopeContext, EnvelopeContextInput, ExecutionGeneration, InteractionId,
    VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    ActiveCallEventProcessingError, ActiveCallTranscriptBinding, ActiveCallTranscriptBindingInput,
    ActiveCallTranscriptBindingPort, ActiveCallTranscriptDurabilityPort,
    ActiveCallTranscriptIngestError, ActiveCallTranscriptProjectionPort,
    ActiveCallUnderstandingEventOutcome, ActiveCallUnderstandingEventProcessor,
    FinalTranscriptUnderstandingError, FinalTranscriptUnderstandingPort,
    TranscriptUnderstandingAppendReceipt, TranscriptUnderstandingDisposition,
    TranscriptUnderstandingHistoryPort, TranscriptUnderstandingSourceError,
    append_active_call_final_transcript, process_active_call_understanding_event,
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

#[tokio::test]
async fn active_call_final_flows_through_sequence_history_and_understanding_once() {
    let binding = binding("customer-track", 1_000);
    let event = final_event(
        &context("session-001"),
        "customer-track",
        1_500,
        Some((1_100, 1_450)),
        0,
        "别再给我打电话了",
        false,
        None,
    );
    let store = CoordinatorStore::new(TranscriptUnderstandingDisposition::AppendedCurrent);
    let processor = Processor::new(TranscriptUnderstandingDisposition::AppendedCurrent, 1);

    let outcome = process_active_call_understanding_event(
        &store,
        &processor,
        &binding,
        &event,
        ExecutionGeneration::new(7).unwrap(),
        TranscriptHistoryLimit::new(16).unwrap(),
    )
    .await
    .unwrap();

    assert_eq!(
        outcome,
        ActiveCallUnderstandingEventOutcome::Processed("processed")
    );
    assert_eq!(store.append_count.load(Ordering::Relaxed), 1);
    assert_eq!(store.history_count.load(Ordering::Relaxed), 1);
    assert_eq!(processor.calls.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn shared_processor_binds_media_then_resolves_the_exact_call_for_each_final() {
    let authority = context("session-001");
    let bindings = BindingStore::default();
    let store = CoordinatorStore::new(TranscriptUnderstandingDisposition::AppendedCurrent);
    let understanding = Processor::new(TranscriptUnderstandingDisposition::AppendedCurrent, 1);
    let processor = ActiveCallUnderstandingEventProcessor::new_dynamic(
        &bindings,
        &store,
        &understanding,
        TranscriptHistoryLimit::new(16).unwrap(),
    );
    let media_ready = normalize_event(
        &AdapterContext::new(authority.clone()),
        r#"{"event":"mediaReady","trackId":"customer-track","timestamp":1000}"#,
    )
    .unwrap();

    processor
        .project_transcript_event(&authority, &media_ready)
        .await
        .unwrap();
    processor
        .project_transcript_event(
            &authority,
            &final_event(
                &authority,
                "customer-track",
                1_500,
                Some((1_100, 1_450)),
                0,
                "恢复后仍属于同一通话",
                false,
                None,
            ),
        )
        .await
        .unwrap();

    assert_eq!(bindings.bind_count.load(Ordering::Relaxed), 1);
    assert_eq!(bindings.load_count.load(Ordering::Relaxed), 1);
    assert_eq!(store.append_count.load(Ordering::Relaxed), 1);
    assert_eq!(understanding.calls.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn replay_and_ignored_events_never_load_history_or_duplicate_model_work() {
    let binding = binding("customer-track", 1_000);
    let replay = CoordinatorStore::new(TranscriptUnderstandingDisposition::ReplayedCurrent);
    let processor = Processor::new(TranscriptUnderstandingDisposition::ReplayedCurrent, 0);
    let customer = final_event(
        &context("session-001"),
        "customer-track",
        1_500,
        None,
        0,
        "重放客户转写",
        false,
        None,
    );
    let replayed = process_active_call_understanding_event(
        &replay,
        &processor,
        &binding,
        &customer,
        ExecutionGeneration::new(7).unwrap(),
        TranscriptHistoryLimit::new(16).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        replayed,
        ActiveCallUnderstandingEventOutcome::Processed("processed")
    );
    assert_eq!(replay.history_count.load(Ordering::Relaxed), 0);
    assert_eq!(processor.calls.load(Ordering::Relaxed), 1);

    let ignored = final_event(
        &context("session-001"),
        "agent-track",
        1_600,
        None,
        0,
        "AI output",
        false,
        None,
    );
    assert_eq!(
        process_active_call_understanding_event(
            &replay,
            &processor,
            &binding,
            &ignored,
            ExecutionGeneration::new(7).unwrap(),
            TranscriptHistoryLimit::new(16).unwrap(),
        )
        .await
        .unwrap(),
        ActiveCallUnderstandingEventOutcome::Ignored
    );
    assert_eq!(replay.append_count.load(Ordering::Relaxed), 1);
    assert_eq!(processor.calls.load(Ordering::Relaxed), 1);
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

struct Receipt {
    segment: TranscriptSegment,
    disposition: TranscriptUnderstandingDisposition,
}

impl TranscriptUnderstandingAppendReceipt for Receipt {
    fn segment(&self) -> &TranscriptSegment {
        &self.segment
    }

    fn disposition(&self) -> TranscriptUnderstandingDisposition {
        self.disposition
    }
}

struct CoordinatorStore {
    disposition: TranscriptUnderstandingDisposition,
    append_count: AtomicUsize,
    history_count: AtomicUsize,
}

#[derive(Default)]
struct BindingStore {
    binding: Mutex<Option<ActiveCallTranscriptBinding>>,
    bind_count: AtomicUsize,
    load_count: AtomicUsize,
}

impl ActiveCallTranscriptBindingPort for BindingStore {
    async fn bind_media(
        &self,
        context: &EnvelopeContext,
        customer_track_id: &str,
        call_started_at_ms: u64,
    ) -> Result<(), ActiveCallEventProcessingError> {
        self.bind_count.fetch_add(1, Ordering::Relaxed);
        let binding = ActiveCallTranscriptBinding::try_new(ActiveCallTranscriptBindingInput {
            channel_agent_session_id: context.channel_agent_session_id().unwrap().clone(),
            customer_track_id: customer_track_id.to_owned(),
            call_started_at_ms,
            language: "zh-CN".to_owned(),
            retention_policy_ref: "until-ms-9999999999999".to_owned(),
        })
        .map_err(|_| ActiveCallEventProcessingError::new("test_binding_invalid"))?;
        *self.binding.lock().unwrap() = Some(binding);
        Ok(())
    }

    async fn load_binding(
        &self,
        _context: &EnvelopeContext,
    ) -> Result<Option<ActiveCallTranscriptBinding>, ActiveCallEventProcessingError> {
        self.load_count.fetch_add(1, Ordering::Relaxed);
        Ok(self.binding.lock().unwrap().clone())
    }
}

impl CoordinatorStore {
    const fn new(disposition: TranscriptUnderstandingDisposition) -> Self {
        Self {
            disposition,
            append_count: AtomicUsize::new(0),
            history_count: AtomicUsize::new(0),
        }
    }
}

impl ActiveCallTranscriptDurabilityPort for CoordinatorStore {
    type Append = Receipt;

    async fn append_sequenced_final_segment(
        &self,
        draft: &TranscriptSegmentDraft,
        current_generation: ExecutionGeneration,
    ) -> Result<Self::Append, ActiveCallTranscriptIngestError> {
        assert_eq!(current_generation.get(), 7);
        self.append_count.fetch_add(1, Ordering::Relaxed);
        Ok(Receipt {
            segment: draft.segment_with_sequence(1).unwrap(),
            disposition: self.disposition,
        })
    }
}

impl TranscriptUnderstandingHistoryPort for CoordinatorStore {
    async fn load_recent_transcript_window(
        &self,
        current: &TranscriptSegment,
        limit: TranscriptHistoryLimit,
    ) -> Result<TranscriptHistoryWindow, TranscriptUnderstandingSourceError> {
        self.history_count.fetch_add(1, Ordering::Relaxed);
        TranscriptHistoryWindow::try_new(current, vec![current.clone()], limit)
            .map_err(|_| TranscriptUnderstandingSourceError::HistoryUnavailable)
    }
}

struct Processor {
    calls: AtomicUsize,
    expected_disposition: TranscriptUnderstandingDisposition,
    expected_history_len: usize,
}

impl Processor {
    const fn new(
        expected_disposition: TranscriptUnderstandingDisposition,
        expected_history_len: usize,
    ) -> Self {
        Self {
            calls: AtomicUsize::new(0),
            expected_disposition,
            expected_history_len,
        }
    }
}

impl FinalTranscriptUnderstandingPort for Processor {
    type Outcome = &'static str;

    async fn process(
        &self,
        disposition: TranscriptUnderstandingDisposition,
        history: &[TranscriptSegment],
    ) -> Result<Self::Outcome, FinalTranscriptUnderstandingError> {
        assert_eq!(disposition, self.expected_disposition);
        assert_eq!(history.len(), self.expected_history_len);
        self.calls.fetch_add(1, Ordering::Relaxed);
        Ok("processed")
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
