use std::{error::Error, fmt, sync::Arc};

use converact_ai_outbound_core::{
    AgentRelease, Campaign, CampaignTransition, CreateCampaign, ImportContacts,
};
use converact_ai_outbound_store::{
    AdminCommandKind, AdminWriteReceipt, AgentReleaseWrite, AiOutboundStore, CampaignCreateWrite,
    CampaignTransitionWrite, ContactAttemptWrite, ContactImportWrite, StoreError,
};
use converact_kernel_ids::TenantId;
use converact_voice_agent_contracts::IdempotencyKey;
use serde_json::Value;

use crate::{PostgresReleaseToolManifest, PostgresRuntime, TransactionError};

/// Sanitized failure returned by the tenant-scoped Campaign authoring adapter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PostgresCampaignAdminError {
    Invalid,
    NotFound,
    Conflict,
    Stale,
    NotAllowed,
    Unavailable,
    OutcomeUnknown,
}

impl PostgresCampaignAdminError {
    /// Stable low-cardinality error code without SQL or topology details.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Invalid => "campaign_admin_input_invalid",
            Self::NotFound => "campaign_admin_resource_not_found",
            Self::Conflict => "campaign_admin_conflict",
            Self::Stale => "campaign_admin_stale",
            Self::NotAllowed => "campaign_admin_not_allowed",
            Self::Unavailable => "campaign_admin_store_unavailable",
            Self::OutcomeUnknown => "campaign_admin_outcome_unknown",
        }
    }
}

impl fmt::Display for PostgresCampaignAdminError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for PostgresCampaignAdminError {}

/// Durable adapter for Agent publication and Campaign authoring.
///
/// Every public mutation owns exactly one bounded tenant transaction. It exposes no raw client or
/// transaction to the application layer.
pub struct PostgresCampaignAdminStore {
    runtime: Arc<PostgresRuntime>,
    sql: AiOutboundStore,
}

impl PostgresCampaignAdminStore {
    #[must_use]
    pub const fn new(runtime: Arc<PostgresRuntime>, sql: AiOutboundStore) -> Self {
        Self { runtime, sql }
    }

