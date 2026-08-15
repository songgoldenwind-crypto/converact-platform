//! Bounded durable platform event envelope and inbox decisions.

#![forbid(unsafe_code)]

use std::{error::Error, fmt};

use converact_contracts::{canonical_json_with_max_bytes, parse_canonical_timestamp_ms};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

const MAX_PAYLOAD_BYTES: usize = 65_536;
const MAX_ESCAPED_PAYLOAD_BYTES: usize = MAX_PAYLOAD_BYTES * 6 + 2;
const MAX_IDENTIFIER_UTF16_UNITS: usize = 256;
const MAX_CORRELATION_FIELDS: usize = 32;
const MAX_EXTENSION_FIELDS: usize = 32;
const MAX_EXTENSION_BYTES: usize = 16_384;
const MAX_JSON_DEPTH: usize = 32;
const MAX_JSON_NODES: usize = 8_192;
const MAX_EVENT_DOCUMENT_BYTES: usize = 512 * 1_024;
const JS_MAX_SAFE_INTEGER_F64: f64 = 9_007_199_254_740_991.0;

const REQUIRED_FIELDS: [(&str, &str); 19] = [
    ("event_id", "missing_event_id"),
    ("event_type", "missing_event_type"),
    ("tenant_id", "missing_tenant_id"),
    ("producer_identity", "missing_producer_identity"),
    ("authority", "missing_authority"),
    ("aggregate_type", "missing_aggregate_type"),
    ("aggregate_id", "missing_aggregate_id"),
    ("aggregate_revision", "missing_aggregate_revision"),
    ("ordering_key", "missing_ordering_key"),
    ("idempotency_key", "missing_idempotency_key"),
    ("payload_digest", "missing_payload_digest"),
    ("occurred_at", "missing_occurred_at"),
    ("observed_at", "missing_observed_at"),
    ("correlation", "missing_correlation"),
    ("causation_event_id", "missing_causation_event_id"),
    ("purpose", "missing_purpose"),
    ("region_policy", "missing_region_policy"),
    ("retention_policy", "missing_retention_policy"),
    ("data", "missing_data"),
];

const ENVELOPE_FIELDS: [&str; 21] = [
    "schema_version",
    "event_id",
    "event_type",
    "tenant_id",
    "producer_identity",
    "authority",
    "aggregate_type",
    "aggregate_id",
    "aggregate_revision",
    "ordering_key",
    "idempotency_key",
    "payload_digest",
    "occurred_at",
    "observed_at",
    "correlation",
    "causation_event_id",
    "purpose",
    "region_policy",
    "retention_policy",
    "data",
    "effect_semantics",
];

/// Closed reader policy for the current two-version rolling window.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EventReadPolicy {
    current_version: u8,
    read_versions: [u8; 2],
}

impl EventReadPolicy {
    /// Returns the current writer-v2/read-v2-v1 policy.
    #[must_use]
    pub const fn v2() -> Self {
        Self {
            current_version: 2,
            read_versions: [2, 1],
        }
    }
}

/// Stable fail-closed event decode result without rejected values.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EventQuarantine {
    reason: &'static str,
}

impl EventQuarantine {
    #[must_use]
    pub const fn reason(self) -> &'static str {
        self.reason
    }
}

impl fmt::Display for EventQuarantine {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.reason)
    }
}

impl Error for EventQuarantine {}

/// Meaning of a known platform event for rolling-schema safety.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectSemantics {
    None,
    StateProjectionV1,
    EffectReceiptV1,
}

/// Validated, normalized event-v2 envelope.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PlatformEvent {
    schema_version: u8,
    source_schema_version: u8,
    event_id: Box<str>,
    event_type: Box<str>,
    tenant_id: Box<str>,
    producer_identity: Box<str>,
    authority: Box<str>,
    aggregate_type: Box<str>,
    aggregate_id: Box<str>,
    aggregate_revision: u64,
    ordering_key: Box<str>,
    idempotency_key: Box<str>,
    payload_digest: Box<str>,
    occurred_at: Box<str>,
    observed_at: Box<str>,
    correlation: Map<String, Value>,
    causation_event_id: Option<Box<str>>,
    purpose: Box<str>,
    region_policy: Box<str>,
    retention_policy: Box<str>,
    data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    effect_semantics: Option<EffectSemantics>,
    extensions: Map<String, Value>,
}

