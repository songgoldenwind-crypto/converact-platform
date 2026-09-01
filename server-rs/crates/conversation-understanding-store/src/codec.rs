use converact_contracts::canonical_sha256;
use converact_conversation_understanding_core::{
    CustomerStateSnapshot, DialoguePolicy, DialogueRecommendation, EmotionCatalog,
    EmotionCheckpoint, IntentCatalog, IntentCheckpoint, UnderstandingError,
};

use crate::{
    UnderstandingRecord, UnderstandingRecordInput, UnderstandingRecordKind, UnderstandingStoreError,
};

/// Encodes one validated observation-plus-state checkpoint as an immutable Intent record.
///
/// # Errors
///
/// Rejects invalid retention fields or a payload that cannot be canonically hashed.
pub fn encode_intent_checkpoint(
    checkpoint: &IntentCheckpoint,
    retention_policy_ref: &str,
    retention_until_ms: u64,
) -> Result<UnderstandingRecord, UnderstandingStoreError> {
    let payload = checkpoint.to_value();
    let payload_hash =
        canonical_sha256(&payload).map_err(|_| UnderstandingStoreError::CheckpointInvalid)?;
    UnderstandingRecord::try_new(UnderstandingRecordInput {
        record_id: checkpoint.record_id().to_owned(),
        context: checkpoint.context().clone(),
        kind: UnderstandingRecordKind::IntentObservation,
        turn_index: checkpoint.turn_index(),
        observed_at_ms: checkpoint.observed_at_ms(),
        retention_policy_ref: retention_policy_ref.to_owned(),
        retention_until_ms,
        payload,
        payload_hash,
    })
}

/// Restores one Intent checkpoint from an exact immutable record without scanning history.
///
/// # Errors
///
/// Rejects kind, identity, authority, turn, clock, schema, catalog or projection drift.
pub fn restore_intent_checkpoint(
    record: &UnderstandingRecord,
    catalog: &IntentCatalog,
) -> Result<IntentCheckpoint, UnderstandingStoreError> {
    if record.kind() != UnderstandingRecordKind::IntentObservation {
        return Err(UnderstandingStoreError::CheckpointInvalid);
    }
    let checkpoint = IntentCheckpoint::from_value(record.payload().clone(), catalog)
        .map_err(map_understanding_error)?;
    if checkpoint.record_id() != record.record_id()
        || checkpoint.context() != record.context()
        || checkpoint.turn_index() != record.turn_index()
        || checkpoint.observed_at_ms() != record.observed_at_ms()
    {
        return Err(UnderstandingStoreError::CheckpointInvalid);
    }
    Ok(checkpoint)
}

/// Encodes one validated fusion-plus-state checkpoint as an immutable Emotion record.
///
/// # Errors
///
/// Rejects invalid retention fields or a payload that cannot be canonically hashed.
pub fn encode_emotion_checkpoint(
    checkpoint: &EmotionCheckpoint,
    retention_policy_ref: &str,
    retention_until_ms: u64,
) -> Result<UnderstandingRecord, UnderstandingStoreError> {
    let payload = checkpoint.to_value();
    let payload_hash =
        canonical_sha256(&payload).map_err(|_| UnderstandingStoreError::CheckpointInvalid)?;
    UnderstandingRecord::try_new(UnderstandingRecordInput {
        record_id: checkpoint.record_id().to_owned(),
        context: checkpoint.context().clone(),
        kind: UnderstandingRecordKind::EmotionFusion,
        turn_index: checkpoint.turn_index(),
        observed_at_ms: checkpoint.observed_at_ms(),
        retention_policy_ref: retention_policy_ref.to_owned(),
        retention_until_ms,
        payload,
        payload_hash,
    })
}

/// Restores one fused Emotion checkpoint from its immutable head record without history replay.
///
/// # Errors
///
/// Rejects kind, identity, authority, turn, clock, schema, catalog or projection drift.
pub fn restore_emotion_checkpoint(
    record: &UnderstandingRecord,
    catalog: &EmotionCatalog,
) -> Result<EmotionCheckpoint, UnderstandingStoreError> {
    if record.kind() != UnderstandingRecordKind::EmotionFusion {
        return Err(UnderstandingStoreError::CheckpointInvalid);
    }
    let checkpoint = EmotionCheckpoint::from_value(record.payload().clone(), catalog)
        .map_err(map_understanding_error)?;
    if checkpoint.record_id() != record.record_id()
        || checkpoint.context() != record.context()
        || checkpoint.turn_index() != record.turn_index()
        || checkpoint.observed_at_ms() != record.observed_at_ms()
    {
        return Err(UnderstandingStoreError::CheckpointInvalid);
    }
    Ok(checkpoint)
}

