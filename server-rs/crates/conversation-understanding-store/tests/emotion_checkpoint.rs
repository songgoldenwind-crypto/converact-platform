use converact_contracts::canonical_sha256;
use converact_conversation_understanding_core::{
    CustomerDistressTrend, EmotionCandidateInput, EmotionCatalog, EmotionCatalogInput,
    EmotionCheckpoint, EmotionDecisionPolicy, EmotionDefinitionInput, EmotionFusion,
    EmotionFusionInput, EmotionObservation, EmotionObservationInput, EmotionSource, EmotionState,
    EmotionValence,
};
use converact_conversation_understanding_store::{
    UnderstandingRecord, UnderstandingRecordInput, UnderstandingStoreError,
    encode_emotion_checkpoint, restore_emotion_checkpoint,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, AudioEvidenceWindowId, CallAttemptId, CampaignContactId, CampaignId,
    EmotionCatalogRevisionId, EmotionFusionId, EmotionObservationId, EnvelopeContext,
    EnvelopeContextInput, ExecutionGeneration, InteractionId, TranscriptSegmentId,
    VOICE_AGENT_SCHEMA_VERSION,
};

#[test]
fn latest_fused_emotion_checkpoint_round_trips_with_trend_state() {
    let catalog = catalog();
    let initial = EmotionState::new(context(), catalog.id().clone());
    let first = checkpoint(&catalog, &initial, 1, 3);
    let second = checkpoint(&catalog, first.state(), 2, 4);

    let record =
        encode_emotion_checkpoint(&second, "understanding-30-days-v1", 2_592_002_000).unwrap();
    let restored = restore_emotion_checkpoint(&record, &catalog).unwrap();

    assert_eq!(restored, second);
    assert_eq!(
        restored.state().distress_trend(),
        CustomerDistressTrend::Worsening
    );
    assert_eq!(restored.state().consecutive_distress_turns(), 2);
    let debug = format!("{record:?} {restored:?}");
    assert!(!debug.contains("customer.angry"));
}

#[test]
fn forged_fusion_or_projection_fails_closed_even_with_a_matching_outer_hash() {
    let catalog = catalog();
    let checkpoint = checkpoint(
        &catalog,
        &EmotionState::new(context(), catalog.id().clone()),
        1,
        4,
    );
    let record =
        encode_emotion_checkpoint(&checkpoint, "understanding-30-days-v1", 2_592_002_000).unwrap();

    let mut payload = record.payload().clone();
    payload["state"]["confirmed_intensity"] = serde_json::json!(1);
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
        restore_emotion_checkpoint(&forged, &catalog),
        Err(UnderstandingStoreError::CheckpointInvalid)
    );

    let mut payload = record.payload().clone();
    payload["fusion"]["payload_hash"] = serde_json::json!("a".repeat(64));
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
        restore_emotion_checkpoint(&forged, &catalog),
        Err(UnderstandingStoreError::CheckpointInvalid)
    );
}

fn checkpoint(
    catalog: &EmotionCatalog,
    previous: &EmotionState,
    turn: u32,
    intensity: u8,
) -> EmotionCheckpoint {
    let observations = vec![
        observation(catalog, turn, EmotionSource::AcousticModel, intensity),
        observation(catalog, turn, EmotionSource::TextClassifier, intensity),
    ];
    let fusion = EmotionFusion::try_new(
        EmotionFusionInput {
            id: EmotionFusionId::parse(format!("emotion-fusion-{turn}")).unwrap(),
            context: context(),
            catalog_revision_id: catalog.id().clone(),
            fusion_revision: "weighted-fusion-v1".to_owned(),
            candidates: vec![EmotionCandidateInput {
                code: "customer.angry".to_owned(),
                confidence_bps: 9_000,
                intensity,
            }],
            turn_index: turn,
            observed_at_ms: u64::from(turn) * 1_000,
        },
        &observations,
        catalog,
    )
    .unwrap();
    let state = previous
        .observe(
            &fusion,
            catalog,
            EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap(),
        )
        .unwrap();
    EmotionCheckpoint::try_new(fusion, state).unwrap()
}

fn observation(
    catalog: &EmotionCatalog,
    turn: u32,
    source: EmotionSource,
    intensity: u8,
) -> EmotionObservation {
    EmotionObservation::try_new(
        EmotionObservationInput {
            id: EmotionObservationId::parse(format!("emotion-observation-{turn}-{source:?}"))
                .unwrap(),
            context: context(),
            catalog_revision_id: catalog.id().clone(),
            source,
            provider_revision: "emotion-provider-v1".to_owned(),
            candidates: vec![EmotionCandidateInput {
                code: "customer.angry".to_owned(),
                confidence_bps: 8_600,
                intensity,
            }],
            transcript_segment_ids: vec![
                TranscriptSegmentId::parse(format!("segment-{turn}")).unwrap(),
            ],
            audio_evidence_window_ids: vec![
                AudioEvidenceWindowId::parse(format!("audio-window-{turn}")).unwrap(),
            ],
            turn_index: turn,
            observed_at_ms: u64::from(turn) * 900,
        },
        catalog,
    )
    .unwrap()
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
                code: "customer.angry".to_owned(),
                valence: EmotionValence::Negative,
                distress_rank: 4,
            },
        ],
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
