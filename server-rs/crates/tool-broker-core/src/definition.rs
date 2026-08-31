use std::{error::Error, fmt};

use converact_voice_agent_contracts::{AgentReleaseId, ToolRevisionId};

const MAX_CAPABILITY_BYTES: usize = 128;
const SHA256_HEX_BYTES: usize = 64;

/// Whether a registered Tool is observational or can change external state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolEffectClass {
    Query,
    Mutation,
}

/// Closed risk classification owned by Converact policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolRisk {
    Low,
    High,
}

/// Immutable deployment-time resolution of one Tool revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolDefinition {
    revision_id: ToolRevisionId,
    agent_release_id: AgentReleaseId,
    schema_hash: Box<str>,
    effect_class: ToolEffectClass,
    risk: ToolRisk,
    action_capability: Box<str>,
}

impl ToolDefinition {
    /// Creates a definition that can resolve only to a registered Rust Adapter capability.
    ///
    /// # Errors
    ///
    /// Rejects malformed digests and capability names, including URL-shaped values.
    pub fn try_new(
        revision_id: ToolRevisionId,
        agent_release_id: AgentReleaseId,
        schema_hash: impl AsRef<str>,
        effect_class: ToolEffectClass,
        risk: ToolRisk,
        action_capability: impl AsRef<str>,
    ) -> Result<Self, ToolDefinitionError> {
        let schema_hash = schema_hash.as_ref();
        if !lowercase_sha256(schema_hash) {
            return Err(ToolDefinitionError::InvalidSchemaDigest);
        }
        let action_capability = action_capability.as_ref();
        if !registered_capability(action_capability) {
            return Err(ToolDefinitionError::InvalidActionCapability);
        }
        Ok(Self {
            revision_id,
            agent_release_id,
            schema_hash: schema_hash.into(),
            effect_class,
            risk,
            action_capability: action_capability.into(),
        })
    }

    #[must_use]
    pub const fn revision_id(&self) -> &ToolRevisionId {
        &self.revision_id
    }

    #[must_use]
    pub const fn agent_release_id(&self) -> &AgentReleaseId {
        &self.agent_release_id
    }

    #[must_use]
    pub fn schema_hash(&self) -> &str {
        &self.schema_hash
    }

    #[must_use]
    pub const fn effect_class(&self) -> ToolEffectClass {
        self.effect_class
    }

    #[must_use]
    pub const fn risk(&self) -> ToolRisk {
        self.risk
    }

    #[must_use]
    pub fn action_capability(&self) -> &str {
        &self.action_capability
    }
}

/// Stable validation failure for immutable Tool definitions.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolDefinitionError {
    InvalidSchemaDigest,
    InvalidActionCapability,
}

impl ToolDefinitionError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidSchemaDigest => "tool_definition_schema_digest_invalid",
            Self::InvalidActionCapability => "tool_definition_action_capability_invalid",
        }
    }
}

impl fmt::Display for ToolDefinitionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ToolDefinitionError {}

pub(crate) fn lowercase_sha256(value: &str) -> bool {
    value.len() == SHA256_HEX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn registered_capability(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_CAPABILITY_BYTES
        && first.is_ascii_lowercase()
        && remainder.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}
