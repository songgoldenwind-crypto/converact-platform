use std::{error::Error, fmt, sync::Arc};

use converact_ai_outbound_core::{AgentReleaseBinding, ReleaseComponentDigests};
use converact_kernel_ids::TenantId;
use converact_voice_agent_contracts::AgentReleaseId;
use serde::Deserialize;

use crate::{PostgresRuntime, TransactionError};

const MAX_COMPILER_REVISION_BYTES: usize = 128;
const MAX_PLAYBOOK_BYTES: usize = 65_536;

const LOAD_ARTIFACT_SQL: &str = "
SELECT release.id AS release_id,
       release.content_hash,
       release.components,
       artifact.compiler_revision,
       artifact.artifact_hash,
       artifact.playbook_content
FROM public.converact_agent_release_runtime_artifacts AS artifact
JOIN public.converact_agent_releases AS release
  ON release.tenant_id = artifact.tenant_id
 AND release.id = artifact.agent_release_id
WHERE artifact.tenant_id = $1
  AND artifact.agent_release_id = $2
  AND artifact.compiler_revision = $3
LIMIT 1";

/// Validated immutable runtime-artifact lookup policy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PostgresActiveCallArtifactStoreConfig {
    compiler_revision: Box<str>,
}

impl PostgresActiveCallArtifactStoreConfig {
    /// Pins lookup to one reviewed compiler revision.
    ///
    /// # Errors
    ///
    /// Rejects empty, oversized or non-canonical revision identifiers.
    pub fn new(
        compiler_revision: impl AsRef<str>,
    ) -> Result<Self, PostgresActiveCallArtifactStoreError> {
        let compiler_revision = compiler_revision.as_ref();
        if !valid_compiler_revision(compiler_revision) {
            return Err(PostgresActiveCallArtifactStoreError::InvalidConfiguration);
        }
        Ok(Self {
            compiler_revision: compiler_revision.into(),
        })
    }

    #[must_use]
    pub fn compiler_revision(&self) -> &str {
        &self.compiler_revision
    }
}

/// One bounded immutable artifact record loaded together with its authoritative Release.
#[derive(Clone, Eq, PartialEq)]
pub struct PostgresActiveCallArtifactRecord {
    release: AgentReleaseBinding,
    compiler_revision: Box<str>,
    playbook_content: Box<str>,
    artifact_hash: Box<str>,
}

impl PostgresActiveCallArtifactRecord {
    /// Validates one untrusted database row before it crosses the Store boundary.
    ///
    /// # Errors
    ///
    /// Rejects malformed provenance, digest or unbounded content.
    pub fn try_new(
        release: AgentReleaseBinding,
        compiler_revision: impl AsRef<str>,
        playbook_content: impl AsRef<str>,
        artifact_hash: impl AsRef<str>,
    ) -> Result<Self, PostgresActiveCallArtifactStoreError> {
        let compiler_revision = compiler_revision.as_ref();
        let playbook_content = playbook_content.as_ref();
        let artifact_hash = artifact_hash.as_ref();
        if !valid_compiler_revision(compiler_revision)
            || playbook_content.is_empty()
            || playbook_content.len() > MAX_PLAYBOOK_BYTES
            || !is_lowercase_sha256(artifact_hash)
        {
            return Err(PostgresActiveCallArtifactStoreError::StoredRowInvalid);
        }
        Ok(Self {
            release,
            compiler_revision: compiler_revision.into(),
            playbook_content: playbook_content.into(),
            artifact_hash: artifact_hash.into(),
        })
    }

    #[must_use]
    pub const fn release(&self) -> &AgentReleaseBinding {
        &self.release
    }

    #[must_use]
    pub fn compiler_revision(&self) -> &str {
        &self.compiler_revision
    }

    #[must_use]
    pub fn playbook_content(&self) -> &str {
        &self.playbook_content
    }

    #[must_use]
    pub fn artifact_hash(&self) -> &str {
        &self.artifact_hash
    }

    #[must_use]
    pub fn into_parts(self) -> (AgentReleaseBinding, Box<str>, Box<str>, Box<str>) {
        (
            self.release,
            self.compiler_revision,
            self.playbook_content,
            self.artifact_hash,
        )
    }
}

impl fmt::Debug for PostgresActiveCallArtifactRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PostgresActiveCallArtifactRecord")
            .field("release_id", &self.release.id())
            .field("compiler_revision", &self.compiler_revision)
            .field("artifact_hash", &self.artifact_hash)
            .field("playbook_bytes", &self.playbook_content.len())
            .finish_non_exhaustive()
    }
}

/// Sanitized immutable-artifact Store failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PostgresActiveCallArtifactStoreError {
    InvalidConfiguration,
    StoredRowInvalid,
    Unavailable,
}

impl PostgresActiveCallArtifactStoreError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidConfiguration => "active_call_artifact_store_configuration_invalid",
            Self::StoredRowInvalid => "active_call_artifact_store_row_invalid",
            Self::Unavailable => "active_call_artifact_store_unavailable",
        }
    }
}

impl fmt::Display for PostgresActiveCallArtifactStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for PostgresActiveCallArtifactStoreError {}

/// Tenant-scoped read-only Store for compiled Active Call Release artifacts.
pub struct PostgresActiveCallArtifactStore {
    runtime: Arc<PostgresRuntime>,
    config: PostgresActiveCallArtifactStoreConfig,
}

