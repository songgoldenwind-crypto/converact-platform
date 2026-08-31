use converact_agent_handoff_core::{ControlOwner, HandoffSession, HandoffState};
use converact_contracts::canonical_sha256;
use converact_voice_agent_contracts::{
    ExecutionGeneration, HandoffCommandId, HandoffId, HandoffReceiptId,
};
use serde_json::{Value, json};
use tokio_postgres::{Row, Transaction};

use crate::{
    HandoffStoreCommand, HandoffStoreError, HandoffTransitionWrite, canonical_request_payload_hash,
};

const MAX_CONTEXT_PACKET_BYTES: usize = 131_072;
const MAX_TARGET_BYTES: usize = 32_768;
const MAX_FAILURE_CODE_BYTES: usize = 255;

/// One immutable Store observation for a Handoff command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HandoffStoreReceipt {
    id: HandoffReceiptId,
    command_id: HandoffCommandId,
    handoff_id: HandoffId,
    stage: ReceiptStage,
    digest: Box<str>,
    resolution: Option<HandoffCommandResolution>,
    failure_code: Option<Box<str>>,
    revision: u64,
    generation: ExecutionGeneration,
    state: HandoffState,
    owner: ControlOwner,
    observed_at_ms: u64,
}

impl HandoffStoreReceipt {
    #[must_use]
    pub const fn id(&self) -> &HandoffReceiptId {
        &self.id
    }

    #[must_use]
    pub const fn command_id(&self) -> &HandoffCommandId {
        &self.command_id
    }

    #[must_use]
    pub const fn handoff_id(&self) -> &HandoffId {
        &self.handoff_id
    }

    #[must_use]
    pub const fn stage(&self) -> ReceiptStage {
        self.stage
    }

    #[must_use]
    pub fn digest(&self) -> &str {
        &self.digest
    }

    #[must_use]
    pub const fn resolution(&self) -> Option<HandoffCommandResolution> {
        self.resolution
    }

    #[must_use]
    pub fn failure_code(&self) -> Option<&str> {
        self.failure_code.as_deref()
    }

    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    #[must_use]
    pub const fn generation(&self) -> ExecutionGeneration {
        self.generation
    }

    #[must_use]
    pub const fn state(&self) -> HandoffState {
        self.state
    }

    #[must_use]
    pub const fn owner(&self) -> ControlOwner {
        self.owner
    }

    #[must_use]
    pub const fn observed_at_ms(&self) -> u64 {
        self.observed_at_ms
    }
}

/// Durable receipt stage.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReceiptStage {
    Prepared,
    StateObserved,
}

/// Definitive command effect observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HandoffCommandResolution {
    Applied,
    NotApplied,
}

impl HandoffCommandResolution {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::NotApplied => "not_applied",
        }
    }
}

impl ReceiptStage {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::StateObserved => "state_observed",
        }
    }
}

/// Result of atomically preparing one command effect.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HandoffPrepareDecision {
    Prepared(HandoffStoreReceipt),
    Replay(HandoffStoreReceipt),
    ReconcileRequired,
    Conflict,
    StaleFence,
}

/// Result of atomically creating or replaying the initial requested aggregate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HandoffCreateDecision {
    Created(HandoffStoreReceipt),
    Replay(HandoffStoreReceipt),
}

/// Stateless SQL coordinator; its caller owns a tenant-scoped transaction and deadline.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct HandoffSqlStore;

