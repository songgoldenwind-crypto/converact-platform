//! Tenant-scoped platform identity policy.

#![forbid(unsafe_code)]

use std::{collections::HashSet, error::Error, fmt};

pub use converact_contracts::parse_canonical_timestamp_ms;
use serde::{Deserialize, Serialize, de::Error as _};
use serde_json::value::RawValue;

mod hs256;

pub use hs256::{
    AuthenticatedPlatformIdentity, Hs256PlatformTokenVerifier, PlatformIdentityRole,
    PlatformTokenVerificationError, PlatformTokenVerifierConfigError,
};

const MAX_TEXT_UTF16_UNITS: usize = 256;
const MAX_STRING_SET_ITEMS: usize = 64;
// Large enough for every currently valid bounded claim set, while bounding
// parser allocation and work before field-level policy validation.
const MAX_CLAIMS_PROJECTION_BYTES: usize = 512 * 1024;
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const JS_MAX_SAFE_INTEGER_F64: f64 = 9_007_199_254_740_991.0;
const JS_DATE_LIMIT_MS: i64 = 8_640_000_000_000_000;

#[derive(Clone, Copy, Eq, PartialEq)]
struct JsNonNegativeSafeInteger(u64);

impl JsNonNegativeSafeInteger {
    const fn value(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for JsNonNegativeSafeInteger {
    fn deserialize<Deserializer>(deserializer: Deserializer) -> Result<Self, Deserializer::Error>
    where
        Deserializer: serde::Deserializer<'de>,
    {
        // Preserve the lexical number. serde_json's normal f64 path does not
        // make the same boundary rounding decision as JSON.parse for every
        // decimal immediately below 2^53.
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        let value = raw
            .get()
            .parse::<f64>()
            .map_err(|_| Deserializer::Error::custom("value is not a JSON number"))?;
        js_non_negative_safe_integer(value)
            .map(JsNonNegativeSafeInteger)
            .ok_or_else(|| {
                Deserializer::Error::custom("number is not a non-negative JavaScript safe integer")
            })
    }
}

fn js_non_negative_safe_integer(value: f64) -> Option<u64> {
    if !value.is_finite()
        || !(0.0..=JS_MAX_SAFE_INTEGER_F64).contains(&value)
        || value.fract() != 0.0
    {
        return None;
    }
    // The checks above prove the cast is non-negative, integral and within
    // the exact shared f64/u64 range.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let integer = value as u64;
    Some(integer)
}

/// JavaScript-compatible UTF-16 text used while replaying the current policy.
/// It can represent a signed claim containing an unpaired surrogate;
/// conversions required to produce Unicode fail closed.
#[derive(Clone, Eq, Hash, PartialEq)]
struct JsText(Box<[u16]>);

impl JsText {
    #[must_use]
    fn from_utf16_units(units: Vec<u16>) -> Self {
        Self(units.into_boxed_slice())
    }

    fn units(&self) -> &[u16] {
        &self.0
    }

    fn equals_ascii(&self, value: &str) -> bool {
        self.0.iter().copied().eq(value.encode_utf16())
    }

    fn to_unicode_string(&self) -> Option<String> {
        String::from_utf16(&self.0).ok()
    }
}

impl From<String> for JsText {
    fn from(value: String) -> Self {
        Self::from_utf16_units(value.encode_utf16().collect())
    }
}

impl From<&str> for JsText {
    fn from(value: &str) -> Self {
        Self::from_utf16_units(value.encode_utf16().collect())
    }
}

impl<'de> Deserialize<'de> for JsText {
    fn deserialize<Deserializer>(deserializer: Deserializer) -> Result<Self, Deserializer::Error>
    where
        Deserializer: serde::Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Into::into)
    }
}

