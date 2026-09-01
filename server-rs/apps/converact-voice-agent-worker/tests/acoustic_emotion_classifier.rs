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
    EmotionCatalog, EmotionCatalogInput, EmotionDefinitionInput, EmotionSource, EmotionValence,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    EmotionCatalogRevisionId, EnvelopeContext, EnvelopeContextInput, EventId, ExecutionGeneration,
    InteractionId, TranscriptSegmentId, VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    AcousticEmotionCandidateOutput, AcousticEmotionClassifierArtifactInput,
    AcousticEmotionClassifierOutput, AcousticEmotionClassifierPort,
    AcousticEmotionClassifierPortError, AcousticEmotionClassifierProvider,
    AcousticEmotionClassifierProviderError, AcousticEmotionClassifierRequest, AudioEvidenceWindow,
    AudioEvidenceWindowError, AudioEvidenceWindowInput,
};

#[tokio::test]
async fn bounded_customer_pcm_becomes_release_bound_acoustic_evidence() {
    let catalog = catalog();
    let segment = segment(TranscriptSpeaker::Customer);
    let window = window(&segment, vec![120_i16; 16_000]).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = provider(
        &catalog,
        FakeClassifier::output(&calls, &[("customer.frustrated", 8_600, 3)]),
    );

    let observation = provider.observe(&window, 2).await.unwrap();

    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(observation.source(), EmotionSource::AcousticModel);
    assert_eq!(observation.primary().unwrap().code(), "customer.frustrated");
    assert_eq!(observation.primary().unwrap().confidence_bps(), 8_600);
    assert_eq!(
        observation.transcript_segment_ids(),
        &[segment.id().clone()]
    );
    assert_eq!(
        observation.audio_evidence_window_ids(),
        &[window.id().clone()]
    );
    assert_eq!(
        observation.provider_revision(),
        provider.artifact_revision()
    );
    assert_eq!(
        provider.observe(&window, 2).await.unwrap().id(),
        observation.id()
    );

    let diagnostics = format!("{provider:?} {window:?} {observation:?}");
    assert!(!diagnostics.contains("customer.frustrated"));
    assert!(!diagnostics.contains("[120"));
}

#[test]
fn audio_window_rejects_non_customer_misaligned_and_unbounded_pcm() {
    let ai = segment(TranscriptSpeaker::AiAgent);
    assert_eq!(
        window(&ai, vec![0_i16; 16_000]).unwrap_err(),
        AudioEvidenceWindowError::AuthorityInvalid
    );

    let customer = segment(TranscriptSpeaker::Customer);
    assert_eq!(
        window(&customer, vec![0_i16; 15_999]).unwrap_err(),
        AudioEvidenceWindowError::PcmInvalid
    );
    let too_long = AudioEvidenceWindow::try_new(AudioEvidenceWindowInput {
        segment: &customer,
        customer_track_id: "customer-track".to_owned(),
        start_offset_ms: 0,
        end_offset_ms: 16_000,
        pcm_s16_mono_16khz: vec![0_i16; 256_000],
    });
    assert_eq!(
        too_long.unwrap_err(),
        AudioEvidenceWindowError::TimingInvalid
    );
}

