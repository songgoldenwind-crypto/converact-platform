use std::collections::BTreeMap;

use converact_conversation_understanding_core::{
    CustomerStateInput, CustomerStateSnapshot, DialoguePolicy, DialogueRecommendationKind,
    EmotionCandidateInput, EmotionCatalog, EmotionCatalogInput, EmotionDecisionPolicy,
    EmotionDefinitionInput, EmotionFusion, EmotionFusionInput, EmotionObservation,
    EmotionObservationInput, EmotionSource, EmotionState, EmotionValence, IntentCandidateInput,
    IntentCatalog, IntentCatalogInput, IntentDecisionPolicy, IntentDefinitionInput,
    IntentObservation, IntentObservationInput, IntentSource, IntentState, UnderstandingError,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, AudioEvidenceWindowId, CallAttemptId, CallId, CampaignContactId, CampaignId,
    ChannelAgentSessionId, CustomerStateSnapshotId, DialoguePolicyRevisionId,
    DialogueRecommendationId, EmotionCatalogRevisionId, EmotionFusionId, EmotionObservationId,
    EnvelopeContext, EnvelopeContextInput, ExecutionGeneration, IntentCatalogRevisionId,
    IntentObservationId, InteractionId, TranscriptSegmentId, VOICE_AGENT_SCHEMA_VERSION,
};

#[test]
fn snapshot_combines_same_authority_evidence_and_redacts_customer_labels() {
    let intent = confirmed_intent_state(1, "sales.interested");
    let emotion = confirmed_emotion_state(1, "customer.neutral", 8_700, 0);
    let snapshot = snapshot(&intent, &emotion);

    assert_eq!(snapshot.confirmed_intent(), Some("sales.interested"));
    assert_eq!(snapshot.confirmed_emotion(), Some("customer.neutral"));
    assert_eq!(snapshot.payload_hash().len(), 64);
    let debug = format!("{snapshot:?}");
    assert!(!debug.contains("sales.interested"));
    assert!(!debug.contains("customer.neutral"));
}

#[test]
fn snapshot_rejects_cross_generation_sources() {
    let intent = confirmed_intent_state(1, "sales.interested");
    let emotion = EmotionState::new(context(2), emotion_catalog().id().clone());
    assert_eq!(
        CustomerStateSnapshot::try_new(
            CustomerStateInput {
                id: CustomerStateSnapshotId::parse("customer-state-001").unwrap(),
                observed_at_ms: 3_000,
            },
            &intent,
            &emotion,
        ),
        Err(UnderstandingError::CustomerStateAuthorityMismatch)
    );
}

#[test]
fn policy_acknowledges_distress_before_asking_for_intent_clarification() {
    let intent = ambiguous_intent_state(1);
    let emotion = confirmed_emotion_state(1, "customer.angry", 8_900, 4);
    let recommendation = policy(1, 3)
        .evaluate(
            DialogueRecommendationId::parse("recommendation-001").unwrap(),
            &snapshot(&intent, &emotion),
            4_000,
        )
        .unwrap();

    assert_eq!(
        recommendation.kind(),
        DialogueRecommendationKind::AcknowledgeThenClarify
    );
    assert_eq!(recommendation.payload_hash().len(), 64);
}

#[test]
fn worsening_confirmed_distress_can_only_propose_handoff() {
    let intent = confirmed_intent_state(2, "sales.interested");
    let first = confirmed_emotion_state(1, "customer.anxious", 8_500, 2);
    let emotion = apply_emotion(&first, 2, "customer.angry", 9_000, 4);
    let recommendation = policy(1, 2)
        .evaluate(
            DialogueRecommendationId::parse("recommendation-002").unwrap(),
            &snapshot(&intent, &emotion),
            4_000,
        )
        .unwrap();

    assert_eq!(
        recommendation.kind(),
        DialogueRecommendationKind::ProposeHumanHandoff
    );
    assert!(format!("{recommendation:?}").contains("ProposeHumanHandoff"));
}