impl HandoffSqlStore {
    /// Atomically records the immutable Context Packet, requested aggregate and request receipt.
    ///
    /// # Errors
    ///
    /// Rejects non-request snapshots, malformed payloads, conflicts, database failures and
    /// invalid stored rows. The caller must roll back the transaction on any error.
    #[allow(clippy::too_many_lines)]
    pub async fn create_requested(
        &self,
        transaction: &Transaction<'_>,
        requested: &HandoffSession,
        command: &HandoffStoreCommand,
    ) -> Result<HandoffCreateDecision, HandoffStoreError> {
        validate_requested(requested, command)?;
        let tenant_id = requested.context().tenant_id();
        let context_payload = context_packet_payload(requested);
        let target = target_payload(requested);
        validate_json_size(&context_payload, MAX_CONTEXT_PACKET_BYTES)?;
        validate_json_size(&target, MAX_TARGET_BYTES)?;
        let source_generation = i64_from(requested.execution_generation().get())?;
        let context_revision = i64_from(requested.context_packet().revision().get())?;
        let context_created_at_ms = i64_from(requested.context_packet().created_at_ms())?;
        transaction
            .execute(
                "INSERT INTO converact_agent_handoff_context_packets (
                   tenant_id, context_packet_id, interaction_id, call_attempt_id, call_id,
                   agent_release_id, source_execution_generation, context_revision,
                   context_packet_digest, payload, created_at
                 ) VALUES (
                   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                   to_timestamp($11::DOUBLE PRECISION / 1000.0)
                 ) ON CONFLICT DO NOTHING",
                &[
                    &tenant_id,
                    &requested.context_packet().id().as_str(),
                    &requested.context().interaction_id().as_str(),
                    &requested.context().call_attempt_id().as_str(),
                    &requested.call_id().as_str(),
                    &requested.context().agent_release_id().as_str(),
                    &source_generation,
                    &context_revision,
                    &requested.context_packet().digest(),
                    &context_payload,
                    &context_created_at_ms,
                ],
            )
            .await
            .map_err(|_| HandoffStoreError::DatabaseUnavailable)?;
        verify_context_packet(transaction, requested).await?;