#[tokio::test]
async fn acoustic_serving_drift_timeout_and_unknown_labels_fail_closed() {
    let catalog = catalog();
    let segment = segment(TranscriptSpeaker::Customer);
    let window = window(&segment, vec![0_i16; 16_000]).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));

    let drifted = provider(&catalog, FakeClassifier::drifted(&calls));
    assert_eq!(
        drifted.observe(&window, 1).await.unwrap_err(),
        AcousticEmotionClassifierProviderError::ArtifactDrift
    );

    let unknown = provider(
        &catalog,
        FakeClassifier::output(&calls, &[("customer.unknown", 9_000, 2)]),
    );
    assert_eq!(
        unknown.observe(&window, 1).await.unwrap_err(),
        AcousticEmotionClassifierProviderError::ClassifierOutputInvalid
    );

    let timeout = AcousticEmotionClassifierProvider::try_new(
        artifact(1),
        &catalog,
        FakeClassifier::pending(&calls),
    )
    .unwrap();
    assert_eq!(
        timeout.observe(&window, 1).await.unwrap_err(),
        AcousticEmotionClassifierProviderError::ClassifierTimedOut
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
        Self {
            calls: Arc::clone(calls),
            mode: Arc::new(FakeMode::Output {
                candidates: candidates
                    .iter()
                    .map(|(code, confidence, intensity)| {
                        ((*code).to_owned(), *confidence, *intensity)
                    })
                    .collect(),
                drifted: false,
            }),
        }
    }

    fn drifted(calls: &Arc<AtomicUsize>) -> Self {
        Self {
            calls: Arc::clone(calls),
            mode: Arc::new(FakeMode::Output {
                candidates: vec![("customer.frustrated".to_owned(), 8_500, 3)],
                drifted: true,
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

impl AcousticEmotionClassifierPort for FakeClassifier {
    async fn classify<'a>(
        &'a self,
        request: AcousticEmotionClassifierRequest<'a>,
    ) -> Result<AcousticEmotionClassifierOutput, AcousticEmotionClassifierPortError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(request.sample_rate_hz(), 16_000);
        assert_eq!(request.samples().len(), 16_000);
        assert_eq!(request.pcm_sha256().len(), 64);
        assert!(request.max_candidates() <= 5);
        match self.mode.as_ref() {
            FakeMode::Output {
                candidates,
                drifted,
            } => Ok(AcousticEmotionClassifierOutput {
                served_artifact_revision: if *drifted {
                    "acoustic-emotion.drifted".to_owned()
                } else {
                    request.artifact_revision().to_owned()
                },
                candidates: candidates
                    .iter()
                    .map(
                        |(code, confidence_bps, intensity)| AcousticEmotionCandidateOutput {
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
) -> AcousticEmotionClassifierProvider<FakeClassifier> {
    AcousticEmotionClassifierProvider::try_new(artifact(100), catalog, port).unwrap()
}

fn artifact(deadline_ms: u64) -> AcousticEmotionClassifierArtifactInput {
    AcousticEmotionClassifierArtifactInput {
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        emotion_catalog_revision_id: EmotionCatalogRevisionId::parse("emotion-catalog-001")
            .unwrap(),
        model_sha256: "1".repeat(64),
        feature_extractor_sha256: "2".repeat(64),
        label_map_sha256: "3".repeat(64),
        calibration_sha256: "4".repeat(64),
        sample_rate_hz: 16_000,
        max_window_ms: 15_000,
        max_candidates: 5,
        inference_deadline_ms: deadline_ms,
    }
}

fn window(
    segment: &TranscriptSegment,
    samples: Vec<i16>,
) -> Result<AudioEvidenceWindow, AudioEvidenceWindowError> {
    AudioEvidenceWindow::try_new(AudioEvidenceWindowInput {
        segment,
        customer_track_id: "customer-track".to_owned(),
        start_offset_ms: 1_000,
        end_offset_ms: 2_000,
        pcm_s16_mono_16khz: samples,
    })
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

fn segment(speaker: TranscriptSpeaker) -> TranscriptSegment {
    TranscriptSegment::try_new(TranscriptSegmentInput {
        id: TranscriptSegmentId::parse("segment-customer-001").unwrap(),
        context: context(),
        source_event_id: EventId::parse("event-customer-001").unwrap(),
        sequence: 2,
        speaker,
        language: "zh-CN".to_owned(),
        text: "这个问题怎么还没解决".to_owned(),
        start_offset_ms: 1_000,
        end_offset_ms: 2_000,
        observed_at_ms: 3_000,
        retention_policy_ref: "retention-standard-v1".to_owned(),
    })
    .unwrap()
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
