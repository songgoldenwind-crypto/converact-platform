use std::{error::Error, fmt};

use converact_tool_broker_core::ActionFailureCode;
use converact_voice_agent_contracts::ToolCallId;

const MAX_IDENTIFIER_BYTES: usize = 255;
const MAX_STATUS_BYTES: usize = 64;
const MAX_SEGMENT_BYTES: usize = 128;
const MAX_LANGUAGE_BYTES: usize = 35;
const MAX_REASON_BYTES: usize = 1_024;

/// Tenant-bound customer lookup request passed to a registered Provider.
pub struct CustomerLookup {
    tenant_id: Box<str>,
    customer_id: Box<str>,
}

impl CustomerLookup {
    pub(crate) fn try_new(tenant_id: &str, customer_id: &str) -> Result<Self, AdapterInputError> {
        if !bounded_identifier(tenant_id) || !bounded_identifier(customer_id) {
            return Err(AdapterInputError);
        }
        Ok(Self {
            tenant_id: tenant_id.into(),
            customer_id: customer_id.into(),
        })
    }

    #[must_use]
    pub fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    #[must_use]
    pub fn customer_id(&self) -> &str {
        &self.customer_id
    }
}

impl fmt::Debug for CustomerLookup {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CustomerLookup([REDACTED])")
    }
}

/// Bounded non-secret customer facts returned to the Agent.
#[derive(Clone, Eq, PartialEq)]
pub struct CustomerSnapshot {
    customer_id: Box<str>,
    status: Box<str>,
    segment: Option<Box<str>>,
    preferred_language: Option<Box<str>>,
}

impl CustomerSnapshot {
    /// Creates a bounded Provider result.
    ///
    /// # Errors
    ///
    /// Rejects malformed identifiers, status, segment and language values.
    pub fn try_new(
        customer_id: impl AsRef<str>,
        status: impl AsRef<str>,
        segment: Option<&str>,
        preferred_language: Option<&str>,
    ) -> Result<Self, AdapterInputError> {
        let customer_id = customer_id.as_ref();
        let status = status.as_ref();
        if !bounded_identifier(customer_id)
            || !bounded_text(status, MAX_STATUS_BYTES)
            || segment.is_some_and(|value| !bounded_text(value, MAX_SEGMENT_BYTES))
            || preferred_language.is_some_and(|value| !valid_language(value))
        {
            return Err(AdapterInputError);
        }
        Ok(Self {
            customer_id: customer_id.into(),
            status: status.into(),
            segment: segment.map(Box::<str>::from),
            preferred_language: preferred_language.map(Box::<str>::from),
        })
    }

    pub(crate) fn customer_id(&self) -> &str {
        &self.customer_id
    }

    pub(crate) fn status(&self) -> &str {
        &self.status
    }

    pub(crate) fn segment(&self) -> Option<&str> {
        self.segment.as_deref()
    }

    pub(crate) fn preferred_language(&self) -> Option<&str> {
        self.preferred_language.as_deref()
    }
}

impl fmt::Debug for CustomerSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CustomerSnapshot([REDACTED])")
    }
}

/// Definitive customer directory result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CustomerLookupResult {
    Found(CustomerSnapshot),
    NotFound,
}

/// Stable bounded follow-up Task identifier.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FollowUpTaskId(Box<str>);

impl FollowUpTaskId {
    /// Parses the shared bounded identifier grammar.
    ///
    /// # Errors
    ///
    /// Rejects empty, malformed or oversized identifiers.
    pub fn parse(value: impl AsRef<str>) -> Result<Self, AdapterInputError> {
        let value = value.as_ref();
        if !bounded_identifier(value) {
            return Err(AdapterInputError);
        }
        Ok(Self(value.into()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Idempotent follow-up mutation request.
pub struct FollowUpRequest {
    tenant_id: Box<str>,
    customer_id: Box<str>,
    reason: Box<str>,
    due_at_ms: u64,
    idempotency_key: ToolCallId,
}

impl FollowUpRequest {
    pub(crate) fn try_new(
        tenant_id: &str,
        customer_id: &str,
        reason: &str,
        due_at_ms: u64,
        idempotency_key: ToolCallId,
    ) -> Result<Self, AdapterInputError> {
        if !bounded_identifier(tenant_id)
            || !bounded_identifier(customer_id)
            || !bounded_text(reason, MAX_REASON_BYTES)
            || due_at_ms == 0
        {
            return Err(AdapterInputError);
        }
        Ok(Self {
            tenant_id: tenant_id.into(),
            customer_id: customer_id.into(),
            reason: reason.into(),
            due_at_ms,
            idempotency_key,
        })
    }

    #[must_use]
    pub fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    #[must_use]
    pub fn customer_id(&self) -> &str {
        &self.customer_id
    }

    #[must_use]
    pub fn reason(&self) -> &str {
        &self.reason
    }

    #[must_use]
    pub const fn due_at_ms(&self) -> u64 {
        self.due_at_ms
    }

    #[must_use]
    pub const fn idempotency_key(&self) -> &ToolCallId {
        &self.idempotency_key
    }
}

impl fmt::Debug for FollowUpRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("FollowUpRequest([REDACTED])")
    }
}

/// Provider query for a previously attempted follow-up mutation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FollowUpQuery {
    tenant_id: Box<str>,
    idempotency_key: ToolCallId,
}

impl FollowUpQuery {
    pub(crate) fn try_new(
        tenant_id: &str,
        idempotency_key: ToolCallId,
    ) -> Result<Self, AdapterInputError> {
        if !bounded_identifier(tenant_id) {
            return Err(AdapterInputError);
        }
        Ok(Self {
            tenant_id: tenant_id.into(),
            idempotency_key,
        })
    }

    #[must_use]
    pub fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    #[must_use]
    pub const fn idempotency_key(&self) -> &ToolCallId {
        &self.idempotency_key
    }
}

/// Closed Provider observation for an idempotent follow-up Task.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FollowUpExecuteResult {
    Created(FollowUpTaskId),
    NotApplied(ActionFailureCode),
    OutcomeUnknown,
}

/// Stable input failure that never echoes customer data.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AdapterInputError;

impl fmt::Display for AdapterInputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("agent_tool_adapter_input_invalid")
    }
}

impl Error for AdapterInputError {}

fn bounded_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_IDENTIFIER_BYTES
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn bounded_text(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.trim().len() == value.len()
        && !value.chars().any(char::is_control)
}

fn valid_language(value: &str) -> bool {
    let Some(first) = value.as_bytes().first() else {
        return false;
    };
    value.len() >= 2
        && value.len() <= MAX_LANGUAGE_BYTES
        && value.is_ascii()
        && first.is_ascii_alphabetic()
        && value.split('-').all(|part| {
            !part.is_empty()
                && part.len() <= 8
                && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}
