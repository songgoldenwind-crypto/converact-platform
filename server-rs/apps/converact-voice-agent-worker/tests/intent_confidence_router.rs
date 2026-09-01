use std::collections::BTreeMap;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use converact_conversation_result_core::{
    TranscriptSegment, TranscriptSegmentInput, TranscriptSpeaker,
};
use converact_conversation_understanding_core::{
    IntentCandidateInput, IntentCatalog, IntentCatalogInput, IntentDecisionPolicy,
    IntentDefinitionInput, IntentObservation, IntentObservationInput, IntentSource, IntentState,
    IntentStatus,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    EnvelopeContext, EnvelopeContextInput, EventId, ExecutionGeneration, IntentCatalogRevisionId,
    IntentObservationId, InteractionId, TranscriptSegmentId, VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    FastIntentCandidateOutput, FastIntentClassifierArtifactInput, FastIntentClassifierOutput,
    FastIntentClassifierPort, FastIntentClassifierPortError, FastIntentClassifierProvider,
    FastIntentClassifierRequest, IntentConfidenceRouter, IntentConfidenceRouterError,
    IntentTurnRoute, SafetyIntentMatchKind, SafetyIntentProvider, SafetyIntentRuleInput,
    SafetyIntentRuleSetInput,
};

#[tokio::test]
async fn safety_match_short_circuits_fast_classifier_and_advances_once() {
    let catalog = catalog();
    let calls = Arc::new(AtomicUsize::new(0));
    let safety = safety_provider(&catalog);
    let fast = fast_provider(
        &catalog,
        FakeClassifier::new(&calls, &[("sales.interested", 9_500)]),
    );
    let router = IntentConfidenceRouter::new(&safety, &fast);

    let route = router
        .route(
            &segment("别再给我打电话了"),
            1,
            &initial(&catalog),
            policy(),
        )
        .await
        .unwrap()
        .unwrap();
    let IntentTurnRoute::Resolved(resolution) = route else {
        panic!("safety evidence must close the turn");
    };

    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(resolution.selected_source(), IntentSource::SafetyRule);
    assert_eq!(resolution.contributor_count(), 1);
    assert_eq!(
        resolution.checkpoint().state().status(),
        IntentStatus::Confirmed
    );
    assert_eq!(resolution.checkpoint().turn_index(), 1);
    assert_eq!(resolution.resolution_hash().len(), 64);
}

#[tokio::test]
async fn confirmed_fast_result_closes_without_contextual_route() {
    let catalog = catalog();
    let calls = Arc::new(AtomicUsize::new(0));
    let safety = safety_provider(&catalog);
    let fast = fast_provider(
        &catalog,
        FakeClassifier::new(
            &calls,
            &[("sales.interested", 9_200), ("callback.later", 3_000)],
        ),
    );
    let route = IntentConfidenceRouter::new(&safety, &fast)
        .route(
            &segment("这个方案我有兴趣"),
            1,
            &initial(&catalog),
            policy(),
        )
        .await
        .unwrap()
        .unwrap();
    let IntentTurnRoute::Resolved(resolution) = route else {
        panic!("confirmed fast evidence must close the turn");
    };

    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(resolution.selected_source(), IntentSource::FastClassifier);
    assert_eq!(resolution.contributor_count(), 1);
    assert_eq!(
        resolution.checkpoint().state().status(),
        IntentStatus::Confirmed
    );
}