/// Claims after signature and key verification but before resource policy.
///
/// String-valued enums remain strings here so malformed claims produce the
/// stable `claims_invalid` decision instead of escaping as a deserializer
/// error at a different boundary.
#[derive(Clone, Deserialize, Eq, PartialEq)]
struct PolicyClaims {
    tenant_id: JsText,
    identity_id: JsText,
    identity_kind: JsText,
    session_id: JsText,
    token_id: JsText,
    issuer: JsText,
    audience: Vec<JsText>,
    key_id: JsText,
    issued_at: JsText,
    not_before: JsText,
    expires_at: JsText,
    policy_version: JsNonNegativeSafeInteger,
    revocation_epoch: JsNonNegativeSafeInteger,
    role: JsText,
    capabilities: Vec<JsText>,
    purpose: Vec<JsText>,
    credential_strength: JsText,
}

/// Stable closed projection parsing failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClaimsProjectionError {
    Invalid,
}

impl fmt::Display for ClaimsProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("platform_identity_claims_projection_invalid")
    }
}

impl Error for ClaimsProjectionError {}

/// Validates the current internal policy projection without granting
/// authenticity or exposing a value that can be promoted to an
/// allow-producing request. Extra projection fields remain ignored for exact
/// TypeScript compatibility; the future JWT authority boundary is separately
/// closed and versioned.
///
/// # Errors
///
/// Missing, incorrectly typed or policy-invalid required fields and documents
/// larger than the bounded projection envelope map to one stable error.
pub fn validate_claims_projection_json(document: &str) -> Result<(), ClaimsProjectionError> {
    let claims = parse_policy_claims_json(document)?;
    valid_claims(&claims)
        .map(|_| ())
        .ok_or(ClaimsProjectionError::Invalid)
}

fn parse_policy_claims_json(document: &str) -> Result<PolicyClaims, ClaimsProjectionError> {
    if document.len() > MAX_CLAIMS_PROJECTION_BYTES {
        return Err(ClaimsProjectionError::Invalid);
    }
    serde_json::from_str(document).map_err(|_| ClaimsProjectionError::Invalid)
}

/// Opaque claims produced only after a future in-crate signature/issuer/key
/// verifier succeeds. This slice intentionally exposes no constructor.
pub struct VerifiedPlatformIdentityClaims(PolicyClaims);

/// Exact tenant/resource policy inputs. The wall clock is Unix milliseconds;
/// callers derive monotonic deadlines separately.
pub struct AccessRequest {
    claims: VerifiedPlatformIdentityClaims,
    resource_tenant_id: JsText,
    required_audience: JsText,
    required_capability: JsText,
    required_purpose: JsText,
    current_policy_version: u64,
    current_revocation_epoch: u64,
    wall_now_epoch_ms: i64,
}

/// Stable fail-closed reason compatible with the current TypeScript policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DenialReason {
    ClaimsInvalid,
    TenantMismatch,
    AudienceMismatch,
    CapabilityDenied,
    PurposeDenied,
    NotYetValid,
    Expired,
    StalePolicy,
    StaleRevocation,
    StrongServiceIdentityRequired,
}

/// Closed access decision wire shape.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct AccessDecision {
    allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<DenialReason>,
}

impl AccessDecision {
    #[must_use]
    pub const fn allowed(self) -> bool {
        self.allowed
    }

    #[must_use]
    pub const fn reason(self) -> Option<DenialReason> {
        self.reason
    }
}