#[test]
fn policy_thresholds_and_evaluation_time_fail_closed() {
    assert_eq!(
        DialoguePolicy::try_new(
            DialoguePolicyRevisionId::parse("policy-invalid").unwrap(),
            AgentReleaseId::parse("release-001").unwrap(),
            3,
            2,
        ),
        Err(UnderstandingError::InvalidDialoguePolicy)
    );

    let intent = confirmed_intent_state(1, "sales.interested");
    let emotion = confirmed_emotion_state(1, "customer.neutral", 8_700, 0);
    assert_eq!(
        policy(1, 3).evaluate(
            DialogueRecommendationId::parse("recommendation-stale").unwrap(),
            &snapshot(&intent, &emotion),
            2_999,
        ),
        Err(UnderstandingError::StaleDialogueEvaluation)
    );

    let wrong_release = DialoguePolicy::try_new(
        DialoguePolicyRevisionId::parse("policy-other-release").unwrap(),
        AgentReleaseId::parse("release-other").unwrap(),
        1,
        3,
    )
    .unwrap();
    assert_eq!(
        wrong_release.evaluate(
            DialogueRecommendationId::parse("recommendation-other-release").unwrap(),
            &snapshot(&intent, &emotion),
            4_000,
        ),
        Err(UnderstandingError::DialoguePolicyReleaseMismatch)
    );
}

fn snapshot(intent: &IntentState, emotion: &EmotionState) -> CustomerStateSnapshot {
    CustomerStateSnapshot::try_new(
        CustomerStateInput {
            id: CustomerStateSnapshotId::parse("customer-state-001").unwrap(),
            observed_at_ms: 3_000,
        },
        intent,
        emotion,
    )
    .unwrap()
}

fn policy(acknowledge_after: u16, handoff_after: u16) -> DialoguePolicy {
    DialoguePolicy::try_new(
        DialoguePolicyRevisionId::parse("dialogue-policy-001").unwrap(),
        AgentReleaseId::parse("release-001").unwrap(),
        acknowledge_after,
        handoff_after,
    )
    .unwrap()
}

fn confirmed_intent_state(turn: u32, code: &str) -> IntentState {
    IntentState::new(context(1), intent_catalog().id().clone())
        .observe(
            &IntentObservation::try_new(
                IntentObservationInput {
                    id: IntentObservationId::parse(format!("intent-observation-{turn}")).unwrap(),
                    context: context(1),
                    catalog_revision_id: intent_catalog().id().clone(),
                    source: IntentSource::ContextualLlm,
                    provider_revision: "intent-provider-v1".to_owned(),
                    candidates: vec![IntentCandidateInput {
                        code: code.to_owned(),
                        confidence_bps: 9_000,
                    }],
                    slots: BTreeMap::new(),
                    evidence_segment_ids: vec![segment(turn)],
                    turn_index: turn,
                    observed_at_ms: 1_000 + u64::from(turn),
                },
                &intent_catalog(),
            )
            .unwrap(),
            &intent_catalog(),
            IntentDecisionPolicy::try_new(5_500, 8_000, 1_500, 9_500).unwrap(),
        )
        .unwrap()
}

fn ambiguous_intent_state(turn: u32) -> IntentState {
    IntentState::new(context(1), intent_catalog().id().clone())
        .observe(
            &IntentObservation::try_new(
                IntentObservationInput {
                    id: IntentObservationId::parse(format!("intent-observation-{turn}")).unwrap(),
                    context: context(1),
                    catalog_revision_id: intent_catalog().id().clone(),
                    source: IntentSource::ContextualLlm,
                    provider_revision: "intent-provider-v1".to_owned(),
                    candidates: vec![
                        IntentCandidateInput {
                            code: "sales.interested".to_owned(),
                            confidence_bps: 9_000,
                        },
                        IntentCandidateInput {
                            code: "callback.specific_time".to_owned(),
                            confidence_bps: 8_500,
                        },
                    ],
                    slots: BTreeMap::new(),
                    evidence_segment_ids: vec![segment(turn)],
                    turn_index: turn,
                    observed_at_ms: 1_000 + u64::from(turn),
                },
                &intent_catalog(),
            )
            .unwrap(),
            &intent_catalog(),
            IntentDecisionPolicy::try_new(5_500, 8_000, 1_500, 9_500).unwrap(),
        )
        .unwrap()
}

