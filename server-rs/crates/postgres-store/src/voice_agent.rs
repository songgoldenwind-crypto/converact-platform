use std::{error::Error, fmt, sync::Arc};

use converact_ai_outbound_core::{AgentReleaseBinding, ReleaseComponentDigests};
use converact_contracts::canonical_sha256;
use converact_kernel_ids::TenantId;
use converact_post_call_finalization_store::{
    FinalizationJobProgress, FinalizationSqlStore, FinalizationStoreError,
};
use converact_voice_agent_contracts::{
    AgentDefinitionId, AgentReleaseId, AgentReleaseState, CallAttemptId, CallAttemptState,
    CampaignId, CampaignState, IdempotencyKey,
};
use serde_json::{Value, json};
use tokio_postgres::{Row, Transaction};

use crate::{PostgresRuntime, TransactionError};

/// Sanitized durable query or reconciliation failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PostgresVoiceAgentStoreError {
    code: &'static str,
}

impl PostgresVoiceAgentStoreError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for PostgresVoiceAgentStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for PostgresVoiceAgentStoreError {}

/// Validated durable Agent Release projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredVoiceAgentRelease {
    id: AgentReleaseId,
    definition_id: AgentDefinitionId,
    state: AgentReleaseState,
    content_hash: Box<str>,
    components: ReleaseComponentDigests,
}

impl StoredVoiceAgentRelease {
    #[must_use]
    pub const fn id(&self) -> &AgentReleaseId {
        &self.id
    }

    #[must_use]
    pub const fn definition_id(&self) -> &AgentDefinitionId {
        &self.definition_id
    }

    #[must_use]
    pub const fn state(&self) -> AgentReleaseState {
        self.state
    }

    #[must_use]
    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }

    #[must_use]
    pub const fn components(&self) -> &ReleaseComponentDigests {
        &self.components
    }
}

/// Validated durable Campaign projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredVoiceAgentCampaign {
    id: CampaignId,
    release_id: AgentReleaseId,
    state: CampaignState,
    active_attempts: u32,
}

impl StoredVoiceAgentCampaign {
    #[must_use]
    pub const fn id(&self) -> &CampaignId {
        &self.id
    }

    #[must_use]
    pub const fn release_id(&self) -> &AgentReleaseId {
        &self.release_id
    }

    #[must_use]
    pub const fn state(&self) -> CampaignState {
        self.state
    }

    #[must_use]
    pub const fn active_attempts(&self) -> u32 {
        self.active_attempts
    }
}

/// Validated durable Attempt inspection projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredVoiceAgentAttempt {
    id: CallAttemptId,
    campaign_id: CampaignId,
    release_id: AgentReleaseId,
    state: CallAttemptState,
    disclosure_completed: bool,
    finalization: Option<FinalizationJobProgress>,
}

impl StoredVoiceAgentAttempt {
    #[must_use]
    pub const fn id(&self) -> &CallAttemptId {
        &self.id
    }

    #[must_use]
    pub const fn campaign_id(&self) -> &CampaignId {
        &self.campaign_id
    }

    #[must_use]
    pub const fn release_id(&self) -> &AgentReleaseId {
        &self.release_id
    }

    #[must_use]
    pub const fn state(&self) -> CallAttemptState {
        self.state
    }

    #[must_use]
    pub const fn disclosure_completed(&self) -> bool {
        self.disclosure_completed
    }

    #[must_use]
    pub const fn finalization(&self) -> Option<&FinalizationJobProgress> {
        self.finalization.as_ref()
    }
}

/// Exact durable reconciliation request result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PostgresReconcileRequestDecision {
    Created,
    Replayed,
}

/// Tenant-scoped read and operator-reconciliation Store for the Worker/API boundary.
pub struct PostgresVoiceAgentStore {
    runtime: Arc<PostgresRuntime>,
    finalization_sql: FinalizationSqlStore,
}

