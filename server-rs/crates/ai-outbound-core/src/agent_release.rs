use std::{error::Error, fmt};

use converact_contracts::canonical_sha256;
use converact_voice_agent_contracts::{AgentDefinitionId, AgentReleaseId, AgentReleaseState};
use serde::Serialize;

const MAX_AGENT_NAME_BYTES: usize = 200;
const MAX_LANGUAGE_BYTES: usize = 35;
const SHA256_HEX_BYTES: usize = 64;
const RELEASE_SCHEMA_VERSION: u16 = 1;

/// An invalid immutable Agent Release proposal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentReleaseError {
    /// The user-visible name is empty, padded or too large.
    InvalidName,
    /// The language is not a bounded BCP-47-style identifier.
    InvalidLanguage,
    /// A component is not bound to an exact lowercase SHA-256 digest.
    InvalidComponentDigest,
    /// The bounded canonical release document could not be hashed.
    CanonicalEncodingFailed,
}

impl fmt::Display for AgentReleaseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidName => "agent_release_name_invalid",
            Self::InvalidLanguage => "agent_release_language_invalid",
            Self::InvalidComponentDigest => "agent_release_component_digest_invalid",
            Self::CanonicalEncodingFailed => "agent_release_canonical_encoding_failed",
        })
    }
}

impl Error for AgentReleaseError {}

/// Validated mutable authoring input. Publishing consumes this value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentDraft {
    definition_id: AgentDefinitionId,
    release_id: AgentReleaseId,
    name: Box<str>,
    language: Box<str>,
}

impl AgentDraft {
    /// Creates a bounded Agent draft ready for immutable publication.
    ///
    /// # Errors
    ///
    /// Rejects empty, padded or oversized names and malformed languages.
    pub fn try_new(
        definition_id: AgentDefinitionId,
        release_id: AgentReleaseId,
        name: impl AsRef<str>,
        language: impl AsRef<str>,
    ) -> Result<Self, AgentReleaseError> {
        let name = name.as_ref();
        if name.is_empty()
            || name.len() > MAX_AGENT_NAME_BYTES
            || name.trim().len() != name.len()
            || name.chars().any(char::is_control)
        {
            return Err(AgentReleaseError::InvalidName);
        }
        let language = language.as_ref();
        if !is_valid_language(language) {
            return Err(AgentReleaseError::InvalidLanguage);
        }
        Ok(Self {
            definition_id,
            release_id,
            name: name.into(),
            language: language.into(),
        })
    }
}

/// Exact component snapshots included in one immutable Agent Release.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ReleaseComponentDigests {
    pub prompt_revision_hash: String,
    pub conversation_flow_revision_hash: String,
    pub knowledge_revision_hash: String,
    pub tool_schema_hash: String,
    pub speech_profile_hash: String,
    pub compliance_policy_hash: String,
    pub outcome_schema_hash: String,
    pub evaluation_rubric_hash: String,
}

impl ReleaseComponentDigests {
    pub(crate) fn is_valid(&self) -> bool {
        [
            &self.prompt_revision_hash,
            &self.conversation_flow_revision_hash,
            &self.knowledge_revision_hash,
            &self.tool_schema_hash,
            &self.speech_profile_hash,
            &self.compliance_policy_hash,
            &self.outcome_schema_hash,
            &self.evaluation_rubric_hash,
        ]
        .into_iter()
        .all(|digest| is_lowercase_sha256(digest))
    }
}

/// Published, content-addressed Agent configuration. It exposes no mutation API.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct AgentRelease {
    id: AgentReleaseId,
    definition_id: AgentDefinitionId,
    state: AgentReleaseState,
    name: Box<str>,
    language: Box<str>,
    content_hash: Box<str>,
    components: ReleaseComponentDigests,
}

impl AgentRelease {
    /// Returns the immutable release identifier.
    #[must_use]
    pub const fn id(&self) -> &AgentReleaseId {
        &self.id
    }

    /// Returns the stable Agent definition identifier.
    #[must_use]
    pub const fn definition_id(&self) -> &AgentDefinitionId {
        &self.definition_id
    }

    /// Returns the publication state, which is always `published` here.
    #[must_use]
    pub const fn state(&self) -> AgentReleaseState {
        self.state
    }

    /// Returns the canonical digest of every frozen release input.
    #[must_use]
    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }

    /// Returns all exact component digests.
    #[must_use]
    pub const fn components(&self) -> &ReleaseComponentDigests {
        &self.components
    }

    /// Returns the bounded display name persisted with this immutable Release.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the bounded language tag persisted with this immutable Release.
    #[must_use]
    pub fn language(&self) -> &str {
        &self.language
    }
}

#[derive(Serialize)]
struct ReleaseHashInput<'a> {
    schema_version: u16,
    release_id: &'a AgentReleaseId,
    definition_id: &'a AgentDefinitionId,
    state: AgentReleaseState,
    name: &'a str,
    language: &'a str,
    components: &'a ReleaseComponentDigests,
}

/// Consumes a valid draft and returns its immutable, content-addressed release.
///
/// # Errors
///
/// Rejects any component that is not pinned by a canonical lowercase SHA-256 digest.
pub fn publish_agent(
    draft: AgentDraft,
    components: ReleaseComponentDigests,
) -> Result<AgentRelease, AgentReleaseError> {
    if !components.is_valid() {
        return Err(AgentReleaseError::InvalidComponentDigest);
    }
    let hash_input = ReleaseHashInput {
        schema_version: RELEASE_SCHEMA_VERSION,
        release_id: &draft.release_id,
        definition_id: &draft.definition_id,
        state: AgentReleaseState::Published,
        name: &draft.name,
        language: &draft.language,
        components: &components,
    };
    let value =
        serde_json::to_value(hash_input).map_err(|_| AgentReleaseError::CanonicalEncodingFailed)?;
    let content_hash = canonical_sha256(&value)
        .map_err(|_| AgentReleaseError::CanonicalEncodingFailed)?
        .into();
    Ok(AgentRelease {
        id: draft.release_id,
        definition_id: draft.definition_id,
        state: AgentReleaseState::Published,
        name: draft.name,
        language: draft.language,
        content_hash,
        components,
    })
}

pub(crate) fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == SHA256_HEX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_valid_language(value: &str) -> bool {
    if value.len() < 2 || value.len() > MAX_LANGUAGE_BYTES || !value.is_ascii() {
        return false;
    }
    value.split('-').all(|part| {
        !part.is_empty() && part.len() <= 8 && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
    }) && value
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
}