impl PlatformEvent {
    #[must_use]
    pub const fn schema_version(&self) -> u8 {
        self.schema_version
    }

    #[must_use]
    pub const fn source_schema_version(&self) -> u8 {
        self.source_schema_version
    }

    #[must_use]
    pub fn event_id(&self) -> &str {
        &self.event_id
    }

    #[must_use]
    pub fn event_type(&self) -> &str {
        &self.event_type
    }

    #[must_use]
    pub fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    #[must_use]
    pub fn producer_identity(&self) -> &str {
        &self.producer_identity
    }

    #[must_use]
    pub fn authority(&self) -> &str {
        &self.authority
    }

    #[must_use]
    pub fn aggregate_type(&self) -> &str {
        &self.aggregate_type
    }

    #[must_use]
    pub fn aggregate_id(&self) -> &str {
        &self.aggregate_id
    }

    #[must_use]
    pub const fn aggregate_revision(&self) -> u64 {
        self.aggregate_revision
    }

    #[must_use]
    pub fn ordering_key(&self) -> &str {
        &self.ordering_key
    }

    #[must_use]
    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    #[must_use]
    pub fn payload_digest(&self) -> &str {
        &self.payload_digest
    }

    #[must_use]
    pub fn occurred_at(&self) -> &str {
        &self.occurred_at
    }

    #[must_use]
    pub fn observed_at(&self) -> &str {
        &self.observed_at
    }

    #[must_use]
    pub const fn correlation(&self) -> &Map<String, Value> {
        &self.correlation
    }

    #[must_use]
    pub fn causation_event_id(&self) -> Option<&str> {
        self.causation_event_id.as_deref()
    }

    #[must_use]
    pub fn purpose(&self) -> &str {
        &self.purpose
    }

    #[must_use]
    pub fn region_policy(&self) -> &str {
        &self.region_policy
    }

    #[must_use]
    pub fn retention_policy(&self) -> &str {
        &self.retention_policy
    }

    #[must_use]
    pub const fn data(&self) -> &Value {
        &self.data
    }

    #[must_use]
    pub const fn effect_semantics(&self) -> Option<EffectSemantics> {
        self.effect_semantics
    }

    #[must_use]
    pub const fn extensions(&self) -> &Map<String, Value> {
        &self.extensions
    }
}

/// Decodes and normalizes the active TypeScript platform envelope.
///
/// Wall-clock values are validated but never used for aggregate ordering.
///
/// # Errors
///
/// Returns a stable quarantine reason for unsupported, malformed, oversized
/// or digest-mismatched input.
pub fn decode_platform_event(
    value: &Value,
    policy: EventReadPolicy,
) -> Result<PlatformEvent, EventQuarantine> {
    if policy != EventReadPolicy::v2() {
        return quarantine("reader_policy_invalid");
    }
    let object = value.as_object().ok_or(EventQuarantine {
        reason: "event_invalid",
    })?;
    let header = decode_header(object, policy)?;
    let (payload_digest, normalized_data) = decode_payload(object)?;
    let extensions = decode_extensions(object)?;
    if !extensions.is_empty() && header.effect_semantics != Some(EffectSemantics::None) {
        return quarantine("unknown_extension_with_effect_semantics");
    }

    Ok(PlatformEvent {
        schema_version: policy.current_version,
        source_schema_version: header.source_schema_version,
        event_id: header.event_id.into(),
        event_type: header.event_type.into(),
        tenant_id: header.tenant_id.into(),
        producer_identity: header.producer_identity.into(),
        authority: header.authority.into(),
        aggregate_type: header.aggregate_type.into(),
        aggregate_id: header.aggregate_id.into(),
        aggregate_revision: header.aggregate_revision,
        ordering_key: header.ordering_key.into(),
        idempotency_key: header.idempotency_key.into(),
        payload_digest: payload_digest.into(),
        occurred_at: header.occurred_at.into(),
        observed_at: header.observed_at.into(),
        correlation: header.correlation,
        causation_event_id: header.causation_event_id.map(Into::into),
        purpose: header.purpose.into(),
        region_policy: header.region_policy.into(),
        retention_policy: header.retention_policy.into(),
        data: normalized_data,
        effect_semantics: header.effect_semantics,
        extensions,
    })
}

