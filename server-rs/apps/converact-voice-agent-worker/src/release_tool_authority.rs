use std::{future::Future, sync::Arc};

use converact_kernel_ids::TenantId;
use converact_postgres_store::{PostgresReleaseToolManifest, PostgresReleaseToolStore};
use converact_tool_broker_core::{
    PolicyDecision, PolicyPort, ToolCatalogPort, ToolDefinition, ToolPortError, ToolProposal,
};
use converact_voice_agent_contracts::{AgentReleaseId, EnvelopeContext};

use crate::{ToolBinding, ToolBindingPort};

/// Read-only boundary for one immutable Agent Release Tool manifest.
pub trait ReleaseToolManifestPort {
    fn load_manifest(
        &self,
        tenant: &TenantId,
        release_id: &AgentReleaseId,
    ) -> impl Future<Output = Result<Option<PostgresReleaseToolManifest>, ToolPortError>> + Send;
}

impl ReleaseToolManifestPort for PostgresReleaseToolStore {
    async fn load_manifest(
        &self,
        tenant: &TenantId,
        release_id: &AgentReleaseId,
    ) -> Result<Option<PostgresReleaseToolManifest>, ToolPortError> {
        PostgresReleaseToolStore::load_manifest(self, tenant, release_id)
            .await
            .map_err(|_| ToolPortError::new("release_tool_manifest_unavailable"))
    }
}

/// One fail-closed authority over friendly names, immutable definitions and Policy.
pub struct ReleaseToolAuthority<S> {
    source: Arc<S>,
}

impl<S> Clone for ReleaseToolAuthority<S> {
    fn clone(&self) -> Self {
        Self {
            source: Arc::clone(&self.source),
        }
    }
}

impl<S> ReleaseToolAuthority<S> {
    #[must_use]
    pub const fn new(source: Arc<S>) -> Self {
        Self { source }
    }
}

impl<S> ToolBindingPort for ReleaseToolAuthority<S>
where
    S: ReleaseToolManifestPort + Send + Sync,
{
    async fn resolve(
        &self,
        authority: &EnvelopeContext,
        tool_name: &str,
    ) -> Result<Option<ToolBinding>, ToolPortError> {
        let Some(manifest) = self.load(authority).await? else {
            return Ok(None);
        };
        manifest
            .tool_by_name(tool_name)
            .map(|registration| {
                ToolBinding::try_new(
                    registration.definition().revision_id().clone(),
                    registration.definition().schema_hash(),
                    registration.deadline_after_ms(),
                )
                .map_err(|_| ToolPortError::new("release_tool_binding_invalid"))
            })
            .transpose()
    }
}

impl<S> ToolCatalogPort for ReleaseToolAuthority<S>
where
    S: ReleaseToolManifestPort + Send + Sync,
{
    async fn resolve(
        &self,
        proposal: &ToolProposal,
    ) -> Result<Option<ToolDefinition>, ToolPortError> {
        let Some(manifest) = self.load(proposal.context()).await? else {
            return Ok(None);
        };
        Ok(manifest
            .tool_by_revision(proposal.tool_revision_id().as_str())
            .map(|registration| registration.definition().clone()))
    }
}

impl<S> PolicyPort for ReleaseToolAuthority<S>
where
    S: ReleaseToolManifestPort + Send + Sync,
{
    async fn evaluate(
        &self,
        definition: &ToolDefinition,
        proposal: &ToolProposal,
    ) -> Result<PolicyDecision, ToolPortError> {
        let manifest = self
            .load(proposal.context())
            .await?
            .ok_or_else(|| ToolPortError::new("release_tool_policy_unavailable"))?;
        let registration = manifest
            .tool_by_revision(proposal.tool_revision_id().as_str())
            .filter(|registration| registration.definition() == definition)
            .ok_or_else(|| ToolPortError::new("release_tool_policy_unavailable"))?;
        Ok(registration.policy_decision())
    }
}

impl<S> ReleaseToolAuthority<S>
where
    S: ReleaseToolManifestPort,
{
    async fn load(
        &self,
        authority: &EnvelopeContext,
    ) -> Result<Option<PostgresReleaseToolManifest>, ToolPortError> {
        let tenant = TenantId::parse(authority.tenant_id())
            .map_err(|_| ToolPortError::new("release_tool_authority_invalid"))?;
        let manifest = self
            .source
            .load_manifest(&tenant, authority.agent_release_id())
            .await?;
        Ok(manifest.filter(|manifest| manifest.release_id() == authority.agent_release_id()))
    }
}
