use converact_kernel_ids::TenantId;
use converact_postgres_store::{
    PostgresActiveCallArtifactStore, PostgresActiveCallArtifactStoreError,
};

use crate::{
    ActiveCallArtifactSource, ActiveCallArtifactSourcePort, ActiveCallPlaybookResolverError,
    AuthenticatedTenant,
};

impl ActiveCallArtifactSourcePort for PostgresActiveCallArtifactStore {
    async fn load(
        &self,
        tenant: &AuthenticatedTenant,
        release: &converact_ai_outbound_core::AgentReleaseBinding,
    ) -> Result<Option<ActiveCallArtifactSource>, ActiveCallPlaybookResolverError> {
        let tenant = TenantId::parse(tenant.as_str())
            .map_err(|_| ActiveCallPlaybookResolverError::InvalidConfiguration)?;
        let record = self
            .load_artifact(&tenant, release)
            .await
            .map_err(map_store_error)?;
        Ok(record.map(|record| {
            let (release, compiler_revision, playbook_content, artifact_hash) = record.into_parts();
            ActiveCallArtifactSource::new(
                release,
                compiler_revision,
                playbook_content,
                artifact_hash,
            )
        }))
    }
}

const fn map_store_error(
    error: PostgresActiveCallArtifactStoreError,
) -> ActiveCallPlaybookResolverError {
    match error {
        PostgresActiveCallArtifactStoreError::InvalidConfiguration => {
            ActiveCallPlaybookResolverError::InvalidConfiguration
        }
        PostgresActiveCallArtifactStoreError::StoredRowInvalid => {
            ActiveCallPlaybookResolverError::SourceDrift
        }
        PostgresActiveCallArtifactStoreError::Unavailable => {
            ActiveCallPlaybookResolverError::Unavailable
        }
    }
}
