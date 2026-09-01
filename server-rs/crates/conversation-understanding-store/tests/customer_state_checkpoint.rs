use std::collections::BTreeMap;

use converact_contracts::canonical_sha256;
use converact_conversation_understanding_core::{
    CustomerStateInput, CustomerStateSnapshot, DialoguePolicy, EmotionCandidateInput,
    EmotionCatalog, EmotionCatalogInput, EmotionDecisionPolicy, EmotionDefinitionInput,
    EmotionFusion, EmotionFusionInput, EmotionObservation, EmotionObservationInput, EmotionSource,
    EmotionState, EmotionValence, IntentCandidateInput, IntentCatalog, IntentCatalogInput,
    IntentDecisionPolicy, IntentDefinitionInput, IntentObservation, IntentObservationInput,
    IntentSource, IntentState,
};
use converact_conversation_understanding_store::{
    UnderstandingRecord, UnderstandingRecordInput, UnderstandingStoreError,
    encode_customer_state_snapshot, encode_dialogue_recommendation,
    restore_customer_state_snapshot, restore_dialogue_recommendation,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, AudioEvidenceWindowId, CallAttemptId, CampaignContactId, CampaignId,
    CustomerStateSnapshotId, DialoguePolicyRevisionId, DialogueRecommendationId,
    EmotionCatalogRevisionId, EmotionFusionId, EmotionObservationId, EnvelopeContext,
    EnvelopeContextInput, ExecutionGeneration, IntentCatalogRevisionId, IntentObservationId,
    InteractionId, TranscriptSegmentId, VOICE_AGENT_SCHEMA_VERSION,
};

#[test]
fn customer_state_snapshot_round_trips_as_one_bounded_head_record() {
    let intent_catalog = intent_catalog();
    let emotion_catalog = emotion_catalog();
    let intent = intent_state(&intent_catalog);
    let emotion = emotion_state(&emotion_catalog);
    let snapshot = CustomerStateSnapshot::try_new(
        CustomerStateInput {
            id: CustomerStateSnapshotId::parse("customer-state-001").unwrap(),
            observed_at_ms: 1_100,
        },
        &intent,
        &emotion,
    )
    .unwrap();

    let record =
        encode_customer_state_snapshot(&snapshot, "understanding-30-days-v1", 2_592_001_100)
            .unwrap();
    let restored = restore_customer_state_snapshot(&record, &intent, &emotion).unwrap();

    assert_eq!(restored, snapshot);
    assert_eq!(record.record_id(), "customer-state-001");
    assert_eq!(record.turn_index(), 1);
    let debug = format!("{record:?} {restored:?}");
    assert!(!debug.contains("sales.interested"));
    assert!(!debug.contains("customer.angry"));
}

#[test]
fn valid_customer_state_from_different_source_states_fails_closed() {
    let intent_catalog = intent_catalog();
    let emotion_catalog = emotion_catalog();
    let intended_intent = intent_state(&intent_catalog);
    let emotion = emotion_state(&emotion_catalog);
    let snapshot = CustomerStateSnapshot::try_new(
        CustomerStateInput {
            id: CustomerStateSnapshotId::parse("customer-state-001").unwrap(),
            observed_at_ms: 1_100,
        },
        &intent_state_for(&intent_catalog, "sales.reject"),
        &emotion,
    )
    .unwrap();
    let record =
        encode_customer_state_snapshot(&snapshot, "understanding-30-days-v1", 2_592_001_100)
            .unwrap();
    assert_eq!(
        restore_customer_state_snapshot(&record, &intended_intent, &emotion),
        Err(UnderstandingStoreError::CheckpointInvalid)
    );
}

