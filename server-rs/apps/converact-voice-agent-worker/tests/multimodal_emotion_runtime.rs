use converact_conversation_understanding_core::{
    EmotionCandidateInput, EmotionCatalog, EmotionCatalogInput, EmotionDecisionPolicy,
    EmotionDefinitionInput, EmotionObservation, EmotionObservationInput, EmotionSource,
    EmotionState, EmotionStatus, EmotionValence,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, AudioEvidenceWindowId, CallAttemptId, CallId, CampaignContactId, CampaignId,
    ChannelAgentSessionId, EmotionCatalogRevisionId, EmotionObservationId, EnvelopeContext,
    EnvelopeContextInput, ExecutionGeneration, InteractionId, TranscriptSegmentId,
    VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    MultimodalEmotionFusionPolicy, MultimodalEmotionTurnRuntime, MultimodalEmotionTurnRuntimeError,
};

#[test]
fn agreeing_text_and_acoustic_evidence_close_one_confirmed_turn() {
    let catalog = catalog();
    let policy = MultimodalEmotionFusionPolicy::try_new(6_000, 4_000, 1_000, 5).unwrap();
    let runtime = MultimodalEmotionTurnRuntime::new(
        &catalog,
        EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap(),
        &policy,
    );
    let text = observation(
        EmotionSource::TextClassifier,
        2,
        "customer.frustrated",
        9_000,
        3,
    );
    let acoustic = observation(
        EmotionSource::AcousticModel,
        2,
        "customer.frustrated",
        8_000,
        4,
    );

    let resolution = runtime
        .resolve(
            text,
            acoustic,
            &EmotionState::new(context(), catalog.id().clone()),
        )
        .unwrap();

    assert_eq!(resolution.contributor_count(), 2);
    assert_eq!(
        resolution.checkpoint().state().status(),
        EmotionStatus::Confirmed
    );
    assert_eq!(
        resolution.checkpoint().state().confirmed_emotion(),
        Some("customer.frustrated")
    );
    assert_eq!(
        resolution.checkpoint().state().confirmed_intensity(),
        Some(3)
    );
    assert_eq!(
        resolution
            .encode_evidence_records("understanding-30-days-v1", 2_592_003_001)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn modality_disagreement_is_diluted_instead_of_becoming_a_false_confirmation() {
    let catalog = catalog();
    let fusion_policy = MultimodalEmotionFusionPolicy::try_new(6_000, 4_000, 1_000, 5).unwrap();
    let runtime = MultimodalEmotionTurnRuntime::new(
        &catalog,
        EmotionDecisionPolicy::try_new(4_000, 8_000).unwrap(),
        &fusion_policy,
    );
    let resolution = runtime
        .resolve(
            observation(
                EmotionSource::TextClassifier,
                1,
                "customer.neutral",
                9_000,
                0,
            ),
            observation(
                EmotionSource::AcousticModel,
                1,
                "customer.frustrated",
                9_000,
                4,
            ),
            &EmotionState::new(context(), catalog.id().clone()),
        )
        .unwrap();

    assert_eq!(
        resolution.checkpoint().state().status(),
        EmotionStatus::Provisional
    );
    assert_eq!(
        resolution.checkpoint().state().primary_emotion(),
        Some("customer.neutral")
    );
    assert_eq!(resolution.checkpoint().state().confirmed_emotion(), None);
}

#[test]
fn source_turn_and_policy_drift_fail_closed() {
    assert_eq!(
        MultimodalEmotionFusionPolicy::try_new(6_000, 3_000, 1_000, 5).unwrap_err(),
        MultimodalEmotionTurnRuntimeError::PolicyInvalid
    );

    let catalog = catalog();
    let fusion_policy = MultimodalEmotionFusionPolicy::try_new(6_000, 4_000, 1_000, 5).unwrap();
    let runtime = MultimodalEmotionTurnRuntime::new(
        &catalog,
        EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap(),
        &fusion_policy,
    );
    let previous = EmotionState::new(context(), catalog.id().clone());
    assert_eq!(
        runtime
            .resolve(
                observation(
                    EmotionSource::TextClassifier,
                    1,
                    "customer.neutral",
                    9_000,
                    0,
                ),
                observation(
                    EmotionSource::AcousticModel,
                    2,
                    "customer.neutral",
                    9_000,
                    0,
                ),
                &previous,
            )
            .unwrap_err(),
        MultimodalEmotionTurnRuntimeError::EvidenceMismatch
    );
    assert_eq!(previous.status(), EmotionStatus::Unknown);

    let text = observation(
        EmotionSource::TextClassifier,
        1,
        "customer.neutral",
        9_000,
        0,
    );
    let mut acoustic_input = observation_input(
        EmotionSource::AcousticModel,
        1,
        "customer.neutral",
        9_000,
        0,
    );
    acoustic_input.transcript_segment_ids =
        vec![TranscriptSegmentId::parse("segment-different").unwrap()];
    let acoustic = EmotionObservation::try_new(acoustic_input, &catalog).unwrap();
    assert_eq!(
        runtime.resolve(text, acoustic, &previous).unwrap_err(),
        MultimodalEmotionTurnRuntimeError::EvidenceMismatch
    );
}

fn observation(
    source: EmotionSource,
    turn: u32,
    code: &str,
    confidence_bps: u16,
    intensity: u8,
) -> EmotionObservation {
    EmotionObservation::try_new(
        observation_input(source, turn, code, confidence_bps, intensity),
        &catalog(),
    )
    .unwrap()
}

fn observation_input(
    source: EmotionSource,
    turn: u32,
    code: &str,
    confidence_bps: u16,
    intensity: u8,
) -> EmotionObservationInput {
    EmotionObservationInput {
        id: EmotionObservationId::parse(format!("emotion-{source:?}-{turn}")).unwrap(),
        context: context(),
        catalog_revision_id: EmotionCatalogRevisionId::parse("emotion-catalog-001").unwrap(),
        source,
        provider_revision: format!("provider-{source:?}-v1"),
        candidates: vec![EmotionCandidateInput {
            code: code.to_owned(),
            confidence_bps,
            intensity,
        }],
        transcript_segment_ids: vec![
            TranscriptSegmentId::parse(format!("segment-{turn}")).unwrap(),
        ],
        audio_evidence_window_ids: if source == EmotionSource::AcousticModel {
            vec![AudioEvidenceWindowId::parse(format!("audio-window-{turn}")).unwrap()]
        } else {
            Vec::new()
        },
        turn_index: turn,
        observed_at_ms: 1_000 + u64::from(turn),
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