/// Parses a bounded JSON event document before applying the normalized event
/// contract. Rust strings cannot represent unpaired UTF-16 surrogates, so the
/// raw boundary rejects them fail closed in agreement with compatibility
/// policy revision 1.
///
/// # Errors
///
/// Returns `event_invalid` for malformed or oversized JSON and otherwise the
/// same quarantine reason as [`decode_platform_event`].
pub fn decode_platform_event_json(
    document: &str,
    policy: EventReadPolicy,
) -> Result<PlatformEvent, EventQuarantine> {
    if document.len() > MAX_EVENT_DOCUMENT_BYTES {
        return quarantine("event_invalid");
    }
    let value: Value = serde_json::from_str(document).map_err(|_| EventQuarantine {
        reason: "event_invalid",
    })?;
    decode_platform_event(&value, policy)
}

struct DecodedHeader<'a> {
    source_schema_version: u8,
    event_id: &'a str,
    event_type: &'a str,
    tenant_id: &'a str,
    producer_identity: &'a str,
    authority: &'a str,
    aggregate_type: &'a str,
    aggregate_id: &'a str,
    aggregate_revision: u64,
    ordering_key: &'a str,
    idempotency_key: &'a str,
    occurred_at: &'a str,
    observed_at: &'a str,
    correlation: Map<String, Value>,
    causation_event_id: Option<&'a str>,
    purpose: &'a str,
    region_policy: &'a str,
    retention_policy: &'a str,
    effect_semantics: Option<EffectSemantics>,
}

fn decode_header(
    object: &Map<String, Value>,
    policy: EventReadPolicy,
) -> Result<DecodedHeader<'_>, EventQuarantine> {
    let source_schema_version = match js_non_negative_safe_integer(object.get("schema_version")) {
        Some(1) if policy.read_versions.contains(&1) => 1,
        Some(2) if policy.read_versions.contains(&2) => 2,
        _ => return quarantine("unsupported_schema_version"),
    };
    for (field, reason) in REQUIRED_FIELDS {
        if !object.contains_key(field) {
            return quarantine(reason);
        }
    }
    let effect_semantics = match object.get("effect_semantics") {
        None => None,
        Some(Value::String(value)) => match value.as_str() {
            "none" => Some(EffectSemantics::None),
            "state_projection_v1" => Some(EffectSemantics::StateProjectionV1),
            "effect_receipt_v1" => Some(EffectSemantics::EffectReceiptV1),
            _ => return quarantine("unknown_effect_semantics"),
        },
        Some(_) => return quarantine("unknown_effect_semantics"),
    };
    let identifiers = [
        "event_id",
        "event_type",
        "tenant_id",
        "producer_identity",
        "authority",
        "aggregate_type",
        "aggregate_id",
        "ordering_key",
        "idempotency_key",
        "purpose",
        "region_policy",
        "retention_policy",
    ];
    if identifiers
        .iter()
        .any(|field| !object.get(*field).is_some_and(valid_bounded_text_value))
        || !object.get("payload_digest").is_some_and(valid_sha256_value)
    {
        return quarantine("event_identity_invalid");
    }
    let aggregate_revision =
        js_non_negative_safe_integer(object.get("aggregate_revision")).ok_or(EventQuarantine {
            reason: "aggregate_revision_invalid",
        })?;
    let causation_event_id = match object.get("causation_event_id") {
        Some(Value::Null) => None,
        Some(Value::String(value)) if valid_bounded_text(value) => Some(value.as_str()),
        _ => return quarantine("causation_event_id_invalid"),
    };
    let occurred_at = text(object, "occurred_at");
    let observed_at = text(object, "observed_at");
    if occurred_at.and_then(parse_canonical_timestamp_ms).is_none()
        || observed_at.and_then(parse_canonical_timestamp_ms).is_none()
    {
        return quarantine("event_timestamp_invalid");
    }
    Ok(DecodedHeader {
        source_schema_version,
        event_id: required_text(object, "event_id"),
        event_type: required_text(object, "event_type"),
        tenant_id: required_text(object, "tenant_id"),
        producer_identity: required_text(object, "producer_identity"),
        authority: required_text(object, "authority"),
        aggregate_type: required_text(object, "aggregate_type"),
        aggregate_id: required_text(object, "aggregate_id"),
        aggregate_revision,
        ordering_key: required_text(object, "ordering_key"),
        idempotency_key: required_text(object, "idempotency_key"),
        occurred_at: occurred_at.ok_or(EventQuarantine {
            reason: "event_timestamp_invalid",
        })?,
        observed_at: observed_at.ok_or(EventQuarantine {
            reason: "event_timestamp_invalid",
        })?,
        correlation: decode_correlation(object.get("correlation"))?,
        causation_event_id,
        purpose: required_text(object, "purpose"),
        region_policy: required_text(object, "region_policy"),
        retention_policy: required_text(object, "retention_policy"),
        effect_semantics,
    })
}

