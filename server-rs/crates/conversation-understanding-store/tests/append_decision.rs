use converact_contracts::canonical_sha256;
use converact_conversation_understanding_store::{
    AppendAction, AppendUnderstandingRecord, RecordPresence, UnderstandingHead,
    UnderstandingHeadExpectation, UnderstandingHeadExpectationInput, UnderstandingHeadInput,
    UnderstandingRecord, UnderstandingRecordInput, UnderstandingRecordKind,
    UnderstandingStoreError,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    EnvelopeContext, EnvelopeContextInput, ExecutionGeneration, InteractionId,
    VOICE_AGENT_SCHEMA_VERSION,
};
use serde_json::json;

#[test]
fn record_only_append_is_idempotent_without_touching_a_head() {
    let command = AppendUnderstandingRecord::try_new(record("record-001", 1, 1_000), None).unwrap();
    assert_eq!(
        command.decide(RecordPresence::Absent, None).unwrap(),
        AppendAction::InsertRecordOnly
    );
    assert_eq!(
        command.decide(RecordPresence::Exact, None).unwrap(),
        AppendAction::ReplayRecordOnly
    );
    assert_eq!(
        command.decide(RecordPresence::Conflict, None),
        Err(UnderstandingStoreError::Conflict)
    );
}

#[test]
fn absent_head_is_created_once_and_exact_current_record_replays() {
    let command = AppendUnderstandingRecord::try_new(
        record("record-001", 1, 1_000),
        Some(expectation(0, None, None)),
    )
    .unwrap();
    assert_eq!(
        command.decide(RecordPresence::Absent, None).unwrap(),
        AppendAction::InsertRecordAndCreateHead { head_revision: 1 }
    );

    let current = head(1, "record-001", command.record().payload_hash(), 1, 1_000);
    assert_eq!(
        command
            .decide(RecordPresence::Exact, Some(&current))
            .unwrap(),
        AppendAction::ReplayCurrent { head_revision: 1 }
    );
}

#[test]
fn exact_previous_fence_advances_once_and_stale_writer_fails_closed() {
    let previous_record = record("record-previous", 1, 1_000);
    let current = head(
        4,
        previous_record.record_id(),
        previous_record.payload_hash(),
        1,
        1_000,
    );
    let next = record("record-next", 2, 1_100);
    let command = AppendUnderstandingRecord::try_new(
        next,
        Some(expectation(
            4,
            Some(previous_record.record_id()),
            Some(previous_record.payload_hash()),
        )),
    )
    .unwrap();
    assert_eq!(
        command
            .decide(RecordPresence::Absent, Some(&current))
            .unwrap(),
        AppendAction::InsertRecordAndAdvanceHead { head_revision: 5 }
    );

    let stale = AppendUnderstandingRecord::try_new(
        record("record-stale", 3, 1_200),
        Some(expectation(
            3,
            Some(previous_record.record_id()),
            Some(previous_record.payload_hash()),
        )),
    )
    .unwrap();
    assert_eq!(
        stale.decide(RecordPresence::Absent, Some(&current)),
        Err(UnderstandingStoreError::StaleFence)
    );
}

#[test]
fn durable_record_can_be_promoted_but_head_cannot_move_backwards() {
    let previous = record("record-previous", 2, 1_100);
    let current = head(2, "record-current", &"b".repeat(64), 3, 1_300);
    let promote = AppendUnderstandingRecord::try_new(
        previous,
        Some(expectation(
            2,
            Some(current.record_id()),
            Some(current.payload_hash()),
        )),
    )
    .unwrap();
    assert_eq!(
        promote.decide(RecordPresence::Exact, Some(&current)),
        Err(UnderstandingStoreError::StaleFence)
    );

    let next = record("record-promoted", 4, 1_400);
    let promote = AppendUnderstandingRecord::try_new(
        next,
        Some(expectation(
            2,
            Some(current.record_id()),
            Some(current.payload_hash()),
        )),
    )
    .unwrap();
    assert_eq!(
        promote
            .decide(RecordPresence::Exact, Some(&current))
            .unwrap(),
        AppendAction::ReuseRecordAndAdvanceHead { head_revision: 3 }
    );
}

#[test]
fn raw_emotion_observation_cannot_become_a_head() {
    let mut input = record_input("emotion-raw", 1, 1_000);
    input.kind = UnderstandingRecordKind::EmotionObservation;
    assert_eq!(
        AppendUnderstandingRecord::try_new(
            UnderstandingRecord::try_new(input).unwrap(),
            Some(expectation(0, None, None)),
        ),
        Err(UnderstandingStoreError::HeadAdvanceNotAllowed)
    );
}

fn expectation(
    revision: u64,
    record_id: Option<&str>,
    payload_hash: Option<&str>,
) -> UnderstandingHeadExpectation {
    UnderstandingHeadExpectation::try_new(UnderstandingHeadExpectationInput {
        expected_revision: revision,
        expected_record_id: record_id.map(str::to_owned),
        expected_payload_hash: payload_hash.map(str::to_owned),
    })
    .unwrap()
}

fn head(
    revision: u64,
    record_id: &str,
    payload_hash: &str,
    turn_index: u32,
    observed_at_ms: u64,
) -> UnderstandingHead {
    UnderstandingHead::try_new(UnderstandingHeadInput {
        context: context(),
        kind: UnderstandingRecordKind::IntentObservation,
        revision,
        record_id: record_id.to_owned(),
        payload_hash: payload_hash.to_owned(),
        turn_index,
        observed_at_ms,
    })
    .unwrap()
}

fn record(record_id: &str, turn_index: u32, observed_at_ms: u64) -> UnderstandingRecord {
    UnderstandingRecord::try_new(record_input(record_id, turn_index, observed_at_ms)).unwrap()
}

fn record_input(record_id: &str, turn_index: u32, observed_at_ms: u64) -> UnderstandingRecordInput {
    let payload = json!({"record_id": record_id, "turn": turn_index});
    UnderstandingRecordInput {
        record_id: record_id.to_owned(),
        context: context(),
        kind: UnderstandingRecordKind::IntentObservation,
        turn_index,
        observed_at_ms,
        retention_policy_ref: "policy-30-days".to_owned(),
        retention_until_ms: 9_999,
        payload_hash: canonical_sha256(&payload).unwrap(),
        payload,
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
