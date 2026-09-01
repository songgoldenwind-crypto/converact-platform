use std::collections::BTreeMap;

use converact_contracts::canonical_sha256;
use converact_conversation_understanding_core::{
    IntentCandidateInput, IntentCatalog, IntentCatalogInput, IntentCheckpoint,
    IntentDecisionPolicy, IntentDefinitionInput, IntentObservation, IntentObservationInput,
    IntentSource, IntentState,
};
use converact_conversation_understanding_store::{
    UnderstandingRecord, UnderstandingRecordInput, UnderstandingStoreError,
    encode_intent_checkpoint, restore_intent_checkpoint,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId, EnvelopeContext,
    EnvelopeContextInput, ExecutionGeneration, IntentCatalogRevisionId, IntentObservationId,
    InteractionId, TranscriptSegmentId, VOICE_AGENT_SCHEMA_VERSION,
};

#[test]
fn latest_intent_checkpoint_round_trips_without_history_scan_or_debug_disclosure() {
    let catalog = catalog();
    let observation = observation(&catalog);
    let state = IntentState::new(context(), catalog.id().clone())
        .observe(
            &observation,
            &catalog,
            IntentDecisionPolicy::try_new(5_500, 8_000, 1_500, 9_500).unwrap(),
        )
        .unwrap();
    let checkpoint = IntentCheckpoint::try_new(observation, state).unwrap();

    let record =
        encode_intent_checkpoint(&checkpoint, "understanding-30-days-v1", 2_592_001_000).unwrap();
    let restored = restore_intent_checkpoint(&record, &catalog).unwrap();

    assert_eq!(restored, checkpoint);
    assert_eq!(record.record_id(), "intent-observation-001");
    assert_eq!(record.turn_index(), 1);
    let debug = format!("{record:?} {restored:?}");
    assert!(!debug.contains("callback.specific_time"));
    assert!(!debug.contains("tomorrow-15:00"));
}

#[test]
fn checkpoint_payload_or_record_identity_drift_fails_closed() {
    let catalog = catalog();
    let observation = observation(&catalog);
    let state = IntentState::new(context(), catalog.id().clone())
        .observe(
            &observation,
            &catalog,
            IntentDecisionPolicy::try_new(5_500, 8_000, 1_500, 9_500).unwrap(),
        )
        .unwrap();
    let checkpoint = IntentCheckpoint::try_new(observation, state).unwrap();
    let record =
        encode_intent_checkpoint(&checkpoint, "understanding-30-days-v1", 2_592_001_000).unwrap();

    let mut payload = record.payload().clone();
    payload["state"]["confirmed_intent"] = serde_json::json!("sales.reject");
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
        restore_intent_checkpoint(&forged, &catalog),
        Err(UnderstandingStoreError::CheckpointInvalid)
    );

    let wrong_id = UnderstandingRecord::try_new(UnderstandingRecordInput {
        record_id: "intent-observation-other".to_owned(),
        context: record.context().clone(),
        kind: record.kind(),
        turn_index: record.turn_index(),
        observed_at_ms: record.observed_at_ms(),
        retention_policy_ref: record.retention_policy_ref().to_owned(),
        retention_until_ms: record.retention_until_ms(),
        payload: record.payload().clone(),
        payload_hash: record.payload_hash().to_owned(),
    })
    .unwrap();
    assert_eq!(
        restore_intent_checkpoint(&wrong_id, &catalog),
        Err(UnderstandingStoreError::CheckpointInvalid)
    );
}

fn observation(catalog: &IntentCatalog) -> IntentObservation {
    IntentObservation::try_new(
        IntentObservationInput {
            id: IntentObservationId::parse("intent-observation-001").unwrap(),
            context: context(),
            catalog_revision_id: catalog.id().clone(),
            source: IntentSource::ContextualLlm,
            provider_revision: "intent-provider-v1".to_owned(),
            candidates: vec![IntentCandidateInput {
                code: "callback.specific_time".to_owned(),
                confidence_bps: 9_200,
            }],
            slots: BTreeMap::from([("callback_time".to_owned(), "tomorrow-15:00".to_owned())]),
            evidence_segment_ids: vec![TranscriptSegmentId::parse("segment-001").unwrap()],
            turn_index: 1,
            observed_at_ms: 1_000,
        },
        catalog,
    )
    .unwrap()
}

fn catalog() -> IntentCatalog {
    IntentCatalog::try_new(IntentCatalogInput {
        id: IntentCatalogRevisionId::parse("intent-catalog-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        definitions: vec![
            IntentDefinitionInput {
                code: "callback".to_owned(),
                parent_code: None,
                slot_keys: Vec::new(),
                safety_critical: false,
            },
            IntentDefinitionInput {
                code: "callback.specific_time".to_owned(),
                parent_code: Some("callback".to_owned()),
                slot_keys: vec!["callback_time".to_owned()],
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
