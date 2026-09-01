use converact_contracts::canonical_sha256;
use converact_conversation_understanding_store::{
    AppendUnderstandingRecord, UnderstandingHeadExpectation, UnderstandingHeadExpectationInput,
    UnderstandingRecord, UnderstandingRecordInput, UnderstandingRecordKind,
    UnderstandingStoreError, UnderstandingTurnBatch,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId, EnvelopeContext,
    EnvelopeContextInput, ExecutionGeneration, InteractionId, VOICE_AGENT_SCHEMA_VERSION,
};
use serde_json::json;

#[test]
fn one_turn_batch_has_exactly_four_ordered_authoritative_domains() {
    let batch = UnderstandingTurnBatch::try_new(
        command(
            "intent-001",
            UnderstandingRecordKind::IntentObservation,
            1,
            1_000,
        ),
        command(
            "emotion-001",
            UnderstandingRecordKind::EmotionFusion,
            1,
            1_050,
        ),
        command(
            "customer-state-001",
            UnderstandingRecordKind::CustomerStateSnapshot,
            1,
            1_100,
        ),
        command(
            "dialogue-001",
            UnderstandingRecordKind::DialogueRecommendation,
            1,
            1_200,
        ),
    )
    .unwrap();

    assert_eq!(batch.commands()[0].record().record_id(), "intent-001");
    assert_eq!(batch.commands()[1].record().record_id(), "emotion-001");
    assert_eq!(
        batch.commands()[2].record().record_id(),
        "customer-state-001"
    );
    assert_eq!(batch.commands()[3].record().record_id(), "dialogue-001");
    assert!(batch.evidence_commands().is_empty());
}

#[test]
fn intent_evidence_precedes_the_four_authoritative_heads_in_one_batch() {
    let batch = UnderstandingTurnBatch::try_new_with_evidence(
        vec![
            record_only(
                "intent-provider-fast-001",
                UnderstandingRecordKind::IntentProviderObservation,
                1,
                1_000,
            ),
            record_only(
                "intent-provider-contextual-001",
                UnderstandingRecordKind::IntentProviderObservation,
                1,
                1_001,
            ),
            record_only(
                "intent-resolution-001",
                UnderstandingRecordKind::IntentResolutionEvidence,
                1,
                1_001,
            ),
        ],
        command(
            "intent-001",
            UnderstandingRecordKind::IntentObservation,
            1,
            1_001,
        ),
        command(
            "emotion-001",
            UnderstandingRecordKind::EmotionFusion,
            1,
            1_050,
        ),
        command(
            "customer-state-001",
            UnderstandingRecordKind::CustomerStateSnapshot,
            1,
            1_100,
        ),
        command(
            "dialogue-001",
            UnderstandingRecordKind::DialogueRecommendation,
            1,
            1_200,
        ),
    )
    .unwrap();

    assert_eq!(batch.evidence_commands().len(), 3);
    assert_eq!(
        batch.evidence_commands()[0].record().kind(),
        UnderstandingRecordKind::IntentProviderObservation
    );
    assert_eq!(
        batch.evidence_commands()[2].record().kind(),
        UnderstandingRecordKind::IntentResolutionEvidence
    );
    assert!(
        batch
            .evidence_commands()
            .iter()
            .all(|command| command.head_expectation().is_none())
    );
}

#[test]
fn incomplete_or_reversed_intent_evidence_fails_before_sql() {
    let (intent, emotion, customer_state, dialogue) = heads();
    assert_eq!(
        UnderstandingTurnBatch::try_new_with_evidence(
            vec![record_only(
                "intent-provider-fast-001",
                UnderstandingRecordKind::IntentProviderObservation,
                1,
                1_000,
            )],
            intent,
            emotion,
            customer_state,
            dialogue,
        ),
        Err(UnderstandingStoreError::InvalidBatch)
    );

    let (intent, emotion, customer_state, dialogue) = heads();
    assert_eq!(
        UnderstandingTurnBatch::try_new_with_evidence(
            vec![
                record_only(
                    "intent-resolution-001",
                    UnderstandingRecordKind::IntentResolutionEvidence,
                    1,
                    1_001,
                ),
                record_only(
                    "intent-provider-fast-001",
                    UnderstandingRecordKind::IntentProviderObservation,
                    1,
                    1_000,
                ),
            ],
            intent,
            emotion,
            customer_state,
            dialogue,
        ),
        Err(UnderstandingStoreError::InvalidBatch)
    );
}