impl PostgresVoiceAgentStore {
    #[must_use]
    pub const fn new(
        runtime: Arc<PostgresRuntime>,
        finalization_sql: FinalizationSqlStore,
    ) -> Self {
        Self {
            runtime,
            finalization_sql,
        }
    }

    /// Loads one exact tenant-bound Release and validates all execution component digests.
    ///
    /// # Errors
    ///
    /// Returns a sanitized Store failure when `PostgreSQL` is unavailable or a row is malformed.
    pub async fn load_release(
        &self,
        tenant: &TenantId,
        release_id: &AgentReleaseId,
    ) -> Result<Option<StoredVoiceAgentRelease>, PostgresVoiceAgentStoreError> {
        let tenant = tenant.clone();
        let query_tenant = tenant.clone();
        let release_id = release_id.clone();
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move { load_release(transaction, &query_tenant, &release_id).await })
            })
            .await
            .map_err(map_transaction_error)
    }

    /// Loads one exact tenant-bound Campaign inspection projection.
    ///
    /// # Errors
    ///
    /// Returns a sanitized Store failure when `PostgreSQL` is unavailable or a row is malformed.
    pub async fn load_campaign(
        &self,
        tenant: &TenantId,
        campaign_id: &CampaignId,
    ) -> Result<Option<StoredVoiceAgentCampaign>, PostgresVoiceAgentStoreError> {
        let tenant = tenant.clone();
        let query_tenant = tenant.clone();
        let campaign_id = campaign_id.clone();
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(
                    async move { load_campaign(transaction, &query_tenant, &campaign_id).await },
                )
            })
            .await
            .map_err(map_transaction_error)
    }

    /// Loads one bounded Attempt plus authoritative post-call progress when scheduled.
    ///
    /// # Errors
    ///
    /// Returns a sanitized Store failure for unavailable, malformed or inconsistent progress.
    pub async fn load_attempt(
        &self,
        tenant: &TenantId,
        attempt_id: &CallAttemptId,
    ) -> Result<Option<StoredVoiceAgentAttempt>, PostgresVoiceAgentStoreError> {
        let tenant = tenant.clone();
        let query_tenant = tenant.clone();
        let attempt_id = attempt_id.clone();
        let finalization_sql = self.finalization_sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    let Some(mut attempt) =
                        load_attempt(transaction, &query_tenant, &attempt_id).await?
                    else {
                        return Ok(None);
                    };
                    attempt.finalization = finalization_sql
                        .load_progress(transaction, &query_tenant, &attempt_id)
                        .await
                        .map_err(VoiceAgentWorkError::Finalization)?;
                    if attempt.state == CallAttemptState::Completed
                        && attempt.finalization.is_none()
                    {
                        return Err(VoiceAgentWorkError::StoredRowInvalid);
                    }
                    Ok(Some(attempt))
                })
            })
            .await
            .map_err(map_transaction_error)
    }

    /// Creates or exactly replays a content-free operator reconciliation request.
    ///
    /// # Errors
    ///
    /// Returns a sanitized Store failure for unavailable storage or an idempotency conflict.
    pub async fn request_reconcile(
        &self,
        tenant: &TenantId,
        attempt_id: &CallAttemptId,
        idempotency_key: &IdempotencyKey,
    ) -> Result<Option<PostgresReconcileRequestDecision>, PostgresVoiceAgentStoreError> {
        let tenant = tenant.clone();
        let query_tenant = tenant.clone();
        let attempt_id = attempt_id.clone();
        let idempotency_key = idempotency_key.clone();
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    request_reconcile(transaction, &query_tenant, &attempt_id, &idempotency_key)
                        .await
                })
            })
            .await
            .map_err(map_transaction_error)
    }
}

impl fmt::Debug for PostgresVoiceAgentStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PostgresVoiceAgentStore")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy)]
enum VoiceAgentWorkError {
    DatabaseUnavailable,
    StoredRowInvalid,
    Conflict,
    Finalization(FinalizationStoreError),
}