#[tokio::test]
async fn ambiguous_fast_result_waits_and_contextual_result_advances_original_state_once() {
    let catalog = catalog();
    let calls = Arc::new(AtomicUsize::new(0));
    let safety = safety_provider(&catalog);
    let fast = fast_provider(
        &catalog,
        FakeClassifier::new(
            &calls,
            &[("sales.interested", 8_900), ("callback.later", 8_000)],
        ),
    );
    let customer_segment = segment("我有点兴趣，不过还是晚点再说");
    let route = IntentConfidenceRouter::new(&safety, &fast)
        .route(&customer_segment, 1, &initial(&catalog), policy())
        .await
        .unwrap()
        .unwrap();
    let IntentTurnRoute::ContextualRequired(pending) = route else {
        panic!("ambiguous fast evidence must not advance the turn");
    };

    assert_eq!(
        pending.fast_observation().source(),
        IntentSource::FastClassifier
    );
    let resolution = pending
        .resolve_contextual(contextual_observation(
            &catalog,
            &customer_segment,
            "callback.later",
        ))
        .unwrap();
    assert_eq!(resolution.selected_source(), IntentSource::ContextualLlm);
    assert_eq!(resolution.contributor_count(), 2);
    assert_eq!(
        resolution.checkpoint().state().status(),
        IntentStatus::Confirmed
    );
    assert_eq!(
        resolution.checkpoint().state().primary_intent(),
        Some("callback.later")
    );
    assert_eq!(resolution.checkpoint().turn_index(), 1);
}

#[tokio::test]
async fn explicit_fast_fallback_and_contextual_evidence_mismatch_are_fail_closed() {
    let catalog = catalog();
    let calls = Arc::new(AtomicUsize::new(0));
    let safety = safety_provider(&catalog);
    let fast = fast_provider(
        &catalog,
        FakeClassifier::new(
            &calls,
            &[("sales.interested", 8_900), ("callback.later", 8_000)],
        ),
    );
    let customer_segment = segment("我再想想");

    let fallback_pending = pending(
        IntentConfidenceRouter::new(&safety, &fast)
            .route(&customer_segment, 1, &initial(&catalog), policy())
            .await
            .unwrap()
            .unwrap(),
    );
    let fallback = fallback_pending.fallback().unwrap();
    assert_eq!(fallback.selected_source(), IntentSource::FastClassifier);
    assert_eq!(
        fallback.checkpoint().state().status(),
        IntentStatus::ClarificationRequired
    );

    let mismatch_pending = pending(
        IntentConfidenceRouter::new(&safety, &fast)
            .route(&customer_segment, 1, &initial(&catalog), policy())
            .await
            .unwrap()
            .unwrap(),
    );
    let other_segment = TranscriptSegment::try_new(TranscriptSegmentInput {
        id: TranscriptSegmentId::parse("segment-other").unwrap(),
        source_event_id: EventId::parse("event-other").unwrap(),
        ..segment_input("different evidence")
    })
    .unwrap();
    assert_eq!(
        mismatch_pending
            .resolve_contextual(contextual_observation(
                &catalog,
                &other_segment,
                "callback.later",
            ))
            .unwrap_err(),
        IntentConfidenceRouterError::ContextualEvidenceMismatch,
    );
}

fn pending(route: IntentTurnRoute) -> converact_voice_agent_worker::PendingIntentTurn {
    let IntentTurnRoute::ContextualRequired(pending) = route else {
        panic!("expected contextual route");
    };
    pending
}

#[derive(Clone)]
struct FakeClassifier {
    calls: Arc<AtomicUsize>,
    candidates: Arc<Vec<(String, u16)>>,
}

impl FakeClassifier {
    fn new(calls: &Arc<AtomicUsize>, candidates: &[(&str, u16)]) -> Self {
        Self {
            calls: Arc::clone(calls),
            candidates: Arc::new(
                candidates
                    .iter()
                    .map(|(code, score)| ((*code).to_owned(), *score))
                    .collect(),
            ),
        }
    }
}

impl FastIntentClassifierPort for FakeClassifier {
    async fn classify<'a>(
        &'a self,
        request: FastIntentClassifierRequest<'a>,
    ) -> Result<FastIntentClassifierOutput, FastIntentClassifierPortError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(FastIntentClassifierOutput {
            served_artifact_revision: request.artifact_revision().to_owned(),
            candidates: self
                .candidates
                .iter()
                .map(|(code, score)| FastIntentCandidateOutput {
                    code: code.clone(),
                    confidence_bps: *score,
                })
                .collect(),
        })
    }
}

