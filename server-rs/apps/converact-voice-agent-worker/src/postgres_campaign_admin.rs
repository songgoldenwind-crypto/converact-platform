use std::fmt;

use converact_ai_outbound_core::{
    AgentRelease, CampaignTransition, CreateCampaign, ImportContacts,
};
use converact_ai_outbound_store::AdminWriteReceipt;
use converact_kernel_ids::TenantId;
use converact_postgres_store::{PostgresCampaignAdminError, PostgresCampaignAdminStore};
use converact_voice_agent_contracts::IdempotencyKey;

use crate::{
    AdminMutationResource, AgentReleaseToolManifest, AuthenticatedTenant, CampaignAdminError,
    CampaignAdminPort,
};

/// Application adapter from the Campaign Admin HTTP contract to tenant-scoped `PostgreSQL` writes.
pub struct PostgresCampaignAdminPort {
    store: PostgresCampaignAdminStore,
    tenant_id: TenantId,
}

impl PostgresCampaignAdminPort {
    #[must_use]
    pub const fn new(store: PostgresCampaignAdminStore, tenant_id: TenantId) -> Self {
        Self { store, tenant_id }
    }

    fn tenant(&self, tenant: &AuthenticatedTenant) -> Result<TenantId, CampaignAdminError> {
        let tenant = TenantId::parse(tenant.as_str()).map_err(|_| CampaignAdminError::invalid())?;
        if tenant != self.tenant_id {
            return Err(CampaignAdminError::not_allowed());
        }
        Ok(tenant)
    }
}

impl CampaignAdminPort for PostgresCampaignAdminPort {
    async fn publish_agent(
        &self,
        tenant: &AuthenticatedTenant,
        release: &AgentRelease,
        tool_manifest: &AgentReleaseToolManifest,
        idempotency_key: &IdempotencyKey,
    ) -> Result<AdminMutationResource, CampaignAdminError> {
        let tenant = self.tenant(tenant)?;
        self.store
            .publish_agent(&tenant, release, tool_manifest.value(), idempotency_key)
            .await
            .map_err(map_store_error)
            .and_then(|receipt| map_receipt(&receipt))
    }

    async fn create_campaign(
        &self,
        tenant: &AuthenticatedTenant,
        campaign: &CreateCampaign,
        idempotency_key: &IdempotencyKey,
    ) -> Result<AdminMutationResource, CampaignAdminError> {
        let tenant = self.tenant(tenant)?;
        self.store
            .create_campaign(&tenant, campaign, idempotency_key)
            .await
            .map_err(map_store_error)
            .and_then(|receipt| map_receipt(&receipt))
    }

    async fn import_contacts(
        &self,
        tenant: &AuthenticatedTenant,
        command: &ImportContacts,
    ) -> Result<AdminMutationResource, CampaignAdminError> {
        let tenant = self.tenant(tenant)?;
        self.store
            .import_contacts(&tenant, command)
            .await
            .map_err(map_store_error)
            .and_then(|receipt| map_receipt(&receipt))
    }

    async fn transition_campaign(
        &self,
        tenant: &AuthenticatedTenant,
        command: &CampaignTransition,
    ) -> Result<AdminMutationResource, CampaignAdminError> {
        let tenant = self.tenant(tenant)?;
        self.store
            .transition_campaign(&tenant, command)
            .await
            .map_err(map_store_error)
            .and_then(|receipt| map_receipt(&receipt))
    }
}

impl fmt::Debug for PostgresCampaignAdminPort {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PostgresCampaignAdminPort([REDACTED])")
    }
}

fn map_receipt(receipt: &AdminWriteReceipt) -> Result<AdminMutationResource, CampaignAdminError> {
    AdminMutationResource::try_new(
        receipt.resource_id(),
        receipt.state(),
        receipt.revision(),
        receipt.accepted_count(),
        receipt.replayed(),
    )
}

const fn map_store_error(error: PostgresCampaignAdminError) -> CampaignAdminError {
    match error {
        PostgresCampaignAdminError::Invalid => CampaignAdminError::invalid(),
        PostgresCampaignAdminError::NotFound => CampaignAdminError::not_found(),
        PostgresCampaignAdminError::Conflict => CampaignAdminError::conflict(),
        PostgresCampaignAdminError::Stale => CampaignAdminError::stale(),
        PostgresCampaignAdminError::NotAllowed => CampaignAdminError::not_allowed(),
        PostgresCampaignAdminError::Unavailable => CampaignAdminError::unavailable(),
        PostgresCampaignAdminError::OutcomeUnknown => CampaignAdminError::outcome_unknown(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_database_outcome_stays_distinct_from_temporary_unavailability() {
        assert_eq!(
            map_store_error(PostgresCampaignAdminError::OutcomeUnknown).code(),
            "ai_outbound_admin_outcome_unknown"
        );
        assert_eq!(
            map_store_error(PostgresCampaignAdminError::Unavailable).code(),
            "ai_outbound_admin_unavailable"
        );
    }
}
