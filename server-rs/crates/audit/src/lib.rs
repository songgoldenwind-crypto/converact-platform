//! Bounded audit record normalization, hashing and replay decisions.

#![forbid(unsafe_code)]

use std::{error::Error, fmt};

use converact_contracts::{
    CanonicalKeyOrder, canonical_json_with_max_bytes, canonical_sha256_with_key_order,
    parse_canonical_timestamp_ms,
};
use serde::Serialize;
use serde_json::{Map, Value};

const MAX_METADATA_BYTES: usize = 32_768;
const MAX_METADATA_DEPTH: usize = 5;
const MAX_METADATA_ARRAY_ITEMS: usize = 100;
const MAX_METADATA_KEY_BYTES: usize = 100;
const MAX_METADATA_TEXT_UTF16_UNITS: usize = 2_048;

/// Stable closed error at the normalized audit-record boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuditContractError {
    /// A record field, timestamp, enum, digest or metadata value is invalid.
    InvalidRecord,
    /// The tenant-chain predecessor is not a lowercase SHA-256 digest.
    InvalidPreviousHash,
}

impl AuditContractError {
    /// Returns the stable machine-readable reason.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRecord => "audit_record_invalid",
            Self::InvalidPreviousHash => "audit_previous_hash_invalid",
        }
    }
}

impl fmt::Display for AuditContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Error for AuditContractError {}

/// Closed actor role copied from the active TypeScript audit contract.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditActorRole {
    Owner,
    Admin,
    Operator,
    Viewer,
    System,
    Provider,
}

impl AuditActorRole {
    /// Returns the wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::Operator => "operator",
            Self::Viewer => "viewer",
            Self::System => "system",
            Self::Provider => "provider",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "owner" => Some(Self::Owner),
            "admin" => Some(Self::Admin),
            "operator" => Some(Self::Operator),
            "viewer" => Some(Self::Viewer),
            "system" => Some(Self::System),
            "provider" => Some(Self::Provider),
            _ => None,
        }
    }
}

/// Closed operation result copied from the active TypeScript audit contract.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditResult {
    Succeeded,
    Failed,
    Denied,
    Accepted,
}

impl AuditResult {
    /// Returns the wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Denied => "denied",
            Self::Accepted => "accepted",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "succeeded" => Some(Self::Succeeded),
            "failed" => Some(Self::Failed),
            "denied" => Some(Self::Denied),
            "accepted" => Some(Self::Accepted),
            _ => None,
        }
    }
}

/// Closed policy result copied from the active TypeScript audit contract.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditPolicyDecision {
    Allow,
    Deny,
    NotApplicable,
}

impl AuditPolicyDecision {
    /// Returns the wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
            Self::NotApplicable => "not_applicable",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "allow" => Some(Self::Allow),
            "deny" => Some(Self::Deny),
            "not_applicable" => Some(Self::NotApplicable),
            _ => None,
        }
    }
}

/// Validated output of the current TypeScript audit service.
///
/// Raw source IP addresses cannot be represented by this type; only their
/// keyed SHA-256 digest crosses the durable append boundary.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AuditAppendInput {
    tenant_id: Box<str>,
    actor_id: Box<str>,
    actor_role: AuditActorRole,
    action: Box<str>,
    resource_type: Box<str>,
    resource_id: Box<str>,
    business_ref_type: Box<str>,
    business_ref_id: Box<str>,
    request_id: Box<str>,
    idempotency_key: Box<str>,
    result: AuditResult,
    policy_decision: AuditPolicyDecision,
    source_ip_hmac: Box<str>,
    metadata: Value,
    occurred_at: Box<str>,
    retention_until: Option<Box<str>>,
    legal_hold: bool,
}

impl AuditAppendInput {
    #[must_use]
    pub fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    #[must_use]
    pub fn actor_id(&self) -> &str {
        &self.actor_id
    }

    #[must_use]
    pub const fn actor_role(&self) -> AuditActorRole {
        self.actor_role
    }

    #[must_use]
    pub fn action(&self) -> &str {
        &self.action
    }

    #[must_use]
    pub fn resource_type(&self) -> &str {
        &self.resource_type
    }