fn contextual_observation(
    catalog: &IntentCatalog,
    segment: &TranscriptSegment,
    intent: &str,
) -> IntentObservation {
    IntentObservation::try_new(
        IntentObservationInput {
            id: IntentObservationId::parse(format!("intent-contextual-{intent}")).unwrap(),
            context: segment.context().clone(),
            catalog_revision_id: catalog.id().clone(),
            source: IntentSource::ContextualLlm,
            provider_revision: "contextual-llm-r1".to_owned(),
            candidates: vec![IntentCandidateInput {
                code: intent.to_owned(),
                confidence_bps: 9_300,
            }],
            slots: BTreeMap::default(),
            evidence_segment_ids: vec![
                TranscriptSegmentId::parse("segment-prior-context").unwrap(),
                segment.id().clone(),
            ],
            turn_index: 1,
            observed_at_ms: segment.observed_at_ms() + 1,
        },
        catalog,
    )
    .unwrap()
}

fn safety_provider(catalog: &IntentCatalog) -> SafetyIntentProvider {
    SafetyIntentProvider::try_new(
        SafetyIntentRuleSetInput {
            agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
            intent_catalog_revision_id: catalog.id().clone(),
            rules: vec![SafetyIntentRuleInput {
                rule_id: "stop-calling-zh".to_owned(),
                intent_code: "safety.stop_calling".to_owned(),
                priority: 1,
                confidence_bps: 9_800,
                match_kind: SafetyIntentMatchKind::Phrase,
                phrases: vec!["别再给我打电话".to_owned()],
            }],
        },
        catalog,
    )
    .unwrap()
}

fn fast_provider(
    catalog: &IntentCatalog,
    port: FakeClassifier,
) -> FastIntentClassifierProvider<FakeClassifier> {
    FastIntentClassifierProvider::try_new(
        FastIntentClassifierArtifactInput {
            agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
            intent_catalog_revision_id: catalog.id().clone(),
            model_sha256: "1".repeat(64),
            tokenizer_sha256: "2".repeat(64),
            label_map_sha256: "3".repeat(64),
            calibration_sha256: "4".repeat(64),
            supported_languages: vec!["zh-CN".to_owned()],
            max_input_bytes: 4_096,
            max_candidates: 5,
            inference_deadline_ms: 100,
        },
        catalog,
        port,
    )
    .unwrap()
}

fn initial(catalog: &IntentCatalog) -> IntentState {
    IntentState::new(context(), catalog.id().clone())
}

fn policy() -> IntentDecisionPolicy {
    IntentDecisionPolicy::try_new(5_500, 8_500, 2_000, 9_500).unwrap()
}

fn catalog() -> IntentCatalog {
    IntentCatalog::try_new(IntentCatalogInput {
        id: IntentCatalogRevisionId::parse("intent-catalog-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        definitions: vec![
            definition("safety", None, false),
            definition("safety.stop_calling", Some("safety"), true),
            definition("sales", None, false),
            definition("sales.interested", Some("sales"), false),
            definition("callback", None, false),
            definition("callback.later", Some("callback"), false),
        ],
    })
    .unwrap()
}

fn definition(
    code: &str,
    parent_code: Option<&str>,
    safety_critical: bool,
) -> IntentDefinitionInput {
    IntentDefinitionInput {
        code: code.to_owned(),
        parent_code: parent_code.map(str::to_owned),
        slot_keys: Vec::new(),
        safety_critical,
    }
}

fn segment(text: &str) -> TranscriptSegment {
    TranscriptSegment::try_new(segment_input(text)).unwrap()
}

fn segment_input(text: &str) -> TranscriptSegmentInput {
    TranscriptSegmentInput {
        id: TranscriptSegmentId::parse("segment-customer").unwrap(),
        context: context(),
        source_event_id: EventId::parse("event-customer").unwrap(),
        sequence: 1,
        speaker: TranscriptSpeaker::Customer,
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
