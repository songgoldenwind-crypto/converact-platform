use std::{
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
    EmotionCatalog, EmotionCatalogInput, EmotionDecisionPolicy, EmotionDefinitionInput,
    EmotionSource, EmotionState, EmotionStatus, EmotionValence,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    EmotionCatalogRevisionId, EnvelopeContext, EnvelopeContextInput, EventId, ExecutionGeneration,
    InteractionId, TranscriptSegmentId, VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    TextEmotionCandidateOutput, TextEmotionClassifierArtifactInput, TextEmotionClassifierOutput,
    TextEmotionClassifierPort, TextEmotionClassifierPortError, TextEmotionClassifierProvider,
    TextEmotionClassifierProviderError, TextEmotionClassifierRequest, TextEmotionTurnRuntime,
};

#[tokio::test]
async fn final_customer_transcript_becomes_release_bound_text_emotion_evidence() {
    let catalog = catalog();
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = provider(
        &catalog,
        FakeClassifier::output(&calls, &[("customer.frustrated", 8_900, 3)]),
    );
    let segment = segment(TranscriptSpeaker::Customer, "这个问题怎么还没解决");

    let observation = provider.observe(&segment, 2).await.unwrap().unwrap();

    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(observation.source(), EmotionSource::TextClassifier);
    assert_eq!(observation.primary().unwrap().code(), "customer.frustrated");
    assert_eq!(observation.primary().unwrap().confidence_bps(), 8_900);
    assert_eq!(observation.primary().unwrap().intensity(), 3);
    assert_eq!(
        observation.transcript_segment_ids(),
        &[segment.id().clone()]
    );
    assert!(observation.audio_evidence_window_ids().is_empty());
    assert_eq!(
        observation.provider_revision(),
        provider.artifact_revision()
    );
    assert_eq!(
        provider.observe(&segment, 2).await.unwrap().unwrap().id(),
        observation.id()
    );

    let diagnostics = format!("{provider:?} {observation:?}");
    assert!(!diagnostics.contains("这个问题"));
    assert!(!diagnostics.contains("customer.frustrated"));

    let resolution = TextEmotionTurnRuntime::new(
        &catalog,
        EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap(),
    )
    .resolve(
        observation,
        &EmotionState::new(context(), catalog.id().clone()),
    )
    .unwrap();
    assert_eq!(resolution.contributor_count(), 1);
    assert_eq!(
        resolution.checkpoint().state().status(),
        EmotionStatus::Confirmed
    );
    assert_eq!(
        resolution.checkpoint().state().confirmed_intensity(),
        Some(3)
    );
    assert_eq!(
        resolution.checkpoint().to_value()["fusion"]["fusion_revision"],
        "text-only-emotion-fusion-v1"
    );
    let evidence = resolution
        .encode_evidence_records("understanding-30-days-v1", 2_592_003_001)
        .unwrap();
    assert_eq!(evidence.len(), 1);
    assert_eq!(
        evidence[0].kind(),
        converact_conversation_understanding_store::UnderstandingRecordKind::EmotionObservation
    );
    assert!(!evidence[0].can_advance_head());
}

