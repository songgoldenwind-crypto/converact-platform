use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicUsize, Ordering},
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
    EnvelopeContextInput, ExecutionGeneration, IntentCatalogRevisionId, IntentObservationId,
    InteractionId, TranscriptSegmentId, VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    UnderstandingAppendDecision, UnderstandingDurabilityPort, UnderstandingPortError,
    UnderstandingRecoveryInputs, UnderstandingRuntime, UnderstandingTurnWriteInput,
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
    EmotionObservation::try_new(
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
            audio_evidence_window_ids: vec![
                AudioEvidenceWindowId::parse("audio-window-001").unwrap(),
            ],
            turn_index: 1,
            observed_at_ms: 1_000,
        },
        catalog,
    )
    .unwrap()
}

fn intent_catalog() -> IntentCatalog {
    IntentCatalog::try_new(IntentCatalogInput {
        id: IntentCatalogRevisionId::parse("intent-catalog-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        definitions: vec![IntentDefinitionInput {
            code: "sales.interested".to_owned(),
            parent_code: None,
            slot_keys: Vec::new(),
            safety_critical: false,
        }],
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
