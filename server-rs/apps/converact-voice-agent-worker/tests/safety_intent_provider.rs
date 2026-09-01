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
    SafetyIntentMatchKind, SafetyIntentProvider, SafetyIntentProviderError, SafetyIntentRuleInput,
    SafetyIntentRuleSetInput,
};

#[test]
fn customer_final_transcript_becomes_release_bound_safety_evidence() {
    let catalog = catalog();
    let provider = build_provider(
        &catalog,
        vec![rule(
            "stop-calling-zh",
            "safety.stop_calling",
            10,
            SafetyIntentMatchKind::Phrase,
            &["别再给我打电话"],
        )],
    );
    let segment = segment(
        TranscriptSpeaker::Customer,
        "请以后别再给我打电话了，谢谢。",
    );

    let observation = provider.observe(&segment, 1).unwrap().unwrap();

    assert_eq!(observation.source(), IntentSource::SafetyRule);
    assert_eq!(observation.turn_index(), 1);
    assert_eq!(observation.primary().unwrap().code(), "safety.stop_calling");
    assert_eq!(observation.primary().unwrap().confidence_bps(), 9_800);
    assert_eq!(observation.evidence_segment_ids(), &[segment.id().clone()]);
    assert!(observation.provider_revision().starts_with("safety-rules."));
    assert_eq!(observation.payload_hash().len(), 64);
    let replay = provider.observe(&segment, 1).unwrap().unwrap();
    assert_eq!(replay.id(), observation.id());
    assert_eq!(replay.payload_hash(), observation.payload_hash());

    let initial = IntentState::new(context(), catalog.id().clone());
    let checkpoint = provider
        .advance(
            &segment,
            1,
            &initial,
            IntentDecisionPolicy::try_new(5_500, 8_500, 2_000, 9_500).unwrap(),
        )
        .unwrap();
    let checkpoint = checkpoint.unwrap();
    assert_eq!(checkpoint.observation(), &observation);
    assert_eq!(checkpoint.state().status(), IntentStatus::Confirmed);
    assert_eq!(
        checkpoint.state().primary_intent(),
        Some("safety.stop_calling")
    );
    let debug = format!("{provider:?} {observation:?}");
    assert!(!debug.contains("别再给我打电话"));
    assert!(!debug.contains("请以后"));
}

#[test]
fn release_priority_is_deterministic_and_non_customer_or_boundary_misses_are_ignored() {
    let catalog = catalog();
    let provider = build_provider(
        &catalog,
        vec![
            rule(
                "human-zh",
                "safety.human_required",
                20,
                SafetyIntentMatchKind::Phrase,
                &["转人工"],
            ),
            rule(
                "stop-zh",
                "safety.stop_calling",
                10,
                SafetyIntentMatchKind::Phrase,
                &["别再联系"],
            ),
            rule(
                "stop-en",
                "safety.stop_calling",
                30,
                SafetyIntentMatchKind::Phrase,
                &["do not call"],
            ),
        ],
    );

    let both = provider
        .observe(
            &segment(TranscriptSpeaker::Customer, "别再联系我，直接给我转人工。"),
            2,
        )
        .unwrap()
        .unwrap();
    assert_eq!(both.primary().unwrap().code(), "safety.stop_calling");

    let canonical_order = build_provider(
        &catalog,
        vec![
            rule(
                "stop-zh",
                "safety.stop_calling",
                10,
                SafetyIntentMatchKind::Phrase,
                &["不要再联系", "别再联系"],
            ),
            rule(
                "human-zh",
                "safety.human_required",
                20,
                SafetyIntentMatchKind::Phrase,
                &["人工服务", "转人工"],
            ),
        ],
    );
    let reordered = build_provider(
        &catalog,
        vec![
            rule(
                "human-zh",
                "safety.human_required",
                20,
                SafetyIntentMatchKind::Phrase,
                &["转人工", "人工服务"],
            ),
            rule(
                "stop-zh",
                "safety.stop_calling",
                10,
                SafetyIntentMatchKind::Phrase,
                &["别再联系", "不要再联系"],
            ),
        ],
    );
    assert_eq!(
        canonical_order.provider_revision(),
        reordered.provider_revision()
    );

    assert!(
        provider
            .observe(&segment(TranscriptSpeaker::AiAgent, "别再联系"), 3,)
            .unwrap()
            .is_none()
    );
    assert!(
        provider
            .observe(
                &segment(TranscriptSpeaker::Customer, "do not callback tomorrow"),
                4,
            )
            .unwrap()
            .is_none()
    );
}

