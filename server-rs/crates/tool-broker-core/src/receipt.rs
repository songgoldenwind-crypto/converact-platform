use std::{error::Error, fmt};

use converact_contracts::canonical_sha256_with_max_bytes;
use converact_voice_agent_contracts::{
    ActionReceiptId, ApprovalId, EnvelopeContext, ExecutionGeneration, ToolCallId, ToolRevisionId,
};
use serde_json::Value;

use crate::AuthorizedToolAction;

const MAX_ACTION_OUTPUT_BYTES: usize = 65_536;
const MAX_FAILURE_CODE_BYTES: usize = 255;

/// Bounded result returned by a registered Action Adapter.
#[derive(Clone, Eq, PartialEq)]
pub struct ToolActionOutput {
    value: Value,
    digest: Box<str>,
}

impl ToolActionOutput {
    /// Canonicalizes and bounds one Tool result.
    ///
    /// # Errors
    ///
    /// Rejects results that cannot be canonically encoded within 64 KiB.
    pub fn try_new(value: Value) -> Result<Self, ActionReceiptError> {
        let digest = canonical_sha256_with_max_bytes(&value, MAX_ACTION_OUTPUT_BYTES)
            .map_err(|_| ActionReceiptError::InvalidOutput)?;
        Ok(Self {
            value,
            digest: digest.into(),
        })
    }

    #[must_use]
    pub const fn value(&self) -> &Value {
        &self.value
    }

    #[must_use]
    pub fn digest(&self) -> &str {
        &self.digest
    }
}

impl fmt::Debug for ToolActionOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ToolActionOutput")
            .field("value", &"[REDACTED]")
            .field("digest", &self.digest)
            .finish()
    }
}

/// Bounded deterministic failure returned by a provider.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionFailureCode(Box<str>);

impl ActionFailureCode {
    /// Creates a lowercase machine code that is safe for durable receipts and logs.
    ///
    /// # Errors
    ///
    /// Rejects empty, non-canonical or oversized values.
    pub fn try_new(value: impl AsRef<str>) -> Result<Self, ActionReceiptError> {
        let value = value.as_ref();
        let bytes = value.as_bytes();
        let valid = bytes.split_first().is_some_and(|(first, rest)| {
            first.is_ascii_lowercase()
                && rest
                    .iter()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
        });
        if !valid || bytes.len() > MAX_FAILURE_CODE_BYTES {
            return Err(ActionReceiptError::InvalidFailureCode);
        }
        Ok(Self(value.into()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Definitive Action result stored in an immutable Receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActionResolution {
    Applied(ToolActionOutput),
    NotApplied(ActionFailureCode),
}

/// Observation returned by execute or provider query.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActionObservation {
    Applied(ToolActionOutput),
    NotApplied(ActionFailureCode),
    OutcomeUnknown,
}

impl ActionObservation {
    #[must_use]
    pub const fn is_definitive(&self) -> bool {
        !matches!(self, Self::OutcomeUnknown)
    }

    /// Converts only a definitive observation into a durable resolution.
    #[must_use]
    pub fn into_resolution(self) -> Option<ActionResolution> {
        match self {
            Self::Applied(output) => Some(ActionResolution::Applied(output)),
            Self::NotApplied(code) => Some(ActionResolution::NotApplied(code)),
            Self::OutcomeUnknown => None,
        }
    }
}

/// Immutable accepted/completed/state-observed Action evidence.
#[derive(Clone, Eq, PartialEq)]
pub struct ActionReceipt {
    receipt_id: ActionReceiptId,
    context: EnvelopeContext,
    tool_revision_id: ToolRevisionId,
    tool_call_id: ToolCallId,
    approval_id: Option<ApprovalId>,
    arguments_hash: Box<str>,
    accepted_at_ms: u64,
    completed_at_ms: u64,
    state_observed_at_ms: u64,
    resolution: ActionResolution,
}

impl ActionReceipt {
    /// Builds final evidence directly from the authorized tuple.
    ///
    /// # Errors
    ///
    /// Rejects zero or out-of-order lifecycle timestamps.
    pub fn state_observed(
        action: &AuthorizedToolAction,
        receipt_id: ActionReceiptId,
        accepted_at_ms: u64,
        completed_at_ms: u64,
        state_observed_at_ms: u64,
        resolution: ActionResolution,
    ) -> Result<Self, ActionReceiptError> {
        if accepted_at_ms == 0
            || completed_at_ms < accepted_at_ms
            || state_observed_at_ms < completed_at_ms
        {
            return Err(ActionReceiptError::InvalidTimestampOrder);
        }
        Ok(Self {
            receipt_id,
            context: action.proposal().context().clone(),
            tool_revision_id: action.proposal().tool_revision_id().clone(),
            tool_call_id: action.proposal().tool_call_id().clone(),
            approval_id: action.approval_id().cloned(),
            arguments_hash: action.proposal().arguments_hash().into(),
            accepted_at_ms,
            completed_at_ms,
            state_observed_at_ms,
            resolution,
        })
    }

    #[must_use]
    pub const fn receipt_id(&self) -> &ActionReceiptId {
        &self.receipt_id
    }

    #[must_use]
    pub const fn context(&self) -> &EnvelopeContext {
        &self.context
    }

    #[must_use]
    pub const fn generation(&self) -> ExecutionGeneration {
        self.context.execution_generation()
    }

    #[must_use]
    pub const fn resolution(&self) -> &ActionResolution {
        &self.resolution
    }

    pub(crate) fn matches_authority(&self, action: &AuthorizedToolAction) -> bool {
        self.context.tenant_id() == action.proposal().context().tenant_id()
            && self.context.interaction_id() == action.proposal().context().interaction_id()
            && self.context.call_attempt_id() == action.proposal().context().call_attempt_id()
            && self.context.agent_release_id() == action.proposal().context().agent_release_id()
            && &self.tool_revision_id == action.proposal().tool_revision_id()
            && &self.tool_call_id == action.proposal().tool_call_id()
            && self.arguments_hash.as_ref() == action.proposal().arguments_hash()
    }
}

impl fmt::Debug for ActionReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActionReceipt")
            .field("receipt_id", &self.receipt_id)
            .field("context", &self.context)
            .field("tool_revision_id", &self.tool_revision_id)
            .field("tool_call_id", &self.tool_call_id)
            .field("approval_id", &self.approval_id)
            .field("arguments_hash", &self.arguments_hash)
            .field("accepted_at_ms", &self.accepted_at_ms)
            .field("completed_at_ms", &self.completed_at_ms)
            .field("state_observed_at_ms", &self.state_observed_at_ms)
            .field("resolution", &self.resolution)
            .finish()
    }
}

/// Stable Receipt validation failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActionReceiptError {
    InvalidOutput,
    InvalidFailureCode,
    InvalidTimestampOrder,
}

impl ActionReceiptError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidOutput => "tool_action_output_invalid",
            Self::InvalidFailureCode => "tool_action_failure_code_invalid",
            Self::InvalidTimestampOrder => "tool_action_receipt_timestamp_invalid",
        }
    }
}

impl fmt::Display for ActionReceiptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ActionReceiptError {}
