use std::{error::Error, fmt};

use converact_contracts::{canonical_sha256, canonical_sha256_with_max_bytes};
use converact_tool_broker_core::{
    ActionAuthority, ActionObservation, ActionReceipt, ActionReceiptInput, ActionResolution,
    AuthorizedToolAction, PrepareDecision,
};
use converact_voice_agent_contracts::{
    ActionReceiptId, AgentReleaseId, ApprovalId, CallAttemptId, ExecutionGeneration, InteractionId,
    ToolRevisionId,
};
use serde_json::{Value, json};
use tokio_postgres::{Row, Transaction};

const MAX_LEASE_MS: u64 = 300_000;
const MAX_IDENTIFIER_BYTES: usize = 255;
const MAX_OUTBOX_BYTES: usize = 131_072;

/// Fixed worker authority used for bounded reconciliation leases.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolActionStoreConfig {
    owner: Box<str>,
    token_hash: Box<str>,
    duration_ms: u64,
}

impl ToolActionStoreConfig {
    /// Creates a bounded lease identity without retaining credentials.
    ///
    /// # Errors
    ///
    /// Rejects malformed worker identifiers, token digests and lease duration.
    pub fn try_new(
        lease_owner: impl AsRef<str>,
        lease_token_hash: impl AsRef<str>,
        lease_duration_ms: u64,
    ) -> Result<Self, ToolStoreError> {
        let lease_owner = lease_owner.as_ref();
        let lease_token_hash = lease_token_hash.as_ref();
        if !bounded_identifier(lease_owner)
            || !lowercase_sha256(lease_token_hash)
            || lease_duration_ms == 0
            || lease_duration_ms > MAX_LEASE_MS
        {
            return Err(ToolStoreError::InvalidInput);
        }
        Ok(Self {
            owner: lease_owner.into(),
            token_hash: lease_token_hash.into(),
            duration_ms: lease_duration_ms,
        })
    }
}

/// Stateless SQL coordinator. Its caller owns the checked tenant transaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolActionSqlStore {
    config: ToolActionStoreConfig,
}

impl ToolActionSqlStore {
    #[must_use]
    pub const fn new(config: ToolActionStoreConfig) -> Self {
        Self { config }
    }

    /// Atomically inserts accepted evidence or resolves replay/reconciliation authority.
    ///
    /// # Errors
    ///
    /// Returns only bounded validation, conflict, database or stored-row failures.
    #[allow(clippy::too_many_lines)] // Keep the locked prepare decision in one auditable sequence.
    pub async fn prepare(
        &self,
        transaction: &Transaction<'_>,
        action: &AuthorizedToolAction,
    ) -> Result<PrepareDecision, ToolStoreError> {
        let digest = proposal_digest(action)?;
        let generation = i64_from(action.proposal().context().execution_generation().get())?;
        let lease_ms = i64_from(self.config.duration_ms)?;
        let approval_id = action.approval_id().map(ApprovalId::as_str);
        let approval_expires_at_ms = action
            .approval()
            .map(|grant| i64_from(grant.expires_at_ms()))
            .transpose()?;
        let inserted = transaction
            .query_opt(
                "INSERT INTO converact_tool_actions (
                   tenant_id, tool_call_id, interaction_id, call_attempt_id,
                   execution_generation, agent_release_id, tool_revision_id,
                   tool_schema_hash, arguments_hash, proposal_digest, arguments,
                   effect_class, risk, action_capability, policy_decision,
                   approval_id, approval_expires_at, state,
                   lease_owner, lease_token_hash, lease_expires_at
                 ) VALUES (
                   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   $12, $13, $14, $15, $16,
                   CASE WHEN $17::BIGINT IS NULL THEN NULL
                        ELSE to_timestamp($17::DOUBLE PRECISION / 1000.0) END,
                   'accepted', $18, $19,
                   transaction_timestamp() + ($20 * interval '1 millisecond')
                 ) ON CONFLICT DO NOTHING
                 RETURNING floor(extract(epoch FROM accepted_at) * 1000)::BIGINT",
                &[
                    &action.proposal().context().tenant_id(),
                    &action.proposal().tool_call_id().as_str(),
                    &action.proposal().context().interaction_id().as_str(),
                    &action.proposal().context().call_attempt_id().as_str(),
                    &generation,
                    &action.proposal().context().agent_release_id().as_str(),
                    &action.proposal().tool_revision_id().as_str(),
                    &action.proposal().tool_schema_hash(),
                    &action.proposal().arguments_hash(),
                    &digest,
                    &action.proposal().arguments(),
                    &action.definition().effect_class().as_str(),
                    &action.definition().risk().as_str(),
                    &action.definition().action_capability(),
                    &action.policy_decision().as_str(),
                    &approval_id,
                    &approval_expires_at_ms,
                    &self.config.owner.as_ref(),
                    &self.config.token_hash.as_ref(),
                    &lease_ms,
                ],
            )
            .await
            .map_err(|_| ToolStoreError::DatabaseUnavailable)?;
        if let Some(row) = inserted {
            let accepted_at_ms = positive_milliseconds(&row, 0)?;
            insert_accepted_receipt(transaction, action, accepted_at_ms).await?;
            return Ok(PrepareDecision::Prepared);
        }

