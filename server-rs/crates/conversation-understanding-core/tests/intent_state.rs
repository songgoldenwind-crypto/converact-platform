use std::collections::BTreeMap;

use converact_conversation_understanding_core::{
    IntentCandidateInput, IntentCatalog, IntentCatalogInput, IntentDecisionPolicy,
    IntentDefinitionInput, IntentObservation, IntentObservationInput, IntentSource, IntentState,
    IntentStatus, UnderstandingError,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    EnvelopeContext, EnvelopeContextInput, ExecutionGeneration, IntentCatalogRevisionId,
    IntentObservationId, InteractionId, TranscriptSegmentId, VOICE_AGENT_SCHEMA_VERSION,
};

#[test]
fn catalog_is_release_bound_hierarchical_and_cycle_free() {
    let catalog = catalog();
    assert_eq!(catalog.id().as_str(), "intent-catalog-001");
    assert!(catalog.is_safety_critical("safety.stop_calling"));
    assert!(catalog.slot_allowed("callback.specific_time", "callback_time"));
    assert!(!catalog.slot_allowed("sales.interested", "callback_time"));

    let cyclic = IntentCatalog::try_new(IntentCatalogInput {
        id: IntentCatalogRevisionId::parse("intent-catalog-cycle").unwrap(),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        definitions: vec![
            definition("a", Some("b"), &[], false),
            definition("b", Some("a"), &[], false),
        ],
    });
    assert_eq!(cyclic, Err(UnderstandingError::InvalidIntentCatalog));
}

#[test]
fn observation_is_bounded_schema_validated_hashed_and_redacted() {
    let observation = observation(
        1,
        IntentSource::FastClassifier,
        &[
            ("callback.specific_time", 8_000),
            ("sales.interested", 1_000),
        ],
        BTreeMap::from([("callback_time".to_owned(), "tomorrow-15:00".to_owned())]),
    );

    assert_eq!(
        observation.primary().unwrap().code(),
        "callback.specific_time"
    );
    assert_eq!(observation.payload_hash().len(), 64);
    assert_eq!(observation.turn_index(), 1);
    let debug = format!("{observation:?}");
    assert!(!debug.contains("callback.specific_time"));
    assert!(!debug.contains("tomorrow-15:00"));

    let unsorted = IntentObservation::try_new(
        observation_input(
            1,
            IntentSource::FastClassifier,
            &[
                ("sales.interested", 1_000),
                ("callback.specific_time", 8_000),
            ],
            BTreeMap::new(),
        ),
        &catalog(),
    );
    assert_eq!(unsorted, Err(UnderstandingError::InvalidIntentObservation));

    let forbidden_slot = IntentObservation::try_new(
        observation_input(
            1,
            IntentSource::FastClassifier,
            &[("sales.interested", 8_000)],
            BTreeMap::from([("callback_time".to_owned(), "secret".to_owned())]),
        ),
        &catalog(),
    );
    assert_eq!(
        forbidden_slot,
        Err(UnderstandingError::IntentSlotNotAllowed)
    );
}

#[test]
fn confidence_policy_drives_unknown_provisional_clarify_confirm_and_change() {
    let policy = IntentDecisionPolicy::try_new(5_500, 8_500, 2_000, 9_500).unwrap();
    let initial = IntentState::new(context(1), catalog().id().clone());
    assert_eq!(initial.status(), IntentStatus::Unknown);

    let unknown = initial
        .observe(
            &observation(1, IntentSource::FastClassifier, &[], BTreeMap::new()),
            &catalog(),
            policy,
        )
        .unwrap();
    assert_eq!(unknown.status(), IntentStatus::Unknown);

    let provisional = unknown
        .observe(
            &observation(
                2,
                IntentSource::FastClassifier,
                &[("sales.interested", 7_000)],
                BTreeMap::new(),
            ),
            &catalog(),
            policy,
        )
        .unwrap();
    assert_eq!(provisional.status(), IntentStatus::Provisional);

    let ambiguous = provisional
        .observe(
            &observation(
                3,
                IntentSource::ContextualLlm,
                &[
                    ("sales.interested", 9_000),
                    ("callback.specific_time", 8_000),
                ],
                BTreeMap::new(),
            ),
            &catalog(),
            policy,
        )
        .unwrap();
    assert_eq!(ambiguous.status(), IntentStatus::ClarificationRequired);

    let confirmed = ambiguous
        .observe(
            &observation(
                4,
                IntentSource::ContextualLlm,
                &[
                    ("sales.interested", 9_000),
                    ("callback.specific_time", 4_000),
                ],
                BTreeMap::new(),
            ),
            &catalog(),
            policy,
        )
        .unwrap();
    assert_eq!(confirmed.status(), IntentStatus::Confirmed);
    assert_eq!(confirmed.primary_intent(), Some("sales.interested"));
    assert!(!format!("{confirmed:?}").contains("sales.interested"));

    let changed = confirmed
        .observe(
            &observation(
                5,
                IntentSource::ContextualLlm,
                &[
                    ("callback.specific_time", 9_200),
                    ("sales.interested", 3_000),
                ],
                BTreeMap::from([("callback_time".to_owned(), "tomorrow".to_owned())]),
            ),
            &catalog(),
            policy,
        )
        .unwrap();
    assert_eq!(changed.status(), IntentStatus::Changed);
    assert_eq!(changed.primary_intent(), Some("callback.specific_time"));
    assert_eq!(
        changed.previous_confirmed_intent(),
        Some("sales.interested")
    );
}

