use std::{
    collections::BTreeMap,
    future,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use converact_conversation_result_core::{
    TranscriptSegment, TranscriptSegmentInput, TranscriptSpeaker,
};
use converact_conversation_understanding_core::{
    IntentCatalog, IntentCatalogInput, IntentDefinitionInput, IntentSource,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    EnvelopeContext, EnvelopeContextInput, EventId, ExecutionGeneration, IntentCatalogRevisionId,
    InteractionId, TranscriptSegmentId, VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    ContextualIntentArtifactInput, ContextualIntentCandidateOutput,
    ContextualIntentClassifierOutput, ContextualIntentClassifierPort,
    ContextualIntentClassifierPortError, ContextualIntentClassifierProvider,
    ContextualIntentClassifierProviderError, ContextualIntentClassifierRequest,
};

#[tokio::test]
async fn ordered_history_becomes_contextual_intent_and_allowed_slots() {
    let catalog = catalog();
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = provider(
        &catalog,
        FakeContextual::output(
            &calls,
            &[
                ("callback.specific_time", 9_300),
                ("sales.interested", 2_000),
            ],
            &[("callback_time", "tomorrow-15:00")],
        ),
    );
    let history = history();

    let observation = provider.observe(&history, 2).await.unwrap().unwrap();

    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(observation.source(), IntentSource::ContextualLlm);
    assert_eq!(
        observation.primary().unwrap().code(),
        "callback.specific_time"
    );
    assert_eq!(observation.evidence_segment_ids().len(), 3);
    assert_eq!(
        observation.evidence_segment_ids().last(),
        Some(history[2].id())
    );
    assert_eq!(
        observation.provider_revision(),
        provider.artifact_revision()
    );
    assert_eq!(
        provider.observe(&history, 2).await.unwrap().unwrap().id(),
        observation.id()
    );

    let diagnostics = format!("{provider:?} {observation:?}");
    assert!(!diagnostics.contains("tomorrow-15:00"));
    assert!(!diagnostics.contains("callback.specific_time"));
    assert!(!diagnostics.contains("明天下午"));
}

#[tokio::test]
async fn invalid_history_is_rejected_before_inference() {
    let catalog = catalog();
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = provider(&catalog, FakeContextual::output(&calls, &[], &[]));

    let mut reordered = history();
    reordered.swap(0, 1);
    assert_eq!(
        provider.observe(&reordered, 2).await.unwrap_err(),
        ContextualIntentClassifierProviderError::InputInvalid,
    );

    let mut wrong_authority = history();
    wrong_authority[0] = segment(
        1,
        TranscriptSpeaker::AiAgent,
        "您好",
        "zh-CN",
        "release-002",
    );
    assert_eq!(
        provider.observe(&wrong_authority, 2).await.unwrap_err(),
        ContextualIntentClassifierProviderError::InputInvalid,
    );

    let unsupported = vec![segment(
        1,
        TranscriptSpeaker::Customer,
        "Estoy interesado",
        "es-ES",
        "release-001",
    )];
    assert_eq!(
        provider.observe(&unsupported, 1).await.unwrap_err(),
        ContextualIntentClassifierProviderError::InputUnsupported,
    );

    let ai_current = vec![segment(
        1,
        TranscriptSpeaker::AiAgent,
        "请问您什么时候方便？",
        "zh-CN",
        "release-001",
    )];
    assert!(provider.observe(&ai_current, 1).await.unwrap().is_none());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn drift_and_schema_invalid_output_fail_closed() {
    let catalog = catalog();
    let calls = Arc::new(AtomicUsize::new(0));
    let history = history();

    let drifted = provider(
        &catalog,
        FakeContextual::drifted(&calls, &[("sales.interested", 9_000)], &[]),
    );
    assert_eq!(
        drifted.observe(&history, 2).await.unwrap_err(),
        ContextualIntentClassifierProviderError::ArtifactDrift,
    );

    let forbidden_slot = provider(
        &catalog,
        FakeContextual::output(
            &calls,
            &[("sales.interested", 9_000)],
            &[("callback_time", "secret")],
        ),
    );
    assert_eq!(
        forbidden_slot.observe(&history, 2).await.unwrap_err(),
        ContextualIntentClassifierProviderError::ClassifierOutputInvalid,
    );

    let unknown_label = provider(
        &catalog,
        FakeContextual::output(&calls, &[("not.in.catalog", 9_000)], &[]),
    );
    assert_eq!(
        unknown_label.observe(&history, 2).await.unwrap_err(),
        ContextualIntentClassifierProviderError::ClassifierOutputInvalid,
    );
}

#[tokio::test]
async fn inference_deadline_and_artifact_are_bounded() {
    let catalog = catalog();
    let calls = Arc::new(AtomicUsize::new(0));
    let timeout_provider = ContextualIntentClassifierProvider::try_new(
        artifact(1),
        &catalog,
        FakeContextual::pending(&calls),
    )
    .unwrap();
    assert_eq!(
        timeout_provider.observe(&history(), 2).await.unwrap_err(),
        ContextualIntentClassifierProviderError::ClassifierTimedOut,
    );

    let invalid = ContextualIntentClassifierProvider::try_new(
        ContextualIntentArtifactInput {
            output_schema_sha256: "A".repeat(64),
            ..artifact(100)
        },
        &catalog,
        FakeContextual::output(&calls, &[], &[]),
    );
    assert_eq!(
        invalid.unwrap_err(),
        ContextualIntentClassifierProviderError::ArtifactInvalid,
    );
}

#[derive(Clone)]
enum FakeMode {
    Output {
        candidates: Vec<(String, u16)>,
        slots: BTreeMap<String, String>,
        drifted: bool,
    },
    Pending,
}

#[derive(Clone)]
struct FakeContextual {
    calls: Arc<AtomicUsize>,
    mode: Arc<FakeMode>,
}

impl FakeContextual {
    fn output(
        calls: &Arc<AtomicUsize>,
        candidates: &[(&str, u16)],
        slots: &[(&str, &str)],
    ) -> Self {
        Self::new(calls, candidates, slots, false)
    }

    fn drifted(
        calls: &Arc<AtomicUsize>,
        candidates: &[(&str, u16)],
        slots: &[(&str, &str)],
    ) -> Self {
        Self::new(calls, candidates, slots, true)
    }

    fn new(
        calls: &Arc<AtomicUsize>,
        candidates: &[(&str, u16)],
        slots: &[(&str, &str)],
        drifted: bool,
    ) -> Self {
        Self {
            calls: Arc::clone(calls),
            mode: Arc::new(FakeMode::Output {
                candidates: candidates
                    .iter()
                    .map(|(code, score)| ((*code).to_owned(), *score))
                    .collect(),
                slots: slots
                    .iter()
                    .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                    .collect(),
                drifted,
            }),
        }
    }

    fn pending(calls: &Arc<AtomicUsize>) -> Self {
        Self {
            calls: Arc::clone(calls),
            mode: Arc::new(FakeMode::Pending),
        }
    }
}

impl ContextualIntentClassifierPort for FakeContextual {
    async fn classify<'a>(
        &'a self,
        request: ContextualIntentClassifierRequest<'a>,
    ) -> Result<ContextualIntentClassifierOutput, ContextualIntentClassifierPortError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(!request.turns().is_empty());
        assert_eq!(
            request.turns().last().unwrap().speaker(),
            TranscriptSpeaker::Customer
        );
        assert!(request.turns().iter().all(|turn| !turn.text().is_empty()));
        assert!(request.max_candidates() <= 5);
        assert!(request.max_slots() <= 32);
        match self.mode.as_ref() {
            FakeMode::Output {
                candidates,
                slots,
                drifted,
            } => Ok(ContextualIntentClassifierOutput {
                served_artifact_revision: if *drifted {
                    "contextual-intent.drifted".to_owned()
                } else {
                    request.artifact_revision().to_owned()
                },
                candidates: candidates
                    .iter()
                    .map(|(code, score)| ContextualIntentCandidateOutput {
                        code: code.clone(),
                        confidence_bps: *score,
                    })
                    .collect(),
                slots: slots.clone(),
            }),
            FakeMode::Pending => future::pending().await,
        }
    }
}