fn confirmed_emotion_state(
    turn: u32,
    code: &str,
    confidence_bps: u16,
    intensity: u8,
) -> EmotionState {
    apply_emotion(
        &EmotionState::new(context(1), emotion_catalog().id().clone()),
        turn,
        code,
        confidence_bps,
        intensity,
    )
}

fn apply_emotion(
    state: &EmotionState,
    turn: u32,
    code: &str,
    confidence_bps: u16,
    intensity: u8,
) -> EmotionState {
    let observations = [
        emotion_observation(
            turn,
            EmotionSource::AcousticModel,
            code,
            confidence_bps,
            intensity,
        ),
        emotion_observation(
            turn,
            EmotionSource::TextClassifier,
            code,
            confidence_bps,
            intensity,
        ),
    ];
    let fusion = EmotionFusion::try_new(
        EmotionFusionInput {
            id: EmotionFusionId::parse(format!("emotion-fusion-{turn}")).unwrap(),
            context: context(1),
            catalog_revision_id: emotion_catalog().id().clone(),
            fusion_revision: "fusion-v1".to_owned(),
            candidates: vec![EmotionCandidateInput {
                code: code.to_owned(),
                confidence_bps,
                intensity,
            }],
            turn_index: turn,
            observed_at_ms: 2_000 + u64::from(turn),
        },
        &observations,
        &emotion_catalog(),
    )
    .unwrap();
    state
        .observe(
            &fusion,
            &emotion_catalog(),
            EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap(),
        )
        .unwrap()
}

fn emotion_observation(
    turn: u32,
    source: EmotionSource,
    code: &str,
    confidence_bps: u16,
    intensity: u8,
) -> EmotionObservation {
    EmotionObservation::try_new(
        EmotionObservationInput {
            id: EmotionObservationId::parse(format!("emotion-observation-{turn}-{source:?}"))
                .unwrap(),
            context: context(1),
            catalog_revision_id: emotion_catalog().id().clone(),
            source,
            provider_revision: "emotion-provider-v1".to_owned(),
            candidates: vec![EmotionCandidateInput {
                code: code.to_owned(),
                confidence_bps,
                intensity,
            }],
            transcript_segment_ids: vec![segment(turn)],
            audio_evidence_window_ids: vec![
                AudioEvidenceWindowId::parse(format!("audio-window-{turn}-{source:?}")).unwrap(),
            ],
            turn_index: turn,
            observed_at_ms: 1_500 + u64::from(turn),
        },
        &emotion_catalog(),
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
                slot_keys: vec![],
                safety_critical: false,
            },
            IntentDefinitionInput {
                code: "callback.specific_time".to_owned(),
                parent_code: None,
                slot_keys: vec![],
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
        definitions: vec![
            EmotionDefinitionInput {
                code: "customer.neutral".to_owned(),
                valence: EmotionValence::Neutral,
                distress_rank: 0,
            },
            EmotionDefinitionInput {
                code: "customer.anxious".to_owned(),
                valence: EmotionValence::Negative,
                distress_rank: 2,
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

fn segment(turn: u32) -> TranscriptSegmentId {
    TranscriptSegmentId::parse(format!("segment-{turn}")).unwrap()
}

fn context(generation: u64) -> EnvelopeContext {
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
        execution_generation: ExecutionGeneration::new(generation).unwrap(),
        trace_id: "trace-001".to_owned(),
    })
    .unwrap()
}