    #[must_use]
    pub fn resource_id(&self) -> &str {
        &self.resource_id
    }

    #[must_use]
    pub fn business_ref_type(&self) -> &str {
        &self.business_ref_type
    }

    #[must_use]
    pub fn business_ref_id(&self) -> &str {
        &self.business_ref_id
    }

    #[must_use]
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    #[must_use]
    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    #[must_use]
    pub const fn result(&self) -> AuditResult {
        self.result
    }

    #[must_use]
    pub const fn policy_decision(&self) -> AuditPolicyDecision {
        self.policy_decision
    }

    #[must_use]
    pub fn source_ip_hmac(&self) -> &str {
        &self.source_ip_hmac
    }

    #[must_use]
    pub const fn metadata(&self) -> &Value {
        &self.metadata
    }

    #[must_use]
    pub fn occurred_at(&self) -> &str {
        &self.occurred_at
    }

    #[must_use]
    pub fn retention_until(&self) -> Option<&str> {
        self.retention_until.as_deref()
    }

    #[must_use]
    pub const fn legal_hold(&self) -> bool {
        self.legal_hold
    }

    fn with_occurred_at(&self, occurred_at: &str) -> Self {
        let mut value = self.clone();
        value.occurred_at = occurred_at.into();
        value
    }
}

impl TryFrom<&Value> for AuditAppendInput {
    type Error = AuditContractError;

    fn try_from(value: &Value) -> Result<Self, Self::Error> {
        let object = value.as_object().ok_or(AuditContractError::InvalidRecord)?;
        let actor_role = AuditActorRole::parse(text(object, "actor_role", 16)?)
            .ok_or(AuditContractError::InvalidRecord)?;
        let result = AuditResult::parse(text(object, "result", 16)?)
            .ok_or(AuditContractError::InvalidRecord)?;
        let policy_decision = AuditPolicyDecision::parse(text(object, "policy_decision", 24)?)
            .ok_or(AuditContractError::InvalidRecord)?;
        let source_ip_hmac = object
            .get("source_ip_hmac")
            .and_then(Value::as_str)
            .filter(|value| value.is_empty() || valid_sha256(value))
            .ok_or(AuditContractError::InvalidRecord)?;
        let occurred_at = canonical_timestamp(object, "occurred_at")?;
        let retention_until = match object.get("retention_until") {
            Some(Value::Null) => None,
            Some(Value::String(value)) if parse_canonical_timestamp_ms(value).is_some() => {
                Some(value.as_str().into())
            }
            _ => return Err(AuditContractError::InvalidRecord),
        };
        let metadata = normalize_metadata(
            object
                .get("metadata")
                .ok_or(AuditContractError::InvalidRecord)?,
            0,
        )?;
        let legal_hold = object
            .get("legal_hold")
            .and_then(Value::as_bool)
            .ok_or(AuditContractError::InvalidRecord)?;

        Ok(Self {
            tenant_id: text(object, "tenant_id", 255)?.into(),
            actor_id: text(object, "actor_id", 255)?.into(),
            actor_role,
            action: text(object, "action", 255)?.into(),
            resource_type: text(object, "resource_type", 100)?.into(),
            resource_id: text(object, "resource_id", 255)?.into(),
            business_ref_type: text(object, "business_ref_type", 100)?.into(),
            business_ref_id: text(object, "business_ref_id", 255)?.into(),
            request_id: text(object, "request_id", 255)?.into(),
            idempotency_key: text(object, "idempotency_key", 255)?.into(),
            result,
            policy_decision,
            source_ip_hmac: source_ip_hmac.into(),
            metadata,
            occurred_at: occurred_at.into(),
            retention_until,
            legal_hold,
        })
    }
}

/// Validated stored event needed for idempotency replay.
#[derive(Clone, Debug, PartialEq)]
pub struct AuditEvent {
    id: Box<str>,
    input: AuditAppendInput,
    previous_hash: Box<str>,
    event_hash: Box<str>,
    created_at: Box<str>,
}

impl AuditEvent {
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub const fn input(&self) -> &AuditAppendInput {
        &self.input
    }