#[tokio::test]
async fn non_customer_and_unsupported_input_are_rejected_before_inference() {
    let catalog = catalog();
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = provider(&catalog, FakeClassifier::output(&calls, &[]));

    assert!(
        provider
            .observe(&segment(TranscriptSpeaker::AiAgent, "我来协助您"), 1)
            .await
            .unwrap()
            .is_none()
    );
    let mut unsupported = segment_input(TranscriptSpeaker::Customer, "still not working");
    unsupported.language = "en-US".to_owned();
    assert_eq!(
        provider
            .observe(&TranscriptSegment::try_new(unsupported).unwrap(), 1)
            .await
            .unwrap_err(),
        TextEmotionClassifierProviderError::InputUnsupported,
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn serving_drift_and_invalid_candidates_fail_closed() {
    let catalog = catalog();
    let calls = Arc::new(AtomicUsize::new(0));
    let customer = segment(TranscriptSpeaker::Customer, "还是不行");

    let drifted = provider(
        &catalog,
        FakeClassifier::drifted(&calls, &[("customer.frustrated", 8_900, 3)]),
    );
    assert_eq!(
        drifted.observe(&customer, 1).await.unwrap_err(),
        TextEmotionClassifierProviderError::ArtifactDrift,
    );

    let unknown = provider(
        &catalog,
        FakeClassifier::output(&calls, &[("customer.not_in_catalog", 9_000, 2)]),
    );
    assert_eq!(
        unknown.observe(&customer, 1).await.unwrap_err(),
        TextEmotionClassifierProviderError::ClassifierOutputInvalid,
    );

    let invalid_intensity = provider(
        &catalog,
        FakeClassifier::output(&calls, &[("customer.frustrated", 9_000, 5)]),
    );
    assert_eq!(
        invalid_intensity.observe(&customer, 1).await.unwrap_err(),
        TextEmotionClassifierProviderError::ClassifierOutputInvalid,
    );
}

#[tokio::test]
async fn inference_deadline_and_artifact_bounds_are_enforced() {
    let catalog = catalog();
    let calls = Arc::new(AtomicUsize::new(0));
    let timeout = TextEmotionClassifierProvider::try_new(
        artifact(1),
        &catalog,
        FakeClassifier::pending(&calls),
    )
    .unwrap();
    assert_eq!(
        timeout
            .observe(&segment(TranscriptSpeaker::Customer, "请尽快处理"), 1)
            .await
            .unwrap_err(),
        TextEmotionClassifierProviderError::ClassifierTimedOut,
    );

    let invalid = TextEmotionClassifierProvider::try_new(
        TextEmotionClassifierArtifactInput {
            model_sha256: "A".repeat(64),
            ..artifact(100)
        },
        &catalog,
        FakeClassifier::output(&calls, &[]),
    );
    assert_eq!(
        invalid.unwrap_err(),
        TextEmotionClassifierProviderError::ArtifactInvalid,
    );
}

#[derive(Clone)]
enum FakeMode {
    Output {
        candidates: Vec<(String, u16, u8)>,
        drifted: bool,
    },
    Pending,
}

#[derive(Clone)]
struct FakeClassifier {
    calls: Arc<AtomicUsize>,
    mode: Arc<FakeMode>,
}

impl FakeClassifier {
    fn output(calls: &Arc<AtomicUsize>, candidates: &[(&str, u16, u8)]) -> Self {
        Self::new(calls, candidates, false)
    }

    fn drifted(calls: &Arc<AtomicUsize>, candidates: &[(&str, u16, u8)]) -> Self {
        Self::new(calls, candidates, true)
    }

    fn new(calls: &Arc<AtomicUsize>, candidates: &[(&str, u16, u8)], drifted: bool) -> Self {
        Self {
            calls: Arc::clone(calls),
            mode: Arc::new(FakeMode::Output {
                candidates: candidates
                    .iter()
                    .map(|(code, confidence, intensity)| {
                        ((*code).to_owned(), *confidence, *intensity)
                    })
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

impl TextEmotionClassifierPort for FakeClassifier {
    async fn classify<'a>(
        &'a self,
        request: TextEmotionClassifierRequest<'a>,
    ) -> Result<TextEmotionClassifierOutput, TextEmotionClassifierPortError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(request.language(), "zh-CN");
        assert!(!request.text().is_empty());
        assert!(request.max_candidates() <= 5);
        match self.mode.as_ref() {
            FakeMode::Output {
                candidates,
                drifted,
            } => Ok(TextEmotionClassifierOutput {
                served_artifact_revision: if *drifted {
                    "text-emotion.drifted".to_owned()
                } else {
                    request.artifact_revision().to_owned()
                },
                candidates: candidates
                    .iter()
                    .map(
                        |(code, confidence_bps, intensity)| TextEmotionCandidateOutput {
                            code: code.clone(),
                            confidence_bps: *confidence_bps,
                            intensity: *intensity,
                        },
                    )
                    .collect(),
            }),
            FakeMode::Pending => future::pending().await,
        }
    }
}

fn provider(
    catalog: &EmotionCatalog,
    port: FakeClassifier,
) -> TextEmotionClassifierProvider<FakeClassifier> {
    TextEmotionClassifierProvider::try_new(artifact(100), catalog, port).unwrap()
}

fn artifact(deadline_ms: u64) -> TextEmotionClassifierArtifactInput {
    TextEmotionClassifierArtifactInput {
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        emotion_catalog_revision_id: EmotionCatalogRevisionId::parse("emotion-catalog-001")
            .unwrap(),
        model_sha256: "1".repeat(64),
        tokenizer_sha256: "2".repeat(64),
        label_map_sha256: "3".repeat(64),
        calibration_sha256: "4".repeat(64),
        supported_languages: vec!["zh-CN".to_owned()],
        max_input_bytes: 4_096,
        max_candidates: 5,
        inference_deadline_ms: deadline_ms,
    }
}

fn catalog() -> EmotionCatalog {
    EmotionCatalog::try_new(EmotionCatalogInput {
        id: EmotionCatalogRevisionId::parse("emotion-catalog-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        definitions: vec![
            EmotionDefinitionInput {
                code: "customer.neutral".to_owned(),
                valence: EmotionValence::Neutral,
                distress_rank: 0,
            },
            EmotionDefinitionInput {
                code: "customer.frustrated".to_owned(),
                valence: EmotionValence::Negative,
                distress_rank: 3,
            },
        ],
    })
    .unwrap()
}

fn segment(speaker: TranscriptSpeaker, text: &str) -> TranscriptSegment {
    TranscriptSegment::try_new(segment_input(speaker, text)).unwrap()
}

fn segment_input(speaker: TranscriptSpeaker, text: &str) -> TranscriptSegmentInput {
    TranscriptSegmentInput {
        id: TranscriptSegmentId::parse("segment-customer-001").unwrap(),
        context: context(),
        source_event_id: EventId::parse("event-customer-001").unwrap(),
        sequence: 2,
        speaker,
        language: "zh-CN".to_owned(),
        text: text.to_owned(),
        start_offset_ms: 1_000,
        end_offset_ms: 2_000,
        observed_at_ms: 3_000,
        retention_policy_ref: "retention-standard-v1".to_owned(),
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
        call_id: Some(CallId::parse("call-001").unwrap()),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        channel_agent_session_id: Some(ChannelAgentSessionId::parse("session-001").unwrap()),
        execution_generation: ExecutionGeneration::new(1).unwrap(),
        trace_id: "trace-001".to_owned(),
    })
    .unwrap()
}