/// Applies the current tenant/audience/capability/purpose and epoch policy.
/// Signature, issuer and key verification must complete before this function.
#[must_use]
pub fn evaluate_platform_access(input: &AccessRequest) -> AccessDecision {
    let claims = &input.claims.0;
    let Some((issued_at, not_before, expires_at)) = valid_claims(claims) else {
        return deny(DenialReason::ClaimsInvalid);
    };
    if !bounded_text(&input.resource_tenant_id)
        || !bounded_text(&input.required_audience)
        || !bounded_text(&input.required_capability)
        || !bounded_text(&input.required_purpose)
        || !positive_safe_integer(input.current_policy_version)
        || !non_negative_safe_integer(input.current_revocation_epoch)
        || input.wall_now_epoch_ms.unsigned_abs() > JS_DATE_LIMIT_MS.unsigned_abs()
    {
        return deny(DenialReason::ClaimsInvalid);
    }
    if claims.tenant_id != input.resource_tenant_id {
        return deny(DenialReason::TenantMismatch);
    }
    if !claims.audience.contains(&input.required_audience) {
        return deny(DenialReason::AudienceMismatch);
    }
    if !claims.capabilities.contains(&input.required_capability) {
        return deny(DenialReason::CapabilityDenied);
    }
    if !claims.purpose.contains(&input.required_purpose) {
        return deny(DenialReason::PurposeDenied);
    }
    if issued_at > input.wall_now_epoch_ms || not_before > input.wall_now_epoch_ms {
        return deny(DenialReason::NotYetValid);
    }
    if expires_at <= input.wall_now_epoch_ms {
        return deny(DenialReason::Expired);
    }
    if claims.policy_version.value() != input.current_policy_version {
        return deny(DenialReason::StalePolicy);
    }
    if claims.revocation_epoch.value() != input.current_revocation_epoch {
        return deny(DenialReason::StaleRevocation);
    }
    if !claims.identity_kind.equals_ascii("human")
        && !claims.credential_strength.equals_ascii("mtls")
    {
        return deny(DenialReason::StrongServiceIdentityRequired);
    }
    AccessDecision {
        allowed: true,
        reason: None,
    }
}

fn valid_claims(claims: &PolicyClaims) -> Option<(i64, i64, i64)> {
    for field in [
        &claims.tenant_id,
        &claims.identity_id,
        &claims.session_id,
        &claims.token_id,
        &claims.issuer,
        &claims.key_id,
        &claims.role,
    ] {
        if !bounded_text(field) {
            return None;
        }
    }
    if !["human", "service", "workload", "edge", "provider"]
        .iter()
        .any(|kind| claims.identity_kind.equals_ascii(kind))
        || !["signed_token", "mtls"]
            .iter()
            .any(|strength| claims.credential_strength.equals_ascii(strength))
        || !bounded_string_set(&claims.audience)
        || !bounded_string_set(&claims.capabilities)
        || !bounded_string_set(&claims.purpose)
        || !positive_safe_integer(claims.policy_version.value())
        || !non_negative_safe_integer(claims.revocation_epoch.value())
    {
        return None;
    }
    let issued_at = parse_canonical_timestamp_ms(&claims.issued_at.to_unicode_string()?)?;
    let not_before = parse_canonical_timestamp_ms(&claims.not_before.to_unicode_string()?)?;
    let expires_at = parse_canonical_timestamp_ms(&claims.expires_at.to_unicode_string()?)?;
    (issued_at <= not_before && not_before < expires_at)
        .then_some((issued_at, not_before, expires_at))
}

fn bounded_string_set(values: &[JsText]) -> bool {
    if values.is_empty() || values.len() > MAX_STRING_SET_ITEMS {
        return false;
    }
    let mut unique = HashSet::with_capacity(values.len());
    values
        .iter()
        .all(|value| bounded_text(value) && unique.insert(value.units()))
}

fn bounded_text(value: &JsText) -> bool {
    !value.units().is_empty()
        && value.units().len() <= MAX_TEXT_UTF16_UNITS
        && value
            .units()
            .iter()
            .all(|unit| !matches!(unit, 0x0000..=0x001f | 0x007f))
        && value.units().first().is_some_and(|item| !is_js_trim(*item))
        && value.units().last().is_some_and(|item| !is_js_trim(*item))
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

const fn positive_safe_integer(value: u64) -> bool {
    value >= 1 && value <= JS_MAX_SAFE_INTEGER
}

const fn non_negative_safe_integer(value: u64) -> bool {
    value <= JS_MAX_SAFE_INTEGER
}

const fn deny(reason: DenialReason) -> AccessDecision {
    AccessDecision {
        allowed: false,
        reason: Some(reason),
    }
}

#[cfg(test)]
mod tests;
