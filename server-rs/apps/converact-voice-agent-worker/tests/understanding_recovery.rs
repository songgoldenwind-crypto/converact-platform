use std::{
    collections::BTreeMap,
    future,
    sync::atomic::{AtomicUsize, Ordering},
};

use converact_conversation_result_core::{
    TranscriptSegment, TranscriptSegmentInput, TranscriptSpeaker,
};
use converact_conversation_understanding_core::{
    CustomerStateInput, CustomerStateSnapshot, DialoguePolicy, EmotionCandidateInput,
    EmotionCatalog, EmotionCatalogInput, EmotionCheckpoint, EmotionDecisionPolicy,
    EmotionDefinitionInput, EmotionFusion, EmotionFusionInput, EmotionObservation,
    EmotionObservationInput, EmotionSource, EmotionState, EmotionValence, IntentCandidateInput,
    IntentCatalog, IntentCatalogInput, IntentCheckpoint, IntentDecisionPolicy,
    IntentDefinitionInput, IntentObservation, IntentObservationInput, IntentSource, IntentState,
};
use converact_conversation_understanding_store::{
    StoredUnderstandingHead, UnderstandingHead, UnderstandingHeadInput, UnderstandingRecord,
    UnderstandingTurnBatch, encode_customer_state_snapshot, encode_dialogue_recommendation,
    encode_emotion_checkpoint, encode_intent_checkpoint,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, AudioEvidenceWindowId, CallAttemptId, CampaignContactId, CampaignId,
    CustomerStateSnapshotId, DialoguePolicyRevisionId, DialogueRecommendationId,
    EmotionCatalogRevisionId, EmotionFusionId, EmotionObservationId, EnvelopeContext,
    EnvelopeContextInput, EventId, ExecutionGeneration, IntentCatalogRevisionId,
    IntentObservationId, InteractionId, TranscriptSegmentId, VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    AcousticEmotionCandidateOutput, AcousticEmotionClassifierArtifactInput,
    AcousticEmotionClassifierOutput, AcousticEmotionClassifierPort,
    AcousticEmotionClassifierPortError, AcousticEmotionClassifierProvider,
    AcousticEmotionClassifierRequest, AcousticEmotionFailurePolicy, AdaptiveEmotionTurnRuntime,
    AdaptiveEmotionTurnRuntimeError, AudioEvidenceWindow, AudioEvidenceWindowInput,
    CompleteUnderstandingTurnInput, ContextualIntentArtifactInput,
    ContextualIntentClassifierOutput, ContextualIntentClassifierPort,
    ContextualIntentClassifierPortError, ContextualIntentClassifierProvider,
    ContextualIntentClassifierRequest, FastIntentClassifierArtifactInput,
    FastIntentClassifierOutput, FastIntentClassifierPort, FastIntentClassifierPortError,
    FastIntentClassifierProvider, FastIntentClassifierRequest, FinalTranscriptUnderstandingInput,
    FinalTranscriptUnderstandingOutcome, IntentConfidenceRouter, IntentTurnRoute,
    MultimodalEmotionFusionPolicy, MultimodalFinalTranscriptUnderstandingInput,
    SafetyIntentMatchKind, SafetyIntentProvider, SafetyIntentRuleInput, SafetyIntentRuleSetInput,
    TextEmotionCandidateOutput, TextEmotionClassifierArtifactInput, TextEmotionClassifierOutput,
    TextEmotionClassifierPort, TextEmotionClassifierPortError, TextEmotionClassifierProvider,
    TextEmotionClassifierRequest, TextEmotionTurnRuntime, TranscriptUnderstandingDisposition,
    UnderstandingAppendDecision, UnderstandingDurabilityPort, UnderstandingPortError,
    UnderstandingRecoveryInputs, UnderstandingRuntime, UnderstandingTurnWriteInput,
    process_final_transcript_understanding, process_final_transcript_understanding_multimodal,
};

struct FakeDurability {
    heads: Vec<StoredUnderstandingHead>,
    loads: AtomicUsize,
    appends: AtomicUsize,
}

impl UnderstandingDurabilityPort for FakeDurability {
    async fn load_consistent_heads(
        &self,
        _context: &EnvelopeContext,
    ) -> Result<Vec<StoredUnderstandingHead>, UnderstandingPortError> {
        self.loads.fetch_add(1, Ordering::Relaxed);
        Ok(self.heads.clone())
    }

    async fn append_turn(
        &self,
        _batch: &UnderstandingTurnBatch,
    ) -> Result<UnderstandingAppendDecision, UnderstandingPortError> {
        self.appends.fetch_add(1, Ordering::Relaxed);
        Ok(UnderstandingAppendDecision::Replayed)
    }
}