fn provider(
    catalog: &IntentCatalog,
    port: FakeContextual,
) -> ContextualIntentClassifierProvider<FakeContextual> {
    ContextualIntentClassifierProvider::try_new(artifact(100), catalog, port).unwrap()
}

fn artifact(deadline_ms: u64) -> ContextualIntentArtifactInput {
    ContextualIntentArtifactInput {
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        intent_catalog_revision_id: IntentCatalogRevisionId::parse("intent-catalog-001").unwrap(),
        model_profile_sha256: "1".repeat(64),
        prompt_template_sha256: "2".repeat(64),
        label_map_sha256: "3".repeat(64),
        output_schema_sha256: "4".repeat(64),
        calibration_sha256: "5".repeat(64),
        supported_languages: vec!["zh-CN".to_owned(), "en-US".to_owned()],
        max_context_segments: 16,
        max_context_bytes: 32_768,
        max_candidates: 5,
        max_slots: 16,
        inference_deadline_ms: deadline_ms,
    }
}

fn history() -> Vec<TranscriptSegment> {
    vec![
        segment_with_trace(
            1,
            TranscriptSpeaker::AiAgent,
            "您对这个方案感兴趣吗？",
            "zh-CN",
            "release-001",
            "trace-prior",
        ),
        segment(
            2,
            TranscriptSpeaker::Customer,
            "有一点兴趣。",
            "zh-CN",
            "release-001",
        ),
        segment(
            3,
            TranscriptSpeaker::Customer,
            "明天下午再联系我。",
            "zh-CN",
            "release-001",
        ),
    ]
}