#[test]
fn unsafe_or_ambiguous_rule_sets_fail_closed() {
    let catalog = catalog();
    let non_safety = SafetyIntentProvider::try_new(
        SafetyIntentRuleSetInput {
            agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
            intent_catalog_revision_id: catalog.id().clone(),
            rules: vec![rule(
                "sales",
                "sales.interested",
                10,
                SafetyIntentMatchKind::Phrase,
                &["我感兴趣"],
            )],
        },
        &catalog,
    );
    assert_eq!(
        non_safety.unwrap_err(),
        SafetyIntentProviderError::RuleSetInvalid
    );

    let duplicate_phrase = SafetyIntentProvider::try_new(
        SafetyIntentRuleSetInput {
            agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
            intent_catalog_revision_id: catalog.id().clone(),
            rules: vec![
                rule(
                    "stop",
                    "safety.stop_calling",
                    10,
                    SafetyIntentMatchKind::Phrase,
                    &[" 别再联系 "],
                ),
                rule(
                    "human",
                    "safety.human_required",
                    20,
                    SafetyIntentMatchKind::Phrase,
                    &["别再联系"],
                ),
            ],
        },
        &catalog,
    );
    assert_eq!(
        duplicate_phrase.unwrap_err(),
        SafetyIntentProviderError::RuleSetInvalid
    );

    let wrong_release = SafetyIntentProvider::try_new(
        SafetyIntentRuleSetInput {
            agent_release_id: AgentReleaseId::parse("release-002").unwrap(),
            intent_catalog_revision_id: catalog.id().clone(),
            rules: vec![rule(
                "stop",
                "safety.stop_calling",
                10,
                SafetyIntentMatchKind::Phrase,
                &["别再联系"],
            )],
        },
        &catalog,
    );
    assert_eq!(
        wrong_release.unwrap_err(),
        SafetyIntentProviderError::CatalogMismatch
    );

    let control_bearing_phrase = SafetyIntentProvider::try_new(
        SafetyIntentRuleSetInput {
            agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
            intent_catalog_revision_id: catalog.id().clone(),
            rules: vec![rule(
                "stop",
                "safety.stop_calling",
                10,
                SafetyIntentMatchKind::Exact,
                &["别再\n联系"],
            )],
        },
        &catalog,
    );
    assert_eq!(
        control_bearing_phrase.unwrap_err(),
        SafetyIntentProviderError::RuleSetInvalid
    );
}

fn build_provider(
    catalog: &IntentCatalog,
    rules: Vec<SafetyIntentRuleInput>,
) -> SafetyIntentProvider {
    SafetyIntentProvider::try_new(
        SafetyIntentRuleSetInput {
            agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
            intent_catalog_revision_id: catalog.id().clone(),
            rules,
        },
        catalog,
    )
    .unwrap()
}

fn rule(
    rule_id: &str,
    intent_code: &str,
    priority: u16,
    match_kind: SafetyIntentMatchKind,
    phrases: &[&str],
) -> SafetyIntentRuleInput {
    SafetyIntentRuleInput {
        rule_id: rule_id.to_owned(),
        intent_code: intent_code.to_owned(),
        priority,
        confidence_bps: 9_800,
        match_kind,
        phrases: phrases.iter().map(|phrase| (*phrase).to_owned()).collect(),
    }
}

fn catalog() -> IntentCatalog {
    IntentCatalog::try_new(IntentCatalogInput {
        id: IntentCatalogRevisionId::parse("intent-catalog-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        definitions: vec![
            definition("sales", None, false),
            definition("sales.interested", Some("sales"), false),
            definition("safety", None, false),
            definition("safety.stop_calling", Some("safety"), true),
            definition("safety.human_required", Some("safety"), true),
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

fn segment(speaker: TranscriptSpeaker, text: &str) -> TranscriptSegment {
    TranscriptSegment::try_new(TranscriptSegmentInput {
        id: TranscriptSegmentId::parse(format!("segment-{}", speaker.as_str())).unwrap(),
        context: context(),
        source_event_id: EventId::parse(format!("event-{}", speaker.as_str())).unwrap(),
        sequence: 1,
        speaker,
        language: "zh-CN".to_owned(),
        text: text.to_owned(),
        start_offset_ms: 1_000,
        end_offset_ms: 2_000,
        observed_at_ms: 3_000,
        retention_policy_ref: "retention-standard-v1".to_owned(),
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