#[tokio::test]
async fn one_consistent_read_restores_the_complete_dependency_graph() {
    let fixture = fixture();
    let durability = FakeDurability {
        heads: fixture.heads.clone(),
        loads: AtomicUsize::new(0),
        appends: AtomicUsize::new(0),
    };
    let runtime = UnderstandingRuntime::new(&durability);

    let restored = runtime
        .recover(
            &fixture.context,
            UnderstandingRecoveryInputs {
                intent_catalog: &fixture.intent_catalog,
                emotion_catalog: &fixture.emotion_catalog,
                dialogue_policy: &fixture.dialogue_policy,
            },
        )
        .await
        .unwrap();

    assert_eq!(durability.loads.load(Ordering::Relaxed), 1);
    assert!(!restored.is_empty());
    assert_eq!(
        restored
            .intent_checkpoint()
            .unwrap()
            .state()
            .confirmed_intent(),
        Some("sales.interested")
    );
    assert_eq!(
        restored.customer_state().unwrap().confirmed_intent(),
        Some("sales.interested")
    );
    assert_eq!(restored.intent_head().unwrap().head().revision(), 1);
    assert_eq!(
        restored.dialogue().unwrap().record_id(),
        "dialogue-recommendation-001"
    );

    let batch = restored
        .prepare_turn(UnderstandingTurnWriteInput {
            intent_checkpoint: &fixture.intent_checkpoint,
            emotion_checkpoint: &fixture.emotion_checkpoint,
            customer_state: &fixture.customer_state,
            dialogue: &fixture.dialogue,
            dialogue_policy: &fixture.dialogue_policy,
            retention_policy_ref: "understanding-30-days-v1",
            retention_until_ms: 2_592_002_000,
        })
        .unwrap();
    for command in batch.commands() {
        let expectation = command.head_expectation().unwrap();
        assert_eq!(expectation.expected_revision(), 1);
        assert!(expectation.expected_record_id().is_some());
        assert!(expectation.expected_payload_hash().is_some());
    }
    assert_eq!(
        runtime.persist_turn(&batch).await.unwrap(),
        UnderstandingAppendDecision::Replayed
    );
    assert_eq!(durability.appends.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn one_consistent_empty_read_is_a_valid_new_conversation() {
    let fixture = fixture();
    let durability = FakeDurability {
        heads: Vec::new(),
        loads: AtomicUsize::new(0),
        appends: AtomicUsize::new(0),
    };

    let restored = UnderstandingRuntime::new(&durability)
        .recover(
            &fixture.context,
            UnderstandingRecoveryInputs {
                intent_catalog: &fixture.intent_catalog,
                emotion_catalog: &fixture.emotion_catalog,
                dialogue_policy: &fixture.dialogue_policy,
            },
        )
        .await
        .unwrap();

    assert!(restored.is_empty());
    assert_eq!(durability.loads.load(Ordering::Relaxed), 1);

    let batch = restored
        .prepare_turn(UnderstandingTurnWriteInput {
            intent_checkpoint: &fixture.intent_checkpoint,
            emotion_checkpoint: &fixture.emotion_checkpoint,
            customer_state: &fixture.customer_state,
            dialogue: &fixture.dialogue,
            dialogue_policy: &fixture.dialogue_policy,
            retention_policy_ref: "understanding-30-days-v1",
            retention_until_ms: 2_592_002_000,
        })
        .unwrap();
    assert!(batch.commands().iter().all(|command| {
        command
            .head_expectation()
            .is_some_and(|expectation| expectation.expected_revision() == 0)
    }));
}

#[tokio::test]
async fn one_resolved_turn_builds_raw_evidence_and_four_heads_atomically() {
    let fixture = fixture();
    let durability = FakeDurability {
        heads: Vec::new(),
        loads: AtomicUsize::new(0),
        appends: AtomicUsize::new(0),
    };
    let recovered = UnderstandingRuntime::new(&durability)
        .recover(
            &fixture.context,
            UnderstandingRecoveryInputs {
                intent_catalog: &fixture.intent_catalog,
                emotion_catalog: &fixture.emotion_catalog,
                dialogue_policy: &fixture.dialogue_policy,
            },
        )
        .await
        .unwrap();
    let segment = final_customer_segment("别再给我打电话了");
    let safety = safety_provider(&fixture.intent_catalog);
    let fast = never_fast_provider(&fixture.intent_catalog);
    let IntentTurnRoute::Resolved(intent_resolution) = IntentConfidenceRouter::new(&safety, &fast)
        .route(
            &segment,
            1,
            &IntentState::new(fixture.context.clone(), fixture.intent_catalog.id().clone()),
            IntentDecisionPolicy::try_new(5_500, 8_000, 1_500, 9_500).unwrap(),
        )
        .await
        .unwrap()
        .unwrap()
    else {
        panic!("safety turn must resolve without Fast inference");
    };
    let text_observation = EmotionObservation::try_new(
        EmotionObservationInput {
            audio_evidence_window_ids: Vec::new(),
            ..emotion_observation_input(&fixture.emotion_catalog, EmotionSource::TextClassifier)
        },
        &fixture.emotion_catalog,
    )
    .unwrap();
    let emotion_resolution = TextEmotionTurnRuntime::new(
        &fixture.emotion_catalog,
        EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap(),
    )
    .resolve(
        text_observation,
        &EmotionState::new(
            fixture.context.clone(),
            fixture.emotion_catalog.id().clone(),
        ),
    )
    .unwrap();

    let prepared = recovered
        .prepare_complete_turn(CompleteUnderstandingTurnInput {
            intent_resolution: &intent_resolution,
            emotion_resolution: &emotion_resolution,
            dialogue_policy: &fixture.dialogue_policy,
            retention_policy_ref: "understanding-30-days-v1",
            retention_until_ms: 2_592_003_000,
        })
        .unwrap();

    let batch = prepared.batch();
    assert_eq!(batch.evidence_commands().len(), 3);
    assert_eq!(
        batch.evidence_commands()[0].record().kind(),
        converact_conversation_understanding_store::UnderstandingRecordKind::IntentProviderObservation
    );
    assert_eq!(
        batch.evidence_commands()[1].record().kind(),
        converact_conversation_understanding_store::UnderstandingRecordKind::IntentResolutionEvidence
    );
    assert_eq!(
        batch.evidence_commands()[2].record().kind(),
        converact_conversation_understanding_store::UnderstandingRecordKind::EmotionObservation
    );
    assert_eq!(batch.commands().len(), 4);
    assert_eq!(
        prepared.dialogue().kind(),
        converact_conversation_understanding_core::DialogueRecommendationKind::ContinueWorkflow
    );
    let replay = recovered
        .prepare_complete_turn(CompleteUnderstandingTurnInput {
            intent_resolution: &intent_resolution,
            emotion_resolution: &emotion_resolution,
            dialogue_policy: &fixture.dialogue_policy,
            retention_policy_ref: "understanding-30-days-v1",
            retention_until_ms: 2_592_003_000,
        })
        .unwrap();
    assert_eq!(replay.batch(), prepared.batch());
    assert_eq!(replay.customer_state(), prepared.customer_state());
    assert_eq!(replay.dialogue(), prepared.dialogue());
}

#[tokio::test]
async fn appended_final_transcript_runs_complete_understanding_while_replay_skips_models() {
    let fixture = fixture();
    let durability = FakeDurability {
        heads: Vec::new(),
        loads: AtomicUsize::new(0),
        appends: AtomicUsize::new(0),
    };
    let safety = safety_provider(&fixture.intent_catalog);
    let fast = never_fast_provider(&fixture.intent_catalog);
    let contextual = never_contextual_provider(&fixture.intent_catalog);
    let text_calls = AtomicUsize::new(0);
    let text_emotion = text_emotion_provider(&fixture.emotion_catalog, &text_calls);
    let history = vec![final_customer_segment("别再给我打电话了")];

    let outcome = process_final_transcript_understanding(FinalTranscriptUnderstandingInput {
        disposition: TranscriptUnderstandingDisposition::AppendedCurrent,
        history: &history,
        durability: &durability,
        safety: &safety,
        fast: &fast,
        contextual: &contextual,
        text_emotion: &text_emotion,
        intent_catalog: &fixture.intent_catalog,
        emotion_catalog: &fixture.emotion_catalog,
        intent_policy: IntentDecisionPolicy::try_new(5_500, 8_000, 1_500, 9_500).unwrap(),
        emotion_policy: EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap(),
        contextual_failure_policy:
            converact_voice_agent_worker::ContextualFailurePolicy::FailClosed,
        dialogue_policy: &fixture.dialogue_policy,
        retention_policy_ref: "understanding-30-days-v1",
        retention_until_ms: 2_592_003_000,
    })
    .await
    .unwrap();
    let FinalTranscriptUnderstandingOutcome::Persisted(processed) = outcome else {
        panic!("new current final transcript must persist one turn");
    };
    assert_eq!(processed.turn_index(), 1);
    assert_eq!(processed.decision(), UnderstandingAppendDecision::Replayed);
    assert_eq!(durability.loads.load(Ordering::Relaxed), 1);
    assert_eq!(durability.appends.load(Ordering::Relaxed), 1);
    assert_eq!(text_calls.load(Ordering::Relaxed), 1);

    let replay = process_final_transcript_understanding(FinalTranscriptUnderstandingInput {
        disposition: TranscriptUnderstandingDisposition::ReplayedCurrent,
        history: &history,
        durability: &durability,
        safety: &safety,
        fast: &fast,
        contextual: &contextual,
        text_emotion: &text_emotion,
        intent_catalog: &fixture.intent_catalog,
        emotion_catalog: &fixture.emotion_catalog,
        intent_policy: IntentDecisionPolicy::try_new(5_500, 8_000, 1_500, 9_500).unwrap(),
        emotion_policy: EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap(),
        contextual_failure_policy:
            converact_voice_agent_worker::ContextualFailurePolicy::FailClosed,
        dialogue_policy: &fixture.dialogue_policy,
        retention_policy_ref: "understanding-30-days-v1",
        retention_until_ms: 2_592_003_000,
    })
    .await
    .unwrap();
    assert_eq!(replay, FinalTranscriptUnderstandingOutcome::SkippedReplay);
    assert_eq!(durability.loads.load(Ordering::Relaxed), 1);
    assert_eq!(durability.appends.load(Ordering::Relaxed), 1);
    assert_eq!(text_calls.load(Ordering::Relaxed), 1);

    let historical = process_final_transcript_understanding(FinalTranscriptUnderstandingInput {
        disposition: TranscriptUnderstandingDisposition::Historical,
        history: &history,
        durability: &durability,
        safety: &safety,
        fast: &fast,
        contextual: &contextual,
        text_emotion: &text_emotion,
        intent_catalog: &fixture.intent_catalog,
        emotion_catalog: &fixture.emotion_catalog,
        intent_policy: IntentDecisionPolicy::try_new(5_500, 8_000, 1_500, 9_500).unwrap(),
        emotion_policy: EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap(),
        contextual_failure_policy:
            converact_voice_agent_worker::ContextualFailurePolicy::FailClosed,
        dialogue_policy: &fixture.dialogue_policy,
        retention_policy_ref: "understanding-30-days-v1",
        retention_until_ms: 2_592_003_000,
    })
    .await
    .unwrap();
    assert_eq!(
        historical,
        FinalTranscriptUnderstandingOutcome::SkippedHistorical
    );
    assert_eq!(durability.loads.load(Ordering::Relaxed), 1);
    assert_eq!(durability.appends.load(Ordering::Relaxed), 1);
    assert_eq!(text_calls.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn adaptive_emotion_uses_multimodal_evidence_and_audits_safe_fallbacks() {
    let fixture = fixture();
    let segment = final_customer_segment("这个问题怎么还没解决");
    let text_calls = AtomicUsize::new(0);
    let acoustic_calls = AtomicUsize::new(0);
    let text = text_emotion_provider(&fixture.emotion_catalog, &text_calls);
    let acoustic = acoustic_emotion_provider(
        &fixture.emotion_catalog,
        &acoustic_calls,
        AcousticMode::Output,
    );
    let runtime = AdaptiveEmotionTurnRuntime::new(
        &text,
        &acoustic,
        &fixture.emotion_catalog,
        EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap(),
        MultimodalEmotionFusionPolicy::try_new(6_000, 4_000, 1_000, 5).unwrap(),
        AcousticEmotionFailurePolicy::FallbackTextOnMissingOrTransient,
    );
    let previous = EmotionState::new(context(), fixture.emotion_catalog.id().clone());

    let missing = runtime.resolve(&segment, None, 1, &previous).await.unwrap();
    assert_eq!(missing.contributor_count(), 1);
    assert_eq!(
        missing.checkpoint().to_value()["fusion"]["fusion_revision"],
        "text-only-emotion.acoustic-evidence-missing-fallback-v1"
    );
    assert_eq!(acoustic_calls.load(Ordering::Relaxed), 0);

    let window = audio_evidence_window(&segment);
    let multimodal = runtime
        .resolve(&segment, Some(&window), 1, &previous)
        .await
        .unwrap();
    assert_eq!(multimodal.contributor_count(), 2);
    assert_eq!(acoustic_calls.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn adaptive_emotion_audits_transient_fallbacks_and_enforces_required_mode() {
    let fixture = fixture();
    let segment = final_customer_segment("这个问题怎么还没解决");
    let window = audio_evidence_window(&segment);
    let previous = EmotionState::new(context(), fixture.emotion_catalog.id().clone());
    let text_calls = AtomicUsize::new(0);
    let acoustic_calls = AtomicUsize::new(0);
    let text = text_emotion_provider(&fixture.emotion_catalog, &text_calls);
    let unavailable = acoustic_emotion_provider(
        &fixture.emotion_catalog,
        &acoustic_calls,
        AcousticMode::Unavailable,
    );
    let fallback_runtime = AdaptiveEmotionTurnRuntime::new(
        &text,
        &unavailable,
        &fixture.emotion_catalog,
        EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap(),
        MultimodalEmotionFusionPolicy::try_new(6_000, 4_000, 1_000, 5).unwrap(),
        AcousticEmotionFailurePolicy::FallbackTextOnMissingOrTransient,
    );
    let fallback = fallback_runtime
        .resolve(&segment, Some(&window), 1, &previous)
        .await
        .unwrap();
    assert_eq!(fallback.contributor_count(), 1);
    assert_eq!(
        fallback.checkpoint().to_value()["fusion"]["fusion_revision"],
        "text-only-emotion.acoustic-unavailable-fallback-v1"
    );

    let timeout = acoustic_emotion_provider(
        &fixture.emotion_catalog,
        &acoustic_calls,
        AcousticMode::Pending,
    );
    let timeout_runtime = AdaptiveEmotionTurnRuntime::new(
        &text,
        &timeout,
        &fixture.emotion_catalog,
        EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap(),
        MultimodalEmotionFusionPolicy::try_new(6_000, 4_000, 1_000, 5).unwrap(),
        AcousticEmotionFailurePolicy::FallbackTextOnMissingOrTransient,
    );
    let timed_out = timeout_runtime
        .resolve(&segment, Some(&window), 1, &previous)
        .await
        .unwrap();
    assert_eq!(
        timed_out.checkpoint().to_value()["fusion"]["fusion_revision"],
        "text-only-emotion.acoustic-timeout-fallback-v1"
    );

    let acoustic = acoustic_emotion_provider(
        &fixture.emotion_catalog,
        &acoustic_calls,
        AcousticMode::Output,
    );
    let required_runtime = AdaptiveEmotionTurnRuntime::new(
        &text,
        &acoustic,
        &fixture.emotion_catalog,
        EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap(),
        MultimodalEmotionFusionPolicy::try_new(6_000, 4_000, 1_000, 5).unwrap(),
        AcousticEmotionFailurePolicy::RequireMultimodal,
    );
    let text_calls_before_required = text_calls.load(Ordering::Relaxed);
    assert_eq!(
        required_runtime
            .resolve(&segment, None, 1, &previous)
            .await
            .unwrap_err(),
        AdaptiveEmotionTurnRuntimeError::AcousticEvidenceRequired
    );
    assert_eq!(
        text_calls.load(Ordering::Relaxed),
        text_calls_before_required
    );
}

#[tokio::test]
async fn final_transcript_processor_atomically_persists_multimodal_emotion_evidence() {
    let fixture = fixture();
    let durability = FakeDurability {
        heads: Vec::new(),
        loads: AtomicUsize::new(0),
        appends: AtomicUsize::new(0),
    };
    let safety = safety_provider(&fixture.intent_catalog);
    let fast = never_fast_provider(&fixture.intent_catalog);
    let contextual = never_contextual_provider(&fixture.intent_catalog);
    let text_calls = AtomicUsize::new(0);
    let acoustic_calls = AtomicUsize::new(0);
    let text = text_emotion_provider(&fixture.emotion_catalog, &text_calls);
    let acoustic = acoustic_emotion_provider(
        &fixture.emotion_catalog,
        &acoustic_calls,
        AcousticMode::Output,
    );
    let history = vec![final_customer_segment("别再给我打电话了")];
    let window = audio_evidence_window(&history[0]);

    let outcome = process_final_transcript_understanding_multimodal(
        MultimodalFinalTranscriptUnderstandingInput {
            base: FinalTranscriptUnderstandingInput {
                disposition: TranscriptUnderstandingDisposition::AppendedCurrent,
                history: &history,
                durability: &durability,
                safety: &safety,
                fast: &fast,
                contextual: &contextual,
                text_emotion: &text,
                intent_catalog: &fixture.intent_catalog,
                emotion_catalog: &fixture.emotion_catalog,
                intent_policy: IntentDecisionPolicy::try_new(5_500, 8_000, 1_500, 9_500).unwrap(),
                emotion_policy: EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap(),
                contextual_failure_policy:
                    converact_voice_agent_worker::ContextualFailurePolicy::FailClosed,
                dialogue_policy: &fixture.dialogue_policy,
                retention_policy_ref: "understanding-30-days-v1",
                retention_until_ms: 2_592_003_000,
            },
            acoustic_emotion: &acoustic,
            audio_evidence_window: Some(&window),
            fusion_policy: MultimodalEmotionFusionPolicy::try_new(6_000, 4_000, 1_000, 5).unwrap(),
            acoustic_failure_policy: AcousticEmotionFailurePolicy::FallbackTextOnMissingOrTransient,
        },
    )
    .await
    .unwrap();

    let FinalTranscriptUnderstandingOutcome::Persisted(processed) = outcome else {
        panic!("current final transcript must persist");
    };
    let batch = processed.prepared().batch();
    let emotion_evidence_count = batch
        .evidence_commands()
        .iter()
        .filter(|command| {
            command.record().kind()
                == converact_conversation_understanding_store::UnderstandingRecordKind::EmotionObservation
        })
        .count();
    assert_eq!(emotion_evidence_count, 2);
    assert_eq!(
        batch.commands()[1].record().payload()["fusion"]["contributor_hashes"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(durability.appends.load(Ordering::Relaxed), 1);
    assert_eq!(text_calls.load(Ordering::Relaxed), 1);
    assert_eq!(acoustic_calls.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn a_partial_or_duplicate_dependency_graph_fails_closed() {
    let fixture = fixture();
    let intent = fixture.heads[0].clone();
    let partial = FakeDurability {
        heads: vec![intent.clone()],
        loads: AtomicUsize::new(0),
        appends: AtomicUsize::new(0),
    };
    let duplicate = FakeDurability {
        heads: vec![intent.clone(), intent],
        loads: AtomicUsize::new(0),
        appends: AtomicUsize::new(0),
    };
    let inputs = || UnderstandingRecoveryInputs {
        intent_catalog: &fixture.intent_catalog,
        emotion_catalog: &fixture.emotion_catalog,
        dialogue_policy: &fixture.dialogue_policy,
    };

    assert_eq!(
        UnderstandingRuntime::new(&partial)
            .recover(&fixture.context, inputs())
            .await
            .unwrap_err()
            .code(),
        "understanding_recovery_dependency_incomplete"
    );
    assert_eq!(
        UnderstandingRuntime::new(&duplicate)
            .recover(&fixture.context, inputs())
            .await
            .unwrap_err()
            .code(),
        "understanding_recovery_snapshot_invalid"
    );
}

#[tokio::test]
async fn a_different_policy_cannot_recover_a_stored_dialogue_decision() {
    let fixture = fixture();
    let durability = FakeDurability {
        heads: fixture.heads,
        loads: AtomicUsize::new(0),
        appends: AtomicUsize::new(0),
    };
    let different_policy = DialoguePolicy::try_new(
        DialoguePolicyRevisionId::parse("dialogue-policy-002").unwrap(),
        AgentReleaseId::parse("release-001").unwrap(),
        3,
        4,
    )
    .unwrap();

    assert_eq!(
        UnderstandingRuntime::new(&durability)
            .recover(
                &fixture.context,
                UnderstandingRecoveryInputs {
                    intent_catalog: &fixture.intent_catalog,
                    emotion_catalog: &fixture.emotion_catalog,
                    dialogue_policy: &different_policy,
                },
            )
            .await
            .unwrap_err()
            .code(),
        "understanding_recovery_checkpoint_invalid"
    );
}

struct Fixture {
    context: EnvelopeContext,
    intent_catalog: IntentCatalog,
    emotion_catalog: EmotionCatalog,
    dialogue_policy: DialoguePolicy,
    intent_checkpoint: IntentCheckpoint,
    emotion_checkpoint: EmotionCheckpoint,
    customer_state: CustomerStateSnapshot,
    dialogue: converact_conversation_understanding_core::DialogueRecommendation,
    heads: Vec<StoredUnderstandingHead>,
}

fn fixture() -> Fixture {
    let context = context();
    let intent_catalog = intent_catalog();
    let emotion_catalog = emotion_catalog();
    let intent_observation = intent_observation(&intent_catalog);
    let intent_state = IntentState::new(context.clone(), intent_catalog.id().clone())
        .observe(
            &intent_observation,
            &intent_catalog,
            IntentDecisionPolicy::try_new(5_500, 8_000, 1_500, 9_500).unwrap(),
        )
        .unwrap();
    let intent_checkpoint =
        IntentCheckpoint::try_new(intent_observation, intent_state.clone()).unwrap();
    let emotion_checkpoint = emotion_checkpoint(&emotion_catalog);
    let customer_state = CustomerStateSnapshot::try_new(
        CustomerStateInput {
            id: CustomerStateSnapshotId::parse("customer-state-001").unwrap(),
            observed_at_ms: 1_100,
        },
        &intent_state,
        emotion_checkpoint.state(),
    )
    .unwrap();
    let dialogue_policy = DialoguePolicy::try_new(
        DialoguePolicyRevisionId::parse("dialogue-policy-001").unwrap(),
        AgentReleaseId::parse("release-001").unwrap(),
        2,
        3,
    )
    .unwrap();
    let dialogue = dialogue_policy
        .evaluate(
            DialogueRecommendationId::parse("dialogue-recommendation-001").unwrap(),
            &customer_state,
            1_200,
        )
        .unwrap();
    let retention = "understanding-30-days-v1";
    let heads = vec![
        stored(encode_intent_checkpoint(&intent_checkpoint, retention, 2_592_001_000).unwrap()),
        stored(encode_emotion_checkpoint(&emotion_checkpoint, retention, 2_592_001_050).unwrap()),
        stored(encode_customer_state_snapshot(&customer_state, retention, 2_592_001_100).unwrap()),
        stored(
            encode_dialogue_recommendation(&dialogue, &customer_state, retention, 2_592_001_200)
                .unwrap(),
        ),
    ];
    Fixture {
        context,
        intent_catalog,
        emotion_catalog,
        dialogue_policy,
        intent_checkpoint,
        emotion_checkpoint,
        customer_state,
        dialogue,
        heads,
    }
}

fn stored(record: UnderstandingRecord) -> StoredUnderstandingHead {
    let head = UnderstandingHead::try_new(UnderstandingHeadInput {
        context: record.context().clone(),
        kind: record.kind(),
        revision: 1,
        record_id: record.record_id().to_owned(),
        payload_hash: record.payload_hash().to_owned(),
        turn_index: record.turn_index(),
        observed_at_ms: record.observed_at_ms(),
    })
    .unwrap();
    StoredUnderstandingHead::try_new(head, record).unwrap()
}

fn intent_observation(catalog: &IntentCatalog) -> IntentObservation {
    IntentObservation::try_new(
        IntentObservationInput {
            id: IntentObservationId::parse("intent-observation-001").unwrap(),
            context: context(),
            catalog_revision_id: catalog.id().clone(),
            source: IntentSource::FastClassifier,
            provider_revision: "intent-fast-v1".to_owned(),
            candidates: vec![IntentCandidateInput {
                code: "sales.interested".to_owned(),
                confidence_bps: 9_100,
            }],
            slots: BTreeMap::new(),
            evidence_segment_ids: vec![TranscriptSegmentId::parse("segment-001").unwrap()],
            turn_index: 1,
            observed_at_ms: 1_000,
        },
        catalog,
    )
    .unwrap()
}

fn emotion_checkpoint(catalog: &EmotionCatalog) -> EmotionCheckpoint {
    let observations = vec![
        emotion_observation(catalog, EmotionSource::AcousticModel),
        emotion_observation(catalog, EmotionSource::TextClassifier),
    ];
    let fusion = EmotionFusion::try_new(
        EmotionFusionInput {
            id: EmotionFusionId::parse("emotion-fusion-001").unwrap(),
            context: context(),
            catalog_revision_id: catalog.id().clone(),
            fusion_revision: "weighted-fusion-v1".to_owned(),
            candidates: vec![EmotionCandidateInput {
                code: "customer.angry".to_owned(),
                confidence_bps: 9_000,
                intensity: 4,
            }],
            turn_index: 1,
            observed_at_ms: 1_050,
        },
        &observations,
        catalog,
    )
    .unwrap();
    let state = EmotionState::new(context(), catalog.id().clone())
        .observe(
            &fusion,
            catalog,
            EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap(),
        )
        .unwrap();
    EmotionCheckpoint::try_new(fusion, state).unwrap()
}

fn emotion_observation(catalog: &EmotionCatalog, source: EmotionSource) -> EmotionObservation {
    EmotionObservation::try_new(emotion_observation_input(catalog, source), catalog).unwrap()
}

fn emotion_observation_input(
    catalog: &EmotionCatalog,
    source: EmotionSource,
) -> EmotionObservationInput {
    EmotionObservationInput {
        id: EmotionObservationId::parse(format!("emotion-observation-{source:?}")).unwrap(),
        context: context(),
        catalog_revision_id: catalog.id().clone(),
        source,
        provider_revision: "emotion-provider-v1".to_owned(),
        candidates: vec![EmotionCandidateInput {
            code: "customer.angry".to_owned(),
            confidence_bps: 8_700,
            intensity: 4,
        }],
        transcript_segment_ids: vec![TranscriptSegmentId::parse("segment-001").unwrap()],
        audio_evidence_window_ids: vec![AudioEvidenceWindowId::parse("audio-window-001").unwrap()],
        turn_index: 1,
        observed_at_ms: 1_000,
    }
}

fn intent_catalog() -> IntentCatalog {
    IntentCatalog::try_new(IntentCatalogInput {
        id: IntentCatalogRevisionId::parse("intent-catalog-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        definitions: vec![
            IntentDefinitionInput {
                code: "sales.interested".to_owned(),
                parent_code: None,
                slot_keys: Vec::new(),
                safety_critical: false,
            },
            IntentDefinitionInput {
                code: "safety.stop_calling".to_owned(),
                parent_code: None,
                slot_keys: Vec::new(),
                safety_critical: true,
            },
        ],
    })
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

struct NeverFast;

impl FastIntentClassifierPort for NeverFast {
    async fn classify<'a>(
        &'a self,
        _request: FastIntentClassifierRequest<'a>,
    ) -> Result<FastIntentClassifierOutput, FastIntentClassifierPortError> {
        panic!("Safety must short-circuit Fast inference")
    }
}

fn never_fast_provider(catalog: &IntentCatalog) -> FastIntentClassifierProvider<NeverFast> {
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
        NeverFast,
    )
    .unwrap()
}

struct NeverContextual;

impl ContextualIntentClassifierPort for NeverContextual {
    async fn classify<'a>(
        &'a self,
        _request: ContextualIntentClassifierRequest<'a>,
    ) -> Result<ContextualIntentClassifierOutput, ContextualIntentClassifierPortError> {
        panic!("Safety must short-circuit Contextual inference")
    }
}

fn never_contextual_provider(
    catalog: &IntentCatalog,
) -> ContextualIntentClassifierProvider<NeverContextual> {
    ContextualIntentClassifierProvider::try_new(
        ContextualIntentArtifactInput {
            agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
            intent_catalog_revision_id: catalog.id().clone(),
            model_profile_sha256: "5".repeat(64),
            prompt_template_sha256: "6".repeat(64),
            label_map_sha256: "7".repeat(64),
            output_schema_sha256: "8".repeat(64),
            calibration_sha256: "9".repeat(64),
            supported_languages: vec!["zh-CN".to_owned()],
            max_context_segments: 16,
            max_context_bytes: 32_768,
            max_candidates: 5,
            max_slots: 16,
            inference_deadline_ms: 100,
        },
        catalog,
        NeverContextual,
    )
    .unwrap()
}

struct FixedTextEmotion<'a> {
    calls: &'a AtomicUsize,
}

impl TextEmotionClassifierPort for FixedTextEmotion<'_> {
    async fn classify<'a>(
        &'a self,
        request: TextEmotionClassifierRequest<'a>,
    ) -> Result<TextEmotionClassifierOutput, TextEmotionClassifierPortError> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Ok(TextEmotionClassifierOutput {
            served_artifact_revision: request.artifact_revision().to_owned(),
            candidates: vec![TextEmotionCandidateOutput {
                code: "customer.angry".to_owned(),
                confidence_bps: 8_700,
                intensity: 4,
            }],
        })
    }
}

fn text_emotion_provider<'a>(
    catalog: &EmotionCatalog,
    calls: &'a AtomicUsize,
) -> TextEmotionClassifierProvider<FixedTextEmotion<'a>> {
    TextEmotionClassifierProvider::try_new(
        TextEmotionClassifierArtifactInput {
            agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
            emotion_catalog_revision_id: catalog.id().clone(),
            model_sha256: "a".repeat(64),
            tokenizer_sha256: "b".repeat(64),
            label_map_sha256: "c".repeat(64),
            calibration_sha256: "d".repeat(64),
            supported_languages: vec!["zh-CN".to_owned()],
            max_input_bytes: 4_096,
            max_candidates: 5,
            inference_deadline_ms: 100,
        },
        catalog,
        FixedTextEmotion { calls },
    )
    .unwrap()
}

#[derive(Clone, Copy)]
enum AcousticMode {
    Output,
    Unavailable,
    Pending,
}

struct FixedAcousticEmotion<'a> {
    calls: &'a AtomicUsize,
    mode: AcousticMode,
}

impl AcousticEmotionClassifierPort for FixedAcousticEmotion<'_> {
    async fn classify<'a>(
        &'a self,
        request: AcousticEmotionClassifierRequest<'a>,
    ) -> Result<AcousticEmotionClassifierOutput, AcousticEmotionClassifierPortError> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        match self.mode {
            AcousticMode::Output => Ok(AcousticEmotionClassifierOutput {
                served_artifact_revision: request.artifact_revision().to_owned(),
                candidates: vec![AcousticEmotionCandidateOutput {
                    code: "customer.angry".to_owned(),
                    confidence_bps: 8_500,
                    intensity: 4,
                }],
            }),
            AcousticMode::Unavailable => Err(AcousticEmotionClassifierPortError::new(
                "fixture_acoustic_unavailable",
            )),
            AcousticMode::Pending => future::pending().await,
        }
    }
}