    /// Publishes or exactly replays one immutable Agent Release.
    ///
    /// # Errors
    ///
    /// Returns a sanitized deterministic failure, temporary unavailability or unknown outcome.
    pub async fn publish_agent(
        &self,
        tenant_id: &TenantId,
        release: &AgentRelease,
        tool_manifest: &Value,
        idempotency_key: &IdempotencyKey,
    ) -> Result<AdminWriteReceipt, PostgresCampaignAdminError> {
        let tool_set_hash = release.components().tool_schema_hash.clone();
        PostgresReleaseToolManifest::try_new(
            release.id().clone(),
            &tool_set_hash,
            tool_manifest.clone(),
        )
        .map_err(|_| PostgresCampaignAdminError::Invalid)?;
        let command = release_write(tenant_id, release, idempotency_key)?;
        let tool_manifest = tool_manifest.clone();
        let transaction_tenant = tenant_id.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&transaction_tenant, move |transaction| {
                Box::pin(async move {
                    let receipt = sql.publish_agent_release(transaction, &command).await?;
                    persist_release_tool_manifest(
                        transaction,
                        &command.tenant_id,
                        &command.release_id,
                        &tool_set_hash,
                        &tool_manifest,
                    )
                    .await?;
                    Ok(receipt)
                })
            })
            .await
            .map_err(map_admin_write_error)
    }

    /// Creates or exactly replays one draft Campaign.
    ///
    /// # Errors
    ///
    /// Returns a sanitized deterministic failure, temporary unavailability or unknown outcome.
    pub async fn create_campaign(
        &self,
        tenant_id: &TenantId,
        campaign: &CreateCampaign,
        idempotency_key: &IdempotencyKey,
    ) -> Result<AdminWriteReceipt, PostgresCampaignAdminError> {
        let command = campaign_write(tenant_id, campaign, idempotency_key)?;
        let transaction_tenant = tenant_id.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&transaction_tenant, move |transaction| {
                Box::pin(async move { sql.create_campaign(transaction, &command).await })
            })
            .await
            .map_err(map_admin_write_error)
    }

    /// Imports one bounded Contact batch and its first physical Attempts atomically.
    ///
    /// # Errors
    ///
    /// Returns a sanitized deterministic failure, temporary unavailability or unknown outcome.
    pub async fn import_contacts(
        &self,
        tenant_id: &TenantId,
        command: &ImportContacts,
    ) -> Result<AdminWriteReceipt, PostgresCampaignAdminError> {
        let command = contact_import_write(tenant_id, command);
        let transaction_tenant = tenant_id.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&transaction_tenant, move |transaction| {
                Box::pin(async move { sql.import_contacts(transaction, &command).await })
            })
            .await
            .map_err(map_admin_write_error)
    }

    /// Replays or applies one revision-fenced Core Campaign transition atomically.
    ///
    /// # Errors
    ///
    /// Returns a sanitized deterministic failure, temporary unavailability or unknown outcome.
    pub async fn transition_campaign(
        &self,
        tenant_id: &TenantId,
        command: &CampaignTransition,
    ) -> Result<AdminWriteReceipt, PostgresCampaignAdminError> {
        let transaction_tenant = tenant_id.clone();
        let tenant = tenant_id.clone();
        let command = command.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&transaction_tenant, move |transaction| {
                Box::pin(async move {
                    if let Some(receipt) = sql
                        .replay_admin_command(
                            transaction,
                            &tenant,
                            command.idempotency_key(),
                            AdminCommandKind::TransitionCampaign,
                            command.request_hash(),
                        )
                        .await?
                    {
                        return Ok(receipt);
                    }
                    let stored = sql
                        .lock_campaign(transaction, &tenant, command.campaign_id())
                        .await?;
                    if stored.revision() != command.expected_revision() {
                        return Err(StoreError::AdminStale);
                    }
                    let aggregate = Campaign::restore(
                        stored.id().clone(),
                        stored.state(),
                        stored.active_attempts(),
                        stored.revision(),
                    )
                    .map_err(|_| StoreError::StoredRowInvalid)?;
                    let next = aggregate
                        .apply(command.command())
                        .map_err(|_| StoreError::AdminNotAllowed)?;
                    let write = CampaignTransitionWrite {
                        tenant_id: tenant,
                        campaign_id: command.campaign_id().clone(),
                        idempotency_key: command.idempotency_key().clone(),
                        request_hash: command.request_hash().to_owned(),
                        expected_state: aggregate.state(),
                        next_state: next.state(),
                        expected_campaign_revision: aggregate.revision(),
                        next_campaign_revision: next.revision(),
                        expected_active_attempts: aggregate.active_attempts(),
                    };
                    sql.persist_campaign_transition(transaction, &write).await
                })
            })
            .await
            .map_err(map_admin_write_error)
    }
}

async fn persist_release_tool_manifest(
    transaction: &tokio_postgres::Transaction<'_>,
    tenant_id: &TenantId,
    release_id: &converact_voice_agent_contracts::AgentReleaseId,
    tool_set_hash: &str,
    tool_manifest: &Value,
) -> Result<(), StoreError> {
    let inserted = transaction
        .query_opt(
            "INSERT INTO public.converact_agent_release_tool_manifests (
               tenant_id, agent_release_id, tool_set_hash, tool_manifest
             ) VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING RETURNING agent_release_id",
            &[
                &tenant_id.as_str(),
                &release_id.as_str(),
                &tool_set_hash,
                &tool_manifest,
            ],
        )
        .await
        .map_err(|_| StoreError::DatabaseUnavailable)?
        .is_some();
    if inserted {
        return Ok(());
    }
    let row = transaction
        .query_opt(
            "SELECT tool_set_hash, tool_manifest
             FROM public.converact_agent_release_tool_manifests
             WHERE tenant_id = $1 AND agent_release_id = $2",
            &[&tenant_id.as_str(), &release_id.as_str()],
        )
        .await
        .map_err(|_| StoreError::DatabaseUnavailable)?;
    let Some(row) = row else {
        return Err(StoreError::AdminConflict);
    };
    let stored_hash: String = row.try_get(0).map_err(|_| StoreError::StoredRowInvalid)?;
    let stored_manifest: Value = row.try_get(1).map_err(|_| StoreError::StoredRowInvalid)?;
    if stored_hash == tool_set_hash && stored_manifest == *tool_manifest {
        Ok(())
    } else {
        Err(StoreError::AdminConflict)
    }
}

impl fmt::Debug for PostgresCampaignAdminStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PostgresCampaignAdminStore([REDACTED])")
    }
}