        let revision = i64_from(requested.revision())?;
        let inserted = transaction
            .query_opt(
                "INSERT INTO converact_agent_handoffs (
                   tenant_id, handoff_id, interaction_id, call_attempt_id, call_id,
                   agent_release_id, context_packet_id, context_packet_digest, target,
                   state, reconcile_from, control_owner, execution_generation, revision,
                   source_ai_session_id, current_ai_session_id, human_leg_id
                 ) VALUES (
                   $1, $2, $3, $4, $5, $6, $7, $8, $9,
                   $10, NULL, $11, $12, $13, $14, $14, NULL
                 ) ON CONFLICT DO NOTHING RETURNING handoff_id",
                &[
                    &tenant_id,
                    &requested.id().as_str(),
                    &requested.context().interaction_id().as_str(),
                    &requested.context().call_attempt_id().as_str(),
                    &requested.call_id().as_str(),
                    &requested.context().agent_release_id().as_str(),
                    &requested.context_packet().id().as_str(),
                    &requested.context_packet().digest(),
                    &target,
                    &requested.state().as_str(),
                    &requested.owner().as_str(),
                    &source_generation,
                    &revision,
                    &requested.ai_session_id().as_str(),
                ],
            )
            .await
            .map_err(|_| HandoffStoreError::DatabaseUnavailable)?;
        if inserted.is_none() {
            return replay_created(transaction, requested, command)
                .await
                .map(HandoffCreateDecision::Replay);
        }

        let observed_at_ms = transaction
            .query_one(
                "INSERT INTO converact_agent_handoff_commands (
                   tenant_id, command_id, handoff_id, command_kind, payload_hash,
                   expected_revision, expected_generation, command_state, resolution,
                   target_revision, target_generation, target_state, target_owner,
                   state_observed_at
                 ) VALUES (
                   $1, $2, $3, $4, $5, $6, $7, 'state_observed', 'applied',
                   $6, $7, $8, $9, transaction_timestamp()
                 ) RETURNING floor(extract(epoch FROM state_observed_at) * 1000)::BIGINT",
                &[
                    &tenant_id,
                    &command.id().as_str(),
                    &requested.id().as_str(),
                    &command.kind(),
                    &command.payload_hash(),
                    &revision,
                    &source_generation,
                    &requested.state().as_str(),
                    &requested.owner().as_str(),
                ],
            )
            .await
            .map_err(|_| HandoffStoreError::Conflict)?;
        let observed_at_ms = positive_i64(
            observed_at_ms
                .try_get(0)
                .map_err(|_| HandoffStoreError::StoredRowInvalid)?,
        )?;
        let receipt = receipt_for(
            command,
            requested,
            ReceiptStage::StateObserved,
            Some(HandoffCommandResolution::Applied),
            None,
            observed_at_ms,
        )?;
        insert_receipt(transaction, tenant_id, &receipt).await?;
        Ok(HandoffCreateDecision::Created(receipt))
    }

    /// Atomically reserves exactly one transition effect or classifies replay/reconciliation.
    ///
    /// # Errors
    ///
    /// Returns only bounded validation, database or stored-row failures. Conflict and stale-fence
    /// decisions are values. The caller must roll back the transaction on any error.
    pub async fn prepare_transition(
        &self,
        transaction: &Transaction<'_>,
        write: &HandoffTransitionWrite<'_>,
    ) -> Result<HandoffPrepareDecision, HandoffStoreError> {
        let current = write.current();
        let command = write.command();
        let tenant_id = current.context().tenant_id();
        if command_exists(transaction, tenant_id, command.id()).await? {
            return classify_existing_command(transaction, current, command).await;
        }
        if !stored_fence_matches(transaction, current).await? {
            return Ok(HandoffPrepareDecision::StaleFence);
        }
        let revision = i64_from(command.expected_revision())?;
        let generation = i64_from(command.expected_generation().get())?;
        let inserted = transaction
            .query_opt(
                "INSERT INTO converact_agent_handoff_commands (
                   tenant_id, command_id, handoff_id, command_kind, payload_hash,
                   expected_revision, expected_generation, command_state
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'prepared')
                 ON CONFLICT DO NOTHING
                 RETURNING floor(extract(epoch FROM prepared_at) * 1000)::BIGINT",
                &[
                    &tenant_id,
                    &command.id().as_str(),
                    &current.id().as_str(),
                    &command.kind(),
                    &command.payload_hash(),
                    &revision,
                    &generation,
                ],
            )
            .await
            .map_err(|_| HandoffStoreError::DatabaseUnavailable)?;
        let Some(row) = inserted else {
            return classify_existing_command(transaction, current, command).await;
        };
        let observed_at_ms = positive_i64(
            row.try_get(0)
                .map_err(|_| HandoffStoreError::StoredRowInvalid)?,
        )?;
        let receipt = receipt_for(
            command,
            current,
            ReceiptStage::Prepared,
            None,
            None,
            observed_at_ms,
        )?;
        insert_receipt(transaction, tenant_id, &receipt).await?;
        Ok(HandoffPrepareDecision::Prepared(receipt))
    }

    /// Atomically applies a prepared transition and records immutable state-observed evidence.
    ///
    /// # Errors
    ///
    /// Rejects missing/mismatched prepare evidence, stale fences, conflicts, database failures and
    /// invalid stored rows. The caller must roll back the transaction on any error.
    #[allow(clippy::too_many_lines)] // Keep the locked snapshot and receipt update auditable.
    pub async fn finalize_transition(
        &self,
        transaction: &Transaction<'_>,
        write: &HandoffTransitionWrite<'_>,
    ) -> Result<HandoffStoreReceipt, HandoffStoreError> {
        let current = write.current();
        let next = write.next();
        let command = write.command();
        let tenant_id = current.context().tenant_id();
        let command_state = transaction
            .query_opt(
                "SELECT payload_hash, handoff_id, command_state
                 FROM converact_agent_handoff_commands
                 WHERE tenant_id = $1 AND command_id = $2 FOR UPDATE",
                &[&tenant_id, &command.id().as_str()],
            )
            .await
            .map_err(|_| HandoffStoreError::DatabaseUnavailable)?
            .ok_or(HandoffStoreError::Conflict)?;
        verify_command_row(&command_state, current, command)?;
        let state: &str = command_state
            .try_get(2)
            .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
        if state == "state_observed" {
            return load_receipt(
                transaction,
                tenant_id,
                command.id(),
                ReceiptStage::StateObserved,
            )
            .await;
        }
        if state != "prepared" {
            return Err(HandoffStoreError::StoredRowInvalid);
        }

        let current_revision = i64_from(current.revision())?;
        let current_generation = i64_from(current.execution_generation().get())?;
        let next_revision = i64_from(next.revision())?;
        let next_generation = i64_from(next.execution_generation().get())?;
        let terminal = next.state().is_terminal();
        let updated = transaction
            .execute(
                "UPDATE converact_agent_handoffs
                 SET state = $6, reconcile_from = $7, control_owner = $8,
                     execution_generation = $9, revision = $10,
                     current_ai_session_id = $11, human_leg_id = $12,
                     terminal_at = CASE WHEN $13 THEN transaction_timestamp() ELSE NULL END,
                     updated_at = transaction_timestamp()
                 WHERE tenant_id = $1 AND handoff_id = $2 AND revision = $3
                   AND execution_generation = $4 AND state = $5",
                &[
                    &tenant_id,
                    &current.id().as_str(),
                    &current_revision,
                    &current_generation,
                    &current.state().as_str(),
                    &next.state().as_str(),
                    &next.reconcile_from().map(HandoffState::as_str),
                    &next.owner().as_str(),
                    &next_generation,
                    &next_revision,
                    &next.ai_session_id().as_str(),
                    &next
                        .human_leg_id()
                        .map(converact_voice_agent_contracts::HumanLegId::as_str),
                    &terminal,
                ],
            )
            .await
            .map_err(|_| HandoffStoreError::DatabaseUnavailable)?;
        if updated != 1 {
            return Err(HandoffStoreError::StaleFence);
        }
        let observed = transaction
            .query_one(
                "UPDATE converact_agent_handoff_commands
                 SET command_state = 'state_observed', target_revision = $3,
                     target_generation = $4, target_state = $5, target_owner = $6,
                     resolution = 'applied', failure_code = NULL,
                     lease_owner = '', lease_token_hash = '', lease_expires_at = NULL,
                     state_observed_at = transaction_timestamp(),
                     updated_at = transaction_timestamp()
                 WHERE tenant_id = $1 AND command_id = $2 AND command_state = 'prepared'
                 RETURNING floor(extract(epoch FROM state_observed_at) * 1000)::BIGINT",
                &[
                    &tenant_id,
                    &command.id().as_str(),
                    &next_revision,
                    &next_generation,
                    &next.state().as_str(),
                    &next.owner().as_str(),
                ],
            )
            .await
            .map_err(|_| HandoffStoreError::Conflict)?;
        let observed_at_ms = positive_i64(
            observed
                .try_get(0)
                .map_err(|_| HandoffStoreError::StoredRowInvalid)?,
        )?;
        let receipt = receipt_for(
            command,
            next,
            ReceiptStage::StateObserved,
            Some(HandoffCommandResolution::Applied),
            None,
            observed_at_ms,
        )?;
        insert_receipt(transaction, tenant_id, &receipt).await?;
        Ok(receipt)
    }

    /// Closes a prepared external effect that definitively did not apply without advancing state.
    ///
    /// # Errors
    ///
    /// Rejects malformed failure codes, missing/mismatched prepare evidence, conflicts, database
    /// failures and invalid stored rows. The caller must roll back on any error.
    pub async fn finalize_not_applied(
        &self,
        transaction: &Transaction<'_>,
        current: &HandoffSession,
        command: &HandoffStoreCommand,
        failure_code: &str,
    ) -> Result<HandoffStoreReceipt, HandoffStoreError> {
        if !bounded_failure_code(failure_code)
            || command.expected_revision() != current.revision()
            || command.expected_generation() != current.execution_generation()
        {
            return Err(HandoffStoreError::InvalidInput);
        }
        let tenant_id = current.context().tenant_id();
        let row = transaction
            .query_opt(
                "SELECT payload_hash, handoff_id, command_state
                 FROM converact_agent_handoff_commands
                 WHERE tenant_id = $1 AND command_id = $2 FOR UPDATE",
                &[&tenant_id, &command.id().as_str()],
            )
            .await
            .map_err(|_| HandoffStoreError::DatabaseUnavailable)?
            .ok_or(HandoffStoreError::Conflict)?;
        verify_command_row(&row, current, command)?;
        let command_state: &str = row
            .try_get(2)
            .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
        if command_state == "state_observed" {
            return load_receipt(
                transaction,
                tenant_id,
                command.id(),
                ReceiptStage::StateObserved,
            )
            .await;
        }
        if command_state != "prepared" {
            return Err(HandoffStoreError::StoredRowInvalid);
        }
        let observed = transaction
            .query_one(
                "UPDATE converact_agent_handoff_commands
                 SET command_state = 'state_observed', resolution = 'not_applied',
                     failure_code = $3, state_observed_at = transaction_timestamp(),
                     lease_owner = '', lease_token_hash = '', lease_expires_at = NULL,
                     updated_at = transaction_timestamp()
                 WHERE tenant_id = $1 AND command_id = $2 AND command_state = 'prepared'
                 RETURNING floor(extract(epoch FROM state_observed_at) * 1000)::BIGINT",
                &[&tenant_id, &command.id().as_str(), &failure_code],
            )
            .await
            .map_err(|_| HandoffStoreError::Conflict)?;
        let observed_at_ms = positive_i64(
            observed
                .try_get(0)
                .map_err(|_| HandoffStoreError::StoredRowInvalid)?,
        )?;
        let receipt = receipt_for(
            command,
            current,
            ReceiptStage::StateObserved,
            Some(HandoffCommandResolution::NotApplied),
            Some(failure_code),
            observed_at_ms,
        )?;
        insert_receipt(transaction, tenant_id, &receipt).await?;
        Ok(receipt)
    }
}

