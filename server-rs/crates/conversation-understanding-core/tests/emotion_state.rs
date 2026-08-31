use converact_conversation_understanding_core::{
    CustomerDistressTrend, EmotionCandidateInput, EmotionCatalog, EmotionCatalogInput,
    EmotionDecisionPolicy, EmotionDefinitionInput, EmotionFusion, EmotionFusionInput,
    EmotionObservation, EmotionObservationInput, EmotionSource, EmotionState, EmotionStatus,
    EmotionValence, UnderstandingError,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, AudioEvidenceWindowId, CallAttemptId, CallId, CampaignContactId, CampaignId,
    ChannelAgentSessionId, EmotionCatalogRevisionId, EmotionFusionId, EmotionObservationId,
    EnvelopeContext, EnvelopeContextInput, ExecutionGeneration, InteractionId, TranscriptSegmentId,
    VOICE_AGENT_SCHEMA_VERSION,
};

#[test]
fn catalog_is_release_bound_and_rejects_invalid_distress_semantics() {
    let catalog = catalog();
    assert_eq!(catalog.id().as_str(), "emotion-catalog-001");
    assert_eq!(
        catalog.valence("customer.angry"),
        Some(EmotionValence::Negative)
    );
    assert_eq!(catalog.distress_rank("customer.angry"), Some(4));

    let invalid = EmotionCatalog::try_new(EmotionCatalogInput {
        id: EmotionCatalogRevisionId::parse("emotion-catalog-invalid").unwrap(),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        definitions: vec![EmotionDefinitionInput {
            code: "customer.happy".to_owned(),
            valence: EmotionValence::Positive,
            distress_rank: 3,
        }],
    });
    assert_eq!(invalid, Err(UnderstandingError::InvalidEmotionCatalog));
}

#[test]
fn signal_requires_source_appropriate_evidence_and_redacts_customer_classification() {
    let acoustic = signal(1, EmotionSource::AcousticModel, "customer.angry", 8_600, 4);
    assert_eq!(acoustic.turn_index(), 1);
    assert_eq!(acoustic.payload_hash().len(), 64);
    let debug = format!("{acoustic:?}");
    assert!(!debug.contains("customer.angry"));

    let missing_audio = EmotionObservation::try_new(
        signal_input(1, EmotionSource::AcousticModel, "customer.angry", 8_600, 4)
            .without_audio_evidence(),
        &catalog(),
    );
    assert_eq!(
        missing_audio,
        Err(UnderstandingError::EmotionEvidenceMismatch)
    );

    let missing_transcript = EmotionObservation::try_new(
        signal_input(1, EmotionSource::TextClassifier, "customer.angry", 8_600, 4)
            .without_transcript_evidence(),
        &catalog(),
    );
    assert_eq!(
        missing_transcript,
        Err(UnderstandingError::EmotionEvidenceMismatch)
    );
}

#[test]
fn fusion_is_content_hashed_and_rejects_cross_generation_or_turn_inputs() {
    let acoustic = signal(1, EmotionSource::AcousticModel, "customer.angry", 8_600, 4);
    let text = signal(
        1,
        EmotionSource::TextClassifier,
        "customer.anxious",
        7_900,
        3,
    );
    let fused = fusion(
        1,
        &[acoustic.clone(), text.clone()],
        "customer.angry",
        8_800,
        4,
    );
    assert_eq!(fused.contributor_count(), 2);
    assert_eq!(fused.payload_hash().len(), 64);
    assert!(!format!("{fused:?}").contains("customer.angry"));

    let mut cross_generation_input =
        signal_input(1, EmotionSource::TextClassifier, "customer.angry", 8_000, 4);
    cross_generation_input.context = context(2);
    let cross_generation = EmotionObservation::try_new(cross_generation_input, &catalog()).unwrap();
    assert_eq!(
        EmotionFusion::try_new(
            fusion_input(1, "customer.angry", 8_800, 4),
            &[acoustic.clone(), cross_generation],
            &catalog(),
        ),
        Err(UnderstandingError::EmotionAuthorityMismatch)
    );

    let other_turn = signal(
        2,
        EmotionSource::ContextualLlm,
        "customer.anxious",
        8_000,
        3,
    );
    assert_eq!(
        EmotionFusion::try_new(
            fusion_input(1, "customer.angry", 8_800, 4),
            &[acoustic, other_turn],
            &catalog(),
        ),
        Err(UnderstandingError::EmotionEvidenceMismatch)
    );
}

#[test]
fn only_confirmed_fusion_updates_distress_trend_and_consecutive_turns() {
    let policy = EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap();
    let initial = EmotionState::new(context(1), catalog().id().clone());
    assert_eq!(initial.status(), EmotionStatus::Unknown);
    assert_eq!(initial.distress_trend(), CustomerDistressTrend::Unknown);

    let first = apply(&initial, 1, "customer.anxious", 8_500, 2, policy);
    assert_eq!(first.status(), EmotionStatus::Confirmed);
    assert_eq!(first.distress_trend(), CustomerDistressTrend::Unknown);
    assert_eq!(first.consecutive_distress_turns(), 1);

    let worsening = apply(&first, 2, "customer.angry", 8_900, 4, policy);
    assert_eq!(worsening.distress_trend(), CustomerDistressTrend::Worsening);
    assert_eq!(worsening.consecutive_distress_turns(), 2);
    assert_eq!(worsening.confirmed_emotion(), Some("customer.angry"));
    assert_eq!(worsening.confirmed_intensity(), Some(4));
    assert!(!format!("{worsening:?}").contains("customer.angry"));

    let provisional = apply(&worsening, 3, "customer.happy", 6_500, 3, policy);
    assert_eq!(provisional.status(), EmotionStatus::Provisional);
    assert_eq!(
        provisional.distress_trend(),
        CustomerDistressTrend::Worsening
    );
    assert_eq!(provisional.consecutive_distress_turns(), 2);

    let improving = apply(&provisional, 4, "customer.neutral", 8_700, 0, policy);
    assert_eq!(improving.status(), EmotionStatus::Confirmed);
    assert_eq!(improving.distress_trend(), CustomerDistressTrend::Improving);
    assert_eq!(improving.consecutive_distress_turns(), 0);
}

