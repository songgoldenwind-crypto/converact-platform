use std::{error::Error, fmt};

use converact_agent_handoff_core::HandoffSession;
use converact_contracts::canonical_sha256;
use converact_voice_agent_contracts::{ExecutionGeneration, HandoffCommandId, HandoffId};
use serde_json::json;

const MAX_COMMAND_KIND_BYTES: usize = 64;

/// Unvalidated command identity and optimistic fences.
pub struct HandoffStoreCommandInput {
    pub id: HandoffCommandId,
    pub kind: String,
    pub payload_hash: String,
    pub expected_revision: u64,
    pub expected_generation: ExecutionGeneration,
}

/// One bounded, idempotent Handoff Store command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HandoffStoreCommand {
    id: HandoffCommandId,
    kind: Box<str>,
    payload_hash: Box<str>,
    expected_revision: u64,
    expected_generation: ExecutionGeneration,
}

impl HandoffStoreCommand {
    /// Creates an exact command identity and fence.
    ///
    /// # Errors
    ///
    /// Rejects malformed command kinds, hashes or zero revisions.
    pub fn try_new(input: HandoffStoreCommandInput) -> Result<Self, HandoffStoreError> {
        if !bounded_identifier(&input.kind, MAX_COMMAND_KIND_BYTES)
            || !lowercase_sha256(&input.payload_hash)
            || input.expected_revision == 0
        {
            return Err(HandoffStoreError::InvalidInput);
        }
        Ok(Self {
            id: input.id,
            kind: input.kind.into(),
            payload_hash: input.payload_hash.into(),
            expected_revision: input.expected_revision,
            expected_generation: input.expected_generation,
        })
    }

    #[must_use]
    pub const fn id(&self) -> &HandoffCommandId {
        &self.id
    }

    #[must_use]
    pub fn kind(&self) -> &str {
        &self.kind
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }

    #[must_use]
    pub const fn expected_revision(&self) -> u64 {
        self.expected_revision
    }

    #[must_use]
    pub const fn expected_generation(&self) -> ExecutionGeneration {
        self.expected_generation
    }
}

/// A prevalidated consecutive aggregate write accepted by the SQL Adapter.
#[derive(Debug)]
pub struct HandoffTransitionWrite<'a> {
    command: HandoffStoreCommand,
    current: &'a HandoffSession,
    next: &'a HandoffSession,
}

impl<'a> HandoffTransitionWrite<'a> {
    /// Binds an exact Store command to consecutive snapshots of the same Handoff.
    ///
    /// # Errors
    ///
    /// Rejects stale command fences, identity changes, revision gaps and invalid owner-generation
    /// changes.
    pub fn try_new(
        command: HandoffStoreCommand,
        current: &'a HandoffSession,
        next: &'a HandoffSession,
    ) -> Result<Self, HandoffStoreError> {
        let expected_next_revision = current
            .revision()
            .checked_add(1)
            .ok_or(HandoffStoreError::InvalidTransitionWrite)?;
        let owner_changed = current.owner() != next.owner();
        let expected_changed_generation = current.execution_generation().next().ok();
        let generation_valid = if owner_changed {
            expected_changed_generation == Some(next.execution_generation())
        } else {
            current.execution_generation() == next.execution_generation()
        };
        if command.expected_revision != current.revision()
            || command.expected_generation != current.execution_generation()
            || current.id() != next.id()
            || current.context() != next.context()
            || current.context_packet() != next.context_packet()
            || current.target() != next.target()
            || next.revision() != expected_next_revision
            || current.state() == next.state()
            || !generation_valid
            || command.payload_hash()
                != canonical_transition_payload_hash(command.kind(), current, next)?
        {
            return Err(HandoffStoreError::InvalidTransitionWrite);
        }
        Ok(Self {
            command,
            current,
            next,
        })
    }

    #[must_use]
    pub const fn command(&self) -> &HandoffStoreCommand {
        &self.command
    }

    #[must_use]
    pub const fn handoff_id(&self) -> &HandoffId {
        self.current.id()
    }

    #[must_use]
    pub const fn current(&self) -> &HandoffSession {
        self.current
    }

    #[must_use]
    pub const fn next(&self) -> &HandoffSession {
        self.next
    }
}

/// Computes the only accepted digest for one requested Handoff snapshot.
///
/// # Errors
///
/// Rejects canonical serialization failure.
pub fn canonical_request_payload_hash(
    requested: &HandoffSession,
) -> Result<String, HandoffStoreError> {
    canonical_sha256(&json!({
        "command_kind": "request",
        "tenant_id": requested.context().tenant_id(),
        "handoff_id": requested.id().as_str(),
        "interaction_id": requested.context().interaction_id().as_str(),
        "call_attempt_id": requested.context().call_attempt_id().as_str(),
        "call_id": requested.call_id().as_str(),
        "context_packet_id": requested.context_packet().id().as_str(),
        "context_packet_digest": requested.context_packet().digest(),
        "target_queue": requested.target().queue(),
        "target_skills": requested.target().skills(),
        "preferred_seat": requested.target().preferred_seat(),
        "state": requested.state().as_str(),
        "owner": requested.owner().as_str(),
        "execution_generation": requested.execution_generation().get(),
        "revision": requested.revision(),
        "ai_session_id": requested.ai_session_id().as_str()
    }))
    .map_err(|_| HandoffStoreError::InvalidInput)
}

/// Computes the only accepted digest for a consecutive Handoff transition.
///
/// # Errors
///
/// Rejects canonical serialization failure.
pub fn canonical_transition_payload_hash(
    kind: &str,
    current: &HandoffSession,
    next: &HandoffSession,
) -> Result<String, HandoffStoreError> {
    canonical_sha256(&json!({
        "command_kind": kind,
        "tenant_id": current.context().tenant_id(),
        "handoff_id": current.id().as_str(),
        "current_revision": current.revision(),
        "current_generation": current.execution_generation().get(),
        "current_state": current.state().as_str(),
        "current_owner": current.owner().as_str(),
        "next_revision": next.revision(),
        "next_generation": next.execution_generation().get(),
        "next_state": next.state().as_str(),
        "next_owner": next.owner().as_str(),
        "human_leg_id": next
            .human_leg_id()
            .map(converact_voice_agent_contracts::HumanLegId::as_str),
        "ai_session_id": next.ai_session_id().as_str(),
        "reconcile_from": next
            .reconcile_from()
            .map(converact_agent_handoff_core::HandoffState::as_str)
    }))
    .map_err(|_| HandoffStoreError::InvalidInput)
}

/// Low-cardinality Store failure without tenant data, SQL or topology.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HandoffStoreError {
    InvalidInput,
    InvalidTransitionWrite,
    DatabaseUnavailable,
    Conflict,
    StaleFence,
    ReconcileRequired,
    StoredRowInvalid,
}

impl HandoffStoreError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidInput => "agent_handoff_store_input_invalid",
            Self::InvalidTransitionWrite => "agent_handoff_store_transition_invalid",
            Self::DatabaseUnavailable => "agent_handoff_store_unavailable",
            Self::Conflict => "agent_handoff_store_conflict",
            Self::StaleFence => "agent_handoff_store_fence_stale",
            Self::ReconcileRequired => "agent_handoff_store_reconcile_required",
            Self::StoredRowInvalid => "agent_handoff_store_row_invalid",
        }
    }
}

impl fmt::Display for HandoffStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for HandoffStoreError {}

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

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