async fn load_release(
    transaction: &Transaction<'_>,
    tenant: &TenantId,
    release_id: &AgentReleaseId,
) -> Result<Option<StoredVoiceAgentRelease>, VoiceAgentWorkError> {
    transaction
        .query_opt(
            "SELECT id, definition_id, state, content_hash, components
             FROM converact_agent_releases
             WHERE tenant_id = $1 AND id = $2",
            &[&tenant.as_str(), &release_id.as_str()],
        )
        .await
        .map_err(|_| VoiceAgentWorkError::DatabaseUnavailable)?
        .map(|row| parse_release(&row))
        .transpose()
}

fn parse_release(row: &Row) -> Result<StoredVoiceAgentRelease, VoiceAgentWorkError> {
    let id = AgentReleaseId::parse(string_at(row, 0)?)
        .map_err(|_| VoiceAgentWorkError::StoredRowInvalid)?;
    let definition_id = AgentDefinitionId::parse(string_at(row, 1)?)
        .map_err(|_| VoiceAgentWorkError::StoredRowInvalid)?;
    let stored_state = string_at(row, 2)?;
    let state = match stored_state.as_str() {
        "published" => AgentReleaseState::Published,
        "retired" => AgentReleaseState::Retired,
        _ => return Err(VoiceAgentWorkError::StoredRowInvalid),
    };
    let content_hash = string_at(row, 3)?;
    let components: Value = row
        .try_get(4)
        .map_err(|_| VoiceAgentWorkError::StoredRowInvalid)?;
    let components: ReleaseComponentDigests =
        serde_json::from_value(components).map_err(|_| VoiceAgentWorkError::StoredRowInvalid)?;
    AgentReleaseBinding::try_new(id.clone(), &content_hash, components.clone())
        .map_err(|_| VoiceAgentWorkError::StoredRowInvalid)?;
    Ok(StoredVoiceAgentRelease {
        id,
        definition_id,
        state,
        content_hash: content_hash.into(),
        components,
    })
}

async fn load_campaign(
    transaction: &Transaction<'_>,
    tenant: &TenantId,
    campaign_id: &CampaignId,
) -> Result<Option<StoredVoiceAgentCampaign>, VoiceAgentWorkError> {
    transaction
        .query_opt(
            "SELECT id, agent_release_id, state, active_attempts
             FROM converact_outbound_campaigns
             WHERE tenant_id = $1 AND id = $2",
            &[&tenant.as_str(), &campaign_id.as_str()],
        )
        .await
        .map_err(|_| VoiceAgentWorkError::DatabaseUnavailable)?
        .map(|row| parse_campaign(&row))
        .transpose()
}

fn parse_campaign(row: &Row) -> Result<StoredVoiceAgentCampaign, VoiceAgentWorkError> {
    let id =
        CampaignId::parse(string_at(row, 0)?).map_err(|_| VoiceAgentWorkError::StoredRowInvalid)?;
    let release_id = AgentReleaseId::parse(string_at(row, 1)?)
        .map_err(|_| VoiceAgentWorkError::StoredRowInvalid)?;
    let stored_state = string_at(row, 2)?;
    let state = parse_campaign_state(&stored_state)?;
    let active_attempts: i32 = row
        .try_get(3)
        .map_err(|_| VoiceAgentWorkError::StoredRowInvalid)?;
    let active_attempts =
        u32::try_from(active_attempts).map_err(|_| VoiceAgentWorkError::StoredRowInvalid)?;
    Ok(StoredVoiceAgentCampaign {
        id,
        release_id,
        state,
        active_attempts,
    })
}