    #[must_use]
    pub fn previous_hash(&self) -> &str {
        &self.previous_hash
    }

    #[must_use]
    pub fn event_hash(&self) -> &str {
        &self.event_hash
    }

    #[must_use]
    pub fn created_at(&self) -> &str {
        &self.created_at
    }
}

impl TryFrom<&Value> for AuditEvent {
    type Error = AuditContractError;

    fn try_from(value: &Value) -> Result<Self, Self::Error> {
        let object = value.as_object().ok_or(AuditContractError::InvalidRecord)?;
        let input = AuditAppendInput::try_from(value)?;
        let previous_hash = object
            .get("previous_hash")
            .and_then(Value::as_str)
            .filter(|value| valid_sha256(value))
            .ok_or(AuditContractError::InvalidRecord)?;
        let event_hash = object
            .get("event_hash")
            .and_then(Value::as_str)
            .filter(|value| valid_sha256(value))
            .ok_or(AuditContractError::InvalidRecord)?;
        Ok(Self {
            id: text(object, "id", 255)?.into(),
            input,
            previous_hash: previous_hash.into(),
            event_hash: event_hash.into(),
            created_at: canonical_timestamp(object, "created_at")?.into(),
        })
    }
}

/// Closed append/replay decision before any durable write.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuditAppendDecision {
    Append,
    Replay,
    Conflict,
}

impl AuditAppendDecision {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Append => "append",
            Self::Replay => "replay",
            Self::Conflict => "conflict",
        }
    }
}

/// Computes the current tenant-local chained event digest.
///
/// # Errors
///
/// Returns [`AuditContractError::InvalidPreviousHash`] for a malformed chain
/// predecessor. The already-validated input is bounded below the canonical
/// document limit.
pub fn audit_event_hash(
    input: &AuditAppendInput,
    previous_hash: &str,
) -> Result<String, AuditContractError> {
    if !valid_sha256(previous_hash) {
        return Err(AuditContractError::InvalidPreviousHash);
    }
    let document = AuditHashDocument {
        input,
        previous_hash,
    };
    let value = serde_json::to_value(document).map_err(|_| AuditContractError::InvalidRecord)?;
    canonical_sha256_with_key_order(&value, CanonicalKeyOrder::Node24EnUsAscii)
        .map_err(|_| AuditContractError::InvalidRecord)
}

/// Decides whether a normalized candidate is new, an exact replay or an
/// idempotency conflict. As in the active TypeScript store, replay evaluates
/// the candidate with the originally stored `occurred_at` value.
#[must_use]
pub fn decide_audit_append(
    existing: Option<&AuditEvent>,
    candidate: &AuditAppendInput,
) -> AuditAppendDecision {
    let Some(existing) = existing else {
        return AuditAppendDecision::Append;
    };
    let replay_candidate = candidate.with_occurred_at(existing.input.occurred_at());
    match audit_event_hash(&replay_candidate, existing.previous_hash()) {
        Ok(hash) if hash == existing.event_hash() => AuditAppendDecision::Replay,
        _ => AuditAppendDecision::Conflict,
    }
}

#[derive(Serialize)]
struct AuditHashDocument<'a> {
    #[serde(flatten)]
    input: &'a AuditAppendInput,
    previous_hash: &'a str,
}

fn text<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    max_utf16_units: usize,
) -> Result<&'a str, AuditContractError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && has_normalized_ecmascript_trim_boundary(value)
                && value.encode_utf16().count() <= max_utf16_units
        })
        .ok_or(AuditContractError::InvalidRecord)
}

fn has_normalized_ecmascript_trim_boundary(value: &str) -> bool {
    value
        .chars()
        .next()
        .is_some_and(|character| !is_ecmascript_trim_character(character))
        && value
            .chars()
            .next_back()
            .is_some_and(|character| !is_ecmascript_trim_character(character))
}

const fn is_ecmascript_trim_character(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn canonical_timestamp<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a str, AuditContractError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| parse_canonical_timestamp_ms(value).is_some())
        .ok_or(AuditContractError::InvalidRecord)
}

