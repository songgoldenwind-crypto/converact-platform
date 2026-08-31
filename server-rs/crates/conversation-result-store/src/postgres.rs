use converact_contracts::canonical_sha256;
use converact_conversation_result_core::{
    ConversationResult, TranscriptGenerationStatus, TranscriptSegment, TranscriptSnapshot,
};
use converact_voice_agent_contracts::ExecutionGeneration;
use serde_json::{Value, json};
use tokio_postgres::{Row, Transaction};

use crate::{
    ConversationResultStoreError, EvaluationProjectionWrite, ProjectionCommand,
    ProjectionFinalizeDecision, ProjectionPrepareDecision, ProjectionWriteDecision,
    TranscriptAppendDecision, canonical_bad_case_payload_hash,
};

/// Stateless tenant-scoped `PostgreSQL` adapter for conversation result projections.
#[derive(Clone, Copy, Debug, Default)]
pub struct ConversationResultSqlStore;

impl ConversationResultSqlStore {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// Atomically prepares one Provider projection command or classifies its exact replay.
    ///
    /// # Errors
    ///
    /// Rejects tenant/command conflicts, conversion failures, database failures or malformed
    /// stored rows. A `Query` decision means the prior Provider outcome remains unknown.
    pub async fn prepare_projection_command(
        &self,
        transaction: &Transaction<'_>,
        tenant_id: &str,
        command: &ProjectionCommand,
    ) -> Result<ProjectionPrepareDecision, ConversationResultStoreError> {
        if let Some(decision) = classify_projection_command(transaction, tenant_id, command).await?
        {
            return Ok(decision);
        }
        let revision = command
            .expected_result_revision()
            .map(i64_from)
            .transpose()?;
        let generation = i64_from(command.expected_generation().get())?;
        let inserted = transaction
            .query_opt(
                "INSERT INTO converact_conversation_projection_commands (
                   tenant_id, command_id, interaction_id, command_kind, payload_hash,
                   expected_result_revision, expected_execution_generation, command_state
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'prepared')
                 ON CONFLICT DO NOTHING
                 RETURNING floor(extract(epoch FROM prepared_at) * 1000)::BIGINT",
                &[
                    &tenant_id,
                    &command.id().as_str(),
                    &command.interaction_id().as_str(),
                    &command.kind().as_str(),
                    &command.payload_hash(),
                    &revision,
                    &generation,
                ],
            )
            .await
            .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
        let Some(row) = inserted else {
            return classify_projection_command(transaction, tenant_id, command)
                .await?
                .ok_or(ConversationResultStoreError::Conflict);
        };
        let observed_at_ms = u64_from(i64_at(&row, 0)?)?;
        insert_projection_receipt(
            transaction,
            ProjectionReceiptInput {
                tenant_id,
                command,
                stage: "prepared",
                resolution: None,
                failure_code: None,
                observed_entity_id: None,
                observed_payload_hash: None,
                observed_at_ms,
            },
        )
        .await?;
        Ok(ProjectionPrepareDecision::Execute)
    }

    /// Records a definitively applied Provider projection and immutable state-observed receipt.
    ///
    /// # Errors
    ///
    /// Rejects missing/mismatched prepare evidence, malformed observations, conflicts, database
    /// failures or malformed stored rows.
    pub async fn finalize_projection_applied(
        &self,
        transaction: &Transaction<'_>,
        tenant_id: &str,
        command: &ProjectionCommand,
        observed_entity_id: &str,
        observed_payload_hash: &str,
    ) -> Result<ProjectionFinalizeDecision, ConversationResultStoreError> {
        if !bounded_identifier(observed_entity_id, 255) || !lowercase_sha256(observed_payload_hash)
        {
            return Err(ConversationResultStoreError::InvalidCommand);
        }
        let row = lock_projection_command(transaction, tenant_id, command).await?;
        let state = string_at(&row, 0)?;
        if state == "state_observed" {
            return verify_final_projection_replay(
                &row,
                Some("applied"),
                None,
                Some(observed_entity_id),
                Some(observed_payload_hash),
            );
        }
        if state != "prepared" {
            return Err(ConversationResultStoreError::StoredRowInvalid);
        }
        let observed_at_ms = update_projection_command(
            transaction,
            tenant_id,
            command,
            "applied",
            None,
            Some(observed_entity_id),
            Some(observed_payload_hash),
        )
        .await?;
        insert_projection_receipt(
            transaction,
            ProjectionReceiptInput {
                tenant_id,
                command,
                stage: "state_observed",
                resolution: Some("applied"),
                failure_code: None,
                observed_entity_id: Some(observed_entity_id),
                observed_payload_hash: Some(observed_payload_hash),
                observed_at_ms,
            },
        )
        .await?;
        Ok(ProjectionFinalizeDecision::Applied)
    }

    /// Records a definitive non-applied Provider projection without inventing an entity.
    ///
    /// # Errors
    ///
    /// Rejects missing/mismatched prepare evidence, malformed failure codes, conflicts, database
    /// failures or malformed stored rows.
    pub async fn finalize_projection_not_applied(
        &self,
        transaction: &Transaction<'_>,
        tenant_id: &str,
        command: &ProjectionCommand,
        failure_code: &str,
    ) -> Result<ProjectionFinalizeDecision, ConversationResultStoreError> {
        if !bounded_identifier(failure_code, 255) {
            return Err(ConversationResultStoreError::InvalidCommand);
        }
        let row = lock_projection_command(transaction, tenant_id, command).await?;
        let state = string_at(&row, 0)?;
        if state == "state_observed" {
            return verify_final_projection_replay(
                &row,
                Some("not_applied"),
                Some(failure_code),
                None,
                None,
            );
        }
        if state != "prepared" {
            return Err(ConversationResultStoreError::StoredRowInvalid);
        }
        let observed_at_ms = update_projection_command(
            transaction,
            tenant_id,
            command,
            "not_applied",
            Some(failure_code),
            None,
            None,
        )
        .await?;
        insert_projection_receipt(
            transaction,
            ProjectionReceiptInput {
                tenant_id,
                command,
                stage: "state_observed",
                resolution: Some("not_applied"),
                failure_code: Some(failure_code),
                observed_entity_id: None,
                observed_payload_hash: None,
                observed_at_ms,
            },
        )
        .await?;
        Ok(ProjectionFinalizeDecision::NotApplied)
    }

    /// Appends one immutable final transcript segment or classifies an exact replay.
    ///
    /// # Errors
    ///
    /// Rejects future generations, conflicting idempotency identities, conversion failures,
    /// database failures or malformed stored rows.
    pub async fn append_final_segment(
        &self,
        transaction: &Transaction<'_>,
        segment: &TranscriptSegment,
        current_generation: ExecutionGeneration,
    ) -> Result<TranscriptAppendDecision, ConversationResultStoreError> {
        let status = segment
            .generation_status(current_generation)
            .map_err(|_| ConversationResultStoreError::Conflict)?;
        let context = segment.context();
        let generation = i64_from(context.execution_generation().get())?;
        let sequence = i64_from(segment.sequence())?;
        let start_offset_ms = i64_from(segment.start_offset_ms())?;
        let end_offset_ms = i64_from(segment.end_offset_ms())?;
        let observed_at_ms = i64_from(segment.observed_at_ms())?;
        let historical = status == TranscriptGenerationStatus::Historical;
        let inserted = transaction
            .query_opt(
                "INSERT INTO converact_conversation_transcript_segments (
                   tenant_id, segment_id, interaction_id, call_attempt_id, agent_release_id,
                   source_event_id, execution_generation, segment_sequence, speaker, language,
                   transcript_text, start_offset_ms, end_offset_ms, observed_at,
                   retention_policy_ref, payload_hash, historical
                 ) VALUES (
                   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                   to_timestamp($14::DOUBLE PRECISION / 1000.0), $15, $16, $17
                 ) ON CONFLICT DO NOTHING RETURNING segment_id",
                &[
                    &context.tenant_id(),
                    &segment.id().as_str(),
                    &context.interaction_id().as_str(),
                    &context.call_attempt_id().as_str(),
                    &context.agent_release_id().as_str(),
                    &segment.source_event_id().as_str(),
                    &generation,
                    &sequence,
                    &segment.speaker().as_str(),
                    &segment.language(),
                    &segment.text(),
                    &start_offset_ms,
                    &end_offset_ms,
                    &observed_at_ms,
                    &segment.retention_policy_ref(),
                    &segment.payload_hash(),
                    &historical,
                ],
            )
            .await
            .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
        if inserted.is_some() {
            return Ok(TranscriptAppendDecision::Appended(status));
        }
        verify_segment_replay(transaction, segment, generation, sequence, historical).await?;
        Ok(TranscriptAppendDecision::Replay(status))
    }

    /// Freezes one immutable terminal snapshot after re-deriving its digest from stored segments.
    ///
    /// # Errors
    ///
    /// Rejects missing/extra segment rows, digest drift, conflicting revisions, database failures
    /// or malformed stored rows.
    pub async fn freeze_snapshot(
        &self,
        transaction: &Transaction<'_>,
        snapshot: &TranscriptSnapshot,
    ) -> Result<ProjectionWriteDecision, ConversationResultStoreError> {
        verify_snapshot_segments(transaction, snapshot).await?;
        if let Some(decision) = classify_existing_snapshot(transaction, snapshot).await? {
            return Ok(decision);
        }
        verify_next_snapshot_revision(transaction, snapshot).await?;
        let context = snapshot.context();
        let revision = i64_from(snapshot.revision().get())?;
        let segment_count = i64::try_from(snapshot.segment_count())
            .map_err(|_| ConversationResultStoreError::NumericOverflow)?;
        let max_generation = i64_from(snapshot.current_generation().get())?;
        let frozen_at_ms = i64_from(snapshot.frozen_at_ms())?;
        let inserted = transaction
            .query_opt(
                "INSERT INTO converact_conversation_snapshots (
                   tenant_id, snapshot_id, interaction_id, call_attempt_id, agent_release_id,
                   snapshot_revision, transcript_snapshot_digest, segment_count,
                   max_execution_generation, call_terminal_observed, agent_terminal_observed,
                   transcript_terminal_observed, payload_hash, frozen_at
                 ) VALUES (
                   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                   to_timestamp($14::DOUBLE PRECISION / 1000.0)
                 ) ON CONFLICT DO NOTHING RETURNING snapshot_id",
                &[
                    &context.tenant_id(),
                    &snapshot.id().as_str(),
                    &context.interaction_id().as_str(),
                    &context.call_attempt_id().as_str(),
                    &context.agent_release_id().as_str(),
                    &revision,
                    &snapshot.transcript_snapshot_digest(),
                    &segment_count,
                    &max_generation,
                    &snapshot.call_terminal_observed(),
                    &snapshot.agent_terminal_observed(),
                    &snapshot.transcript_terminal_observed(),
                    &snapshot.payload_hash(),
                    &frozen_at_ms,
                ],
            )
            .await
            .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
        if inserted.is_some() {
            return Ok(ProjectionWriteDecision::Created);
        }
        classify_existing_snapshot(transaction, snapshot)
            .await?
            .ok_or(ConversationResultStoreError::Conflict)
    }

    /// Persists one immutable, schema-validated result with a continuous interaction revision.
    ///
    /// # Errors
    ///
    /// Rejects missing snapshots, revision gaps, conflicting replays, database failures or
    /// malformed stored rows.
    pub async fn persist_result(
        &self,
        transaction: &Transaction<'_>,
        result: &ConversationResult,
    ) -> Result<ProjectionWriteDecision, ConversationResultStoreError> {
        verify_result_snapshot(transaction, result).await?;
        if let Some(decision) = classify_existing_result(transaction, result).await? {
            return Ok(decision);
        }
        verify_next_result_revision(transaction, result).await?;

        let context = result.context();
        let revision = i64_from(result.revision().get())?;
        let confidence_bps = i32::from(result.confidence_bps());
        let created_at_ms = i64_from(result.created_at_ms())?;
        let attributes = serde_json::to_value(result.attributes())
            .map_err(|_| ConversationResultStoreError::SerializationFailed)?;
        let inserted = transaction
            .query_opt(
                "INSERT INTO converact_conversation_results (
                   tenant_id, result_id, interaction_id, call_attempt_id, agent_release_id,
                   result_revision, outcome_schema_revision_id, transcript_snapshot_digest,
                   summary_artifact_ref, intent_code, disposition_code, outcome_code,
                   confidence_bps, attributes, payload_hash, created_at
                 ) VALUES (
                   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                   to_timestamp($16::DOUBLE PRECISION / 1000.0)
                 ) ON CONFLICT DO NOTHING RETURNING result_id",
                &[
                    &context.tenant_id(),
                    &result.id().as_str(),
                    &context.interaction_id().as_str(),
                    &context.call_attempt_id().as_str(),
                    &context.agent_release_id().as_str(),
                    &revision,
                    &result.outcome_schema_revision_id().as_str(),
                    &result.transcript_snapshot_digest(),
                    &result.summary_artifact_ref(),
                    &result.intent(),
                    &result.disposition(),
                    &result.outcome_code(),
                    &confidence_bps,
                    &attributes,
                    &result.payload_hash(),
                    &created_at_ms,
                ],
            )
            .await
            .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
        if inserted.is_some() {
            return Ok(ProjectionWriteDecision::Created);
        }
        classify_existing_result(transaction, result)
            .await?
            .ok_or(ConversationResultStoreError::Conflict)
    }

    /// Persists an immutable evaluation and its platform-derived Bad Case row atomically.
    ///
    /// # Errors
    ///
    /// Rejects missing/mismatched results, conflicting replays, database failures or malformed
    /// stored rows. The caller must roll back the transaction on every error.
    pub async fn persist_evaluation(
        &self,
        transaction: &Transaction<'_>,
        write: &EvaluationProjectionWrite<'_>,
    ) -> Result<ProjectionWriteDecision, ConversationResultStoreError> {
        verify_evaluation_result(transaction, write).await?;
        verify_evaluation_evidence(transaction, write).await?;
        if let Some(decision) = classify_existing_evaluation(transaction, write).await? {
            verify_bad_case_projection(transaction, write).await?;
            return Ok(decision);
        }

        let result = write.result();
        let evaluation = write.evaluation();
        let dimension_scores = serde_json::to_value(evaluation.dimension_scores_bps())
            .map_err(|_| ConversationResultStoreError::SerializationFailed)?;
        let evidence_segment_ids = serde_json::to_value(evaluation.evidence_segment_ids())
            .map_err(|_| ConversationResultStoreError::SerializationFailed)?;
        let violation_codes = serde_json::to_value(evaluation.violation_codes())
            .map_err(|_| ConversationResultStoreError::SerializationFailed)?;
        let bad_case_reasons = serde_json::to_value(
            evaluation
                .bad_case_reasons()
                .iter()
                .map(|reason| reason.as_str())
                .collect::<Vec<_>>(),
        )
        .map_err(|_| ConversationResultStoreError::SerializationFailed)?;
        let result_revision = i64_from(evaluation.result_revision().get())?;
        let overall_score_bps = i32::from(evaluation.overall_score_bps());
        let created_at_ms = i64_from(evaluation.created_at_ms())?;
        let inserted = transaction
            .query_opt(
                "INSERT INTO converact_conversation_evaluations (
                   tenant_id, evaluation_id, interaction_id, result_id, result_revision,
                   evaluator_release_id, evaluation_rubric_revision_id, dimension_scores,
                   evidence_segment_ids, violation_codes, overall_score_bps, quality_grade,
                   bad_case_reasons, payload_hash, created_at
                 ) VALUES (
                   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                   to_timestamp($15::DOUBLE PRECISION / 1000.0)
                 ) ON CONFLICT DO NOTHING RETURNING evaluation_id",
                &[
                    &result.context().tenant_id(),
                    &evaluation.id().as_str(),
                    &result.context().interaction_id().as_str(),
                    &evaluation.result_id().as_str(),
                    &result_revision,
                    &evaluation.evaluator_release_id().as_str(),
                    &evaluation.rubric_revision_id().as_str(),
                    &dimension_scores,
                    &evidence_segment_ids,
                    &violation_codes,
                    &overall_score_bps,
                    &evaluation.grade().as_str(),
                    &bad_case_reasons,
                    &evaluation.payload_hash(),
                    &created_at_ms,
                ],
            )
            .await
            .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
        if inserted.is_none() {
            let decision = classify_existing_evaluation(transaction, write)
                .await?
                .ok_or(ConversationResultStoreError::Conflict)?;
            verify_bad_case_projection(transaction, write).await?;
            return Ok(decision);
        }
        insert_bad_case_projection(transaction, write, &bad_case_reasons, created_at_ms).await?;
        Ok(ProjectionWriteDecision::Created)
    }
}