        let row = transaction
            .query_opt(
                "SELECT proposal_digest, state,
                        lease_owner, lease_token_hash,
                        lease_expires_at <= transaction_timestamp() AS lease_expired
                 FROM converact_tool_actions
                 WHERE tenant_id = $1 AND tool_call_id = $2
                 FOR UPDATE",
                &[
                    &action.proposal().context().tenant_id(),
                    &action.proposal().tool_call_id().as_str(),
                ],
            )
            .await
            .map_err(|_| ToolStoreError::DatabaseUnavailable)?
            .ok_or(ToolStoreError::Conflict)?;
        let stored_digest: String = row
            .try_get(0)
            .map_err(|_| ToolStoreError::StoredRowInvalid)?;
        if stored_digest != digest {
            return Ok(PrepareDecision::Conflict);
        }
        let state: String = row
            .try_get(1)
            .map_err(|_| ToolStoreError::StoredRowInvalid)?;
        if state == "state_observed" {
            return load_final_receipt(transaction, action)
                .await
                .map(|receipt| PrepareDecision::Replay(Box::new(receipt)));
        }
        if state != "accepted" {
            return Err(ToolStoreError::StoredRowInvalid);
        }
        let lease_owner: String = row
            .try_get(2)
            .map_err(|_| ToolStoreError::StoredRowInvalid)?;
        let lease_token_hash: String = row
            .try_get(3)
            .map_err(|_| ToolStoreError::StoredRowInvalid)?;
        let lease_expired: bool = row
            .try_get(4)
            .map_err(|_| ToolStoreError::StoredRowInvalid)?;
        if !lease_expired
            && (lease_owner != self.config.owner.as_ref()
                || lease_token_hash != self.config.token_hash.as_ref())
        {
            return Ok(PrepareDecision::InProgress);
        }
        let renewed = transaction
            .execute(
                "UPDATE converact_tool_actions
                 SET lease_owner = $3, lease_token_hash = $4,
                     lease_expires_at = transaction_timestamp() + ($5 * interval '1 millisecond'),
                     updated_at = transaction_timestamp()
                 WHERE tenant_id = $1 AND tool_call_id = $2 AND state = 'accepted'",
                &[
                    &action.proposal().context().tenant_id(),
                    &action.proposal().tool_call_id().as_str(),
                    &self.config.owner.as_ref(),
                    &self.config.token_hash.as_ref(),
                    &lease_ms,
                ],
            )
            .await
            .map_err(|_| ToolStoreError::DatabaseUnavailable)?;
        if renewed == 1 {
            Ok(PrepareDecision::ReconcileRequired)
        } else {
            Err(ToolStoreError::Conflict)
        }
    }

    /// Atomically records completed/state-observed evidence and one result Outbox row.
    ///
    /// # Errors
    ///
    /// Rejects unknown observations, stale leases, authority conflict and invalid stored rows.
    #[allow(clippy::too_many_lines)] // Preserve atomic finalization ordering beside its SQL.
    pub async fn finalize(
        &self,
        transaction: &Transaction<'_>,
        action: &AuthorizedToolAction,
        observation: ActionObservation,
    ) -> Result<ActionReceipt, ToolStoreError> {
        let resolution = observation
            .into_resolution()
            .ok_or(ToolStoreError::OutcomeUnknown)?;
        let digest = proposal_digest(action)?;
        let row = transaction
            .query_opt(
                "SELECT interaction_id, call_attempt_id, execution_generation,
                        agent_release_id, tool_revision_id, arguments_hash,
                        approval_id,
                        floor(extract(epoch FROM accepted_at) * 1000)::BIGINT
                 FROM converact_tool_actions
                 WHERE tenant_id = $1 AND tool_call_id = $2
                   AND proposal_digest = $3 AND state = 'accepted'
                   AND lease_owner = $4 AND lease_token_hash = $5
                   AND lease_expires_at > transaction_timestamp()
                 FOR UPDATE",
                &[
                    &action.proposal().context().tenant_id(),
                    &action.proposal().tool_call_id().as_str(),
                    &digest,
                    &self.config.owner.as_ref(),
                    &self.config.token_hash.as_ref(),
                ],
            )
            .await
            .map_err(|_| ToolStoreError::DatabaseUnavailable)?
            .ok_or(ToolStoreError::LeaseStale)?;
        let stored = StoredAuthority::parse(action.proposal().context().tenant_id(), &row)?;
        let (resolution_name, result_hash, result_payload, failure_code) =
            resolution_columns(&resolution);
        let timestamp = transaction
            .query_one(
                "UPDATE converact_tool_actions
                 SET state = 'state_observed', resolution = $3,
                     completed_at = transaction_timestamp(),
                     state_observed_at = transaction_timestamp(),
                     lease_owner = '', lease_token_hash = '', lease_expires_at = NULL,
                     updated_at = transaction_timestamp()
                 WHERE tenant_id = $1 AND tool_call_id = $2 AND state = 'accepted'
                 RETURNING floor(extract(epoch FROM completed_at) * 1000)::BIGINT,
                           floor(extract(epoch FROM state_observed_at) * 1000)::BIGINT",
                &[
                    &action.proposal().context().tenant_id(),
                    &action.proposal().tool_call_id().as_str(),
                    &resolution_name,
                ],
            )
            .await
            .map_err(|_| ToolStoreError::DatabaseUnavailable)?;
        let completed_at_ms = positive_milliseconds(&timestamp, 0)?;
        let observed_at_ms = positive_milliseconds(&timestamp, 1)?;
        let completed_digest = receipt_digest(
            action.proposal().context().tenant_id(),
            action.proposal().tool_call_id().as_str(),
            stored.generation,
            "completed",
            resolution_name,
            result_hash,
            failure_code,
            completed_at_ms,
        )?;
        let observed_digest = receipt_digest(
            action.proposal().context().tenant_id(),
            action.proposal().tool_call_id().as_str(),
            stored.generation,
            "state_observed",
            resolution_name,
            result_hash,
            failure_code,
            observed_at_ms,
        )?;
        let completed_id = receipt_id("completed", &completed_digest)?;
        let observed_id = receipt_id("state-observed", &observed_digest)?;
        insert_final_receipt(
            transaction,
            action,
            stored.generation,
            &completed_id,
            "completed",
            &completed_digest,
            resolution_name,
            result_hash,
            result_payload,
            failure_code,
            completed_at_ms,
        )
        .await?;
        insert_final_receipt(
            transaction,
            action,
            stored.generation,
            &observed_id,
            "state_observed",
            &observed_digest,
            resolution_name,
            result_hash,
            result_payload,
            failure_code,
            observed_at_ms,
        )
        .await?;
        insert_result_outbox(
            transaction,
            action,
            stored.generation,
            &observed_id,
            &resolution,
        )
        .await?;
        ActionReceipt::try_new(ActionReceiptInput {
            receipt_id: observed_id,
            authority: stored.authority,
            tool_revision_id: stored.tool_revision_id,
            tool_call_id: action.proposal().tool_call_id().clone(),
            approval_id: stored.approval_id,
            arguments_hash: stored.arguments_hash,
            accepted_at_ms: stored.accepted_at_ms,
            completed_at_ms,
            state_observed_at_ms: observed_at_ms,
            resolution,
        })
        .map_err(|_| ToolStoreError::StoredRowInvalid)
    }
}