#[test]
fn same_projection_from_different_intent_history_fails_closed() {
    let intent_catalog = intent_catalog();
    let emotion_catalog = emotion_catalog();
    let emotion = emotion_state(&emotion_catalog);
    let direct = IntentState::new(context(), intent_catalog.id().clone())
        .observe(
            &intent_observation(&intent_catalog, 2, "sales.interested"),
            &intent_catalog,
            intent_policy(),
        )
        .unwrap();
    let historical = IntentState::new(context(), intent_catalog.id().clone())
        .observe(
            &intent_observation(&intent_catalog, 1, "sales.interested"),
            &intent_catalog,
            intent_policy(),
        )
        .unwrap()
        .observe(
            &intent_observation(&intent_catalog, 2, "sales.interested"),
            &intent_catalog,
            intent_policy(),
        )
        .unwrap();
    assert_eq!(direct.status(), historical.status());
    assert_eq!(direct.confirmed_intent(), historical.confirmed_intent());

    let snapshot = CustomerStateSnapshot::try_new(
        CustomerStateInput {
            id: CustomerStateSnapshotId::parse("customer-state-history").unwrap(),
            observed_at_ms: 1_100,
        },
        &historical,
        &emotion,
    )
    .unwrap();
    let record =
        encode_customer_state_snapshot(&snapshot, "understanding-30-days-v1", 2_592_001_100)
            .unwrap();

    assert_eq!(
        restore_customer_state_snapshot(&record, &direct, &emotion),
        Err(UnderstandingStoreError::CheckpointInvalid)
    );
}

#[test]
fn dialogue_recommendation_round_trips_by_recomputing_exact_policy_output() {
    let intent_catalog = intent_catalog();
    let emotion_catalog = emotion_catalog();
    let snapshot = customer_state(&intent_catalog, &emotion_catalog);
    let policy = dialogue_policy();
    let recommendation = policy
        .evaluate(
            DialogueRecommendationId::parse("dialogue-recommendation-001").unwrap(),
            &snapshot,
            1_200,
        )
        .unwrap();

    let record = encode_dialogue_recommendation(
        &recommendation,
        &snapshot,
        "understanding-30-days-v1",
        2_592_001_200,
    )
    .unwrap();
    let restored = restore_dialogue_recommendation(&record, &policy, &snapshot).unwrap();

    assert_eq!(restored, recommendation);
    assert_eq!(record.record_id(), "dialogue-recommendation-001");
    assert_eq!(record.turn_index(), 1);
}

#[test]
fn forged_dialogue_kind_fails_closed_even_with_recomputed_record_hash() {
    let intent_catalog = intent_catalog();
    let emotion_catalog = emotion_catalog();
    let snapshot = customer_state(&intent_catalog, &emotion_catalog);
    let policy = dialogue_policy();
    let recommendation = policy
        .evaluate(
            DialogueRecommendationId::parse("dialogue-recommendation-001").unwrap(),
            &snapshot,
            1_200,
        )
        .unwrap();
    let record = encode_dialogue_recommendation(
        &recommendation,
        &snapshot,
        "understanding-30-days-v1",
        2_592_001_200,
    )
    .unwrap();

    let mut payload = record.payload().clone();
    payload["kind"] = serde_json::json!("propose_human_handoff");
    let forged = UnderstandingRecord::try_new(UnderstandingRecordInput {
        record_id: record.record_id().to_owned(),
        context: record.context().clone(),
        kind: record.kind(),
        turn_index: record.turn_index(),
        observed_at_ms: record.observed_at_ms(),
        retention_policy_ref: record.retention_policy_ref().to_owned(),
        retention_until_ms: record.retention_until_ms(),
        payload_hash: canonical_sha256(&payload).unwrap(),
        payload,
    })
    .unwrap();

    assert_eq!(
        restore_dialogue_recommendation(&forged, &policy, &snapshot),
        Err(UnderstandingStoreError::CheckpointInvalid)
    );
}