async fn load_attempt(
    transaction: &Transaction<'_>,
    tenant: &TenantId,
    attempt_id: &CallAttemptId,
) -> Result<Option<StoredVoiceAgentAttempt>, VoiceAgentWorkError> {
    transaction
        .query_opt(
            "SELECT id, campaign_id, agent_release_id, state,
                    CASE WHEN state IN (
                      'conversing', 'handoff_pending', 'human_active',
                      'ai_resuming', 'finalizing', 'completed'
                    ) THEN TRUE ELSE disclosure_completed END
             FROM converact_outbound_call_attempts
             WHERE tenant_id = $1 AND id = $2",
            &[&tenant.as_str(), &attempt_id.as_str()],
        )
        .await
        .map_err(|_| VoiceAgentWorkError::DatabaseUnavailable)?
        .map(|row| parse_attempt(&row))
        .transpose()
}

fn parse_attempt(row: &Row) -> Result<StoredVoiceAgentAttempt, VoiceAgentWorkError> {
    let id = CallAttemptId::parse(string_at(row, 0)?)
        .map_err(|_| VoiceAgentWorkError::StoredRowInvalid)?;
    let campaign_id =
        CampaignId::parse(string_at(row, 1)?).map_err(|_| VoiceAgentWorkError::StoredRowInvalid)?;
    let release_id = AgentReleaseId::parse(string_at(row, 2)?)
        .map_err(|_| VoiceAgentWorkError::StoredRowInvalid)?;
    let stored_state = string_at(row, 3)?;
    let state = parse_attempt_state(&stored_state)?;
    let disclosure_completed = row
        .try_get(4)
        .map_err(|_| VoiceAgentWorkError::StoredRowInvalid)?;
    Ok(StoredVoiceAgentAttempt {
        id,
        campaign_id,
        release_id,
        state,
        disclosure_completed,
        finalization: None,
    })
}

async fn request_reconcile(
    transaction: &Transaction<'_>,
    tenant: &TenantId,
    attempt_id: &CallAttemptId,
    idempotency_key: &IdempotencyKey,
) -> Result<Option<PostgresReconcileRequestDecision>, VoiceAgentWorkError> {
    let request_hash = canonical_sha256(&json!({
        "tenant_id": tenant.as_str(),
        "call_attempt_id": attempt_id.as_str(),
    }))
    .map_err(|_| VoiceAgentWorkError::StoredRowInvalid)?;
    if transaction
        .query_opt(
            "INSERT INTO converact_outbound_reconcile_requests (
               tenant_id, idempotency_key, call_attempt_id, request_hash
             )
             SELECT $1, $2, attempt.id, $4
             FROM converact_outbound_call_attempts AS attempt
             WHERE attempt.tenant_id = $1 AND attempt.id = $3
             ON CONFLICT DO NOTHING
             RETURNING idempotency_key",
            &[
                &tenant.as_str(),
                &idempotency_key.as_str(),
                &attempt_id.as_str(),
                &request_hash,
            ],
        )
        .await
        .map_err(|_| VoiceAgentWorkError::DatabaseUnavailable)?
        .is_some()
    {
        return Ok(Some(PostgresReconcileRequestDecision::Created));
    }
    if let Some(row) = transaction
        .query_opt(
            "SELECT call_attempt_id, request_hash
             FROM converact_outbound_reconcile_requests
             WHERE tenant_id = $1 AND idempotency_key = $2",
            &[&tenant.as_str(), &idempotency_key.as_str()],
        )
        .await
        .map_err(|_| VoiceAgentWorkError::DatabaseUnavailable)?
    {
        return if string_at(&row, 0)? == attempt_id.as_str() && string_at(&row, 1)? == request_hash
        {
            Ok(Some(PostgresReconcileRequestDecision::Replayed))
        } else {
            Err(VoiceAgentWorkError::Conflict)
        };
    }
    let exists = transaction
        .query_opt(
            "SELECT 1 FROM converact_outbound_call_attempts
             WHERE tenant_id = $1 AND id = $2",
            &[&tenant.as_str(), &attempt_id.as_str()],
        )
        .await
        .map_err(|_| VoiceAgentWorkError::DatabaseUnavailable)?
        .is_some();
    if exists {
        Err(VoiceAgentWorkError::Conflict)
    } else {
        Ok(None)
    }
}