/// Low-cardinality SQL Adapter failure without SQL, credentials or values.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolStoreError {
    InvalidInput,
    DatabaseUnavailable,
    Conflict,
    LeaseStale,
    OutcomeUnknown,
    StoredRowInvalid,
}

impl ToolStoreError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidInput => "tool_store_input_invalid",
            Self::DatabaseUnavailable => "tool_store_unavailable",
            Self::Conflict => "tool_store_conflict",
            Self::LeaseStale => "tool_store_lease_stale",
            Self::OutcomeUnknown => "tool_store_outcome_unknown",
            Self::StoredRowInvalid => "tool_store_row_invalid",
        }
    }
}

impl fmt::Display for ToolStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ToolStoreError {}

struct StoredAuthority {
    authority: ActionAuthority,
    generation: u64,
    tool_revision_id: ToolRevisionId,
    approval_id: Option<ApprovalId>,
    arguments_hash: String,
    accepted_at_ms: u64,
}

impl StoredAuthority {
    fn parse(tenant_id: &str, row: &Row) -> Result<Self, ToolStoreError> {
        let interaction: String = row
            .try_get(0)
            .map_err(|_| ToolStoreError::StoredRowInvalid)?;
        let attempt: String = row
            .try_get(1)
            .map_err(|_| ToolStoreError::StoredRowInvalid)?;
        let generation_i64: i64 = row
            .try_get(2)
            .map_err(|_| ToolStoreError::StoredRowInvalid)?;
        let generation = u64::try_from(generation_i64)
            .ok()
            .and_then(|value| ExecutionGeneration::new(value).ok())
            .ok_or(ToolStoreError::StoredRowInvalid)?;
        let release: String = row
            .try_get(3)
            .map_err(|_| ToolStoreError::StoredRowInvalid)?;
        let revision: String = row
            .try_get(4)
            .map_err(|_| ToolStoreError::StoredRowInvalid)?;
        let arguments_hash: String = row
            .try_get(5)
            .map_err(|_| ToolStoreError::StoredRowInvalid)?;
        if !lowercase_sha256(&arguments_hash) {
            return Err(ToolStoreError::StoredRowInvalid);
        }
        let approval: Option<String> = row
            .try_get(6)
            .map_err(|_| ToolStoreError::StoredRowInvalid)?;
        let accepted_at_ms = positive_milliseconds(row, 7)?;
        let authority = ActionAuthority::try_new(
            tenant_id,
            InteractionId::parse(interaction).map_err(|_| ToolStoreError::StoredRowInvalid)?,
            CallAttemptId::parse(attempt).map_err(|_| ToolStoreError::StoredRowInvalid)?,
            AgentReleaseId::parse(release).map_err(|_| ToolStoreError::StoredRowInvalid)?,
            generation,
        )
        .map_err(|_| ToolStoreError::StoredRowInvalid)?;
        Ok(Self {
            authority,
            generation: generation.get(),
            tool_revision_id: ToolRevisionId::parse(revision)
                .map_err(|_| ToolStoreError::StoredRowInvalid)?,
            approval_id: approval
                .map(ApprovalId::parse)
                .transpose()
                .map_err(|_| ToolStoreError::StoredRowInvalid)?,
            arguments_hash,
            accepted_at_ms,
        })
    }
}

