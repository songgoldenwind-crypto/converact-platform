use converact_ai_outbound_core::{AgentRelease, CallAttempt, Campaign};
use converact_tenant_auth::AuthenticatedPlatformIdentity;
use converact_voice_agent_contracts::{AgentReleaseState, CallAttemptState, CampaignState};
use serde::Serialize;

const MAX_TENANT_BYTES: usize = 255;
const MAX_OUTCOME_BYTES: usize = 100;
const MAX_TRANSCRIPT_SEGMENTS: u32 = 1_000_000;

/// Invalid bounded inspection or final-conversation data.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModelError {
    InvalidTenant,
    InvalidOutcome,
    InvalidTranscriptSegmentCount,
}

impl std::fmt::Display for ModelError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidTenant => "voice_agent_tenant_invalid",
            Self::InvalidOutcome => "voice_agent_outcome_invalid",
            Self::InvalidTranscriptSegmentCount => "voice_agent_transcript_count_invalid",
        })
    }
}

impl std::error::Error for ModelError {}

/// Tenant scope injected only after the shared authentication boundary succeeds.
#[derive(Clone, Eq, Hash, PartialEq)]
pub struct AuthenticatedTenant(Box<str>);

impl AuthenticatedTenant {
    #[must_use]
    pub fn from_platform_identity(identity: &AuthenticatedPlatformIdentity) -> Self {
        Self(identity.tenant_id().into())
    }

    /// Constructs the same boundary value in trusted adapters and deterministic tests.
    ///
    /// # Errors
    ///
    /// Rejects a value outside the shared bounded identifier grammar.
    pub fn try_from_verified_tenant_id(value: &str) -> Result<Self, ModelError> {
        if !bounded_identifier(value, MAX_TENANT_BYTES) {
            return Err(ModelError::InvalidTenant);
        }
        Ok(Self(value.into()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for AuthenticatedTenant {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("AuthenticatedTenant([REDACTED])")
    }
}

/// Stable bounded business outcome without transcript or customer data.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Outcome {
    code: Box<str>,
}

impl Outcome {
    /// Creates a bounded machine outcome.
    ///
    /// # Errors
    ///
    /// Rejects empty, oversized or non-canonical values.
    pub fn try_new(code: &str) -> Result<Self, ModelError> {
        if !bounded_identifier(code, MAX_OUTCOME_BYTES) {
            return Err(ModelError::InvalidOutcome);
        }
        Ok(Self { code: code.into() })
    }

    #[must_use]
    pub fn code(&self) -> &str {
        &self.code
    }
}

/// Final bounded evidence projected from the channel-agent event stream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationEvidence {
    final_transcript_segments: u32,
    outcome: Outcome,
}

impl ConversationEvidence {
    /// Creates terminal conversation evidence without retaining transcript text.
    ///
    /// # Errors
    ///
    /// Rejects an unbounded transcript segment count.
    pub fn new(final_transcript_segments: u32, outcome: Outcome) -> Result<Self, ModelError> {
        if final_transcript_segments > MAX_TRANSCRIPT_SEGMENTS {
            return Err(ModelError::InvalidTranscriptSegmentCount);
        }
        Ok(Self {
            final_transcript_segments,
            outcome,
        })
    }

    #[must_use]
    pub const fn final_transcript_segments(&self) -> u32 {
        self.final_transcript_segments
    }

    #[must_use]
    pub const fn outcome(&self) -> &Outcome {
        &self.outcome
    }
}

/// PII-minimized immutable Agent Release projection.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AgentReleaseResource {
    id: String,
    definition_id: String,
    state: AgentReleaseState,
    content_hash: String,
}

impl AgentReleaseResource {
    #[must_use]
    pub fn from_release(release: &AgentRelease) -> Self {
        Self {
            id: release.id().as_str().to_owned(),
            definition_id: release.definition_id().as_str().to_owned(),
            state: release.state(),
            content_hash: release.content_hash().to_owned(),
        }
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub const fn state(&self) -> AgentReleaseState {
        self.state
    }
}

/// Bounded campaign inspection projection.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CampaignResource {
    id: String,
    release_id: String,
    state: CampaignState,
    active_attempts: u32,
}

impl CampaignResource {
    #[must_use]
    pub fn from_campaign(campaign: &Campaign, release_id: &str) -> Self {
        Self {
            id: campaign.id().as_str().to_owned(),
            release_id: release_id.to_owned(),
            state: campaign.state(),
            active_attempts: campaign.active_attempts(),
        }
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub fn release_id(&self) -> &str {
        &self.release_id
    }

    #[must_use]
    pub const fn state(&self) -> CampaignState {
        self.state
    }
}

/// Durable PII-minimized Attempt projection returned by the internal API.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AttemptResource {
    id: String,
    campaign_id: String,
    release_id: String,
    state: CallAttemptState,
    disclosure_completed: bool,
    final_transcript_segments: u32,
    outcome: Option<Outcome>,
}

impl AttemptResource {
    #[must_use]
    pub fn completed(
        campaign_id: &str,
        release_id: &str,
        attempt: &CallAttempt,
        evidence: &ConversationEvidence,
    ) -> Self {
        Self {
            id: attempt.id().as_str().to_owned(),
            campaign_id: campaign_id.to_owned(),
            release_id: release_id.to_owned(),
            state: attempt.state(),
            disclosure_completed: attempt.disclosure_completed(),
            final_transcript_segments: evidence.final_transcript_segments(),
            outcome: Some(evidence.outcome().clone()),
        }
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub const fn state(&self) -> CallAttemptState {
        self.state
    }

    #[must_use]
    pub const fn disclosure_completed(&self) -> bool {
        self.disclosure_completed
    }

    #[must_use]
    pub const fn final_transcript_segments(&self) -> u32 {
        self.final_transcript_segments
    }

    #[must_use]
    pub const fn outcome(&self) -> Option<&Outcome> {
        self.outcome.as_ref()
    }
}

/// Process capacity projection without customer or provider data.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct WorkerResource {
    pub worker_count: u16,
    pub claim_size: u16,
    pub accepting_new_work: bool,
    pub shutdown_requested: bool,
}

fn bounded_identifier(value: &str, max_bytes: usize) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= max_bytes
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
