//! Bounded durable effect receipts and idempotency decisions.

#![forbid(unsafe_code)]

use std::{error::Error, fmt};

use converact_contracts::parse_canonical_timestamp_ms;
use serde::Serialize;
use serde_json::Value;

const RECEIPT_FIELD_COUNT: usize = 11;
const MAX_TEXT_UTF16_UNITS: usize = 256;
const MAX_RECEIPT_DOCUMENT_BYTES: usize = 65_536;
const JS_MAX_SAFE_INTEGER_F64: f64 = 9_007_199_254_740_991.0;

/// Durable external-effect lifecycle stage.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectReceiptStage {
    Accepted,
    Completed,
    StateObserved,
}

impl EffectReceiptStage {
    const fn index(self) -> usize {
        match self {
            Self::Accepted => 0,
            Self::Completed => 1,
            Self::StateObserved => 2,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Completed => "completed",
            Self::StateObserved => "state_observed",
        }
    }
}

/// Strict validated effect receipt. Unknown fields cannot cross this boundary.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct EffectReceipt {
    receipt_id: Box<str>,
    tenant_id: Box<str>,
    effect_id: Box<str>,
    event_id: Box<str>,
    correlation_id: Box<str>,
    stage: EffectReceiptStage,
    generation: u64,
    writer_id: Box<str>,
    owner_epoch: u64,
    receipt_digest: Box<str>,
    observed_at: Box<str>,
}

impl EffectReceipt {
    #[must_use]
    pub fn receipt_id(&self) -> &str {
        &self.receipt_id
    }

    #[must_use]
    pub fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    #[must_use]
    pub fn effect_id(&self) -> &str {
        &self.effect_id
    }

    #[must_use]
    pub fn event_id(&self) -> &str {
        &self.event_id
    }

    #[must_use]
    pub fn correlation_id(&self) -> &str {
        &self.correlation_id
    }

    #[must_use]
    pub const fn stage(&self) -> EffectReceiptStage {
        self.stage
    }

    #[must_use]
    pub const fn generation(&self) -> u64 {
        self.generation
    }

    #[must_use]
    pub fn writer_id(&self) -> &str {
        &self.writer_id
    }

    #[must_use]
    pub const fn owner_epoch(&self) -> u64 {
        self.owner_epoch
    }

    #[must_use]
    pub fn receipt_digest(&self) -> &str {
        &self.receipt_digest
    }

    #[must_use]
    pub fn observed_at(&self) -> &str {
        &self.observed_at
    }
}

/// Stable strict receipt shape failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EffectReceiptError;

impl fmt::Display for EffectReceiptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("effect_receipt_shape_invalid")
    }
}

impl Error for EffectReceiptError {}

impl TryFrom<&Value> for EffectReceipt {
    type Error = EffectReceiptError;

    fn try_from(value: &Value) -> Result<Self, Self::Error> {
        let object = value.as_object().ok_or(EffectReceiptError)?;
        if object.len() != RECEIPT_FIELD_COUNT {
            return Err(EffectReceiptError);
        }
        let text = |field: &str| {
            object
                .get(field)
                .and_then(Value::as_str)
                .filter(|value| valid_bounded_text(value))
                .map(Box::<str>::from)
                .ok_or(EffectReceiptError)
        };
        let stage = match object.get("stage").and_then(Value::as_str) {
            Some("accepted") => EffectReceiptStage::Accepted,
            Some("completed") => EffectReceiptStage::Completed,
            Some("state_observed") => EffectReceiptStage::StateObserved,
            _ => return Err(EffectReceiptError),
        };
        let generation = js_non_negative_safe_integer(object.get("generation"))
            .filter(|generation| *generation > 0)
            .ok_or(EffectReceiptError)?;
        let owner_epoch =
            js_non_negative_safe_integer(object.get("owner_epoch")).ok_or(EffectReceiptError)?;
        let receipt_digest = object
            .get("receipt_digest")
            .and_then(Value::as_str)
            .filter(|value| valid_sha256(value))
            .ok_or(EffectReceiptError)?;
        let observed_at = object
            .get("observed_at")
            .and_then(Value::as_str)
            .filter(|value| parse_canonical_timestamp_ms(value).is_some())
            .ok_or(EffectReceiptError)?;
        Ok(Self {
            receipt_id: text("receipt_id")?,
            tenant_id: text("tenant_id")?,
            effect_id: text("effect_id")?,
            event_id: text("event_id")?,
            correlation_id: text("correlation_id")?,
            stage,
            generation,
            writer_id: text("writer_id")?,
            owner_epoch,
            receipt_digest: receipt_digest.into(),
            observed_at: observed_at.into(),
        })
    }
}

/// Closed durable receipt append result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectReceiptAppendDecision {
    Append,
    Replay,
    Conflict,
    StaleWriter,
    InvalidTransition,
}

impl EffectReceiptAppendDecision {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Append => "append",
            Self::Replay => "replay",
            Self::Conflict => "conflict",
            Self::StaleWriter => "stale_writer",
            Self::InvalidTransition => "invalid_transition",
        }
    }
}