fn decode_payload(object: &Map<String, Value>) -> Result<(String, Value), EventQuarantine> {
    let data = object.get("data").ok_or(EventQuarantine {
        reason: "missing_data",
    })?;
    if data
        .as_str()
        .is_some_and(|value| value.len() > MAX_PAYLOAD_BYTES)
    {
        return quarantine("payload_too_large");
    }
    let payload_budget = if data.is_string() {
        MAX_ESCAPED_PAYLOAD_BYTES
    } else {
        MAX_PAYLOAD_BYTES
    };
    let canonical_data =
        canonical_json_with_max_bytes(data, payload_budget).map_err(|_| EventQuarantine {
            reason: "payload_too_large_or_invalid",
        })?;
    let payload_digest = hex::encode(Sha256::digest(canonical_data.as_bytes()));
    if text(object, "payload_digest") != Some(payload_digest.as_str()) {
        return quarantine("payload_digest_mismatch");
    }
    let normalized_data: Value =
        serde_json::from_str(&canonical_data).map_err(|_| EventQuarantine {
            reason: "payload_too_large_or_invalid",
        })?;
    Ok((payload_digest, normalized_data))
}

/// Existing inbox head used for an aggregate-local write decision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlatformInboxState {
    payload_digest: Box<str>,
    aggregate_revision: u64,
    event_id: Option<Box<str>>,
    ordering_key: Option<Box<str>>,
}

/// Stable corrupt inbox state error.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InboxStateError;

impl fmt::Display for InboxStateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("platform_inbox_state_invalid")
    }
}

impl Error for InboxStateError {}

impl TryFrom<&Value> for PlatformInboxState {
    type Error = InboxStateError;

    fn try_from(value: &Value) -> Result<Self, Self::Error> {
        let object = value.as_object().ok_or(InboxStateError)?;
        let payload_digest = object
            .get("payload_digest")
            .and_then(Value::as_str)
            .filter(|value| valid_sha256(value))
            .ok_or(InboxStateError)?;
        let aggregate_revision = js_non_negative_safe_integer(object.get("aggregate_revision"))
            .ok_or(InboxStateError)?;
        let event_id = optional_bounded_text(object.get("event_id"))?;
        let ordering_key = optional_bounded_text(object.get("ordering_key"))?;
        Ok(Self {
            payload_digest: payload_digest.into(),
            aggregate_revision,
            event_id,
            ordering_key,
        })
    }
}

/// Closed inbox duplicate/reorder decision.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InboxWriteDecision {
    Insert,
    Replay,
    Stale,
    Conflict,
    GapRequiresReconcile,
}