async fn classify_projection_command(
    transaction: &Transaction<'_>,
    tenant_id: &str,
    command: &ProjectionCommand,
) -> Result<Option<ProjectionPrepareDecision>, ConversationResultStoreError> {
    let row = transaction
        .query_opt(
            "SELECT interaction_id, command_kind, payload_hash, expected_result_revision,
                    expected_execution_generation, command_state, resolution
             FROM converact_conversation_projection_commands
             WHERE tenant_id = $1 AND command_id = $2 FOR UPDATE",
            &[&tenant_id, &command.id().as_str()],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
    let Some(row) = row else {
        return Ok(None);
    };
    verify_projection_command_identity(&row, command)?;
    let state = string_at(&row, 5)?;
    let resolution = optional_string_at(&row, 6)?;
    match (state.as_str(), resolution.as_deref()) {
        ("prepared", None) => Ok(Some(ProjectionPrepareDecision::Query)),
        ("state_observed", Some("applied")) => Ok(Some(ProjectionPrepareDecision::ReplayApplied)),
        ("state_observed", Some("not_applied")) => {
            Ok(Some(ProjectionPrepareDecision::ReplayNotApplied))
        }
        _ => Err(ConversationResultStoreError::StoredRowInvalid),
    }
}

async fn lock_projection_command(
    transaction: &Transaction<'_>,
    tenant_id: &str,
    command: &ProjectionCommand,
) -> Result<Row, ConversationResultStoreError> {
    let row = transaction
        .query_opt(
            "SELECT command_state, resolution, failure_code, observed_entity_id,
                    observed_payload_hash, interaction_id, command_kind, payload_hash,
                    expected_result_revision, expected_execution_generation
             FROM converact_conversation_projection_commands
             WHERE tenant_id = $1 AND command_id = $2 FOR UPDATE",
            &[&tenant_id, &command.id().as_str()],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?
        .ok_or(ConversationResultStoreError::Conflict)?;
    verify_projection_command_identity_offset(&row, command, 5)?;
    Ok(row)
}

fn verify_projection_command_identity(
    row: &Row,
    command: &ProjectionCommand,
) -> Result<(), ConversationResultStoreError> {
    verify_projection_command_identity_offset(row, command, 0)
}

fn verify_projection_command_identity_offset(
    row: &Row,
    command: &ProjectionCommand,
    offset: usize,
) -> Result<(), ConversationResultStoreError> {
    let stored_revision: Option<i64> = row
        .try_get(offset + 3)
        .map_err(|_| ConversationResultStoreError::StoredRowInvalid)?;
    let expected_revision = command
        .expected_result_revision()
        .map(i64_from)
        .transpose()?;
    if string_at(row, offset)? != command.interaction_id().as_str()
        || string_at(row, offset + 1)? != command.kind().as_str()
        || string_at(row, offset + 2)? != command.payload_hash()
        || stored_revision != expected_revision
        || i64_at(row, offset + 4)? != i64_from(command.expected_generation().get())?
    {
        return Err(ConversationResultStoreError::Conflict);
    }
    Ok(())
}

fn verify_final_projection_replay(
    row: &Row,
    resolution: Option<&str>,
    failure_code: Option<&str>,
    observed_entity_id: Option<&str>,
    observed_payload_hash: Option<&str>,
) -> Result<ProjectionFinalizeDecision, ConversationResultStoreError> {
    if optional_string_at(row, 1)?.as_deref() != resolution
        || optional_string_at(row, 2)?.as_deref() != failure_code
        || optional_string_at(row, 3)?.as_deref() != observed_entity_id
        || optional_string_at(row, 4)?.as_deref() != observed_payload_hash
    {
        return Err(ConversationResultStoreError::Conflict);
    }
    match resolution {
        Some("applied") => Ok(ProjectionFinalizeDecision::ReplayApplied),
        Some("not_applied") => Ok(ProjectionFinalizeDecision::ReplayNotApplied),
        _ => Err(ConversationResultStoreError::StoredRowInvalid),
    }
}

async fn update_projection_command(
    transaction: &Transaction<'_>,
    tenant_id: &str,
    command: &ProjectionCommand,
    resolution: &str,
    failure_code: Option<&str>,
    observed_entity_id: Option<&str>,
    observed_payload_hash: Option<&str>,
) -> Result<u64, ConversationResultStoreError> {
    let row = transaction
        .query_opt(
            "UPDATE converact_conversation_projection_commands
             SET command_state = 'state_observed', resolution = $3, failure_code = $4,
                 observed_entity_id = $5, observed_payload_hash = $6,
                 state_observed_at = transaction_timestamp(), lease_owner = '',
                 lease_token_hash = '', lease_expires_at = NULL,
                 updated_at = transaction_timestamp()
             WHERE tenant_id = $1 AND command_id = $2 AND command_state = 'prepared'
             RETURNING floor(extract(epoch FROM state_observed_at) * 1000)::BIGINT",
            &[
                &tenant_id,
                &command.id().as_str(),
                &resolution,
                &failure_code,
                &observed_entity_id,
                &observed_payload_hash,
            ],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?
        .ok_or(ConversationResultStoreError::Conflict)?;
    u64_from(i64_at(&row, 0)?)
}

struct ProjectionReceiptInput<'a> {
    tenant_id: &'a str,
    command: &'a ProjectionCommand,
    stage: &'a str,
    resolution: Option<&'a str>,
    failure_code: Option<&'a str>,
    observed_entity_id: Option<&'a str>,
    observed_payload_hash: Option<&'a str>,
    observed_at_ms: u64,
}

async fn insert_projection_receipt(
    transaction: &Transaction<'_>,
    input: ProjectionReceiptInput<'_>,
) -> Result<(), ConversationResultStoreError> {
    let receipt_id_hash = canonical_sha256(&json!({
        "command_id": input.command.id().as_str(),
        "stage": input.stage
    }))
    .map_err(|_| ConversationResultStoreError::SerializationFailed)?;
    let receipt_id = format!("projection-receipt-{receipt_id_hash}");
    let receipt_digest = canonical_sha256(&json!({
        "tenant_id": input.tenant_id,
        "receipt_id": receipt_id,
        "command_id": input.command.id().as_str(),
        "interaction_id": input.command.interaction_id().as_str(),
        "stage": input.stage,
        "resolution": input.resolution,
        "failure_code": input.failure_code,
        "observed_entity_id": input.observed_entity_id,
        "observed_payload_hash": input.observed_payload_hash,
        "observed_at_ms": input.observed_at_ms
    }))
    .map_err(|_| ConversationResultStoreError::SerializationFailed)?;
    let observed_at_ms = i64_from(input.observed_at_ms)?;
    let inserted = transaction
        .query_opt(
            "INSERT INTO converact_conversation_projection_receipts (
               tenant_id, receipt_id, command_id, interaction_id, stage, receipt_digest,
               resolution, failure_code, observed_entity_id, observed_payload_hash, observed_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               to_timestamp($11::DOUBLE PRECISION / 1000.0))
             ON CONFLICT DO NOTHING RETURNING receipt_id",
            &[
                &input.tenant_id,
                &receipt_id,
                &input.command.id().as_str(),
                &input.command.interaction_id().as_str(),
                &input.stage,
                &receipt_digest,
                &input.resolution,
                &input.failure_code,
                &input.observed_entity_id,
                &input.observed_payload_hash,
                &observed_at_ms,
            ],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
    if inserted.is_some() {
        return Ok(());
    }
    let row = transaction
        .query_opt(
            "SELECT receipt_id, receipt_digest
             FROM converact_conversation_projection_receipts
             WHERE tenant_id = $1 AND command_id = $2 AND stage = $3",
            &[&input.tenant_id, &input.command.id().as_str(), &input.stage],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?
        .ok_or(ConversationResultStoreError::Conflict)?;
    if string_at(&row, 0)? != receipt_id || string_at(&row, 1)? != receipt_digest {
        return Err(ConversationResultStoreError::Conflict);
    }
    Ok(())
}

async fn verify_segment_replay(
    transaction: &Transaction<'_>,
    segment: &TranscriptSegment,
    generation: i64,
    sequence: i64,
    historical: bool,
) -> Result<(), ConversationResultStoreError> {
    let context = segment.context();
    let rows = transaction
        .query(
            "SELECT payload_hash, historical
             FROM converact_conversation_transcript_segments
             WHERE tenant_id = $1 AND (
               segment_id = $2 OR
               (interaction_id = $3 AND source_event_id = $4) OR
               (interaction_id = $3 AND execution_generation = $5 AND segment_sequence = $6)
             ) LIMIT 2",
            &[
                &context.tenant_id(),
                &segment.id().as_str(),
                &context.interaction_id().as_str(),
                &segment.source_event_id().as_str(),
                &generation,
                &sequence,
            ],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
    if rows.len() != 1
        || string_at(&rows[0], 0)? != segment.payload_hash()
        || bool_at(&rows[0], 1)? != historical
    {
        return Err(ConversationResultStoreError::Conflict);
    }
    Ok(())
}

async fn verify_snapshot_segments(
    transaction: &Transaction<'_>,
    snapshot: &TranscriptSnapshot,
) -> Result<(), ConversationResultStoreError> {
    let generation = i64_from(snapshot.current_generation().get())?;
    let rows = transaction
        .query(
            "SELECT segment_id, execution_generation, segment_sequence, payload_hash
             FROM converact_conversation_transcript_segments
             WHERE tenant_id = $1 AND interaction_id = $2 AND execution_generation <= $3
             ORDER BY execution_generation, segment_sequence, segment_id FOR UPDATE",
            &[
                &snapshot.context().tenant_id(),
                &snapshot.context().interaction_id().as_str(),
                &generation,
            ],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
    if rows.len() != snapshot.segment_count() {
        return Err(ConversationResultStoreError::Conflict);
    }
    let mut refs = Vec::with_capacity(rows.len());
    for (row, expected_id) in rows.iter().zip(snapshot.segment_ids()) {
        let segment_id = string_at(row, 0)?;
        if segment_id != expected_id.as_str() {
            return Err(ConversationResultStoreError::Conflict);
        }
        refs.push(json!({
            "segment_id": segment_id,
            "execution_generation": i64_at(row, 1)?,
            "segment_sequence": i64_at(row, 2)?,
            "payload_hash": string_at(row, 3)?
        }));
    }
    let digest = canonical_sha256(&Value::Array(refs))
        .map_err(|_| ConversationResultStoreError::SerializationFailed)?;
    if digest != snapshot.transcript_snapshot_digest() {
        return Err(ConversationResultStoreError::Conflict);
    }
    Ok(())
}

async fn classify_existing_snapshot(
    transaction: &Transaction<'_>,
    snapshot: &TranscriptSnapshot,
) -> Result<Option<ProjectionWriteDecision>, ConversationResultStoreError> {
    let revision = i64_from(snapshot.revision().get())?;
    let rows = transaction
        .query(
            "SELECT payload_hash FROM converact_conversation_snapshots
             WHERE tenant_id = $1 AND (
               snapshot_id = $2 OR
               (interaction_id = $3 AND snapshot_revision = $4) OR
               (interaction_id = $3 AND transcript_snapshot_digest = $5)
             ) LIMIT 2",
            &[
                &snapshot.context().tenant_id(),
                &snapshot.id().as_str(),
                &snapshot.context().interaction_id().as_str(),
                &revision,
                &snapshot.transcript_snapshot_digest(),
            ],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
    if rows.is_empty() {
        return Ok(None);
    }
    if rows.len() == 1 && string_at(&rows[0], 0)? == snapshot.payload_hash() {
        return Ok(Some(ProjectionWriteDecision::Replay));
    }
    Err(ConversationResultStoreError::Conflict)
}

async fn verify_next_snapshot_revision(
    transaction: &Transaction<'_>,
    snapshot: &TranscriptSnapshot,
) -> Result<(), ConversationResultStoreError> {
    let latest = transaction
        .query_opt(
            "SELECT snapshot_revision FROM converact_conversation_snapshots
             WHERE tenant_id = $1 AND interaction_id = $2
             ORDER BY snapshot_revision DESC LIMIT 1 FOR UPDATE",
            &[
                &snapshot.context().tenant_id(),
                &snapshot.context().interaction_id().as_str(),
            ],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
    let expected = match latest {
        Some(row) => u64_from(i64_at(&row, 0)?)?
            .checked_add(1)
            .ok_or(ConversationResultStoreError::NumericOverflow)?,
        None => 1,
    };
    if snapshot.revision().get() != expected {
        return Err(ConversationResultStoreError::Conflict);
    }
    Ok(())
}

async fn verify_result_snapshot(
    transaction: &Transaction<'_>,
    result: &ConversationResult,
) -> Result<(), ConversationResultStoreError> {
    let row = transaction
        .query_opt(
            "SELECT snapshot_id FROM converact_conversation_snapshots
             WHERE tenant_id = $1 AND interaction_id = $2 AND agent_release_id = $3
               AND call_attempt_id = $4 AND transcript_snapshot_digest = $5",
            &[
                &result.context().tenant_id(),
                &result.context().interaction_id().as_str(),
                &result.context().agent_release_id().as_str(),
                &result.context().call_attempt_id().as_str(),
                &result.transcript_snapshot_digest(),
            ],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
    if row.is_none() {
        return Err(ConversationResultStoreError::Conflict);
    }
    Ok(())
}

async fn classify_existing_result(
    transaction: &Transaction<'_>,
    result: &ConversationResult,
) -> Result<Option<ProjectionWriteDecision>, ConversationResultStoreError> {
    let revision = i64_from(result.revision().get())?;
    let rows = transaction
        .query(
            "SELECT payload_hash FROM converact_conversation_results
             WHERE tenant_id = $1 AND (
               result_id = $2 OR (interaction_id = $3 AND result_revision = $4)
             ) FOR UPDATE",
            &[
                &result.context().tenant_id(),
                &result.id().as_str(),
                &result.context().interaction_id().as_str(),
                &revision,
            ],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
    if rows.is_empty() {
        return Ok(None);
    }
    if rows.len() == 1 && string_at(&rows[0], 0)? == result.payload_hash() {
        return Ok(Some(ProjectionWriteDecision::Replay));
    }
    Err(ConversationResultStoreError::Conflict)
}

async fn verify_next_result_revision(
    transaction: &Transaction<'_>,
    result: &ConversationResult,
) -> Result<(), ConversationResultStoreError> {
    let latest = transaction
        .query_opt(
            "SELECT result_revision FROM converact_conversation_results
             WHERE tenant_id = $1 AND interaction_id = $2
             ORDER BY result_revision DESC LIMIT 1 FOR UPDATE",
            &[
                &result.context().tenant_id(),
                &result.context().interaction_id().as_str(),
            ],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
    let expected = match latest {
        Some(row) => u64_from(i64_at(&row, 0)?)?
            .checked_add(1)
            .ok_or(ConversationResultStoreError::NumericOverflow)?,
        None => 1,
    };
    if result.revision().get() != expected {
        return Err(ConversationResultStoreError::Conflict);
    }
    Ok(())
}

async fn verify_evaluation_result(
    transaction: &Transaction<'_>,
    write: &EvaluationProjectionWrite<'_>,
) -> Result<(), ConversationResultStoreError> {
    let row = transaction
        .query_opt(
            "SELECT payload_hash FROM converact_conversation_results
             WHERE tenant_id = $1 AND result_id = $2 AND result_revision = $3",
            &[
                &write.result().context().tenant_id(),
                &write.result().id().as_str(),
                &i64_from(write.result().revision().get())?,
            ],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
    match row {
        Some(row) if string_at(&row, 0)? == write.result().payload_hash() => Ok(()),
        _ => Err(ConversationResultStoreError::Conflict),
    }
}

async fn verify_evaluation_evidence(
    transaction: &Transaction<'_>,
    write: &EvaluationProjectionWrite<'_>,
) -> Result<(), ConversationResultStoreError> {
    let expected = write.evaluation().evidence_segment_ids();
    let expected_ids = expected
        .iter()
        .map(|id| id.as_str().to_owned())
        .collect::<Vec<_>>();
    let rows = transaction
        .query(
            "SELECT segment_id FROM converact_conversation_transcript_segments
             WHERE tenant_id = $1 AND interaction_id = $2 AND segment_id = ANY($3::TEXT[])
             ORDER BY segment_id FOR UPDATE",
            &[
                &write.result().context().tenant_id(),
                &write.interaction_id().as_str(),
                &expected_ids,
            ],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
    if rows.len() != expected.len() {
        return Err(ConversationResultStoreError::Conflict);
    }
    Ok(())
}

async fn classify_existing_evaluation(
    transaction: &Transaction<'_>,
    write: &EvaluationProjectionWrite<'_>,
) -> Result<Option<ProjectionWriteDecision>, ConversationResultStoreError> {
    let evaluation = write.evaluation();
    let rows = transaction
        .query(
            "SELECT payload_hash FROM converact_conversation_evaluations
             WHERE tenant_id = $1 AND (
               evaluation_id = $2 OR
               (result_id = $3 AND evaluation_rubric_revision_id = $4)
             ) FOR UPDATE",
            &[
                &write.result().context().tenant_id(),
                &evaluation.id().as_str(),
                &evaluation.result_id().as_str(),
                &evaluation.rubric_revision_id().as_str(),
            ],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
    if rows.is_empty() {
        return Ok(None);
    }
    if rows.len() == 1 && string_at(&rows[0], 0)? == evaluation.payload_hash() {
        return Ok(Some(ProjectionWriteDecision::Replay));
    }
    Err(ConversationResultStoreError::Conflict)
}

async fn insert_bad_case_projection(
    transaction: &Transaction<'_>,
    write: &EvaluationProjectionWrite<'_>,
    reasons: &Value,
    created_at_ms: i64,
) -> Result<(), ConversationResultStoreError> {
    let Some(bad_case_id) = write.bad_case_id() else {
        return Ok(());
    };
    let payload_hash = canonical_bad_case_payload_hash(write)?;
    let inserted = transaction
        .query_opt(
            "INSERT INTO converact_conversation_bad_cases (
               tenant_id, bad_case_id, interaction_id, evaluation_id, bad_case_reasons,
               review_state, payload_hash, created_at
             ) VALUES ($1, $2, $3, $4, $5, 'pending', $6,
               to_timestamp($7::DOUBLE PRECISION / 1000.0))
             ON CONFLICT DO NOTHING RETURNING bad_case_id",
            &[
                &write.result().context().tenant_id(),
                &bad_case_id.as_str(),
                &write.interaction_id().as_str(),
                &write.evaluation().id().as_str(),
                &reasons,
                &payload_hash,
                &created_at_ms,
            ],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
    if inserted.is_none() {
        verify_bad_case_projection(transaction, write).await?;
    }
    Ok(())
}

async fn verify_bad_case_projection(
    transaction: &Transaction<'_>,
    write: &EvaluationProjectionWrite<'_>,
) -> Result<(), ConversationResultStoreError> {
    let rows = transaction
        .query(
            "SELECT bad_case_id, payload_hash FROM converact_conversation_bad_cases
             WHERE tenant_id = $1 AND evaluation_id = $2 FOR UPDATE",
            &[
                &write.result().context().tenant_id(),
                &write.evaluation().id().as_str(),
            ],
        )
        .await
        .map_err(|_| ConversationResultStoreError::DatabaseUnavailable)?;
    let Some(expected_id) = write.bad_case_id() else {
        return if rows.is_empty() {
            Ok(())
        } else {
            Err(ConversationResultStoreError::Conflict)
        };
    };
    let expected_hash = canonical_bad_case_payload_hash(write)?;
    if rows.len() != 1
        || string_at(&rows[0], 0)? != expected_id.as_str()
        || string_at(&rows[0], 1)? != expected_hash
    {
        return Err(ConversationResultStoreError::Conflict);
    }
    Ok(())
}

fn i64_from(value: u64) -> Result<i64, ConversationResultStoreError> {
    i64::try_from(value).map_err(|_| ConversationResultStoreError::NumericOverflow)
}

fn u64_from(value: i64) -> Result<u64, ConversationResultStoreError> {
    u64::try_from(value).map_err(|_| ConversationResultStoreError::StoredRowInvalid)
}

fn string_at(row: &Row, index: usize) -> Result<String, ConversationResultStoreError> {
    row.try_get(index)
        .map_err(|_| ConversationResultStoreError::StoredRowInvalid)
}

fn i64_at(row: &Row, index: usize) -> Result<i64, ConversationResultStoreError> {
    row.try_get(index)
        .map_err(|_| ConversationResultStoreError::StoredRowInvalid)
}

fn bool_at(row: &Row, index: usize) -> Result<bool, ConversationResultStoreError> {
    row.try_get(index)
        .map_err(|_| ConversationResultStoreError::StoredRowInvalid)
}

fn optional_string_at(
    row: &Row,
    index: usize,
) -> Result<Option<String>, ConversationResultStoreError> {
    row.try_get(index)
        .map_err(|_| ConversationResultStoreError::StoredRowInvalid)
}

fn bounded_identifier(value: &str, maximum: usize) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= maximum
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