/// Replays the accepted/completed/state-observed compatibility decision.
///
/// Generation and owner epoch here are untrusted receipt fields, not write
/// authorization. A caller must not persist this result without the separate
/// same-transaction `PostgreSQL` Authority writer fence.
#[must_use]
pub fn decide_effect_receipt_append(
    history: &[EffectReceipt],
    candidate: &EffectReceipt,
) -> EffectReceiptAppendDecision {
    if !valid_history(history) {
        return EffectReceiptAppendDecision::InvalidTransition;
    }
    if history.is_empty() {
        return if candidate.stage == EffectReceiptStage::Accepted {
            EffectReceiptAppendDecision::Append
        } else {
            EffectReceiptAppendDecision::InvalidTransition
        };
    }
    let current = ordered_history(history);
    let Some(head) = current.last() else {
        return EffectReceiptAppendDecision::InvalidTransition;
    };
    if candidate.tenant_id != head.tenant_id || candidate.effect_id != head.effect_id {
        return EffectReceiptAppendDecision::Conflict;
    }
    if candidate.generation < head.generation || candidate.owner_epoch < head.owner_epoch {
        return EffectReceiptAppendDecision::StaleWriter;
    }
    if candidate.owner_epoch == head.owner_epoch && candidate.writer_id != head.writer_id {
        return EffectReceiptAppendDecision::Conflict;
    }
    if candidate.generation > head.generation {
        return if candidate.stage == EffectReceiptStage::Accepted {
            EffectReceiptAppendDecision::Append
        } else {
            EffectReceiptAppendDecision::InvalidTransition
        };
    }
    if let Some(existing) = current
        .iter()
        .find(|receipt| receipt.stage == candidate.stage)
    {
        return if *existing == candidate {
            EffectReceiptAppendDecision::Replay
        } else {
            EffectReceiptAppendDecision::Conflict
        };
    }
    if candidate.stage.index() == current.len() {
        EffectReceiptAppendDecision::Append
    } else {
        EffectReceiptAppendDecision::InvalidTransition
    }
}

/// Maps untrusted JSON values to the current TypeScript append decision.
/// Shape errors are `invalid_transition`; only validated receipts reach the
/// typed transition helper.
#[must_use]
pub fn decide_effect_receipt_value_append(
    history: &[Value],
    candidate: &Value,
) -> EffectReceiptAppendDecision {
    if history.len() > 3 {
        return EffectReceiptAppendDecision::InvalidTransition;
    }
    let Ok(candidate) = EffectReceipt::try_from(candidate) else {
        return EffectReceiptAppendDecision::InvalidTransition;
    };
    let history: Result<Vec<_>, _> = history.iter().map(EffectReceipt::try_from).collect();
    let Ok(history) = history else {
        return EffectReceiptAppendDecision::InvalidTransition;
    };
    decide_effect_receipt_append(&history, &candidate)
}

/// Parses bounded raw JSON receipt documents and maps invalid Unicode,
/// malformed JSON and shape failures to the current `invalid_transition`
/// decision.
#[must_use]
pub fn decide_effect_receipt_json_append(
    history: &[&str],
    candidate: &str,
) -> EffectReceiptAppendDecision {
    if history.len() > 3
        || candidate.len() > MAX_RECEIPT_DOCUMENT_BYTES
        || history
            .iter()
            .any(|document| document.len() > MAX_RECEIPT_DOCUMENT_BYTES)
    {
        return EffectReceiptAppendDecision::InvalidTransition;
    }
    let Ok(candidate) = serde_json::from_str::<Value>(candidate) else {
        return EffectReceiptAppendDecision::InvalidTransition;
    };
    let history: Result<Vec<_>, _> = history
        .iter()
        .map(|document| serde_json::from_str::<Value>(document))
        .collect();
    let Ok(history) = history else {
        return EffectReceiptAppendDecision::InvalidTransition;
    };
    decide_effect_receipt_value_append(&history, &candidate)
}

/// Returns whether a non-empty generation lacks a state-observed receipt or
/// contains an invalid sequence.
#[must_use]
pub fn effect_needs_reconcile(history: &[EffectReceipt]) -> bool {
    !history.is_empty()
        && (!valid_history(history)
            || ordered_history(history)
                .last()
                .is_none_or(|receipt| receipt.stage != EffectReceiptStage::StateObserved)
            || history.len() != 3)
}

/// Non-sensitive exact audit reference to one durable effect receipt.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[allow(
    clippy::struct_field_names,
    reason = "field names are the frozen cross-runtime audit wire contract"
)]
pub struct EffectAuditLink<'a> {
    tenant_id: &'a str,
    effect_id: &'a str,
    event_id: &'a str,
    receipt_id: &'a str,
    correlation_id: &'a str,
}

/// Projects only receipt identities; raw effect payload or credentials cannot
/// be added by a caller.
#[must_use]
pub const fn create_effect_audit_link(receipt: &EffectReceipt) -> EffectAuditLink<'_> {
    EffectAuditLink {
        tenant_id: &receipt.tenant_id,
        effect_id: &receipt.effect_id,
        event_id: &receipt.event_id,
        receipt_id: &receipt.receipt_id,
        correlation_id: &receipt.correlation_id,
    }
}

fn valid_history(history: &[EffectReceipt]) -> bool {
    if history.len() > 3 {
        return false;
    }
    let current = ordered_history(history);
    let Some(first) = current.first() else {
        return true;
    };
    let mut last_epoch = 0;
    for (index, receipt) in current.iter().enumerate() {
        if receipt.tenant_id != first.tenant_id
            || receipt.effect_id != first.effect_id
            || receipt.generation != first.generation
            || receipt.stage.index() != index
            || (index > 0 && receipt.owner_epoch < last_epoch)
        {
            return false;
        }
        last_epoch = receipt.owner_epoch;
    }
    true
}

fn ordered_history(history: &[EffectReceipt]) -> Vec<&EffectReceipt> {
    let mut current: Vec<_> = history.iter().collect();
    current.sort_unstable_by_key(|receipt| receipt.stage.index());
    current
}

fn valid_bounded_text(value: &str) -> bool {
    let mut count = 0;
    let mut first = None;
    let mut last = None;
    for unit in value.encode_utf16() {
        count += 1;
        if count > MAX_TEXT_UTF16_UNITS || matches!(unit, 0x0000..=0x001f | 0x007f) {
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

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}