#[test]
fn safety_rule_can_confirm_classification_but_returns_no_business_action() {
    let policy = IntentDecisionPolicy::try_new(5_500, 8_500, 2_000, 9_500).unwrap();
    let state = IntentState::new(context(1), catalog().id().clone())
        .observe(
            &observation(
                1,
                IntentSource::SafetyRule,
                &[("safety.stop_calling", 9_800), ("sales.interested", 9_000)],
                BTreeMap::new(),
            ),
            &catalog(),
            policy,
        )
        .unwrap();

    assert_eq!(state.status(), IntentStatus::Confirmed);
    assert_eq!(state.primary_intent(), Some("safety.stop_calling"));
}

#[test]
fn stale_turn_and_cross_generation_or_release_evidence_fail_closed() {
    let policy = IntentDecisionPolicy::try_new(5_500, 8_500, 2_000, 9_500).unwrap();
    let state = IntentState::new(context(1), catalog().id().clone())
        .observe(
            &observation(
                2,
                IntentSource::FastClassifier,
                &[("sales.interested", 7_000)],
                BTreeMap::new(),
            ),
            &catalog(),
            policy,
        )
        .unwrap();
    assert_eq!(
        state.observe(
            &observation(
                2,
                IntentSource::FastClassifier,
                &[("sales.interested", 9_000)],
                BTreeMap::new(),
            ),
            &catalog(),
            policy,
        ),
        Err(UnderstandingError::StaleIntentObservation)
    );

    let mut cross_generation = observation_input(
        3,
        IntentSource::ContextualLlm,
        &[("sales.interested", 9_000)],
        BTreeMap::new(),
    );
    cross_generation.context = context(2);
    let cross_generation = IntentObservation::try_new(cross_generation, &catalog()).unwrap();
    assert_eq!(
        state.observe(&cross_generation, &catalog(), policy),
        Err(UnderstandingError::IntentAuthorityMismatch)
    );
}

fn catalog() -> IntentCatalog {
    IntentCatalog::try_new(IntentCatalogInput {
        id: IntentCatalogRevisionId::parse("intent-catalog-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        definitions: vec![
            definition("sales", None, &[], false),
            definition("sales.interested", Some("sales"), &["product"], false),
            definition("callback", None, &[], false),
            definition(
                "callback.specific_time",
                Some("callback"),
                &["callback_time"],
                false,
            ),
            definition("safety", None, &[], false),
            definition("safety.stop_calling", Some("safety"), &[], true),
        ],
    })
    .unwrap()
}

fn definition(
    code: &str,
    parent: Option<&str>,
    slots: &[&str],
    safety_critical: bool,
) -> IntentDefinitionInput {
    IntentDefinitionInput {
        code: code.to_owned(),
        parent_code: parent.map(str::to_owned),
        slot_keys: slots.iter().map(|value| (*value).to_owned()).collect(),
        safety_critical,
    }
}

fn observation(
    turn_index: u32,
    source: IntentSource,
    candidates: &[(&str, u16)],
    slots: BTreeMap<String, String>,
) -> IntentObservation {
    IntentObservation::try_new(
        observation_input(turn_index, source, candidates, slots),
        &catalog(),
    )
    .unwrap()
}

fn observation_input(
    turn_index: u32,
    source: IntentSource,
    candidates: &[(&str, u16)],
    slots: BTreeMap<String, String>,
) -> IntentObservationInput {
    IntentObservationInput {
        id: IntentObservationId::parse(format!("intent-observation-{turn_index}")).unwrap(),
        context: context(1),
        catalog_revision_id: IntentCatalogRevisionId::parse("intent-catalog-001").unwrap(),
        source,
        provider_revision: "intent-provider-v1".to_owned(),
        candidates: candidates
            .iter()
            .map(|(code, confidence_bps)| IntentCandidateInput {
                code: (*code).to_owned(),
                confidence_bps: *confidence_bps,
            })
            .collect(),
        slots,
        evidence_segment_ids: vec![
            TranscriptSegmentId::parse(format!("segment-{turn_index}")).unwrap(),
        ],
        turn_index,
        observed_at_ms: 1_000 + u64::from(turn_index),
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