/// Encodes one validated Customer State aggregate as its immutable latest-head record.
///
/// # Errors
///
/// Rejects invalid retention fields or a payload that cannot be canonically hashed.
pub fn encode_customer_state_snapshot(
    snapshot: &CustomerStateSnapshot,
    retention_policy_ref: &str,
    retention_until_ms: u64,
) -> Result<UnderstandingRecord, UnderstandingStoreError> {
    let payload = snapshot.to_value();
    let payload_hash =
        canonical_sha256(&payload).map_err(|_| UnderstandingStoreError::CheckpointInvalid)?;
    UnderstandingRecord::try_new(UnderstandingRecordInput {
        record_id: snapshot.record_id().to_owned(),
        context: snapshot.context().clone(),
        kind: UnderstandingRecordKind::CustomerStateSnapshot,
        turn_index: snapshot.turn_index(),
        observed_at_ms: snapshot.observed_at_ms(),
        retention_policy_ref: retention_policy_ref.to_owned(),
        retention_until_ms,
        payload,
        payload_hash,
    })
}

/// Restores one Customer State aggregate from an immutable head record without history replay.
///
/// # Errors
///
/// Rejects kind, identity, authority, turn, clock, schema, catalog or aggregate hash drift.
pub fn restore_customer_state_snapshot(
    record: &UnderstandingRecord,
    intent_state: &converact_conversation_understanding_core::IntentState,
    emotion_state: &converact_conversation_understanding_core::EmotionState,
) -> Result<CustomerStateSnapshot, UnderstandingStoreError> {
    if record.kind() != UnderstandingRecordKind::CustomerStateSnapshot {
        return Err(UnderstandingStoreError::CheckpointInvalid);
    }
    let snapshot =
        CustomerStateSnapshot::from_value(record.payload().clone(), intent_state, emotion_state)
            .map_err(map_understanding_error)?;
    if snapshot.record_id() != record.record_id()
        || snapshot.context() != record.context()
        || snapshot.turn_index() != record.turn_index()
        || snapshot.observed_at_ms() != record.observed_at_ms()
    {
        return Err(UnderstandingStoreError::CheckpointInvalid);
    }
    Ok(snapshot)
}

/// Encodes one deterministic Dialogue recommendation linked to its exact Customer State.
///
/// # Errors
///
/// Rejects source-state drift, invalid retention fields or non-canonical payloads.
pub fn encode_dialogue_recommendation(
    recommendation: &DialogueRecommendation,
    state: &CustomerStateSnapshot,
    retention_policy_ref: &str,
    retention_until_ms: u64,
) -> Result<UnderstandingRecord, UnderstandingStoreError> {
    if recommendation.context() != state.context()
        || recommendation.customer_state_snapshot_id() != state.record_id()
        || recommendation.customer_state_payload_hash() != state.payload_hash()
    {
        return Err(UnderstandingStoreError::CheckpointInvalid);
    }
    let payload = recommendation.to_value();
    let payload_hash =
        canonical_sha256(&payload).map_err(|_| UnderstandingStoreError::CheckpointInvalid)?;
    UnderstandingRecord::try_new(UnderstandingRecordInput {
        record_id: recommendation.record_id().to_owned(),
        context: recommendation.context().clone(),
        kind: UnderstandingRecordKind::DialogueRecommendation,
        turn_index: state.turn_index(),
        observed_at_ms: recommendation.evaluated_at_ms(),
        retention_policy_ref: retention_policy_ref.to_owned(),
        retention_until_ms,
        payload,
        payload_hash,
    })
}

/// Restores one Dialogue recommendation by deterministic policy re-evaluation.
///
/// # Errors
///
/// Rejects kind, source-state, authority, turn, clock, policy or projection drift.
pub fn restore_dialogue_recommendation(
    record: &UnderstandingRecord,
    policy: &DialoguePolicy,
    state: &CustomerStateSnapshot,
) -> Result<DialogueRecommendation, UnderstandingStoreError> {
    if record.kind() != UnderstandingRecordKind::DialogueRecommendation
        || record.context() != state.context()
        || record.turn_index() != state.turn_index()
    {
        return Err(UnderstandingStoreError::CheckpointInvalid);
    }
    let recommendation =
        DialogueRecommendation::from_value(record.payload().clone(), policy, state)
            .map_err(map_understanding_error)?;
    if recommendation.record_id() != record.record_id()
        || recommendation.context() != record.context()
        || recommendation.evaluated_at_ms() != record.observed_at_ms()
    {
        return Err(UnderstandingStoreError::CheckpointInvalid);
    }
    Ok(recommendation)
}

const fn map_understanding_error(_error: UnderstandingError) -> UnderstandingStoreError {
    UnderstandingStoreError::CheckpointInvalid
}