fn normalize_metadata(value: &Value, depth: usize) -> Result<Value, AuditContractError> {
    if depth > MAX_METADATA_DEPTH {
        return Err(AuditContractError::InvalidRecord);
    }
    let object = value.as_object().ok_or(AuditContractError::InvalidRecord)?;
    for (key, item) in object {
        if !valid_metadata_key(key) || forbidden_metadata_key(key) {
            return Err(AuditContractError::InvalidRecord);
        }
        if let Some(items) = item.as_array() {
            if items.len() > MAX_METADATA_ARRAY_ITEMS {
                return Err(AuditContractError::InvalidRecord);
            }
            for nested in items {
                validate_metadata_value(nested, depth + 1)?;
            }
        } else if item.is_object() {
            normalize_metadata(item, depth + 1)?;
        } else {
            validate_metadata_value(item, depth)?;
        }
    }
    let canonical = canonical_json_with_max_bytes(value, MAX_METADATA_BYTES)
        .map_err(|_| AuditContractError::InvalidRecord)?;
    serde_json::from_str(&canonical).map_err(|_| AuditContractError::InvalidRecord)
}

fn validate_metadata_value(value: &Value, depth: usize) -> Result<(), AuditContractError> {
    match value {
        Value::String(value)
            if value.encode_utf16().count() <= MAX_METADATA_TEXT_UTF16_UNITS
                && !contains_email(value)
                && !contains_phone(value) =>
        {
            Ok(())
        }
        Value::String(_) | Value::Array(_) => Err(AuditContractError::InvalidRecord),
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::Object(_) => normalize_metadata(value, depth + 1).map(|_| ()),
    }
}

fn valid_metadata_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_METADATA_KEY_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn forbidden_metadata_key(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    [
        "secret",
        "token",
        "password",
        "authorization",
        "cookie",
        "phone",
        "mobile",
        "email",
        "address",
        "body",
        "content",
        "absolute_path",
        "file_path",
    ]
    .iter()
    .any(|forbidden| value.contains(forbidden))
}

fn contains_email(value: &str) -> bool {
    let bytes = value.as_bytes();
    for at in bytes
        .iter()
        .enumerate()
        .filter_map(|(index, byte)| (*byte == b'@').then_some(index))
    {
        if at == 0 || !email_local_byte(bytes[at - 1]) {
            continue;
        }
        let mut left = at;
        while left > 0 && email_local_byte(bytes[left - 1]) {
            left -= 1;
        }
        if left == at {
            continue;
        }
        let mut end = at + 1;
        while end < bytes.len() && email_domain_byte(bytes[end]) {
            end += 1;
        }
        for dot in at + 2..end {
            if bytes[dot] != b'.' {
                continue;
            }
            let suffix = &bytes[dot + 1..end];
            if suffix
                .iter()
                .take_while(|byte| byte.is_ascii_alphabetic())
                .count()
                >= 2
            {
                return true;
            }
        }
    }
    false
}

const fn email_local_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'%' | b'+' | b'-')
}

const fn email_domain_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-')
}

fn contains_phone(value: &str) -> bool {
    let mut previous_is_digit = false;
    for (offset, character) in value.char_indices() {
        if !previous_is_digit && phone_match_at(&value[offset..]) {
            return true;
        }
        previous_is_digit = character.is_ascii_digit();
    }
    false
}

fn phone_match_at(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(mut first) = characters.next() else {
        return false;
    };
    if first == '+' {
        let Some(character) = characters.next() else {
            return false;
        };
        first = character;
    }
    if !first.is_ascii_digit() {
        return false;
    }

    let mut middle_characters = 0;
    while let Some(character) = characters.next() {
        if !phone_middle_character(character) {
            return false;
        }
        if middle_characters >= 8
            && character.is_ascii_digit()
            && characters
                .clone()
                .next()
                .is_none_or(|next| !next.is_ascii_digit())
        {
            return true;
        }
        middle_characters += 1;
    }
    false
}

const fn phone_middle_character(character: char) -> bool {
    character.is_ascii_digit()
        || matches!(character, '(' | ')' | '-')
        || is_ecmascript_trim_character(character)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