fn release_write(
    tenant_id: &TenantId,
    release: &AgentRelease,
    idempotency_key: &IdempotencyKey,
) -> Result<AgentReleaseWrite, PostgresCampaignAdminError> {
    let components = serde_json::to_value(release.components())
        .map_err(|_| PostgresCampaignAdminError::Invalid)?;
    Ok(AgentReleaseWrite {
        tenant_id: tenant_id.clone(),
        idempotency_key: idempotency_key.clone(),
        release_id: release.id().clone(),
        definition_id: release.definition_id().clone(),
        name: release.name().to_owned(),
        language: release.language().to_owned(),
        content_hash: release.content_hash().to_owned(),
        components,
    })
}

fn campaign_write(
    tenant_id: &TenantId,
    campaign: &CreateCampaign,
    idempotency_key: &IdempotencyKey,
) -> Result<CampaignCreateWrite, PostgresCampaignAdminError> {
    let schedule = serde_json::to_value(campaign.schedule())
        .map_err(|_| PostgresCampaignAdminError::Invalid)?;
    Ok(CampaignCreateWrite {
        tenant_id: tenant_id.clone(),
        idempotency_key: idempotency_key.clone(),
        campaign_id: campaign.campaign_id().clone(),
        agent_release_id: campaign.agent_release_id().clone(),
        audience_id: campaign.audience_id().to_owned(),
        dial_policy_revision: campaign.dial_policy_revision().to_owned(),
        dial_policy_content_hash: campaign.dial_policy().content_hash().to_owned(),
        dial_caller_id: campaign.dial_policy().caller_id().map(str::to_owned),
        dial_timeout_secs: campaign.dial_policy().timeout_secs(),
        dial_trunk: campaign.dial_policy().trunk().map(str::to_owned),
        schedule,
        request_hash: campaign.request_hash().to_owned(),
    })
}

fn contact_import_write(tenant_id: &TenantId, command: &ImportContacts) -> ContactImportWrite {
    let contacts = command
        .contacts()
        .iter()
        .map(|contact| ContactAttemptWrite {
            contact_id: contact.contact_id().clone(),
            external_contact_id: contact.external_contact_id().to_owned(),
            destination: contact.destination().to_owned(),
            consent_id: contact.consent_id().to_owned(),
            recording_mode: contact.recording_mode().as_str().to_owned(),
            retention_until_ms: contact.retention_until_ms(),
            scheduled_for_ms: contact.scheduled_for_ms(),
            attempt_id: contact.attempt_id().clone(),
            interaction_id: contact.interaction_id().clone(),
            attempt_idempotency_key: contact.idempotency_key().clone(),
        })
        .collect();
    ContactImportWrite {
        tenant_id: tenant_id.clone(),
        campaign_id: command.campaign_id().clone(),
        expected_campaign_revision: command.expected_campaign_revision(),
        idempotency_key: command.idempotency_key().clone(),
        request_hash: command.request_hash().to_owned(),
        contacts,
    }
}

#[allow(clippy::needless_pass_by_value)]
fn map_admin_write_error(error: TransactionError<StoreError>) -> PostgresCampaignAdminError {
    match error {
        TransactionError::Work(StoreError::InvalidInput) => PostgresCampaignAdminError::Invalid,
        TransactionError::Work(StoreError::AdminNotFound) => PostgresCampaignAdminError::NotFound,
        TransactionError::Work(StoreError::AdminConflict) => PostgresCampaignAdminError::Conflict,
        TransactionError::Work(StoreError::AdminStale) => PostgresCampaignAdminError::Stale,
        TransactionError::Work(StoreError::AdminNotAllowed) => {
            PostgresCampaignAdminError::NotAllowed
        }
        TransactionError::CommitUnknown | TransactionError::RollbackUnknown => {
            PostgresCampaignAdminError::OutcomeUnknown
        }
        TransactionError::AdmissionRejected
        | TransactionError::PoolUnavailable
        | TransactionError::DatabaseUnavailable
        | TransactionError::DeadlineExceeded
        | TransactionError::Work(_) => PostgresCampaignAdminError::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_commit_and_rollback_outcomes_never_become_safe_retries() {
        for error in [
            TransactionError::CommitUnknown,
            TransactionError::RollbackUnknown,
        ] {
            assert_eq!(
                map_admin_write_error(error),
                PostgresCampaignAdminError::OutcomeUnknown
            );
        }
    }

    #[test]
    fn malformed_stored_rows_are_unavailable_not_client_input() {
        assert_eq!(
            map_admin_write_error(TransactionError::Work(StoreError::StoredRowInvalid)),
            PostgresCampaignAdminError::Unavailable
        );
    }
}
