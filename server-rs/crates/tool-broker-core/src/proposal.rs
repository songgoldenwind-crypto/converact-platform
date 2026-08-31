use std::{error::Error, fmt};

use converact_contracts::canonical_sha256_with_max_bytes;
use converact_voice_agent_contracts::{EnvelopeContext, ToolCallId, ToolRevisionId};
use serde_json::Value;

const MAX_ARGUMENT_BYTES: usize = 65_536;
const SHA256_HEX_BYTES: usize = 64;

/// Unvalidated values accepted by [`ToolProposal::try_new`].
pub struct ToolProposalInput {
    pub context: EnvelopeContext,
    pub tool_revision_id: ToolRevisionId,
    pub tool_call_id: ToolCallId,
    pub tool_schema_hash: String,
    pub arguments_hash: String,
    pub arguments: Value,
    pub requested_at_ms: u64,
    pub deadline_ms: u64,
}

/// A bounded, authority-bound Agent request. It has no execution capability.
#[derive(Clone, Eq, PartialEq)]
pub struct ToolProposal {
    context: EnvelopeContext,
    tool_revision_id: ToolRevisionId,
    tool_call_id: ToolCallId,
    tool_schema_hash: Box<str>,
    arguments_hash: Box<str>,
    arguments: Value,
    requested_at_ms: u64,
    deadline_ms: u64,
}

impl ToolProposal {
    /// Validates authority, digests, bounded canonical arguments and deadline order.
    ///
    /// # Errors
    ///
    /// Returns a stable error without echoing arguments or rejected values.
    pub fn try_new(input: ToolProposalInput) -> Result<Self, ProposalError> {
        if !lowercase_sha256(&input.tool_schema_hash) || !lowercase_sha256(&input.arguments_hash) {
            return Err(ProposalError::InvalidDigest);
        }
        if input.requested_at_ms == 0 || input.deadline_ms <= input.requested_at_ms {
            return Err(ProposalError::InvalidDeadline);
        }
        let observed_hash = canonical_sha256_with_max_bytes(&input.arguments, MAX_ARGUMENT_BYTES)
            .map_err(|_| ProposalError::InvalidArguments)?;
        if observed_hash != input.arguments_hash {
            return Err(ProposalError::ArgumentsDigestMismatch);
        }
        Ok(Self {
            context: input.context,
            tool_revision_id: input.tool_revision_id,
            tool_call_id: input.tool_call_id,
            tool_schema_hash: input.tool_schema_hash.into(),
            arguments_hash: input.arguments_hash.into(),
            arguments: input.arguments,
            requested_at_ms: input.requested_at_ms,
            deadline_ms: input.deadline_ms,
        })
    }

    #[must_use]
    pub const fn context(&self) -> &EnvelopeContext {
        &self.context
    }

    #[must_use]
    pub const fn tool_revision_id(&self) -> &ToolRevisionId {
        &self.tool_revision_id
    }

    #[must_use]
    pub const fn tool_call_id(&self) -> &ToolCallId {
        &self.tool_call_id
    }

    #[must_use]
    pub fn tool_schema_hash(&self) -> &str {
        &self.tool_schema_hash
    }

    #[must_use]
    pub fn arguments_hash(&self) -> &str {
        &self.arguments_hash
    }

    #[must_use]
    pub const fn arguments(&self) -> &Value {
        &self.arguments
    }

    #[must_use]
    pub const fn requested_at_ms(&self) -> u64 {
        self.requested_at_ms
    }

    #[must_use]
    pub const fn deadline_ms(&self) -> u64 {
        self.deadline_ms
    }
}

impl fmt::Debug for ToolProposal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ToolProposal")
            .field("context", &self.context)
            .field("tool_revision_id", &self.tool_revision_id)
            .field("tool_call_id", &self.tool_call_id)
            .field("tool_schema_hash", &self.tool_schema_hash)
            .field("arguments_hash", &self.arguments_hash)
            .field("arguments", &"[REDACTED]")
            .field("requested_at_ms", &self.requested_at_ms)
            .field("deadline_ms", &self.deadline_ms)
            .finish()
    }
}

/// Stable Proposal validation failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProposalError {
    InvalidDigest,
    InvalidArguments,
    ArgumentsDigestMismatch,
    InvalidDeadline,
}

impl ProposalError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidDigest => "tool_proposal_digest_invalid",
            Self::InvalidArguments => "tool_proposal_arguments_invalid",
            Self::ArgumentsDigestMismatch => "tool_proposal_arguments_digest_mismatch",
            Self::InvalidDeadline => "tool_proposal_deadline_invalid",
        }
    }
}

impl fmt::Display for ProposalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ProposalError {}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == SHA256_HEX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}
