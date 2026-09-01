use converact_kernel_ids::TenantId;
use converact_postgres_store::{
    PostgresVoiceAgentStore, StoredVoiceAgentAttempt, StoredVoiceAgentCampaign,
    StoredVoiceAgentRelease,
};
use converact_voice_agent_contracts::{AgentReleaseId, CallAttemptId, CampaignId, IdempotencyKey};

use crate::{
    AgentReleaseResource, AttemptResource, AuthenticatedTenant, CampaignResource, ReconcileReceipt,
    RepositoryError, VoiceAgentRepository,
};

/// Concrete `PostgreSQL` inspection and reconciliation repository.
pub struct PostgresVoiceAgentRepository {
    store: PostgresVoiceAgentStore,
}

impl PostgresVoiceAgentRepository {
    #[must_use]
    pub const fn new(store: PostgresVoiceAgentStore) -> Self {
        Self { store }
    }
}

impl VoiceAgentRepository for PostgresVoiceAgentRepository {
    async fn release(
        &self,
        tenant: &AuthenticatedTenant,
        id: &str,
    ) -> Result<Option<AgentReleaseResource>, RepositoryError> {
        let tenant = parse_tenant(tenant)?;
        let release_id = AgentReleaseId::parse(id).map_err(|_| RepositoryError::unavailable())?;
        self.store
            .load_release(&tenant, &release_id)
            .await
            .map(|release| release.as_ref().map(release_resource))
            .map_err(|_| RepositoryError::unavailable())
    }

    async fn campaign(
        &self,
        tenant: &AuthenticatedTenant,
        id: &str,
    ) -> Result<Option<CampaignResource>, RepositoryError> {
        let tenant = parse_tenant(tenant)?;
        let campaign_id = CampaignId::parse(id).map_err(|_| RepositoryError::unavailable())?;
        self.store
            .load_campaign(&tenant, &campaign_id)
            .await
            .map(|campaign| campaign.as_ref().map(campaign_resource))
            .map_err(|_| RepositoryError::unavailable())
    }

    async fn attempt(
        &self,
        tenant: &AuthenticatedTenant,
        id: &str,
    ) -> Result<Option<AttemptResource>, RepositoryError> {
        let tenant = parse_tenant(tenant)?;
        let attempt_id = CallAttemptId::parse(id).map_err(|_| RepositoryError::unavailable())?;
        self.store
            .load_attempt(&tenant, &attempt_id)
            .await
            .map(|attempt| attempt.as_ref().map(attempt_resource))
            .map_err(|_| RepositoryError::unavailable())
    }

    async fn request_reconcile(
        &self,
        tenant: &AuthenticatedTenant,
        attempt_id: &str,
        idempotency_key: &IdempotencyKey,
    ) -> Result<Option<ReconcileReceipt>, RepositoryError> {
        let tenant = parse_tenant(tenant)?;
        let attempt_id =
            CallAttemptId::parse(attempt_id).map_err(|_| RepositoryError::unavailable())?;
        self.store
            .request_reconcile(&tenant, &attempt_id, idempotency_key)
            .await
            .map(|decision| {
                decision.map(|_| ReconcileReceipt {
                    attempt_id: attempt_id.as_str().to_owned(),
                    accepted: true,
                })
            })
            .map_err(|error| {
                if error.code() == "voice_agent_reconcile_conflict" {
                    RepositoryError::conflict()
                } else {
                    RepositoryError::unavailable()
                }
            })
    }
}

impl std::fmt::Debug for PostgresVoiceAgentRepository {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PostgresVoiceAgentRepository")
            .finish_non_exhaustive()
    }
}

fn parse_tenant(tenant: &AuthenticatedTenant) -> Result<TenantId, RepositoryError> {
    TenantId::parse(tenant.as_str()).map_err(|_| RepositoryError::unavailable())
}

fn release_resource(release: &StoredVoiceAgentRelease) -> AgentReleaseResource {
    AgentReleaseResource::from_durable(
        release.id().as_str().to_owned(),
        release.definition_id().as_str().to_owned(),
        release.state(),
        release.content_hash().to_owned(),
        release.components().clone(),
    )
}

fn campaign_resource(campaign: &StoredVoiceAgentCampaign) -> CampaignResource {
    CampaignResource::from_durable(
        campaign.id().as_str().to_owned(),
        campaign.release_id().as_str().to_owned(),
        campaign.state(),
        campaign.active_attempts(),
    )
}

fn attempt_resource(attempt: &StoredVoiceAgentAttempt) -> AttemptResource {
    AttemptResource::from_durable(
        attempt.id().as_str().to_owned(),
        attempt.campaign_id().as_str().to_owned(),
        attempt.release_id().as_str().to_owned(),
        attempt.state(),
        attempt.disclosure_completed(),
        attempt.finalization(),
    )
}