fn validate_requested(
    requested: &HandoffSession,
    command: &HandoffStoreCommand,
) -> Result<(), HandoffStoreError> {
    if requested.state() != HandoffState::Requested
        || requested.owner() != ControlOwner::Ai
        || requested.revision() != 1
        || command.kind() != "request"
        || command.payload_hash() != canonical_request_payload_hash(requested)?
        || command.expected_revision() != requested.revision()
        || command.expected_generation() != requested.execution_generation()
    {
        return Err(HandoffStoreError::InvalidInput);
    }
    Ok(())
}

async fn command_exists(
    transaction: &Transaction<'_>,
    tenant_id: &str,
    command_id: &HandoffCommandId,
) -> Result<bool, HandoffStoreError> {
    transaction
        .query_opt(
            "SELECT 1 FROM converact_agent_handoff_commands
             WHERE tenant_id = $1 AND command_id = $2",
            &[&tenant_id, &command_id.as_str()],
        )
        .await
        .map(|row| row.is_some())
        .map_err(|_| HandoffStoreError::DatabaseUnavailable)
}

fn context_packet_payload(handoff: &HandoffSession) -> Value {
    let packet = handoff.context_packet();
    json!({
        "schema_version": 1,
        "summary_artifact_ref": packet.summary_artifact_ref(),
        "transcript_artifact_ref": packet.transcript_artifact_ref(),
        "unresolved_item_refs": packet.unresolved_item_refs(),
        "action_receipt_refs": packet.action_receipt_refs(),
        "disclosure_completed": packet.disclosure_completed(),
        "recording_active": packet.recording_active(),
        "data_region_policy_ref": packet.data_region_policy_ref()
    })
}

