use std::{error::Error, fmt};

use converact_active_call_adapter::InlinePlaybook;
use converact_ai_outbound_core::AgentReleaseBinding;
use converact_contracts::canonical_sha256_with_max_bytes;
use serde_json::json;

const ARTIFACT_HASH_DOMAIN: &str = "active_call_playbook_artifact_v1";
const MAX_ARTIFACT_CANONICAL_BYTES: usize = 196_608;

/// Rejection at the immutable Active Call Playbook artifact boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveCallPlaybookArtifactError {
    InvalidDigest,
    InvalidDocument,
    DigestMismatch,
    HashingFailed,
}

impl ActiveCallPlaybookArtifactError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidDigest => "active_call_playbook_artifact_digest_invalid",
            Self::InvalidDocument => "active_call_playbook_artifact_document_invalid",
            Self::DigestMismatch => "active_call_playbook_artifact_digest_mismatch",
            Self::HashingFailed => "active_call_playbook_artifact_hashing_failed",
        }
    }
}

impl fmt::Display for ActiveCallPlaybookArtifactError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ActiveCallPlaybookArtifactError {}

/// Bounded Playbook document associated with one exact immutable Agent Release.
///
/// This boundary verifies the document framing and declared artifact digest. It deliberately does
/// not claim that the document was derived from the Release's component payloads; that proof
/// belongs to the trusted deterministic artifact resolver.
#[derive(Clone, Eq, PartialEq)]
pub struct ActiveCallPlaybookArtifact {
    release: AgentReleaseBinding,
    artifact_hash: Box<str>,
    playbook: InlinePlaybook,
}

impl ActiveCallPlaybookArtifact {
    /// Binds a bounded document and its declared digest to one exact Release.
    ///
    /// # Errors
    ///
    /// Rejects malformed digests, invalid Active Call framing, hashing failure and content drift.
    pub fn try_new(
        release: AgentReleaseBinding,
        content: impl AsRef<str>,
        declared_artifact_hash: impl AsRef<str>,
    ) -> Result<Self, ActiveCallPlaybookArtifactError> {
        let declared_artifact_hash = declared_artifact_hash.as_ref();
        if !is_lowercase_sha256(declared_artifact_hash) {
            return Err(ActiveCallPlaybookArtifactError::InvalidDigest);
        }
        let content = content.as_ref();
        let playbook = InlinePlaybook::try_new(content)
            .map_err(|_| ActiveCallPlaybookArtifactError::InvalidDocument)?;
        let actual_hash = artifact_hash(content)?;
        if actual_hash != declared_artifact_hash {
            return Err(ActiveCallPlaybookArtifactError::DigestMismatch);
        }
        Ok(Self {
            release,
            artifact_hash: actual_hash.into(),
            playbook,
        })
    }

    #[must_use]
    pub const fn release(&self) -> &AgentReleaseBinding {
        &self.release
    }

    #[must_use]
    pub fn artifact_hash(&self) -> &str {
        &self.artifact_hash
    }

    #[must_use]
    pub fn into_playbook(self) -> InlinePlaybook {
        self.playbook
    }
}

impl fmt::Debug for ActiveCallPlaybookArtifact {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ActiveCallPlaybookArtifact([REDACTED])")
    }
}

fn artifact_hash(content: &str) -> Result<String, ActiveCallPlaybookArtifactError> {
    canonical_sha256_with_max_bytes(
        &json!({
            "content": content,
            "domain": ARTIFACT_HASH_DOMAIN,
        }),
        MAX_ARTIFACT_CANONICAL_BYTES,
    )
    .map_err(|_| ActiveCallPlaybookArtifactError::HashingFailed)
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use converact_ai_outbound_core::{AgentReleaseBinding, ReleaseComponentDigests};
    use converact_voice_agent_contracts::AgentReleaseId;

    use super::{ActiveCallPlaybookArtifact, ActiveCallPlaybookArtifactError};

    const PLAYBOOK: &str = "---\nname: sales-r1\n---\n# Main\nHello";
    const ARTIFACT_HASH: &str = "d166fc603bcf881b32a0ebfde04994f38f5aa655160834ee69b0dbce5b9052af";

    #[test]
    fn bounded_artifact_preserves_exact_release_and_document_hash() {
        let artifact =
            ActiveCallPlaybookArtifact::try_new(release(), PLAYBOOK, ARTIFACT_HASH).unwrap();

        assert_eq!(artifact.release().id().as_str(), "release-001");
        assert_eq!(
            artifact.release().components().prompt_revision_hash,
            "1".repeat(64)
        );
        assert_eq!(artifact.artifact_hash(), ARTIFACT_HASH);
        assert!(!format!("{artifact:?}").contains("Hello"));
    }

    #[test]
    fn invalid_or_drifting_artifact_fails_closed() {
        assert_eq!(
            ActiveCallPlaybookArtifact::try_new(release(), PLAYBOOK, "9".repeat(64)),
            Err(ActiveCallPlaybookArtifactError::DigestMismatch),
        );
        assert_eq!(
            ActiveCallPlaybookArtifact::try_new(release(), PLAYBOOK, "A".repeat(64)),
            Err(ActiveCallPlaybookArtifactError::InvalidDigest),
        );
        assert_eq!(
            ActiveCallPlaybookArtifact::try_new(release(), "plain prompt", ARTIFACT_HASH),
            Err(ActiveCallPlaybookArtifactError::InvalidDocument),
        );
    }

    fn release() -> AgentReleaseBinding {
        AgentReleaseBinding::try_new(
            AgentReleaseId::parse("release-001").unwrap(),
            "9".repeat(64),
            ReleaseComponentDigests {
                prompt_revision_hash: "1".repeat(64),
                conversation_flow_revision_hash: "2".repeat(64),
                knowledge_revision_hash: "3".repeat(64),
                tool_schema_hash: "4".repeat(64),
                speech_profile_hash: "5".repeat(64),
                compliance_policy_hash: "6".repeat(64),
                outcome_schema_hash: "7".repeat(64),
                evaluation_rubric_hash: "8".repeat(64),
            },
        )
        .unwrap()
    }
}