async fn insert_accepted_receipt(
    transaction: &Transaction<'_>,
    action: &AuthorizedToolAction,
    accepted_at_ms: u64,
) -> Result<(), ToolStoreError> {
    let digest = receipt_digest(
        action.proposal().context().tenant_id(),
        action.proposal().tool_call_id().as_str(),
        action.proposal().context().execution_generation().get(),
        "accepted",
        "",
        None,
        None,
        accepted_at_ms,
    )?;
    let receipt_id = receipt_id("accepted", &digest)?;
    let generation = i64_from(action.proposal().context().execution_generation().get())?;
    let observed = i64_from(accepted_at_ms)?;
    transaction
        .execute(
            "INSERT INTO converact_tool_action_receipts (
               tenant_id, receipt_id, tool_call_id, execution_generation,
               stage, receipt_digest, observed_at
             ) VALUES ($1, $2, $3, $4, 'accepted', $5,
               to_timestamp($6::DOUBLE PRECISION / 1000.0))",
            &[
                &action.proposal().context().tenant_id(),
                &receipt_id.as_str(),
                &action.proposal().tool_call_id().as_str(),
                &generation,
                &digest,
                &observed,
            ],
        )
        .await
        .map_err(|_| ToolStoreError::DatabaseUnavailable)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_final_receipt(
    transaction: &Transaction<'_>,
    action: &AuthorizedToolAction,
    generation: u64,
    receipt_id: &ActionReceiptId,
    stage: &str,
    receipt_digest: &str,
    resolution: &str,
    result_hash: Option<&str>,
    result_payload: Option<&Value>,
    failure_code: Option<&str>,
    observed_at_ms: u64,
) -> Result<(), ToolStoreError> {
    let generation = i64_from(generation)?;
    let observed_at_ms = i64_from(observed_at_ms)?;
    transaction
        .execute(
            "INSERT INTO converact_tool_action_receipts (
               tenant_id, receipt_id, tool_call_id, execution_generation,
               stage, receipt_digest, resolution, result_hash, result_payload,
               failure_code, observed_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               to_timestamp($11::DOUBLE PRECISION / 1000.0))",
            &[
                &action.proposal().context().tenant_id(),
                &receipt_id.as_str(),
                &action.proposal().tool_call_id().as_str(),
                &generation,
                &stage,
                &receipt_digest,
                &resolution,
                &result_hash,
                &result_payload,
                &failure_code,
                &observed_at_ms,
            ],
        )
        .await
        .map_err(|_| ToolStoreError::DatabaseUnavailable)?;
    Ok(())
}

