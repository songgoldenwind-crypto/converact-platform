use std::{error::Error, fmt};

use serde_json::{Value, json};

const MAX_IDENTIFIER_BYTES: usize = 255;
const MAX_DESTINATION_BYTES: usize = 512;
const MAX_REASON_BYTES: usize = 128;
const MAX_CONTEXTS: usize = 16;
const MAX_PAYLOAD_BYTES: usize = 65_536;
const MAX_TIMEOUT_SECONDS: u32 = 120;

/// One outbound call request in the closed RWI subset.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OriginateRequest {
    pub action_id: String,
    pub call_id: String,
    pub destination: String,
    pub caller_id: Option<String>,
    pub timeout_secs: u32,
    pub trunk: Option<String>,
}

/// One internal Active Call SIP leg bound to a pre-reserved Agent session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AddAgentLegRequest {
    pub action_id: String,
    pub call_id: String,
    pub target: String,
    pub leg_id: String,
    pub agent_session_id: String,
}

/// One bridge request between two distinct call legs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeRequest {
    pub action_id: String,
    pub leg_a: String,
    pub leg_b: String,
}

/// One deterministic call termination request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HangupRequest {
    pub action_id: String,
    pub call_id: String,
    pub reason: String,
}

/// Subscription request for bounded RWI event contexts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscribeRequest {
    pub action_id: String,
    pub contexts: Vec<String>,
}

/// Status-query request used for reconciliation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListCallsRequest {
    pub action_id: String,
}

/// Closed command set accepted by the first Rust adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RwiCommand {
    Subscribe(SubscribeRequest),
    ListCalls(ListCallsRequest),
    Originate(OriginateRequest),
    AddAgentLeg(AddAgentLegRequest),
    Hangup(HangupRequest),
    Bridge(BridgeRequest),
    Unsupported { action: String },
}

/// Rejection from the fail-closed RWI envelope encoder.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RwiError {
    InvalidIdentifier,
    InvalidDestination,
    InvalidTimeout,
    InvalidReason,
    InvalidContexts,
    BridgeLegsInvalid,
    PayloadTooLarge,
    SecretFieldForbidden,
    CapabilityUnavailable,
}

impl RwiError {
    /// Returns the stable machine-readable rejection code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidIdentifier => "rustpbx_identifier_invalid",
            Self::InvalidDestination => "rustpbx_destination_invalid",
            Self::InvalidTimeout => "rustpbx_timeout_invalid",
            Self::InvalidReason => "rustpbx_hangup_reason_invalid",
            Self::InvalidContexts => "rustpbx_subscription_contexts_invalid",
            Self::BridgeLegsInvalid => "rustpbx_bridge_legs_invalid",
            Self::PayloadTooLarge => "rustpbx_payload_too_large",
            Self::SecretFieldForbidden => "rustpbx_secret_field_forbidden",
            Self::CapabilityUnavailable => "capability_unavailable",
        }
    }
}

impl fmt::Display for RwiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for RwiError {}

/// Encodes one validated command into the frozen RWI v1 action envelope.
///
/// # Errors
///
/// Rejects unbounded identifiers and payloads, invalid destinations and timeouts, duplicate bridge
/// legs, secret-bearing field names, and every unsupported capability.
pub fn encode_command(command: RwiCommand) -> Result<Value, RwiError> {
    let envelope = match command {
        RwiCommand::Subscribe(request) => encode_subscribe(&request)?,
        RwiCommand::ListCalls(request) => {
            validate_identifier(&request.action_id)?;
            json!({
                "action": "session.list_calls",
                "action_id": request.action_id,
                "params": {},
            })
        }
        RwiCommand::Originate(request) => encode_originate(&request)?,
        RwiCommand::AddAgentLeg(request) => encode_agent_leg(&request)?,
        RwiCommand::Hangup(request) => encode_hangup(&request)?,
        RwiCommand::Bridge(request) => encode_bridge(&request)?,
        RwiCommand::Unsupported { .. } => return Err(RwiError::CapabilityUnavailable),
    };
    reject_secret_fields(&envelope)?;
    let payload_bytes = serde_json::to_vec(&envelope)
        .map_err(|_| RwiError::PayloadTooLarge)?
        .len();
    if payload_bytes > MAX_PAYLOAD_BYTES {
        return Err(RwiError::PayloadTooLarge);
    }
    Ok(envelope)
}

fn encode_subscribe(request: &SubscribeRequest) -> Result<Value, RwiError> {
    validate_identifier(&request.action_id)?;
    if request.contexts.is_empty() || request.contexts.len() > MAX_CONTEXTS {
        return Err(RwiError::InvalidContexts);
    }
    for context in &request.contexts {
        validate_identifier(context).map_err(|_| RwiError::InvalidContexts)?;
    }
    Ok(json!({
        "action": "session.subscribe",
        "action_id": request.action_id,
        "params": { "contexts": request.contexts },
    }))
}