fn target_payload(handoff: &HandoffSession) -> Value {
    json!({
        "queue": handoff.target().queue(),
        "skills": handoff.target().skills(),
        "preferred_seat": handoff.target().preferred_seat()
    })
}

fn validate_json_size(value: &Value, maximum: usize) -> Result<(), HandoffStoreError> {
    if serde_json::to_vec(value)
        .map_err(|_| HandoffStoreError::InvalidInput)?
        .len()
        > maximum
    {
        return Err(HandoffStoreError::InvalidInput);
    }
    Ok(())
}

async fn verify_context_packet(
    transaction: &Transaction<'_>,
    handoff: &HandoffSession,
) -> Result<(), HandoffStoreError> {
    let row = transaction
        .query_opt(
            "SELECT interaction_id, context_revision, context_packet_digest
             FROM converact_agent_handoff_context_packets
             WHERE tenant_id = $1 AND context_packet_id = $2 FOR UPDATE",
            &[
                &handoff.context().tenant_id(),
                &handoff.context_packet().id().as_str(),
            ],
        )
        .await
        .map_err(|_| HandoffStoreError::DatabaseUnavailable)?
        .ok_or(HandoffStoreError::Conflict)?;
    let interaction_id: &str = row
        .try_get(0)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    let revision: i64 = row
        .try_get(1)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    let digest: &str = row
        .try_get(2)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    if interaction_id != handoff.context().interaction_id().as_str()
        || positive_i64(revision)? != handoff.context_packet().revision().get()
        || digest != handoff.context_packet().digest()
    {
        return Err(HandoffStoreError::Conflict);
    }
    Ok(())
}