#[test]
fn intent_evidence_authority_or_record_identity_drift_fails_before_sql() {
    let (intent, emotion, customer_state, dialogue) = heads();
    assert_eq!(
        UnderstandingTurnBatch::try_new_with_evidence(
            vec![
                record_only_for(
                    &context("other-attempt"),
                    "intent-provider-fast-001",
                    UnderstandingRecordKind::IntentProviderObservation,
                    1,
                    1_000,
                ),
                record_only(
                    "intent-resolution-001",
                    UnderstandingRecordKind::IntentResolutionEvidence,
                    1,
                    1_001,
                ),
            ],
            intent,
            emotion,
            customer_state,
            dialogue,
        ),
        Err(UnderstandingStoreError::InvalidBatch)
    );

    let (intent, emotion, customer_state, dialogue) = heads();
    assert_eq!(
        UnderstandingTurnBatch::try_new_with_evidence(
            vec![
                record_only(
                    "intent-001",
                    UnderstandingRecordKind::IntentProviderObservation,
                    1,
                    1_000,
                ),
                record_only(
                    "intent-resolution-001",
                    UnderstandingRecordKind::IntentResolutionEvidence,
                    1,
                    1_001,
                ),
            ],
            intent,
            emotion,
            customer_state,
            dialogue,
        ),
        Err(UnderstandingStoreError::InvalidBatch)
    );
}

fn heads() -> (
    AppendUnderstandingRecord,
    AppendUnderstandingRecord,
    AppendUnderstandingRecord,
    AppendUnderstandingRecord,
) {
    (
        command(
            "intent-001",
            UnderstandingRecordKind::IntentObservation,
            1,
            1_001,
        ),
        command(
            "emotion-001",
            UnderstandingRecordKind::EmotionFusion,
            1,
            1_050,
        ),
        command(
            "customer-state-001",
            UnderstandingRecordKind::CustomerStateSnapshot,
            1,
            1_100,
        ),
        command(
            "dialogue-001",
            UnderstandingRecordKind::DialogueRecommendation,
            1,
            1_200,
        ),
    )
}

#[test]
fn wrong_domain_authority_or_dependency_clock_fails_before_sql() {
    let duplicate_intent = UnderstandingTurnBatch::try_new(
        command(
            "intent-001",
            UnderstandingRecordKind::IntentObservation,
            1,
            1_000,
        ),
        command(
            "intent-002",
            UnderstandingRecordKind::IntentObservation,
            1,
            1_050,
        ),
        command(
            "customer-state-001",
            UnderstandingRecordKind::CustomerStateSnapshot,
            1,
            1_100,
        ),
        command(
            "dialogue-001",
            UnderstandingRecordKind::DialogueRecommendation,
            1,
            1_200,
        ),
    );
    assert_eq!(duplicate_intent, Err(UnderstandingStoreError::InvalidBatch));

    let stale_customer_state = UnderstandingTurnBatch::try_new(
        command(
            "intent-001",
            UnderstandingRecordKind::IntentObservation,
            2,
            2_000,
        ),
        command(
            "emotion-001",
            UnderstandingRecordKind::EmotionFusion,
            1,
            1_050,
        ),
        command(
            "customer-state-001",
            UnderstandingRecordKind::CustomerStateSnapshot,
            1,
            1_100,
        ),
        command(
            "dialogue-001",
            UnderstandingRecordKind::DialogueRecommendation,
            1,
            1_200,
        ),
    );
    assert_eq!(
        stale_customer_state,
        Err(UnderstandingStoreError::InvalidBatch)
    );

    let other_context = context("other-attempt");
    let authority_drift = UnderstandingTurnBatch::try_new(
        command(
            "intent-001",
            UnderstandingRecordKind::IntentObservation,
            1,
            1_000,
        ),
        command_for(
            &other_context,
            "emotion-001",
            UnderstandingRecordKind::EmotionFusion,
            1,
            1_050,
        ),
        command(
            "customer-state-001",
            UnderstandingRecordKind::CustomerStateSnapshot,
            1,
            1_100,
        ),
        command(
            "dialogue-001",
            UnderstandingRecordKind::DialogueRecommendation,
            1,
            1_200,
        ),
    );
    assert_eq!(authority_drift, Err(UnderstandingStoreError::InvalidBatch));
}

