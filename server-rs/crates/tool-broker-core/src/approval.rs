use std::{error::Error, fmt};

use converact_voice_agent_contracts::{
    ApprovalId, CallAttemptId, ExecutionGeneration, InteractionId, ToolCallId, ToolRevisionId,
};

use crate::{ToolProposal, definition::lowercase_sha256};

const MAX_TENANT_BYTES: usize = 255;

/// Untrusted durable Approval fields accepted by [`ApprovalGrant::try_new`].
pub struct ApprovalGrantInput {
    pub approval_id: ApprovalId,
    pub tenant_id: String,
    pub interaction_id: InteractionId,
    pub call_attempt_id: CallAttemptId,
    pub execution_generation: ExecutionGeneration,
    pub tool_revision_id: ToolRevisionId,
    pub tool_call_id: ToolCallId,
    pub tool_schema_hash: String,
    pub arguments_hash: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub revoked: bool,
}

/// Durable human or policy Approval bound to one exact Tool Proposal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApprovalGrant {
    approval_id: ApprovalId,
    tenant_id: Box<str>,
    interaction_id: InteractionId,
    call_attempt_id: CallAttemptId,
    execution_generation: ExecutionGeneration,
    tool_revision_id: ToolRevisionId,
    tool_call_id: ToolCallId,
    tool_schema_hash: Box<str>,
    arguments_hash: Box<str>,
    issued_at_ms: u64,
    expires_at_ms: u64,
    revoked: bool,
}

impl ApprovalGrant {
    /// Validates a durable Approval without granting broader authority.
    ///
    /// # Errors
    ///
    /// Rejects malformed authority, digest or lifetime fields.
    pub fn try_new(input: ApprovalGrantInput) -> Result<Self, ApprovalGrantError> {
        if !bounded_identifier(&input.tenant_id) {
            return Err(ApprovalGrantError::InvalidTenant);
        }
        if !lowercase_sha256(&input.tool_schema_hash) || !lowercase_sha256(&input.arguments_hash) {
            return Err(ApprovalGrantError::InvalidDigest);
        }
        if input.issued_at_ms == 0 || input.expires_at_ms <= input.issued_at_ms {
            return Err(ApprovalGrantError::InvalidLifetime);
        }
        Ok(Self {
            approval_id: input.approval_id,
            tenant_id: input.tenant_id.into(),
            interaction_id: input.interaction_id,
            call_attempt_id: input.call_attempt_id,
            execution_generation: input.execution_generation,
            tool_revision_id: input.tool_revision_id,
            tool_call_id: input.tool_call_id,
            tool_schema_hash: input.tool_schema_hash.into(),
            arguments_hash: input.arguments_hash.into(),
            issued_at_ms: input.issued_at_ms,
            expires_at_ms: input.expires_at_ms,
            revoked: input.revoked,
        })
    }

    /// Returns true only for the exact, live Proposal authority tuple.
    #[must_use]
    pub fn authorizes(&self, proposal: &ToolProposal, now_ms: u64) -> bool {
        !self.revoked
            && now_ms >= self.issued_at_ms
            && now_ms < self.expires_at_ms
            && self.tenant_id.as_ref() == proposal.context().tenant_id()
            && &self.interaction_id == proposal.context().interaction_id()
            && &self.call_attempt_id == proposal.context().call_attempt_id()
            && self.execution_generation == proposal.context().execution_generation()
            && &self.tool_revision_id == proposal.tool_revision_id()
            && &self.tool_call_id == proposal.tool_call_id()
            && self.tool_schema_hash.as_ref() == proposal.tool_schema_hash()
            && self.arguments_hash.as_ref() == proposal.arguments_hash()
    }

    #[must_use]
    pub const fn approval_id(&self) -> &ApprovalId {
        &self.approval_id
    }
}

/// Stable Approval validation failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalGrantError {
    InvalidTenant,
    InvalidDigest,
    InvalidLifetime,
}

impl ApprovalGrantError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidTenant => "tool_approval_tenant_invalid",
            Self::InvalidDigest => "tool_approval_digest_invalid",
            Self::InvalidLifetime => "tool_approval_lifetime_invalid",
        }
    }
}

impl fmt::Display for ApprovalGrantError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ApprovalGrantError {}

fn bounded_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_TENANT_BYTES
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