#[test]
fn stale_fusion_and_cross_release_catalog_fail_closed() {
    let policy = EmotionDecisionPolicy::try_new(5_500, 8_000).unwrap();
    let initial = EmotionState::new(context(1), catalog().id().clone());
    let state = apply(&initial, 2, "customer.neutral", 8_500, 0, policy);
    let signals = signals(2, "customer.neutral", 8_500, 0);
    let same_turn_fusion = fusion(2, &signals, "customer.neutral", 8_500, 0);
    assert_eq!(
        state.observe(&same_turn_fusion, &catalog(), policy),
        Err(UnderstandingError::StaleEmotionFusion)
    );

    let other_catalog = EmotionCatalog::try_new(EmotionCatalogInput {
        id: EmotionCatalogRevisionId::parse("emotion-catalog-other").unwrap(),
        agent_release_id: AgentReleaseId::parse("release-other").unwrap(),
        definitions: vec![EmotionDefinitionInput {
            code: "customer.neutral".to_owned(),
            valence: EmotionValence::Neutral,
            distress_rank: 0,
        }],
    })
    .unwrap();
    assert_eq!(
        state.observe(&same_turn_fusion, &other_catalog, policy),
        Err(UnderstandingError::EmotionCatalogMismatch)
    );
}

fn apply(
    state: &EmotionState,
    turn: u32,
    code: &str,
    confidence_bps: u16,
    intensity: u8,
    policy: EmotionDecisionPolicy,
) -> EmotionState {
    let signals = signals(turn, code, confidence_bps, intensity);
    state
        .observe(
            &fusion(turn, &signals, code, confidence_bps, intensity),
            &catalog(),
            policy,
        )
        .unwrap()
}

fn signals(turn: u32, code: &str, confidence_bps: u16, intensity: u8) -> Vec<EmotionObservation> {
    vec![
        signal(
            turn,
            EmotionSource::AcousticModel,
            code,
            confidence_bps,
            intensity,
        ),
        signal(
            turn,
            EmotionSource::TextClassifier,
            code,
            confidence_bps,
            intensity,
        ),
    ]
}

fn fusion(
    turn: u32,
    observations: &[EmotionObservation],
    code: &str,
    confidence_bps: u16,
    intensity: u8,
) -> EmotionFusion {
    EmotionFusion::try_new(
        fusion_input(turn, code, confidence_bps, intensity),
        observations,
        &catalog(),
    )
    .unwrap()
}

fn fusion_input(turn: u32, code: &str, confidence_bps: u16, intensity: u8) -> EmotionFusionInput {
    EmotionFusionInput {
        id: EmotionFusionId::parse(format!("emotion-fusion-{turn}")).unwrap(),
        context: context(1),
        catalog_revision_id: EmotionCatalogRevisionId::parse("emotion-catalog-001").unwrap(),
        fusion_revision: "fusion-v1".to_owned(),
        candidates: vec![EmotionCandidateInput {
            code: code.to_owned(),
            confidence_bps,
            intensity,
        }],
        turn_index: turn,
        observed_at_ms: 2_000 + u64::from(turn),
    }
}

fn signal(
    turn: u32,
    source: EmotionSource,
    code: &str,
    confidence_bps: u16,
    intensity: u8,
) -> EmotionObservation {
    EmotionObservation::try_new(
        signal_input(turn, source, code, confidence_bps, intensity),
        &catalog(),
    )
    .unwrap()
}

fn signal_input(
    turn: u32,
    source: EmotionSource,
    code: &str,
    confidence_bps: u16,
    intensity: u8,
) -> EmotionObservationInput {
    EmotionObservationInput {
        id: EmotionObservationId::parse(format!("emotion-observation-{turn}-{source:?}")).unwrap(),
        context: context(1),
        catalog_revision_id: EmotionCatalogRevisionId::parse("emotion-catalog-001").unwrap(),
        source,
        provider_revision: "emotion-provider-v1".to_owned(),
        candidates: vec![EmotionCandidateInput {
            code: code.to_owned(),
            confidence_bps,
            intensity,
        }],
        transcript_segment_ids: vec![
            TranscriptSegmentId::parse(format!("segment-{turn}")).unwrap(),
        ],
        audio_evidence_window_ids: vec![
            AudioEvidenceWindowId::parse(format!("audio-window-{turn}")).unwrap(),
        ],
        turn_index: turn,
        observed_at_ms: 1_000 + u64::from(turn),
    }
}

fn catalog() -> EmotionCatalog {
    EmotionCatalog::try_new(EmotionCatalogInput {
        id: EmotionCatalogRevisionId::parse("emotion-catalog-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        definitions: vec![
            emotion("customer.neutral", EmotionValence::Neutral, 0),
            emotion("customer.happy", EmotionValence::Positive, 0),
            emotion("customer.anxious", EmotionValence::Negative, 2),
            emotion("customer.angry", EmotionValence::Negative, 4),
        ],
    })
    .unwrap()
}

fn emotion(code: &str, valence: EmotionValence, distress_rank: u8) -> EmotionDefinitionInput {
    EmotionDefinitionInput {
        code: code.to_owned(),
        valence,
        distress_rank,
    }
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