fn command(
    record_id: &str,
    kind: UnderstandingRecordKind,
    turn_index: u32,
    observed_at_ms: u64,
) -> AppendUnderstandingRecord {
    command_for(
        &context("attempt-001"),
        record_id,
        kind,
        turn_index,
        observed_at_ms,
    )
}

fn command_for(
    context: &EnvelopeContext,
    record_id: &str,
    kind: UnderstandingRecordKind,
    turn_index: u32,
    observed_at_ms: u64,
) -> AppendUnderstandingRecord {
    let payload = json!({"record_id": record_id});
    let record = UnderstandingRecord::try_new(UnderstandingRecordInput {
        record_id: record_id.to_owned(),
        context: context.clone(),
        kind,
        turn_index,
        observed_at_ms,
        retention_policy_ref: "understanding-30-days-v1".to_owned(),
        retention_until_ms: 9_999,
        payload_hash: canonical_sha256(&payload).unwrap(),
        payload,
    })
    .unwrap();
    AppendUnderstandingRecord::try_new(
        record,
        Some(
            UnderstandingHeadExpectation::try_new(UnderstandingHeadExpectationInput {
                expected_revision: 0,
                expected_record_id: None,
                expected_payload_hash: None,
            })
            .unwrap(),
        ),
    )
    .unwrap()
}

fn record_only(
    record_id: &str,
    kind: UnderstandingRecordKind,
    turn_index: u32,
    observed_at_ms: u64,
) -> AppendUnderstandingRecord {
    record_only_for(
        &context("attempt-001"),
        record_id,
        kind,
        turn_index,
        observed_at_ms,
    )
}

fn record_only_for(
    context: &EnvelopeContext,
    record_id: &str,
    kind: UnderstandingRecordKind,
    turn_index: u32,
    observed_at_ms: u64,
) -> AppendUnderstandingRecord {
    let payload = json!({"record_id": record_id});
    let record = UnderstandingRecord::try_new(UnderstandingRecordInput {
        record_id: record_id.to_owned(),
        context: context.clone(),
        kind,
        turn_index,
        observed_at_ms,
        retention_policy_ref: "understanding-30-days-v1".to_owned(),
        retention_until_ms: 9_999,
        payload_hash: canonical_sha256(&payload).unwrap(),
        payload,
    })
    .unwrap();
    AppendUnderstandingRecord::try_new(record, None).unwrap()
}

fn context(attempt: &str) -> EnvelopeContext {
    EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version: VOICE_AGENT_SCHEMA_VERSION,
        tenant_id: "tenant-a".to_owned(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        campaign_id: CampaignId::parse("campaign-001").unwrap(),
        campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
        call_attempt_id: CallAttemptId::parse(attempt).unwrap(),
        call_id: None,
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        channel_agent_session_id: None,
        execution_generation: ExecutionGeneration::new(1).unwrap(),
        trace_id: "trace-001".to_owned(),
    })
    .unwrap()
}