async fn replay_created(
    transaction: &Transaction<'_>,
    handoff: &HandoffSession,
    command: &HandoffStoreCommand,
) -> Result<HandoffStoreReceipt, HandoffStoreError> {
    let row = transaction
        .query_opt(
            "SELECT payload_hash, handoff_id, command_state
             FROM converact_agent_handoff_commands
             WHERE tenant_id = $1 AND command_id = $2",
            &[&handoff.context().tenant_id(), &command.id().as_str()],
        )
        .await
        .map_err(|_| HandoffStoreError::DatabaseUnavailable)?
        .ok_or(HandoffStoreError::Conflict)?;
    verify_command_row(&row, handoff, command)?;
    let state: &str = row
        .try_get(2)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    if state != "state_observed" {
        return Err(HandoffStoreError::ReconcileRequired);
    }
    load_receipt(
        transaction,
        handoff.context().tenant_id(),
        command.id(),
        ReceiptStage::StateObserved,
    )
    .await
}

async fn stored_fence_matches(
    transaction: &Transaction<'_>,
    current: &HandoffSession,
) -> Result<bool, HandoffStoreError> {
    let row = transaction
        .query_opt(
            "SELECT revision, execution_generation, state, control_owner
             FROM converact_agent_handoffs
             WHERE tenant_id = $1 AND handoff_id = $2 FOR UPDATE",
            &[&current.context().tenant_id(), &current.id().as_str()],
        )
        .await
        .map_err(|_| HandoffStoreError::DatabaseUnavailable)?;
    let Some(row) = row else {
        return Ok(false);
    };
    let revision: i64 = row
        .try_get(0)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    let generation: i64 = row
        .try_get(1)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    let state: &str = row
        .try_get(2)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    let owner: &str = row
        .try_get(3)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    Ok(positive_i64(revision)? == current.revision()
        && positive_i64(generation)? == current.execution_generation().get()
        && state == current.state().as_str()
        && owner == current.owner().as_str())
}

async fn classify_existing_command(
    transaction: &Transaction<'_>,
    current: &HandoffSession,
    command: &HandoffStoreCommand,
) -> Result<HandoffPrepareDecision, HandoffStoreError> {
    let row = transaction
        .query_opt(
            "SELECT payload_hash, handoff_id, command_state
             FROM converact_agent_handoff_commands
             WHERE tenant_id = $1 AND command_id = $2 FOR UPDATE",
            &[&current.context().tenant_id(), &command.id().as_str()],
        )
        .await
        .map_err(|_| HandoffStoreError::DatabaseUnavailable)?
        .ok_or(HandoffStoreError::Conflict)?;
    if verify_command_row(&row, current, command).is_err() {
        return Ok(HandoffPrepareDecision::Conflict);
    }
    let state: &str = row
        .try_get(2)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    match state {
        "prepared" => Ok(HandoffPrepareDecision::ReconcileRequired),
        "state_observed" => load_receipt(
            transaction,
            current.context().tenant_id(),
            command.id(),
            ReceiptStage::StateObserved,
        )
        .await
        .map(HandoffPrepareDecision::Replay),
        _ => Err(HandoffStoreError::StoredRowInvalid),
    }
}

fn verify_command_row(
    row: &Row,
    handoff: &HandoffSession,
    command: &HandoffStoreCommand,
) -> Result<(), HandoffStoreError> {
    let payload_hash: &str = row
        .try_get(0)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    let handoff_id: &str = row
        .try_get(1)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    if payload_hash != command.payload_hash() || handoff_id != handoff.id().as_str() {
        return Err(HandoffStoreError::Conflict);
    }
    Ok(())
}