fn encode_originate(request: &OriginateRequest) -> Result<Value, RwiError> {
    validate_identifier(&request.action_id)?;
    validate_identifier(&request.call_id)?;
    validate_destination(&request.destination)?;
    if let Some(caller_id) = &request.caller_id {
        validate_destination(caller_id)?;
    }
    if let Some(trunk) = &request.trunk {
        validate_identifier(trunk)?;
    }
    if request.timeout_secs == 0 || request.timeout_secs > MAX_TIMEOUT_SECONDS {
        return Err(RwiError::InvalidTimeout);
    }
    Ok(json!({
        "action": "call.originate",
        "action_id": request.action_id,
        "params": {
            "call_id": request.call_id,
            "destination": request.destination,
            "caller_id": request.caller_id,
            "timeout_secs": request.timeout_secs,
            "extra_headers": {},
            "trunk": request.trunk,
        },
    }))
}

fn encode_agent_leg(request: &AddAgentLegRequest) -> Result<Value, RwiError> {
    validate_identifier(&request.action_id)?;
    validate_identifier(&request.call_id)?;
    validate_identifier(&request.leg_id)?;
    validate_identifier(&request.agent_session_id)?;
    validate_sip_target(&request.target)?;
    Ok(json!({
        "action": "call.leg_add",
        "action_id": request.action_id,
        "params": {
            "call_id": request.call_id,
            "target": request.target,
            "leg_id": request.leg_id,
            "agent_session_id": request.agent_session_id,
        },
    }))
}

fn encode_hangup(request: &HangupRequest) -> Result<Value, RwiError> {
    validate_identifier(&request.action_id)?;
    validate_identifier(&request.call_id)?;
    if request.reason.is_empty()
        || request.reason.len() > MAX_REASON_BYTES
        || request.reason.chars().any(char::is_control)
    {
        return Err(RwiError::InvalidReason);
    }
    Ok(json!({
        "action": "call.hangup",
        "action_id": request.action_id,
        "params": {
            "call_id": request.call_id,
            "reason": request.reason,
        },
    }))
}

fn encode_bridge(request: &BridgeRequest) -> Result<Value, RwiError> {
    validate_identifier(&request.action_id)?;
    validate_identifier(&request.leg_a).map_err(|_| RwiError::BridgeLegsInvalid)?;
    validate_identifier(&request.leg_b).map_err(|_| RwiError::BridgeLegsInvalid)?;
    if request.leg_a == request.leg_b {
        return Err(RwiError::BridgeLegsInvalid);
    }
    Ok(json!({
        "action": "call.bridge",
        "action_id": request.action_id,
        "params": {
            "leg_a": request.leg_a,
            "leg_b": request.leg_b,
        },
    }))
}

fn validate_identifier(value: &str) -> Result<(), RwiError> {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return Err(RwiError::InvalidIdentifier);
    };
    if bytes.len() > MAX_IDENTIFIER_BYTES
        || !first.is_ascii_alphanumeric()
        || !remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(RwiError::InvalidIdentifier);
    }
    Ok(())
}

fn validate_destination(value: &str) -> Result<(), RwiError> {
    if value.is_empty()
        || value.len() > MAX_DESTINATION_BYTES
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(RwiError::InvalidDestination);
    }
    if let Some(number) = value.strip_prefix('+') {
        let valid = (8..=15).contains(&number.len())
            && number.as_bytes().first().is_some_and(u8::is_ascii_digit)
            && number.as_bytes().first() != Some(&b'0')
            && number.bytes().all(|byte| byte.is_ascii_digit());
        return valid.then_some(()).ok_or(RwiError::InvalidDestination);
    }
    let address = value
        .strip_prefix("sip:")
        .or_else(|| value.strip_prefix("sips:"))
        .ok_or(RwiError::InvalidDestination)?;
    let (user, host) = address
        .split_once('@')
        .ok_or(RwiError::InvalidDestination)?;
    if user.is_empty() || host.is_empty() || host.contains('@') {
        return Err(RwiError::InvalidDestination);
    }
    Ok(())
}

fn validate_sip_target(value: &str) -> Result<(), RwiError> {
    validate_destination(value)?;
    if !value.starts_with("sip:") && !value.starts_with("sips:") {
        return Err(RwiError::InvalidDestination);
    }
    Ok(())
}

fn reject_secret_fields(value: &Value) -> Result<(), RwiError> {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                let canonical = key.to_ascii_lowercase().replace('-', "_");
                if matches!(
                    canonical.as_str(),
                    "authorization" | "token" | "access_token" | "secret" | "password" | "api_key"
                ) {
                    return Err(RwiError::SecretFieldForbidden);
                }
                reject_secret_fields(child)?;
            }
        }
        Value::Array(array) => {
            for child in array {
                reject_secret_fields(child)?;
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
    Ok(())
}
