use std::{collections::HashSet, error::Error, fmt, sync::Arc};

use converact_contracts::canonical_sha256_with_max_bytes;
use converact_kernel_ids::TenantId;
use converact_tool_broker_core::{PolicyDecision, ToolDefinition, ToolEffectClass, ToolRisk};
use converact_voice_agent_contracts::{AgentReleaseId, ToolRevisionId};
use serde::Deserialize;
use serde_json::Value;

use crate::{PostgresRuntime, TransactionError};

const MAX_MANIFEST_BYTES: usize = 65_536;
const MAX_TOOLS: usize = 64;
const MAX_TOOL_NAME_BYTES: usize = 128;
const MAX_TOOL_DEADLINE_MS: u64 = 120_000;

const LOAD_MANIFEST_SQL: &str = "
SELECT artifact.agent_release_id,
       artifact.tool_set_hash,
       artifact.tool_manifest,
       release.components->>'tool_schema_hash' AS release_tool_set_hash
FROM public.converact_agent_release_tool_manifests AS artifact
JOIN public.converact_agent_releases AS release
  ON release.tenant_id = artifact.tenant_id
 AND release.id = artifact.agent_release_id
WHERE artifact.tenant_id = $1
  AND artifact.agent_release_id = $2
LIMIT 1";

/// One validated immutable Tool registration inside an Agent Release manifest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PostgresReleaseToolRegistration {
    name: Box<str>,
    definition: ToolDefinition,
    arguments_schema: Value,
    policy_decision: PolicyDecision,
    deadline_after_ms: u64,
}

impl PostgresReleaseToolRegistration {
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub const fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    #[must_use]
    pub const fn arguments_schema(&self) -> &Value {
        &self.arguments_schema
    }

    #[must_use]
    pub const fn policy_decision(&self) -> PolicyDecision {
        self.policy_decision
    }

    #[must_use]
    pub const fn deadline_after_ms(&self) -> u64 {
        self.deadline_after_ms
    }
}

/// Content-addressed, bounded Tool manifest for one exact Agent Release.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PostgresReleaseToolManifest {
    release_id: AgentReleaseId,
    tool_set_hash: Box<str>,
    tools: Box<[PostgresReleaseToolRegistration]>,
}

impl PostgresReleaseToolManifest {
    /// Parses an untrusted database artifact and verifies its canonical digest and every entry.
    ///
    /// # Errors
    ///
    /// Rejects digest drift, duplicate names/revisions, unknown fields and unbounded manifests.
    pub fn try_new(
        release_id: AgentReleaseId,
        tool_set_hash: impl AsRef<str>,
        manifest: Value,
    ) -> Result<Self, PostgresReleaseToolManifestError> {
        let tool_set_hash = tool_set_hash.as_ref();
        let observed_hash = canonical_sha256_with_max_bytes(&manifest, MAX_MANIFEST_BYTES)
            .map_err(|_| PostgresReleaseToolManifestError::StoredRowInvalid)?;
        if observed_hash != tool_set_hash {
            return Err(PostgresReleaseToolManifestError::StoredRowInvalid);
        }
        let stored: Vec<StoredToolRegistration> = serde_json::from_value(manifest)
            .map_err(|_| PostgresReleaseToolManifestError::StoredRowInvalid)?;
        if stored.is_empty() || stored.len() > MAX_TOOLS {
            return Err(PostgresReleaseToolManifestError::StoredRowInvalid);
        }
        let mut names = HashSet::with_capacity(stored.len());
        let mut revisions = HashSet::with_capacity(stored.len());
        let mut tools = Vec::with_capacity(stored.len());
        for stored in stored {
            if !valid_tool_name(&stored.name)
                || !names.insert(stored.name.clone())
                || !revisions.insert(stored.revision_id.clone())
                || !(1..=MAX_TOOL_DEADLINE_MS).contains(&stored.deadline_after_ms)
            {
                return Err(PostgresReleaseToolManifestError::StoredRowInvalid);
            }
            let schema_hash =
                canonical_sha256_with_max_bytes(&stored.arguments_schema, MAX_MANIFEST_BYTES)
                    .map_err(|_| PostgresReleaseToolManifestError::StoredRowInvalid)?;
            if schema_hash != stored.schema_hash {
                return Err(PostgresReleaseToolManifestError::StoredRowInvalid);
            }
            let effect_class = parse_effect_class(&stored.effect_class)?;
            let risk = parse_risk(&stored.risk)?;
            let policy_decision = parse_policy(&stored.policy_decision)?;
            let definition = ToolDefinition::try_new(
                ToolRevisionId::parse(&stored.revision_id)
                    .map_err(|_| PostgresReleaseToolManifestError::StoredRowInvalid)?,
                release_id.clone(),
                &stored.schema_hash,
                effect_class,
                risk,
                &stored.action_capability,
            )
            .map_err(|_| PostgresReleaseToolManifestError::StoredRowInvalid)?;
            tools.push(PostgresReleaseToolRegistration {
                name: stored.name.into(),
                definition,
                arguments_schema: stored.arguments_schema,
                policy_decision,
                deadline_after_ms: stored.deadline_after_ms,
            });
        }
        Ok(Self {
            release_id,
            tool_set_hash: tool_set_hash.into(),
            tools: tools.into_boxed_slice(),
        })
    }

    #[must_use]
    pub const fn release_id(&self) -> &AgentReleaseId {
        &self.release_id
    }