async fn insert_receipt(
    transaction: &Transaction<'_>,
    tenant_id: &str,
    receipt: &HandoffStoreReceipt,
) -> Result<(), HandoffStoreError> {
    let revision = i64_from(receipt.revision)?;
    let generation = i64_from(receipt.generation.get())?;
    let observed_at_ms = i64_from(receipt.observed_at_ms)?;
    let inserted = transaction
        .execute(
            "INSERT INTO converact_agent_handoff_receipts (
               tenant_id, receipt_id, command_id, handoff_id, stage, receipt_digest,
               resolution, failure_code, observed_revision, observed_generation,
               observed_state, observed_owner, observed_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               to_timestamp($13::DOUBLE PRECISION / 1000.0)
             ) ON CONFLICT DO NOTHING",
            &[
                &tenant_id,
                &receipt.id.as_str(),
                &receipt.command_id.as_str(),
                &receipt.handoff_id.as_str(),
                &receipt.stage.as_str(),
                &receipt.digest.as_ref(),
                &receipt.resolution.map(HandoffCommandResolution::as_str),
                &receipt.failure_code.as_deref(),
                &revision,
                &generation,
                &receipt.state.as_str(),
                &receipt.owner.as_str(),
                &observed_at_ms,
            ],
        )
        .await
        .map_err(|_| HandoffStoreError::DatabaseUnavailable)?;
    if inserted != 1 {
        return Err(HandoffStoreError::Conflict);
    }
    Ok(())
}

async fn load_receipt(
    transaction: &Transaction<'_>,
    tenant_id: &str,
    command_id: &HandoffCommandId,
    stage: ReceiptStage,
) -> Result<HandoffStoreReceipt, HandoffStoreError> {
    let row = transaction
        .query_opt(
            "SELECT receipt_id, handoff_id, receipt_digest,
                    resolution, failure_code, observed_revision, observed_generation,
                    observed_state, observed_owner,
                    floor(extract(epoch FROM observed_at) * 1000)::BIGINT
             FROM converact_agent_handoff_receipts
             WHERE tenant_id = $1 AND command_id = $2 AND stage = $3",
            &[&tenant_id, &command_id.as_str(), &stage.as_str()],
        )
        .await
        .map_err(|_| HandoffStoreError::DatabaseUnavailable)?
        .ok_or(HandoffStoreError::StoredRowInvalid)?;
    parse_receipt(&row, command_id.clone(), stage)
}

fn receipt_for(
    command: &HandoffStoreCommand,
    handoff: &HandoffSession,
    stage: ReceiptStage,
    resolution: Option<HandoffCommandResolution>,
    failure_code: Option<&str>,
    observed_at_ms: u64,
) -> Result<HandoffStoreReceipt, HandoffStoreError> {
    let digest = canonical_sha256(&json!({
        "tenant_id": handoff.context().tenant_id(),
        "command_id": command.id().as_str(),
        "handoff_id": handoff.id().as_str(),
        "stage": stage.as_str(),
        "resolution": resolution.map(HandoffCommandResolution::as_str),
        "failure_code": failure_code,
        "payload_hash": command.payload_hash(),
        "revision": handoff.revision(),
        "execution_generation": handoff.execution_generation().get(),
        "state": handoff.state().as_str(),
        "owner": handoff.owner().as_str(),
        "observed_at_ms": observed_at_ms
    }))
    .map_err(|_| HandoffStoreError::InvalidInput)?;
    let id = HandoffReceiptId::parse(format!(
        "handoff-{}-{}",
        stage.as_str().replace('_', "-"),
        &digest[..32]
    ))
    .map_err(|_| HandoffStoreError::InvalidInput)?;
    Ok(HandoffStoreReceipt {
        id,
        command_id: command.id().clone(),
        handoff_id: handoff.id().clone(),
        stage,
        digest: digest.into(),
        resolution,
        failure_code: failure_code.map(Into::into),
        revision: handoff.revision(),
        generation: handoff.execution_generation(),
        state: handoff.state(),
        owner: handoff.owner(),
        observed_at_ms,
    })
}