fn segment(
    sequence: u64,
    speaker: TranscriptSpeaker,
    text: &str,
    language: &str,
    release: &str,
) -> TranscriptSegment {
    segment_with_trace(sequence, speaker, text, language, release, "trace-001")
}

fn segment_with_trace(
    sequence: u64,
    speaker: TranscriptSpeaker,
    text: &str,
    language: &str,
    release: &str,
    trace: &str,
) -> TranscriptSegment {
    TranscriptSegment::try_new(TranscriptSegmentInput {
        id: TranscriptSegmentId::parse(format!("segment-{sequence}")).unwrap(),
        context: context(release, trace),
        source_event_id: EventId::parse(format!("event-{sequence}")).unwrap(),
        sequence,
        speaker,
        language: language.to_owned(),
        text: text.to_owned(),
        start_offset_ms: sequence * 1_000,
        end_offset_ms: sequence * 1_000 + 500,
        observed_at_ms: sequence * 1_000 + 600,
        retention_policy_ref: "retention-standard-v1".to_owned(),
    })
    .unwrap()
}

fn catalog() -> IntentCatalog {
    IntentCatalog::try_new(IntentCatalogInput {
        id: IntentCatalogRevisionId::parse("intent-catalog-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        definitions: vec![
            definition("sales", None, &[]),
            definition("sales.interested", Some("sales"), &[]),
            definition("callback", None, &[]),
            definition(
                "callback.specific_time",
                Some("callback"),
                &["callback_time"],
            ),
        ],
    })
    .unwrap()
}

fn definition(code: &str, parent: Option<&str>, slots: &[&str]) -> IntentDefinitionInput {
    IntentDefinitionInput {
        code: code.to_owned(),
        parent_code: parent.map(str::to_owned),
        slot_keys: slots.iter().map(|slot| (*slot).to_owned()).collect(),
        safety_critical: false,
    }
}

fn context(release: &str, trace: &str) -> EnvelopeContext {
    EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version: VOICE_AGENT_SCHEMA_VERSION,
        tenant_id: "tenant-a".to_owned(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        campaign_id: CampaignId::parse("campaign-001").unwrap(),
        campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
        call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        call_id: Some(CallId::parse("call-001").unwrap()),
        agent_release_id: AgentReleaseId::parse(release).unwrap(),
        channel_agent_session_id: Some(ChannelAgentSessionId::parse("session-001").unwrap()),
        execution_generation: ExecutionGeneration::new(1).unwrap(),
        trace_id: trace.to_owned(),
    })
    .unwrap()
}
