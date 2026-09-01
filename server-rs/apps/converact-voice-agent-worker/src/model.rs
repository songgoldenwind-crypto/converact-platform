use converact_ai_outbound_core::{AgentRelease, CallAttempt, Campaign, ReleaseComponentDigests};
use converact_post_call_finalization_core::{FinalizationJobState, FinalizationResolution};
use converact_post_call_finalization_store::FinalizationJobProgress;
use converact_tenant_auth::AuthenticatedPlatformIdentity;
use converact_voice_agent_contracts::{AgentReleaseState, CallAttemptState, CampaignState};
use serde::Serialize;

use crate::{RetryWorkerDecision, RetryWorkerError};

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
    NotScheduled,
    Pending,
    Processing,
    ReconcileRequired,
    Projected,
    Incomplete,
}

/// PII-free Campaign retry progress exposed by the internal Attempt inspection API.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryInspectionState {
    Planned,
    NotRetryable,
    Exhausted,
    ReconcileRequired,
}

impl PostCallState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotScheduled => "not_scheduled",
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
    #[serde(skip)]
    components: ReleaseComponentDigests,
}

impl AgentReleaseResource {
    #[must_use]
    pub fn from_release(release: &AgentRelease) -> Self {
        Self {
            id: release.id().as_str().to_owned(),
            definition_id: release.definition_id().as_str().to_owned(),
            state: release.state(),
            content_hash: release.content_hash().to_owned(),
            components: release.components().clone(),
        }
    }

    pub(crate) fn from_durable(
        id: String,
        definition_id: String,
        state: AgentReleaseState,
        content_hash: String,
        components: ReleaseComponentDigests,
    ) -> Self {
        Self {
            id,
            definition_id,
            state,
            content_hash,
            components,
        }
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }

    #[must_use]
    pub const fn components(&self) -> &ReleaseComponentDigests {
        &self.components
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

    pub(crate) fn from_durable(
        id: String,
        release_id: String,
        state: CampaignState,
        active_attempts: u32,
    ) -> Self {
        Self {
            id,
            release_id,
            state,
            active_attempts,
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
    post_call_error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    final_transcript_segments: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<Outcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_state: Option<RetryInspectionState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_reason_code: Option<&'static str>,
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
            post_call_error_code: None,
            final_transcript_segments: None,
            outcome: None,
            retry_state: None,
            retry_reason_code: None,
        }
    }

    pub(crate) fn from_durable(
        id: String,
        campaign_id: String,
        release_id: String,
        state: CallAttemptState,
        disclosure_completed: bool,
        finalization: Option<&FinalizationJobProgress>,
    ) -> Self {
        let resource = Self {
            id,
            campaign_id,
            release_id,
            state,
            disclosure_completed,
            post_call_state: PostCallState::NotScheduled,
            post_call_error_code: None,
            final_transcript_segments: None,
            outcome: None,
            retry_state: None,
            retry_reason_code: None,
        };
        match finalization {
            Some(progress) => resource.with_finalization_progress(progress),
            None => resource,
        }
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub fn campaign_id(&self) -> &str {
        &self.campaign_id
    }

    #[must_use]
    pub fn release_id(&self) -> &str {
        &self.release_id
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

    /// Applies authoritative bounded queue progress to this inspection projection.
    #[must_use]
    pub fn with_finalization_progress(mut self, progress: &FinalizationJobProgress) -> Self {
        self.post_call_state = match progress.state() {
            FinalizationJobState::Pending => PostCallState::Pending,
            FinalizationJobState::Claimed => PostCallState::Processing,
            FinalizationJobState::ReconcileRequired => PostCallState::ReconcileRequired,
            FinalizationJobState::Completed => match progress.resolution() {
                Some(FinalizationResolution::Projected) => PostCallState::Projected,
                Some(FinalizationResolution::Incomplete) => PostCallState::Incomplete,
                None => PostCallState::ReconcileRequired,
            },
        };
        self.post_call_error_code = progress.last_error_code().map(str::to_owned);
        self
    }

    #[must_use]
    pub fn post_call_error_code(&self) -> Option<&str> {
        self.post_call_error_code.as_deref()
    }

    #[must_use]
    pub const fn final_transcript_segments(&self) -> Option<u32> {
        self.final_transcript_segments
    }

    #[must_use]
    pub const fn outcome(&self) -> Option<&Outcome> {
        self.outcome.as_ref()
    }

    /// Adds only the closed retry state and a stable content-free reason.
    #[must_use]
    pub const fn with_retry_decision(mut self, decision: &RetryWorkerDecision) -> Self {
        let (state, reason) = match decision {
            RetryWorkerDecision::Planned { .. } => (RetryInspectionState::Planned, None),
            RetryWorkerDecision::NotRetryable => (
                RetryInspectionState::NotRetryable,
                Some("ai_outbound_terminal_not_retryable"),
            ),
            RetryWorkerDecision::Exhausted => (
                RetryInspectionState::Exhausted,
                Some("ai_outbound_retry_attempts_exhausted"),
            ),
        };
        self.retry_state = Some(state);
        self.retry_reason_code = reason;
        self
    }

    /// Marks an unresolved retry decision without exposing the underlying call content.
    #[must_use]
    pub const fn with_retry_error(mut self, error: RetryWorkerError) -> Self {
        self.retry_state = Some(RetryInspectionState::ReconcileRequired);
        self.retry_reason_code = Some(error.code());
        self
    }

    #[must_use]
    pub const fn retry_state(&self) -> Option<RetryInspectionState> {
        self.retry_state
    }

    #[must_use]
    pub const fn retry_reason_code(&self) -> Option<&'static str> {
        self.retry_reason_code
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