fn parse_receipt(
    row: &Row,
    command_id: HandoffCommandId,
    stage: ReceiptStage,
) -> Result<HandoffStoreReceipt, HandoffStoreError> {
    let receipt_id: &str = row
        .try_get(0)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    let handoff_id: &str = row
        .try_get(1)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    let digest: &str = row
        .try_get(2)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    let resolution: Option<&str> = row
        .try_get(3)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    let failure_code: Option<&str> = row
        .try_get(4)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    let revision: i64 = row
        .try_get(5)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    let generation: i64 = row
        .try_get(6)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    let stored_state: &str = row
        .try_get(7)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    let owner: &str = row
        .try_get(8)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    let observed_at_ms: i64 = row
        .try_get(9)
        .map_err(|_| HandoffStoreError::StoredRowInvalid)?;
    let resolution = resolution.map(parse_resolution).transpose()?;
    if !lowercase_sha256(digest)
        || !valid_receipt_resolution(stage, resolution, failure_code)
        || failure_code.is_some_and(|code| !bounded_failure_code(code))
    {
        return Err(HandoffStoreError::StoredRowInvalid);
    }
    Ok(HandoffStoreReceipt {
        id: HandoffReceiptId::parse(receipt_id).map_err(|_| HandoffStoreError::StoredRowInvalid)?,
        command_id,
        handoff_id: HandoffId::parse(handoff_id)
            .map_err(|_| HandoffStoreError::StoredRowInvalid)?,
        stage,
        digest: digest.into(),
        resolution,
        failure_code: failure_code.map(Into::into),
        revision: positive_i64(revision)?,
        generation: ExecutionGeneration::new(positive_i64(generation)?)
            .map_err(|_| HandoffStoreError::StoredRowInvalid)?,
        state: parse_state(stored_state)?,
        owner: parse_owner(owner)?,
        observed_at_ms: positive_i64(observed_at_ms)?,
    })
}

fn parse_resolution(value: &str) -> Result<HandoffCommandResolution, HandoffStoreError> {
    match value {
        "applied" => Ok(HandoffCommandResolution::Applied),
        "not_applied" => Ok(HandoffCommandResolution::NotApplied),
        _ => Err(HandoffStoreError::StoredRowInvalid),
    }
}

const fn valid_receipt_resolution(
    stage: ReceiptStage,
    resolution: Option<HandoffCommandResolution>,
    failure_code: Option<&str>,
) -> bool {
    matches!(
        (stage, resolution, failure_code),
        (ReceiptStage::Prepared, None, None)
            | (
                ReceiptStage::StateObserved,
                Some(HandoffCommandResolution::Applied),
                None
            )
            | (
                ReceiptStage::StateObserved,
                Some(HandoffCommandResolution::NotApplied),
                Some(_)
            )
    )
}

fn parse_state(value: &str) -> Result<HandoffState, HandoffStoreError> {
    match value {
        "requested" => Ok(HandoffState::Requested),
        "prepared" => Ok(HandoffState::Prepared),
        "human_leg_dialing" => Ok(HandoffState::HumanLegDialing),
        "human_leg_answered" => Ok(HandoffState::HumanLegAnswered),
        "committed" => Ok(HandoffState::Committed),
        "human_active" => Ok(HandoffState::HumanActive),
        "ai_resume_preparing" => Ok(HandoffState::AiResumePreparing),
        "ai_resumed" => Ok(HandoffState::AiResumed),
        "aborted" => Ok(HandoffState::Aborted),
        "reconcile_required" => Ok(HandoffState::ReconcileRequired),
        _ => Err(HandoffStoreError::StoredRowInvalid),
    }
}

fn parse_owner(value: &str) -> Result<ControlOwner, HandoffStoreError> {
    match value {
        "ai" => Ok(ControlOwner::Ai),
        "human" => Ok(ControlOwner::Human),
        _ => Err(HandoffStoreError::StoredRowInvalid),
    }
}

fn i64_from(value: u64) -> Result<i64, HandoffStoreError> {
    i64::try_from(value).map_err(|_| HandoffStoreError::InvalidInput)
}

fn positive_i64(value: i64) -> Result<u64, HandoffStoreError> {
    u64::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or(HandoffStoreError::StoredRowInvalid)
}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn bounded_failure_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_FAILURE_CODE_BYTES
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
