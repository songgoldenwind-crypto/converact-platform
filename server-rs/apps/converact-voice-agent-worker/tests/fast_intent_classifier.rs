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
    IntentCatalog, IntentCatalogInput, IntentDecisionPolicy, IntentDefinitionInput, IntentSource,
    IntentState, IntentStatus,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    EnvelopeContext, EnvelopeContextInput, EventId, ExecutionGeneration, IntentCatalogRevisionId,
    InteractionId, TranscriptSegmentId, VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    FastIntentCandidateOutput, FastIntentClassifierArtifactInput, FastIntentClassifierOutput,
    FastIntentClassifierPort, FastIntentClassifierPortError, FastIntentClassifierProvider,
    FastIntentClassifierProviderError, FastIntentClassifierRequest,
};

#[tokio::test]
async fn high_confidence_model_output_becomes_release_bound_checkpoint() {
    let catalog = catalog();
    let provider = provider(
        &catalog,
        FakeClassifier::output(&[("sales.interested", 9_200), ("callback.later", 3_000)]),
    );
    let segment = segment(
        TranscriptSpeaker::Customer,
        "这个方案不错，我有兴趣。",
        "zh-CN",
    );

    let observation = provider.observe(&segment, 1).await.unwrap().unwrap();
    assert_eq!(observation.source(), IntentSource::FastClassifier);
    assert_eq!(observation.primary().unwrap().code(), "sales.interested");
    assert_eq!(observation.primary().unwrap().confidence_bps(), 9_200);
    assert_eq!(observation.evidence_segment_ids(), &[segment.id().clone()]);
    assert_eq!(
        observation.provider_revision(),
        provider.artifact_revision()
    );

    let checkpoint = provider
        .advance(
            &segment,
            1,
            &IntentState::new(context("release-001"), catalog.id().clone()),
            policy(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(checkpoint.state().status(), IntentStatus::Confirmed);
    assert_eq!(
        checkpoint.state().primary_intent(),
        Some("sales.interested")
    );
    assert_eq!(checkpoint.observation().id(), observation.id());
    assert_eq!(
        checkpoint.observation().payload_hash(),
        observation.payload_hash()
    );

    let diagnostics = format!("{provider:?} {observation:?}");
    assert!(!diagnostics.contains("这个方案"));
    assert!(!diagnostics.contains("sales.interested"));
}

#[tokio::test]
async fn confidence_router_preserves_ambiguity_and_explicit_unknown() {
    let catalog = catalog();
    let segment = segment(
        TranscriptSpeaker::Customer,
        "我再想想，也许晚点联系。",
        "zh-CN",
    );
    let ambiguous = provider(
        &catalog,
        FakeClassifier::output(&[("sales.interested", 8_900), ("callback.later", 8_000)]),
    )
    .advance(
        &segment,
        1,
        &IntentState::new(context("release-001"), catalog.id().clone()),
        policy(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        ambiguous.state().status(),
        IntentStatus::ClarificationRequired
    );

    let unknown = provider(&catalog, FakeClassifier::output(&[]))
        .advance(
            &segment,
            1,
            &IntentState::new(context("release-001"), catalog.id().clone()),
            policy(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unknown.state().status(), IntentStatus::Unknown);
    assert_eq!(unknown.state().primary_intent(), None);
}

#[tokio::test]
async fn drift_and_invalid_classifier_outputs_fail_closed() {
    let catalog = catalog();
    let segment = segment(TranscriptSpeaker::Customer, "晚点再联系。", "zh-CN");

    let drifted = provider(
        &catalog,
        FakeClassifier::drifted(&[("callback.later", 9_000)]),
    );
    assert_eq!(
        drifted.observe(&segment, 1).await.unwrap_err(),
        FastIntentClassifierProviderError::ArtifactDrift,
    );

    let unsorted = provider(
        &catalog,
        FakeClassifier::output(&[("callback.later", 4_000), ("sales.interested", 9_000)]),
    );
    assert_eq!(
        unsorted.observe(&segment, 1).await.unwrap_err(),
        FastIntentClassifierProviderError::ClassifierOutputInvalid,
    );

    let unknown_label = provider(
        &catalog,
        FakeClassifier::output(&[("not.in.catalog", 9_000)]),
    );
    assert_eq!(
        unknown_label.observe(&segment, 1).await.unwrap_err(),
        FastIntentClassifierProviderError::ClassifierOutputInvalid,
    );

    let overflow = provider(
        &catalog,
        FakeClassifier::output(&[
            ("sales.interested", 9_000),
            ("callback.later", 8_000),
            ("sales.interested", 7_000),
            ("callback.later", 6_000),
            ("sales.interested", 5_000),
            ("callback.later", 4_000),
        ]),
    );
    assert_eq!(
        overflow.observe(&segment, 1).await.unwrap_err(),
        FastIntentClassifierProviderError::ClassifierOutputInvalid,
    );

    let unavailable = provider(&catalog, FakeClassifier::failure());
    assert_eq!(
        unavailable.observe(&segment, 1).await.unwrap_err(),
        FastIntentClassifierProviderError::ClassifierUnavailable,
    );
}

#[tokio::test]
async fn unsupported_or_non_customer_input_never_leaks_into_inference() {
    let catalog = catalog();
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = provider(
        &catalog,
        FakeClassifier::counted(&calls, &[("sales.interested", 9_000)]),
    );

    assert!(
        provider
            .observe(
                &segment(TranscriptSpeaker::AiAgent, "我可以给您介绍。", "zh-CN"),
                1,
            )
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    assert_eq!(
        provider
            .observe(
                &segment(TranscriptSpeaker::Customer, "Estoy interesado", "es-ES"),
                1,
            )
            .await
            .unwrap_err(),
        FastIntentClassifierProviderError::InputUnsupported,
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn inference_deadline_and_artifact_validation_are_bounded() {
    let catalog = catalog();
    let timeout_provider =
        FastIntentClassifierProvider::try_new(artifact(1), &catalog, FakeClassifier::pending())
            .unwrap();
    assert_eq!(
        timeout_provider
            .observe(
                &segment(TranscriptSpeaker::Customer, "我有兴趣。", "zh-CN"),
                1,
            )
            .await
            .unwrap_err(),
        FastIntentClassifierProviderError::ClassifierTimedOut,
    );

    let bad_digest = FastIntentClassifierProvider::try_new(
        FastIntentClassifierArtifactInput {
            model_sha256: "A".repeat(64),
            ..artifact(100)
        },
        &catalog,
        FakeClassifier::output(&[]),
    );
    assert_eq!(
        bad_digest.unwrap_err(),
        FastIntentClassifierProviderError::ArtifactInvalid,
    );

    let wrong_release = FastIntentClassifierProvider::try_new(
        FastIntentClassifierArtifactInput {
            agent_release_id: AgentReleaseId::parse("release-002").unwrap(),
            ..artifact(100)
        },
        &catalog,
        FakeClassifier::output(&[]),
    );
    assert_eq!(
        wrong_release.unwrap_err(),
        FastIntentClassifierProviderError::CatalogMismatch,
    );

    let canonical = provider(&catalog, FakeClassifier::output(&[]));
    let reordered = FastIntentClassifierProvider::try_new(
        FastIntentClassifierArtifactInput {
            supported_languages: vec!["en-US".to_owned(), "zh-CN".to_owned()],
            ..artifact(100)
        },
        &catalog,
        FakeClassifier::output(&[]),
    )
    .unwrap();
    assert_eq!(canonical.artifact_revision(), reordered.artifact_revision());
}

#[derive(Clone)]
enum FakeMode {
    Output(Vec<(String, u16)>),
    Drifted(Vec<(String, u16)>),
    Failure,
    Pending,
}

#[derive(Clone)]
struct FakeClassifier {
    mode: FakeMode,
    calls: Option<Arc<AtomicUsize>>,
}

impl FakeClassifier {
    fn output(candidates: &[(&str, u16)]) -> Self {
        Self::new(FakeMode::Output(owned(candidates)))
    }

    fn drifted(candidates: &[(&str, u16)]) -> Self {
        Self::new(FakeMode::Drifted(owned(candidates)))
    }

    fn counted(calls: &Arc<AtomicUsize>, candidates: &[(&str, u16)]) -> Self {
        Self {
            mode: FakeMode::Output(owned(candidates)),
            calls: Some(Arc::clone(calls)),
        }
    }

    const fn pending() -> Self {
        Self::new(FakeMode::Pending)
    }

    const fn failure() -> Self {
        Self::new(FakeMode::Failure)
    }

    const fn new(mode: FakeMode) -> Self {
        Self { mode, calls: None }
    }
}

impl FastIntentClassifierPort for FakeClassifier {
    async fn classify<'a>(
        &'a self,
        request: FastIntentClassifierRequest<'a>,
    ) -> Result<FastIntentClassifierOutput, FastIntentClassifierPortError> {
        if let Some(calls) = &self.calls {
            calls.fetch_add(1, Ordering::SeqCst);
        }
        assert_eq!(request.language(), "zh-CN");
        assert!(!request.text().is_empty());
        assert!(request.max_candidates() <= 5);
        match &self.mode {
            FakeMode::Output(candidates) => Ok(output(request.artifact_revision(), candidates)),
            FakeMode::Drifted(candidates) => Ok(output("fast-intent.drifted", candidates)),
            FakeMode::Failure => Err(FastIntentClassifierPortError::new("model_unavailable")),
            FakeMode::Pending => future::pending().await,
        }
    }
}

fn output(artifact_revision: &str, candidates: &[(String, u16)]) -> FastIntentClassifierOutput {
    FastIntentClassifierOutput {
        served_artifact_revision: artifact_revision.to_owned(),
        candidates: candidates
            .iter()
            .map(|(code, confidence_bps)| FastIntentCandidateOutput {
                code: code.clone(),
                confidence_bps: *confidence_bps,
            })
            .collect(),
    }
}

fn owned(candidates: &[(&str, u16)]) -> Vec<(String, u16)> {
    candidates
        .iter()
        .map(|(code, score)| ((*code).to_owned(), *score))
        .collect()
}

fn provider(
    catalog: &IntentCatalog,
    port: FakeClassifier,
) -> FastIntentClassifierProvider<FakeClassifier> {
    FastIntentClassifierProvider::try_new(artifact(100), catalog, port).unwrap()
}

fn artifact(deadline_ms: u64) -> FastIntentClassifierArtifactInput {
    FastIntentClassifierArtifactInput {
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        intent_catalog_revision_id: IntentCatalogRevisionId::parse("intent-catalog-001").unwrap(),
        model_sha256: "1".repeat(64),
        tokenizer_sha256: "2".repeat(64),
        label_map_sha256: "3".repeat(64),
        calibration_sha256: "4".repeat(64),
        supported_languages: vec!["zh-CN".to_owned(), "en-US".to_owned()],
        max_input_bytes: 4_096,
        max_candidates: 5,
        inference_deadline_ms: deadline_ms,
    }
}

fn policy() -> IntentDecisionPolicy {
    IntentDecisionPolicy::try_new(5_500, 8_500, 2_000, 9_500).unwrap()
}

fn catalog() -> IntentCatalog {
    IntentCatalog::try_new(IntentCatalogInput {
        id: IntentCatalogRevisionId::parse("intent-catalog-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        definitions: vec![
            definition("sales", None),
            definition("sales.interested", Some("sales")),
            definition("callback", None),
            definition("callback.later", Some("callback")),
        ],
    })
    .unwrap()
}

fn definition(code: &str, parent_code: Option<&str>) -> IntentDefinitionInput {
    IntentDefinitionInput {
        code: code.to_owned(),
        parent_code: parent_code.map(str::to_owned),
        slot_keys: Vec::new(),
        safety_critical: false,
    }
}

fn segment(speaker: TranscriptSpeaker, text: &str, language: &str) -> TranscriptSegment {
    TranscriptSegment::try_new(TranscriptSegmentInput {
        id: TranscriptSegmentId::parse(format!("segment-{}", speaker.as_str())).unwrap(),
        context: context("release-001"),
        source_event_id: EventId::parse(format!("event-{}", speaker.as_str())).unwrap(),
        sequence: 1,
        speaker,
        language: language.to_owned(),
        text: text.to_owned(),
        start_offset_ms: 1_000,
        end_offset_ms: 2_000,
        observed_at_ms: 3_000,
        retention_policy_ref: "retention-standard-v1".to_owned(),
    })
    .unwrap()
}

fn context(release: &str) -> EnvelopeContext {
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
        trace_id: "trace-001".to_owned(),
    })
    .unwrap()
}
