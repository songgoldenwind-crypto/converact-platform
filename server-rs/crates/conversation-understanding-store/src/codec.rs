use converact_contracts::canonical_sha256;
use converact_conversation_understanding_core::{
    EmotionCatalog, EmotionCheckpoint, IntentCatalog, IntentCheckpoint, UnderstandingError,
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

const fn map_understanding_error(_error: UnderstandingError) -> UnderstandingStoreError {
    UnderstandingStoreError::CheckpointInvalid
}