#[test]
fn same_dialogue_output_from_different_policy_thresholds_fails_closed() {
    let intent_catalog = intent_catalog();
    let emotion_catalog = emotion_catalog();
    let snapshot = customer_state(&intent_catalog, &emotion_catalog);
    let accepted_policy = dialogue_policy();
    let different_policy = DialoguePolicy::try_new(
        DialoguePolicyRevisionId::parse("dialogue-policy-001").unwrap(),
        AgentReleaseId::parse("release-001").unwrap(),
        5,
        6,
    )
    .unwrap();
    let recommendation = accepted_policy
        .evaluate(
            DialogueRecommendationId::parse("dialogue-recommendation-policy").unwrap(),
            &snapshot,
            1_200,
        )
        .unwrap();
    assert_eq!(
        recommendation.kind(),
        different_policy
            .evaluate(
                DialogueRecommendationId::parse("dialogue-recommendation-comparison").unwrap(),
                &snapshot,
                1_200,
            )
            .unwrap()
            .kind()
    );
    let record = encode_dialogue_recommendation(
        &recommendation,
        &snapshot,
        "understanding-30-days-v1",
        2_592_001_200,
    )
    .unwrap();

    assert_eq!(
        restore_dialogue_recommendation(&record, &different_policy, &snapshot),
        Err(UnderstandingStoreError::CheckpointInvalid)
    );
}

fn customer_state(
    intent_catalog: &IntentCatalog,
    emotion_catalog: &EmotionCatalog,
) -> CustomerStateSnapshot {
    CustomerStateSnapshot::try_new(
        CustomerStateInput {
            id: CustomerStateSnapshotId::parse("customer-state-001").unwrap(),
            observed_at_ms: 1_100,
        },
        &intent_state(intent_catalog),
        &emotion_state(emotion_catalog),
    )
    .unwrap()
}

fn dialogue_policy() -> DialoguePolicy {
    DialoguePolicy::try_new(
        DialoguePolicyRevisionId::parse("dialogue-policy-001").unwrap(),
        AgentReleaseId::parse("release-001").unwrap(),
        2,
        3,
    )
    .unwrap()
}

fn intent_state(catalog: &IntentCatalog) -> IntentState {
    intent_state_for(catalog, "sales.interested")
}

fn intent_state_for(catalog: &IntentCatalog, code: &str) -> IntentState {
    let observation = intent_observation(catalog, 1, code);
    IntentState::new(context(), catalog.id().clone())
        .observe(&observation, catalog, intent_policy())
        .unwrap()
}

fn intent_observation(catalog: &IntentCatalog, turn: u32, code: &str) -> IntentObservation {
    IntentObservation::try_new(
        IntentObservationInput {
            id: IntentObservationId::parse(format!("intent-observation-{turn}")).unwrap(),
            context: context(),
            catalog_revision_id: catalog.id().clone(),
            source: IntentSource::FastClassifier,
            provider_revision: "intent-fast-v1".to_owned(),
            candidates: vec![IntentCandidateInput {
                code: code.to_owned(),
                confidence_bps: 9_100,
            }],
            slots: BTreeMap::new(),
            evidence_segment_ids: vec![
                TranscriptSegmentId::parse(format!("segment-{turn}")).unwrap(),
            ],
            turn_index: turn,
            observed_at_ms: 999 + u64::from(turn),
        },
        catalog,
    )
    .unwrap()
}

fn intent_policy() -> IntentDecisionPolicy {
    IntentDecisionPolicy::try_new(5_500, 8_000, 1_500, 9_500).unwrap()
}

fn emotion_state(catalog: &EmotionCatalog) -> EmotionState {
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
    EmotionState::new(context(), catalog.id().clone())
        .observe(
            &fusion,
            catalog,
            EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap(),
        )
        .unwrap()
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
        definitions: vec![
            IntentDefinitionInput {
                code: "sales.interested".to_owned(),
                parent_code: None,
                slot_keys: Vec::new(),
                safety_critical: false,
            },
            IntentDefinitionInput {
                code: "sales.reject".to_owned(),
                parent_code: None,
                slot_keys: Vec::new(),
                safety_critical: false,
            },
        ],
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
