use converact_ai_outbound_core::{AgentRelease, CallAttempt, Campaign};
use converact_tenant_auth::AuthenticatedPlatformIdentity;
use converact_voice_agent_contracts::{AgentReleaseState, CallAttemptState, CampaignState};
use serde::Serialize;

const MAX_TENANT_BYTES: usize = 255;
const MAX_OUTCOME_BYTES: usize = 100;

/// Invalid bounded inspection or final-conversation data.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModelError {
    InvalidTenant,
    InvalidOutcome,
}

impl std::fmt::Display for ModelError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidTenant => "voice_agent_tenant_invalid",
            Self::InvalidOutcome => "voice_agent_outcome_invalid",
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

/// Bounded public progress for durable post-call work.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PostCallState {
    Pending,
    Processing,
    ReconcileRequired,
    Projected,
    Incomplete,
}

impl PostCallState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Processing => "processing",
            Self::ReconcileRequired => "reconcile_required",
            Self::Projected => "projected",
            Self::Incomplete => "incomplete",
        }
    }
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
    post_call_state: PostCallState,
    #[serde(skip_serializing_if = "Option::is_none")]
    final_transcript_segments: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<Outcome>,
}

impl AttemptResource {
    #[must_use]
    pub fn terminal_pending(campaign_id: &str, release_id: &str, attempt: &CallAttempt) -> Self {
        Self {
            id: attempt.id().as_str().to_owned(),
            campaign_id: campaign_id.to_owned(),
            release_id: release_id.to_owned(),
            state: attempt.state(),
            disclosure_completed: attempt.disclosure_completed(),
            post_call_state: PostCallState::Pending,
            final_transcript_segments: None,
            outcome: None,
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
    pub const fn post_call_state(&self) -> PostCallState {
        self.post_call_state
    }

    #[must_use]
    pub const fn final_transcript_segments(&self) -> Option<u32> {
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