fn acoustic_emotion_provider<'a>(
    catalog: &EmotionCatalog,
    calls: &'a AtomicUsize,
    mode: AcousticMode,
) -> AcousticEmotionClassifierProvider<FixedAcousticEmotion<'a>> {
    AcousticEmotionClassifierProvider::try_new(
        AcousticEmotionClassifierArtifactInput {
            agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
            emotion_catalog_revision_id: catalog.id().clone(),
            model_sha256: "1".repeat(64),
            feature_extractor_sha256: "2".repeat(64),
            label_map_sha256: "3".repeat(64),
            calibration_sha256: "4".repeat(64),
            sample_rate_hz: 16_000,
            max_window_ms: 15_000,
            max_candidates: 5,
            inference_deadline_ms: if matches!(mode, AcousticMode::Pending) {
                1
            } else {
                100
            },
        },
        catalog,
        FixedAcousticEmotion { calls, mode },
    )
    .unwrap()
}

fn final_customer_segment(text: &str) -> TranscriptSegment {
    TranscriptSegment::try_new(TranscriptSegmentInput {
        id: TranscriptSegmentId::parse("segment-customer-final").unwrap(),
        context: context(),
        source_event_id: EventId::parse("event-customer-final").unwrap(),
        sequence: 1,
        speaker: TranscriptSpeaker::Customer,
        language: "zh-CN".to_owned(),
        text: text.to_owned(),
        start_offset_ms: 1_000,
        end_offset_ms: 2_000,
        observed_at_ms: 3_000,
        retention_policy_ref: "retention-standard-v1".to_owned(),
    })
    .unwrap()
}

fn audio_evidence_window(segment: &TranscriptSegment) -> AudioEvidenceWindow {
    AudioEvidenceWindow::try_new(AudioEvidenceWindowInput {
        segment,
        customer_track_id: "customer-track".to_owned(),
        start_offset_ms: 1_000,
        end_offset_ms: 2_000,
        pcm_s16_mono_16khz: vec![0; 16_000],
    })
    .unwrap()
}

fn emotion_catalog() -> EmotionCatalog {
    EmotionCatalog::try_new(EmotionCatalogInput {
        id: EmotionCatalogRevisionId::parse("emotion-catalog-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        definitions: vec![EmotionDefinitionInput {
            code: "customer.angry".to_owned(),
            valence: EmotionValence::Negative,
            distress_rank: 4,
        }],
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
        call_id: None,
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        channel_agent_session_id: None,
        execution_generation: ExecutionGeneration::new(1).unwrap(),
        trace_id: "trace-001".to_owned(),
    })
    .unwrap()
}