    #[must_use]
    pub fn tool_set_hash(&self) -> &str {
        &self.tool_set_hash
    }

    #[must_use]
    pub fn tool_by_name(&self, name: &str) -> Option<&PostgresReleaseToolRegistration> {
        self.tools.iter().find(|tool| tool.name() == name)
    }

    #[must_use]
    pub fn tool_by_revision(&self, revision: &str) -> Option<&PostgresReleaseToolRegistration> {
        self.tools
            .iter()
            .find(|tool| tool.definition().revision_id().as_str() == revision)
    }
}

/// Sanitized immutable Tool manifest Store failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PostgresReleaseToolManifestError {
    StoredRowInvalid,
    Unavailable,
}

impl PostgresReleaseToolManifestError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::StoredRowInvalid => "release_tool_manifest_row_invalid",
            Self::Unavailable => "release_tool_manifest_store_unavailable",
        }
    }
}

impl fmt::Display for PostgresReleaseToolManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for PostgresReleaseToolManifestError {}

/// Tenant-scoped read-only Store for immutable Agent Release Tool manifests.
pub struct PostgresReleaseToolStore {
    runtime: Arc<PostgresRuntime>,
}

impl PostgresReleaseToolStore {
    #[must_use]
    pub const fn new(runtime: Arc<PostgresRuntime>) -> Self {
        Self { runtime }
    }

    /// Loads and validates the complete manifest for one exact tenant/Release tuple.
    ///
    /// # Errors
    ///
    /// Returns bounded row or transaction failures without exposing SQL or topology.
    pub async fn load_manifest(
        &self,
        tenant: &TenantId,
        release_id: &AgentReleaseId,
    ) -> Result<Option<PostgresReleaseToolManifest>, PostgresReleaseToolManifestError> {
        let tenant_id = tenant.as_str().to_owned();
        let release_id = release_id.clone();
        let release_lookup = release_id.as_str().to_owned();
        let transaction_tenant = tenant.clone();
        self.runtime
            .with_tenant_transaction(&transaction_tenant, move |transaction| {
                Box::pin(async move {
                    let row = transaction
                        .query_opt(LOAD_MANIFEST_SQL, &[&tenant_id, &release_lookup])
                        .await
                        .map_err(|_| PostgresReleaseToolManifestError::Unavailable)?;
                    let Some(row) = row else {
                        return Ok(None);
                    };
                    let stored_release_id: String = row
                        .try_get("agent_release_id")
                        .map_err(|_| PostgresReleaseToolManifestError::StoredRowInvalid)?;
                    if stored_release_id != release_id.as_str() {
                        return Err(PostgresReleaseToolManifestError::StoredRowInvalid);
                    }
                    let tool_set_hash: String = row
                        .try_get("tool_set_hash")
                        .map_err(|_| PostgresReleaseToolManifestError::StoredRowInvalid)?;
                    let release_tool_set_hash: String = row
                        .try_get("release_tool_set_hash")
                        .map_err(|_| PostgresReleaseToolManifestError::StoredRowInvalid)?;
                    if tool_set_hash != release_tool_set_hash {
                        return Err(PostgresReleaseToolManifestError::StoredRowInvalid);
                    }
                    let manifest: Value = row
                        .try_get("tool_manifest")
                        .map_err(|_| PostgresReleaseToolManifestError::StoredRowInvalid)?;
                    PostgresReleaseToolManifest::try_new(release_id, tool_set_hash, manifest)
                        .map(Some)
                })
            })
            .await
            .map_err(map_transaction_error)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredToolRegistration {
    name: String,
    revision_id: String,
    schema_hash: String,
    arguments_schema: Value,
    effect_class: String,
    risk: String,
    action_capability: String,
    policy_decision: String,
    deadline_after_ms: u64,
}

fn parse_effect_class(value: &str) -> Result<ToolEffectClass, PostgresReleaseToolManifestError> {
    match value {
        "query" => Ok(ToolEffectClass::Query),
        "mutation" => Ok(ToolEffectClass::Mutation),
        _ => Err(PostgresReleaseToolManifestError::StoredRowInvalid),
    }
}

fn parse_risk(value: &str) -> Result<ToolRisk, PostgresReleaseToolManifestError> {
    match value {
        "low" => Ok(ToolRisk::Low),
        "high" => Ok(ToolRisk::High),
        _ => Err(PostgresReleaseToolManifestError::StoredRowInvalid),
    }
}

fn parse_policy(value: &str) -> Result<PolicyDecision, PostgresReleaseToolManifestError> {
    match value {
        "allowed" => Ok(PolicyDecision::Allowed),
        "approval_required" => Ok(PolicyDecision::ApprovalRequired),
        _ => Err(PostgresReleaseToolManifestError::StoredRowInvalid),
    }
}

fn valid_tool_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_TOOL_NAME_BYTES
        && first.is_ascii_lowercase()
        && remainder.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

#[allow(clippy::needless_pass_by_value)]
fn map_transaction_error(
    error: TransactionError<PostgresReleaseToolManifestError>,
) -> PostgresReleaseToolManifestError {
    match error {
        TransactionError::Work(error) => error,
        TransactionError::AdmissionRejected
        | TransactionError::PoolUnavailable
        | TransactionError::DatabaseUnavailable
        | TransactionError::DeadlineExceeded
        | TransactionError::RollbackUnknown
        | TransactionError::CommitUnknown => PostgresReleaseToolManifestError::Unavailable,
    }
}
