use converact_contracts::canonical_sha256;
use converact_conversation_understanding_store::{
    StoredUnderstandingHead, UnderstandingDomain, UnderstandingHead, UnderstandingHeadExpectation,
    UnderstandingHeadExpectationInput, UnderstandingHeadInput, UnderstandingRecord,
    UnderstandingRecordInput, UnderstandingRecordKind, UnderstandingStoreError,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    EnvelopeContext, EnvelopeContextInput, ExecutionGeneration, InteractionId,
    VOICE_AGENT_SCHEMA_VERSION,
};
use serde_json::{Value, json};

#[test]
fn record_is_canonical_bounded_and_redacted() {
    let record = record(UnderstandingRecordKind::EmotionFusion);

    assert_eq!(record.domain(), UnderstandingDomain::Emotion);
    assert_eq!(record.kind(), UnderstandingRecordKind::EmotionFusion);
    assert_eq!(record.record_id(), "record-001");
    assert_eq!(record.turn_index(), 7);
    assert_eq!(record.payload_hash().len(), 64);
    assert!(record.can_advance_head());
    let debug = format!("{record:?}");
    assert!(!debug.contains("customer.angry"));
    assert!(!debug.contains("private-slot"));
}

#[test]
fn raw_emotion_signal_is_durable_but_cannot_become_authoritative_head() {
    let record = record(UnderstandingRecordKind::EmotionObservation);
    assert_eq!(record.domain(), UnderstandingDomain::Emotion);
    assert!(!record.can_advance_head());
}

#[test]
fn raw_intent_contributors_and_resolution_are_durable_but_never_heads() {
    for kind in [
        UnderstandingRecordKind::IntentProviderObservation,
        UnderstandingRecordKind::IntentResolutionEvidence,
    ] {
        let record = record(kind);
        assert_eq!(record.domain(), UnderstandingDomain::Intent);
        assert!(!record.can_advance_head());
        assert_eq!(
            converact_conversation_understanding_store::AppendUnderstandingRecord::try_new(
                record,
                Some(
                    UnderstandingHeadExpectation::try_new(UnderstandingHeadExpectationInput {
                        expected_revision: 0,
                        expected_record_id: None,
                        expected_payload_hash: None,
                    })
                    .unwrap(),
                ),
            ),
            Err(UnderstandingStoreError::HeadAdvanceNotAllowed)
        );
    }
}

#[test]
fn malformed_payload_hash_retention_and_size_fail_closed() {
    let mut input = record_input(UnderstandingRecordKind::IntentObservation);
    input.payload_hash = "0".repeat(64);
    assert_eq!(
        UnderstandingRecord::try_new(input),
        Err(UnderstandingStoreError::InvalidRecord)
    );

    let mut input = record_input(UnderstandingRecordKind::IntentObservation);
    input.retention_until_ms = input.observed_at_ms;
    assert_eq!(
        UnderstandingRecord::try_new(input),
        Err(UnderstandingStoreError::InvalidRecord)
    );

    let mut input = record_input(UnderstandingRecordKind::IntentObservation);
    input.payload = Value::String("not-an-object".to_owned());
    input.payload_hash = canonical_sha256(&input.payload).unwrap();
    assert_eq!(
        UnderstandingRecord::try_new(input),
        Err(UnderstandingStoreError::InvalidRecord)
    );

    let mut input = record_input(UnderstandingRecordKind::IntentObservation);
    input.payload = json!({"value": "x".repeat(131_073)});
    input.payload_hash = "0".repeat(64);
    assert_eq!(
        UnderstandingRecord::try_new(input),
        Err(UnderstandingStoreError::InvalidRecord)
    );
}

#[test]
fn head_expectation_requires_exact_revision_record_and_hash_fence() {
    let initial = UnderstandingHeadExpectation::try_new(UnderstandingHeadExpectationInput {
        expected_revision: 0,
        expected_record_id: None,
        expected_payload_hash: None,
    })
    .unwrap();
    assert_eq!(initial.next_revision().unwrap(), 1);

    let current = UnderstandingHeadExpectation::try_new(UnderstandingHeadExpectationInput {
        expected_revision: 4,
        expected_record_id: Some("record-previous".to_owned()),
        expected_payload_hash: Some("a".repeat(64)),
    })
    .unwrap();
    assert_eq!(current.next_revision().unwrap(), 5);

    assert_eq!(
        UnderstandingHeadExpectation::try_new(UnderstandingHeadExpectationInput {
            expected_revision: 1,
            expected_record_id: None,
            expected_payload_hash: None,
        }),
        Err(UnderstandingStoreError::InvalidHeadExpectation)
    );
}

#[test]
fn stored_head_must_match_its_exact_immutable_record() {
    let record = record(UnderstandingRecordKind::IntentObservation);
    let exact = UnderstandingHead::try_new(UnderstandingHeadInput {
        context: record.context().clone(),
        kind: record.kind(),
        revision: 1,
        record_id: record.record_id().to_owned(),
        payload_hash: record.payload_hash().to_owned(),
        turn_index: record.turn_index(),
        observed_at_ms: record.observed_at_ms(),
    })
    .unwrap();
    assert!(StoredUnderstandingHead::try_new(exact, record.clone()).is_ok());

    let wrong_turn = UnderstandingHead::try_new(UnderstandingHeadInput {
        context: record.context().clone(),
        kind: record.kind(),
        revision: 1,
        record_id: record.record_id().to_owned(),
        payload_hash: record.payload_hash().to_owned(),
        turn_index: record.turn_index() + 1,
        observed_at_ms: record.observed_at_ms(),
    })
    .unwrap();
    assert_eq!(
        StoredUnderstandingHead::try_new(wrong_turn, record),
        Err(UnderstandingStoreError::StoredRowInvalid)
    );
}

fn record(kind: UnderstandingRecordKind) -> UnderstandingRecord {
    UnderstandingRecord::try_new(record_input(kind)).unwrap()
}

fn record_input(kind: UnderstandingRecordKind) -> UnderstandingRecordInput {
    let payload = json!({
        "emotion": "customer.angry",
        "slot": "private-slot",
        "turn": 7,
    });
    let payload_hash = canonical_sha256(&payload).unwrap();
    UnderstandingRecordInput {
        record_id: "record-001".to_owned(),
        context: context(),
        kind,
        turn_index: 7,
        observed_at_ms: 1_000,
        retention_policy_ref: "policy-30-days".to_owned(),
        retention_until_ms: 2_000,
        payload,
        payload_hash,
    }
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
        execution_generation: ExecutionGeneration::new(3).unwrap(),
        trace_id: "trace-001".to_owned(),
    })
    .unwrap()
}