impl InboxWriteDecision {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Insert => "insert",
            Self::Replay => "replay",
            Self::Stale => "stale",
            Self::Conflict => "conflict",
            Self::GapRequiresReconcile => "gap_requires_reconcile",
        }
    }
}

/// Replays the current event-id and ordering-key inbox decision.
#[must_use]
pub fn decide_inbox_write(
    existing: Option<&PlatformInboxState>,
    incoming: &PlatformEvent,
) -> InboxWriteDecision {
    let Some(existing) = existing else {
        return InboxWriteDecision::Insert;
    };
    if existing.event_id.as_deref() == Some(incoming.event_id()) {
        return if existing.payload_digest.as_ref() == incoming.payload_digest()
            && existing.aggregate_revision == incoming.aggregate_revision()
            && existing
                .ordering_key
                .as_deref()
                .is_none_or(|key| key == incoming.ordering_key())
        {
            InboxWriteDecision::Replay
        } else {
            InboxWriteDecision::Conflict
        };
    }
    if existing
        .ordering_key
        .as_deref()
        .is_some_and(|key| key != incoming.ordering_key())
    {
        return InboxWriteDecision::Insert;
    }
    if incoming.aggregate_revision() < existing.aggregate_revision {
        return InboxWriteDecision::Stale;
    }
    if incoming.aggregate_revision() == existing.aggregate_revision {
        return if existing.payload_digest.as_ref() == incoming.payload_digest() {
            InboxWriteDecision::Replay
        } else {
            InboxWriteDecision::Conflict
        };
    }
    if incoming.aggregate_revision() > existing.aggregate_revision.saturating_add(1) {
        return InboxWriteDecision::GapRequiresReconcile;
    }
    InboxWriteDecision::Insert
}

fn decode_correlation(value: Option<&Value>) -> Result<Map<String, Value>, EventQuarantine> {
    let object = value.and_then(Value::as_object).ok_or(EventQuarantine {
        reason: "correlation_invalid",
    })?;
    if object.is_empty()
        || object.len() > MAX_CORRELATION_FIELDS
        || !object
            .get("correlation_id")
            .is_some_and(valid_bounded_text_value)
    {
        return quarantine("correlation_invalid");
    }
    let mut normalized = Map::new();
    for (key, value) in object {
        if !valid_bounded_text(key) || key == "__proto__" {
            return quarantine("correlation_invalid");
        }
        match value {
            Value::String(text) if valid_bounded_text(text) => {
                normalized.insert(key.clone(), Value::String(text.clone()));
            }
            _ => {
                let integer = js_non_negative_safe_integer(Some(value)).ok_or(EventQuarantine {
                    reason: "correlation_invalid",
                })?;
                normalized.insert(key.clone(), Value::Number(integer.into()));
            }
        }
    }
    Ok(normalized)
}

fn decode_extensions(object: &Map<String, Value>) -> Result<Map<String, Value>, EventQuarantine> {
    let extension_count = object
        .keys()
        .filter(|key| !ENVELOPE_FIELDS.contains(&key.as_str()))
        .count();
    if extension_count > MAX_EXTENSION_FIELDS
        || object
            .keys()
            .any(|key| key == "__proto__" && !ENVELOPE_FIELDS.contains(&key.as_str()))
    {
        return quarantine("extensions_invalid");
    }
    let mut nodes: usize = 1;
    let mut raw_bytes: usize = 2;
    for (key, value) in object {
        if ENVELOPE_FIELDS.contains(&key.as_str()) {
            continue;
        }
        raw_bytes = raw_bytes
            .checked_add(key.len() + 3)
            .ok_or(EventQuarantine {
                reason: "extensions_invalid",
            })?;
        if raw_bytes > MAX_EXTENSION_BYTES || !preflight_json(value, 1, &mut nodes, &mut raw_bytes)
        {
            return quarantine("extensions_invalid");
        }
    }
    let mut extensions = Map::new();
    for (key, value) in object {
        if !ENVELOPE_FIELDS.contains(&key.as_str()) {
            extensions.insert(key.clone(), value.clone());
        }
    }
    let canonical = canonical_json_with_max_bytes(&Value::Object(extensions), MAX_EXTENSION_BYTES)
        .map_err(|_| EventQuarantine {
            reason: "extensions_invalid",
        })?;
    serde_json::from_str::<Value>(&canonical)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .ok_or(EventQuarantine {
            reason: "extensions_invalid",
        })
}