async fn insert_result_outbox(
    transaction: &Transaction<'_>,
    action: &AuthorizedToolAction,
    generation: u64,
    observed_receipt_id: &ActionReceiptId,
    resolution: &ActionResolution,
) -> Result<(), ToolStoreError> {
    let payload = match resolution {
        ActionResolution::Applied(output) => json!({
            "tool_call_id": action.proposal().tool_call_id(),
            "execution_generation": generation,
            "resolution": "applied",
            "result_hash": output.digest(),
            "result": output.value(),
        }),
        ActionResolution::NotApplied(code) => json!({
            "tool_call_id": action.proposal().tool_call_id(),
            "execution_generation": generation,
            "resolution": "not_applied",
            "failure_code": code.as_str(),
        }),
    };
    let payload_hash = canonical_sha256_with_max_bytes(&payload, MAX_OUTBOX_BYTES)
        .map_err(|_| ToolStoreError::InvalidInput)?;
    let outbox_id = format!("tool-action-outbox-{payload_hash}");
    let generation = i64_from(generation)?;
    transaction
        .execute(
            "INSERT INTO converact_tool_action_outbox (
               tenant_id, outbox_id, tool_call_id, state_observed_receipt_id,
               execution_generation, payload_hash, payload
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            &[
                &action.proposal().context().tenant_id(),
                &outbox_id,
                &action.proposal().tool_call_id().as_str(),
                &observed_receipt_id.as_str(),
                &generation,
                &payload_hash,
                &payload,
            ],
        )
        .await
        .map_err(|_| ToolStoreError::DatabaseUnavailable)?;
    Ok(())
}

async fn load_final_receipt(
    transaction: &Transaction<'_>,
    action: &AuthorizedToolAction,
) -> Result<ActionReceipt, ToolStoreError> {
    let row = transaction
        .query_opt(
            "SELECT action.interaction_id, action.call_attempt_id,
                    action.execution_generation, action.agent_release_id,
                    action.tool_revision_id, action.arguments_hash, action.approval_id,
                    floor(extract(epoch FROM action.accepted_at) * 1000)::BIGINT,
                    receipt.receipt_id, receipt.resolution,
                    receipt.result_hash, receipt.result_payload, receipt.failure_code,
                    floor(extract(epoch FROM action.completed_at) * 1000)::BIGINT,
                    floor(extract(epoch FROM action.state_observed_at) * 1000)::BIGINT
             FROM converact_tool_actions AS action
             JOIN converact_tool_action_receipts AS receipt
               ON receipt.tenant_id = action.tenant_id
              AND receipt.tool_call_id = action.tool_call_id
              AND receipt.stage = 'state_observed'
             WHERE action.tenant_id = $1 AND action.tool_call_id = $2",
            &[
                &action.proposal().context().tenant_id(),
                &action.proposal().tool_call_id().as_str(),
            ],
        )
        .await
        .map_err(|_| ToolStoreError::DatabaseUnavailable)?
        .ok_or(ToolStoreError::StoredRowInvalid)?;
    let stored = StoredAuthority::parse(action.proposal().context().tenant_id(), &row)?;
    let receipt_id: String = row
        .try_get(8)
        .map_err(|_| ToolStoreError::StoredRowInvalid)?;
    let resolution_name: String = row
        .try_get(9)
        .map_err(|_| ToolStoreError::StoredRowInvalid)?;
    let result_hash: Option<String> = row
        .try_get(10)
        .map_err(|_| ToolStoreError::StoredRowInvalid)?;
    let result_payload: Option<Value> = row
        .try_get(11)
        .map_err(|_| ToolStoreError::StoredRowInvalid)?;
    let failure_code: Option<String> = row
        .try_get(12)
        .map_err(|_| ToolStoreError::StoredRowInvalid)?;
    let resolution = parse_resolution(
        &resolution_name,
        result_hash.as_deref(),
        result_payload,
        failure_code.as_deref(),
    )?;
    ActionReceipt::try_new(ActionReceiptInput {
        receipt_id: ActionReceiptId::parse(receipt_id)
            .map_err(|_| ToolStoreError::StoredRowInvalid)?,
        authority: stored.authority,
        tool_revision_id: stored.tool_revision_id,
        tool_call_id: action.proposal().tool_call_id().clone(),
        approval_id: stored.approval_id,
        arguments_hash: stored.arguments_hash,
        accepted_at_ms: stored.accepted_at_ms,
        completed_at_ms: positive_milliseconds(&row, 13)?,
        state_observed_at_ms: positive_milliseconds(&row, 14)?,
        resolution,
    })
    .map_err(|_| ToolStoreError::StoredRowInvalid)
}