impl PostgresActiveCallArtifactStore {
    #[must_use]
    pub const fn new(
        runtime: Arc<PostgresRuntime>,
        config: PostgresActiveCallArtifactStoreConfig,
    ) -> Self {
        Self { runtime, config }
    }

    #[must_use]
    pub const fn config(&self) -> &PostgresActiveCallArtifactStoreConfig {
        &self.config
    }

    /// Loads one exact tenant/Release/compiler artifact and rejects Release drift.
    ///
    /// # Errors
    ///
    /// Rejects malformed input/stored rows, provenance drift and transaction failure.
    pub async fn load_artifact(
        &self,
        tenant: &TenantId,
        expected_release: &AgentReleaseBinding,
    ) -> Result<Option<PostgresActiveCallArtifactRecord>, PostgresActiveCallArtifactStoreError>
    {
        let release_id = expected_release.id().as_str().to_owned();
        let compiler_revision = self.config.compiler_revision.to_string();
        let expected_release = expected_release.clone();
        let transaction_tenant = tenant.clone();
        let tenant_id = tenant.as_str().to_owned();
        self.runtime
            .with_tenant_transaction(&transaction_tenant, move |transaction| {
                Box::pin(async move {
                    let row = transaction
                        .query_opt(
                            LOAD_ARTIFACT_SQL,
                            &[&tenant_id, &release_id, &compiler_revision],
                        )
                        .await
                        .map_err(|_| PostgresActiveCallArtifactStoreError::Unavailable)?;
                    let Some(row) = row else {
                        return Ok(None);
                    };
                    let stored_release_id: String = row
                        .try_get("release_id")
                        .map_err(|_| PostgresActiveCallArtifactStoreError::StoredRowInvalid)?;
                    let content_hash: String = row
                        .try_get("content_hash")
                        .map_err(|_| PostgresActiveCallArtifactStoreError::StoredRowInvalid)?;
                    let components: serde_json::Value = row
                        .try_get("components")
                        .map_err(|_| PostgresActiveCallArtifactStoreError::StoredRowInvalid)?;
                    let components: StoredReleaseComponentDigests =
                        serde_json::from_value(components)
                            .map_err(|_| PostgresActiveCallArtifactStoreError::StoredRowInvalid)?;
                    let stored_release = AgentReleaseBinding::try_new(
                        AgentReleaseId::parse(stored_release_id)
                            .map_err(|_| PostgresActiveCallArtifactStoreError::StoredRowInvalid)?,
                        content_hash,
                        components.into(),
                    )
                    .map_err(|_| PostgresActiveCallArtifactStoreError::StoredRowInvalid)?;
                    if stored_release != expected_release {
                        return Err(PostgresActiveCallArtifactStoreError::StoredRowInvalid);
                    }
                    PostgresActiveCallArtifactRecord::try_new(
                        stored_release,
                        row.try_get::<_, String>("compiler_revision")
                            .map_err(|_| PostgresActiveCallArtifactStoreError::StoredRowInvalid)?,
                        row.try_get::<_, String>("playbook_content")
                            .map_err(|_| PostgresActiveCallArtifactStoreError::StoredRowInvalid)?,
                        row.try_get::<_, String>("artifact_hash")
                            .map_err(|_| PostgresActiveCallArtifactStoreError::StoredRowInvalid)?,
                    )
                    .map(Some)
                })
            })
            .await
            .map_err(map_transaction_error)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredReleaseComponentDigests {
    #[serde(rename = "prompt_revision_hash")]
    prompt_revision: String,
    #[serde(rename = "conversation_flow_revision_hash")]
    conversation_flow_revision: String,
    #[serde(rename = "knowledge_revision_hash")]
    knowledge_revision: String,
    #[serde(rename = "tool_schema_hash")]
    tool_schema: String,
    #[serde(rename = "speech_profile_hash")]
    speech_profile: String,
    #[serde(rename = "compliance_policy_hash")]
    compliance_policy: String,
    #[serde(rename = "outcome_schema_hash")]
    outcome_schema: String,
    #[serde(rename = "evaluation_rubric_hash")]
    evaluation_rubric: String,
}

impl From<StoredReleaseComponentDigests> for ReleaseComponentDigests {
    fn from(stored: StoredReleaseComponentDigests) -> Self {
        Self {
            prompt_revision_hash: stored.prompt_revision,
            conversation_flow_revision_hash: stored.conversation_flow_revision,
            knowledge_revision_hash: stored.knowledge_revision,
            tool_schema_hash: stored.tool_schema,
            speech_profile_hash: stored.speech_profile,
            compliance_policy_hash: stored.compliance_policy,
            outcome_schema_hash: stored.outcome_schema,
            evaluation_rubric_hash: stored.evaluation_rubric,
        }
    }
}

fn valid_compiler_revision(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_COMPILER_REVISION_BYTES
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[allow(clippy::needless_pass_by_value)]
fn map_transaction_error(
    error: TransactionError<PostgresActiveCallArtifactStoreError>,
) -> PostgresActiveCallArtifactStoreError {
    match error {
        TransactionError::Work(error) => error,
        TransactionError::AdmissionRejected
        | TransactionError::PoolUnavailable
        | TransactionError::DatabaseUnavailable
        | TransactionError::DeadlineExceeded
        | TransactionError::RollbackUnknown
        | TransactionError::CommitUnknown => PostgresActiveCallArtifactStoreError::Unavailable,
    }
}