fn string_at(row: &Row, index: usize) -> Result<String, VoiceAgentWorkError> {
    row.try_get(index)
        .map_err(|_| VoiceAgentWorkError::StoredRowInvalid)
}

fn parse_campaign_state(value: &str) -> Result<CampaignState, VoiceAgentWorkError> {
    match value {
        "draft" => Ok(CampaignState::Draft),
        "scheduled" => Ok(CampaignState::Scheduled),
        "running" => Ok(CampaignState::Running),
        "paused" => Ok(CampaignState::Paused),
        "draining" => Ok(CampaignState::Draining),
        "completed" => Ok(CampaignState::Completed),
        "cancelled" => Ok(CampaignState::Cancelled),
        "archived" => Ok(CampaignState::Archived),
        _ => Err(VoiceAgentWorkError::StoredRowInvalid),
    }
}

fn parse_attempt_state(value: &str) -> Result<CallAttemptState, VoiceAgentWorkError> {
    match value {
        "planned" => Ok(CallAttemptState::Planned),
        "claimed" => Ok(CallAttemptState::Claimed),
        "compliance_approved" => Ok(CallAttemptState::ComplianceApproved),
        "compliance_blocked" => Ok(CallAttemptState::ComplianceBlocked),
        "agent_capacity_reserved" => Ok(CallAttemptState::AgentCapacityReserved),
        "dialing" => Ok(CallAttemptState::Dialing),
        "ringing" => Ok(CallAttemptState::Ringing),
        "answered" => Ok(CallAttemptState::Answered),
        "agent_connecting" => Ok(CallAttemptState::AgentConnecting),
        "disclosure_pending" => Ok(CallAttemptState::DisclosurePending),
        "conversing" => Ok(CallAttemptState::Conversing),
        "handoff_pending" => Ok(CallAttemptState::HandoffPending),
        "human_active" => Ok(CallAttemptState::HumanActive),
        "ai_resuming" => Ok(CallAttemptState::AiResuming),
        "finalizing" => Ok(CallAttemptState::Finalizing),
        "completed" => Ok(CallAttemptState::Completed),
        "cancelled" => Ok(CallAttemptState::Cancelled),
        "busy" => Ok(CallAttemptState::Busy),
        "no_answer" => Ok(CallAttemptState::NoAnswer),
        "rejected" => Ok(CallAttemptState::Rejected),
        "failed_before_answer" => Ok(CallAttemptState::FailedBeforeAnswer),
        "failed_after_answer" => Ok(CallAttemptState::FailedAfterAnswer),
        "outcome_unknown" => Ok(CallAttemptState::OutcomeUnknown),
        "reconcile_required" => Ok(CallAttemptState::ReconcileRequired),
        _ => Err(VoiceAgentWorkError::StoredRowInvalid),
    }
}

#[allow(clippy::needless_pass_by_value)]
fn map_transaction_error(
    error: TransactionError<VoiceAgentWorkError>,
) -> PostgresVoiceAgentStoreError {
    let code = match error {
        TransactionError::Work(VoiceAgentWorkError::Conflict) => "voice_agent_reconcile_conflict",
        TransactionError::Work(
            VoiceAgentWorkError::StoredRowInvalid
            | VoiceAgentWorkError::Finalization(FinalizationStoreError::StoredRowInvalid),
        ) => "voice_agent_store_row_invalid",
        TransactionError::Work(VoiceAgentWorkError::Finalization(error)) => error.code(),
        TransactionError::Work(VoiceAgentWorkError::DatabaseUnavailable)
        | TransactionError::AdmissionRejected
        | TransactionError::PoolUnavailable
        | TransactionError::DatabaseUnavailable
        | TransactionError::DeadlineExceeded
        | TransactionError::RollbackUnknown
        | TransactionError::CommitUnknown => "voice_agent_store_unavailable",
    };
    PostgresVoiceAgentStoreError { code }
}
