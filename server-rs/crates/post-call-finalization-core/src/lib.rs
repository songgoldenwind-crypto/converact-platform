//! Durable post-call finalization job authority.

#![forbid(unsafe_code)]

use std::{error::Error, fmt};

use converact_contracts::canonical_sha256;
use converact_voice_agent_contracts::{ConversationFinalizationJobId, EnvelopeContext};
use serde::{Deserialize, Serialize};
use serde_json::json;

const MAX_RETENTION_POLICY_BYTES: usize = 255;

/// Closed durable scheduling state for one completed physical Call Attempt.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FinalizationJobState {
    Pending,
    Claimed,
    ReconcileRequired,
    Completed,
}

impl FinalizationJobState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Claimed => "claimed",
            Self::ReconcileRequired => "reconcile_required",
            Self::Completed => "completed",
        }
    }
}

/// Definitive post-call settlement without rewriting the Call outcome.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FinalizationResolution {
    Projected,
    Incomplete,
}

impl FinalizationResolution {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Projected => "projected",
            Self::Incomplete => "incomplete",
        }
    }
}

/// Untrusted immutable values for a new post-call job.
pub struct FinalizationJobInput {
    pub id: ConversationFinalizationJobId,
    pub context: EnvelopeContext,
    pub retention_policy_ref: String,
    pub enqueued_at_ms: u64,
}

/// One content-addressed post-call job. It contains no transcript, audio or Provider payload.
#[derive(Clone, Eq, PartialEq)]
pub struct PostCallFinalizationJob {
    id: ConversationFinalizationJobId,
    context: EnvelopeContext,
    retention_policy_ref: Box<str>,
    enqueued_at_ms: u64,
    payload_hash: Box<str>,
    state: FinalizationJobState,
    resolution: Option<FinalizationResolution>,
    revision: u64,
}

impl PostCallFinalizationJob {
    /// Validates and creates the unique pending job for one completed physical Call Attempt.
    ///
    /// # Errors
    ///
    /// Rejects a missing Call binding, malformed retention policy, zero timestamp or a payload
    /// that cannot be canonically hashed.
    pub fn try_new(input: FinalizationJobInput) -> Result<Self, FinalizationJobError> {
        if input.context.call_id().is_none() {
            return Err(FinalizationJobError::CallRequired);
        }
        if !bounded_identifier(&input.retention_policy_ref, MAX_RETENTION_POLICY_BYTES) {
            return Err(FinalizationJobError::InvalidRetentionPolicy);
        }
        if input.enqueued_at_ms == 0 {
            return Err(FinalizationJobError::InvalidTimestamp);
        }
        let payload_hash = canonical_sha256(&json!({
            "context": &input.context,
            "retention_policy_ref": &input.retention_policy_ref,
            "enqueued_at_ms": input.enqueued_at_ms
        }))
        .map_err(|_| FinalizationJobError::SerializationFailed)?;
        Ok(Self {
            id: input.id,
            context: input.context,
            retention_policy_ref: input.retention_policy_ref.into(),
            enqueued_at_ms: input.enqueued_at_ms,
            payload_hash: payload_hash.into(),
            state: FinalizationJobState::Pending,
            resolution: None,
            revision: 1,
        })
    }

    /// Claims a pending or explicitly reconciled job under a fresh optimistic revision.
    ///
    /// # Errors
    ///
    /// Rejects stale revisions, completed/active claims and revision overflow.
    pub fn claim(&self, expected_revision: u64) -> Result<Self, FinalizationJobError> {
        self.transition(
            expected_revision,
            &[
                FinalizationJobState::Pending,
                FinalizationJobState::ReconcileRequired,
            ],
            FinalizationJobState::Claimed,
            None,
        )
    }

    /// Records that a claimed job must query/reconcile an ambiguous downstream effect.
    ///
    /// # Errors
    ///
    /// Rejects stale revisions, non-claimed jobs and revision overflow.
    pub fn require_reconcile(&self, expected_revision: u64) -> Result<Self, FinalizationJobError> {
        self.transition(
            expected_revision,
            &[FinalizationJobState::Claimed],
            FinalizationJobState::ReconcileRequired,
            None,
        )
    }

    /// Settles a claimed job with a definitive projection resolution.
    ///
    /// # Errors
    ///
    /// Rejects stale revisions, non-claimed jobs and revision overflow.
    pub fn complete(
        &self,
        expected_revision: u64,
        resolution: FinalizationResolution,
    ) -> Result<Self, FinalizationJobError> {
        self.transition(
            expected_revision,
            &[FinalizationJobState::Claimed],
            FinalizationJobState::Completed,
            Some(resolution),
        )
    }

    fn transition(
        &self,
        expected_revision: u64,
        allowed: &[FinalizationJobState],
        state: FinalizationJobState,
        resolution: Option<FinalizationResolution>,
    ) -> Result<Self, FinalizationJobError> {
        if self.revision != expected_revision {
            return Err(FinalizationJobError::StaleRevision);
        }
        if !allowed.contains(&self.state) {
            return Err(FinalizationJobError::InvalidTransition);
        }
        let mut next = self.clone();
        next.revision = self
            .revision
            .checked_add(1)
            .ok_or(FinalizationJobError::RevisionExhausted)?;
        next.state = state;
        next.resolution = resolution;
        Ok(next)
    }

    #[must_use]
    pub const fn id(&self) -> &ConversationFinalizationJobId {
        &self.id
    }

    #[must_use]
    pub const fn context(&self) -> &EnvelopeContext {
        &self.context
    }

    #[must_use]
    pub fn retention_policy_ref(&self) -> &str {
        &self.retention_policy_ref
    }

    #[must_use]
    pub const fn enqueued_at_ms(&self) -> u64 {
        self.enqueued_at_ms
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }

    #[must_use]
    pub const fn state(&self) -> FinalizationJobState {
        self.state
    }

    #[must_use]
    pub const fn resolution(&self) -> Option<FinalizationResolution> {
        self.resolution
    }

    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }
}

impl fmt::Debug for PostCallFinalizationJob {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PostCallFinalizationJob")
            .field("id", &self.id)
            .field("state", &self.state)
            .field("resolution", &self.resolution)
            .field("revision", &self.revision)
            .finish_non_exhaustive()
    }
}

/// Stable fail-closed post-call job rejection categories.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FinalizationJobError {
    InvalidTransition,
    StaleRevision,
    CallRequired,
    InvalidRetentionPolicy,
    InvalidTimestamp,
    RevisionExhausted,
    SerializationFailed,
}

impl FinalizationJobError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidTransition => "post_call_finalization_transition_invalid",
            Self::StaleRevision => "post_call_finalization_revision_stale",
            Self::CallRequired => "post_call_finalization_call_required",
            Self::InvalidRetentionPolicy => "post_call_finalization_retention_policy_invalid",
            Self::InvalidTimestamp => "post_call_finalization_timestamp_invalid",
            Self::RevisionExhausted => "post_call_finalization_revision_exhausted",
            Self::SerializationFailed => "post_call_finalization_serialization_failed",
        }
    }
}

impl fmt::Display for FinalizationJobError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for FinalizationJobError {}

fn bounded_identifier(value: &str, maximum: usize) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= maximum
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