fn preflight_json(value: &Value, depth: usize, nodes: &mut usize, raw_bytes: &mut usize) -> bool {
    *nodes += 1;
    if depth > MAX_JSON_DEPTH || *nodes > MAX_JSON_NODES {
        return false;
    }
    let scalar_bytes = match value {
        Value::Null | Value::Bool(true) => Some(4),
        Value::Bool(false) => Some(5),
        Value::Number(number) => Some(number.to_string().len()),
        Value::String(text) => Some(text.len()),
        Value::Array(items) => {
            if !add_raw_bytes(raw_bytes, 2 + items.len().saturating_sub(1)) {
                return false;
            }
            return items
                .iter()
                .all(|item| preflight_json(item, depth + 1, nodes, raw_bytes));
        }
        Value::Object(object) => {
            if !add_raw_bytes(raw_bytes, 2 + object.len().saturating_sub(1)) {
                return false;
            }
            for (key, item) in object {
                if !add_raw_bytes(raw_bytes, key.len() + 3)
                    || !preflight_json(item, depth + 1, nodes, raw_bytes)
                {
                    return false;
                }
            }
            return true;
        }
    };
    scalar_bytes.is_some_and(|bytes| add_raw_bytes(raw_bytes, bytes))
}

fn add_raw_bytes(total: &mut usize, additional: usize) -> bool {
    let Some(updated) = total.checked_add(additional) else {
        return false;
    };
    if updated > MAX_EXTENSION_BYTES {
        return false;
    }
    *total = updated;
    true
}

fn required_text<'a>(object: &'a Map<String, Value>, field: &str) -> &'a str {
    object[field].as_str().expect("validated bounded text")
}

fn text<'a>(object: &'a Map<String, Value>, field: &str) -> Option<&'a str> {
    object.get(field).and_then(Value::as_str)
}

fn optional_bounded_text(value: Option<&Value>) -> Result<Option<Box<str>>, InboxStateError> {
    match value {
        None => Ok(None),
        Some(Value::String(value)) if valid_bounded_text(value) => Ok(Some(value.as_str().into())),
        _ => Err(InboxStateError),
    }
}

fn valid_bounded_text_value(value: &Value) -> bool {
    value.as_str().is_some_and(valid_bounded_text)
}

fn valid_bounded_text(value: &str) -> bool {
    let mut count = 0;
    let mut first = None;
    let mut last = None;
    for unit in value.encode_utf16() {
        count += 1;
        if count > MAX_IDENTIFIER_UTF16_UNITS || matches!(unit, 0x0000..=0x001f | 0x007f) {
            return false;
        }
        first.get_or_insert(unit);
        last = Some(unit);
    }
    first.is_some_and(|unit| !is_js_trim(unit)) && last.is_some_and(|unit| !is_js_trim(unit))
}

const fn is_js_trim(character: u16) -> bool {
    matches!(
        character,
        0x0009..=0x000d
            | 0x0020
            | 0x00a0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

fn js_non_negative_safe_integer(value: Option<&Value>) -> Option<u64> {
    let value = value?.as_f64()?;
    if !value.is_finite()
        || !(0.0..=JS_MAX_SAFE_INTEGER_F64).contains(&value)
        || value.fract() != 0.0
    {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(value as u64)
}

fn valid_sha256_value(value: &Value) -> bool {
    value.as_str().is_some_and(valid_sha256)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn quarantine<T>(reason: &'static str) -> Result<T, EventQuarantine> {
    Err(EventQuarantine { reason })
}