fn proposal_digest(action: &AuthorizedToolAction) -> Result<String, ToolStoreError> {
    canonical_sha256(&json!({
        "tenant_id": action.proposal().context().tenant_id(),
        "interaction_id": action.proposal().context().interaction_id(),
        "call_attempt_id": action.proposal().context().call_attempt_id(),
        "agent_release_id": action.proposal().context().agent_release_id(),
        "tool_revision_id": action.proposal().tool_revision_id(),
        "tool_call_id": action.proposal().tool_call_id(),
        "tool_schema_hash": action.proposal().tool_schema_hash(),
        "arguments_hash": action.proposal().arguments_hash(),
        "effect_class": action.definition().effect_class().as_str(),
        "risk": action.definition().risk().as_str(),
        "action_capability": action.definition().action_capability(),
    }))
    .map_err(|_| ToolStoreError::InvalidInput)
}

#[allow(clippy::too_many_arguments)]
fn receipt_digest(
    tenant_id: &str,
    tool_call_id: &str,
    generation: u64,
    stage: &str,
    resolution: &str,
    result_hash: Option<&str>,
    failure_code: Option<&str>,
    observed_at_ms: u64,
) -> Result<String, ToolStoreError> {
    canonical_sha256(&json!({
        "tenant_id": tenant_id,
        "tool_call_id": tool_call_id,
        "execution_generation": generation,
        "stage": stage,
        "resolution": resolution,
        "result_hash": result_hash,
        "failure_code": failure_code,
        "observed_at_ms": observed_at_ms,
    }))
    .map_err(|_| ToolStoreError::InvalidInput)
}

fn receipt_id(stage: &str, digest: &str) -> Result<ActionReceiptId, ToolStoreError> {
    ActionReceiptId::parse(format!("action-receipt-{stage}-{digest}"))
        .map_err(|_| ToolStoreError::InvalidInput)
}

fn resolution_columns(
    resolution: &ActionResolution,
) -> (&'static str, Option<&str>, Option<&Value>, Option<&str>) {
    match resolution {
        ActionResolution::Applied(output) => {
            ("applied", Some(output.digest()), Some(output.value()), None)
        }
        ActionResolution::NotApplied(code) => ("not_applied", None, None, Some(code.as_str())),
    }
}

fn parse_resolution(
    resolution: &str,
    result_hash: Option<&str>,
    result_payload: Option<Value>,
    failure_code: Option<&str>,
) -> Result<ActionResolution, ToolStoreError> {
    match (resolution, result_hash, result_payload, failure_code) {
        ("applied", Some(hash), Some(value), None) => {
            let output = converact_tool_broker_core::ToolActionOutput::try_new(value)
                .map_err(|_| ToolStoreError::StoredRowInvalid)?;
            if output.digest() != hash {
                return Err(ToolStoreError::StoredRowInvalid);
            }
            Ok(ActionResolution::Applied(output))
        }
        ("not_applied", None, None, Some(code)) => Ok(ActionResolution::NotApplied(
            converact_tool_broker_core::ActionFailureCode::try_new(code)
                .map_err(|_| ToolStoreError::StoredRowInvalid)?,
        )),
        _ => Err(ToolStoreError::StoredRowInvalid),
    }
}

fn positive_milliseconds(row: &Row, index: usize) -> Result<u64, ToolStoreError> {
    let value: i64 = row
        .try_get(index)
        .map_err(|_| ToolStoreError::StoredRowInvalid)?;
    u64::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or(ToolStoreError::StoredRowInvalid)
}

fn i64_from(value: u64) -> Result<i64, ToolStoreError> {
    i64::try_from(value).map_err(|_| ToolStoreError::InvalidInput)
}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn bounded_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_IDENTIFIER_BYTES
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
