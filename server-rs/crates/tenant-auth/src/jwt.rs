use std::{error::Error, fmt};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use converact_contracts::format_canonical_timestamp_ms;
use serde::{Deserialize, de::Error as _};
use serde_json::value::RawValue;

use super::{
    AccessRequest, DenialReason, JS_MAX_SAFE_INTEGER_F64, JsNonNegativeSafeInteger, JsText,
    PolicyClaims, VerifiedPlatformIdentityClaims, bounded_string_set, bounded_text,
    evaluate_platform_access, non_negative_safe_integer, positive_safe_integer,
};

const MAX_PLATFORM_TOKEN_BYTES: usize = 65_536;

/// Invalid verifier configuration without exposing key or policy values.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PlatformTokenVerifierConfigError;

impl fmt::Display for PlatformTokenVerifierConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("platform_token_verifier_config_invalid")
    }
}

impl Error for PlatformTokenVerifierConfigError {}

/// Stable, value-free platform token verification failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlatformTokenVerificationError {
    EncodingInvalid,
    SignatureInvalid,
    HeaderInvalid,
    ClaimsInvalid,
    PolicyDenied(DenialReason),
}

impl PlatformTokenVerificationError {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::EncodingInvalid => "platform_token_encoding_invalid",
            Self::SignatureInvalid => "platform_token_signature_invalid",
            Self::HeaderInvalid => "platform_token_header_invalid",
            Self::ClaimsInvalid => "platform_token_claims_invalid",
            Self::PolicyDenied(_) => "platform_token_policy_denied",
        }
    }

    #[must_use]
    pub const fn denial_reason(self) -> Option<DenialReason> {
        match self {
            Self::PolicyDenied(reason) => Some(reason),
            _ => None,
        }
    }
}

impl fmt::Display for PlatformTokenVerificationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Error for PlatformTokenVerificationError {}

/// Closed role set returned only after signature and platform-policy checks.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlatformIdentityRole {
    Owner,
    Admin,
    Operator,
    Viewer,
    System,
}

impl PlatformIdentityRole {
    fn parse(value: &JsText) -> Option<Self> {
        [
            ("owner", Self::Owner),
            ("admin", Self::Admin),
            ("operator", Self::Operator),
            ("viewer", Self::Viewer),
            ("system", Self::System),
        ]
        .into_iter()
        .find_map(|(name, role)| value.equals_ascii(name).then_some(role))
    }
}

/// Bounded identity returned after signature, claim-binding and policy checks.
#[derive(Eq, PartialEq)]
pub struct AuthenticatedPlatformIdentity {
    tenant_id: Box<str>,
    identity_id: Box<str>,
    role: PlatformIdentityRole,
    expires_at_epoch_seconds: i64,
}

impl AuthenticatedPlatformIdentity {
    #[must_use]
    pub fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    #[must_use]
    pub fn identity_id(&self) -> &str {
        &self.identity_id
    }

    #[must_use]
    pub const fn role(&self) -> PlatformIdentityRole {
        self.role
    }

    #[must_use]
    pub const fn expires_at_epoch_seconds(&self) -> i64 {
        self.expires_at_epoch_seconds
    }
}

impl fmt::Debug for AuthenticatedPlatformIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AuthenticatedPlatformIdentity([REDACTED])")
    }
}

pub(super) struct PlatformJwtPolicy {
    expected_issuer: JsText,
    expected_audience: JsText,
    expected_key_id: Option<JsText>,
    current_policy_version: u64,
    current_revocation_epoch: u64,
}

impl PlatformJwtPolicy {
    pub(super) fn new(
        expected_issuer: &str,
        expected_audience: &str,
        expected_key_id: Option<&str>,
        current_policy_version: u64,
        current_revocation_epoch: u64,
    ) -> Result<Self, PlatformTokenVerifierConfigError> {
        let expected_issuer = JsText::from(expected_issuer);
        let expected_audience = JsText::from(expected_audience);
        let expected_key_id = expected_key_id.map(JsText::from);
        if !bounded_text(&expected_issuer)
            || !bounded_text(&expected_audience)
            || expected_key_id
                .as_ref()
                .is_some_and(|key| !bounded_text(key))
            || !positive_safe_integer(current_policy_version)
            || !non_negative_safe_integer(current_revocation_epoch)
        {
            return Err(PlatformTokenVerifierConfigError);
        }
        Ok(Self {
            expected_issuer,
            expected_audience,
            expected_key_id,
            current_policy_version,
            current_revocation_epoch,
        })
    }

    pub(super) fn configured_key_matches(&self, key_id: &str) -> bool {
        self.expected_key_id
            .as_ref()
            .is_some_and(|expected| *expected == JsText::from(key_id))
    }

    pub(super) fn verify_claims(
        &self,
        payload_raw: &str,
        verified_key_id: &str,
        wall_now_epoch_ms: i64,
    ) -> Result<AuthenticatedPlatformIdentity, PlatformTokenVerificationError> {
        let payload = decode_payload(payload_raw)?;
        let tenant_id = normalized_tenant(&payload)?;
        let role = PlatformIdentityRole::parse(&payload.role)
            .ok_or(PlatformTokenVerificationError::ClaimsInvalid)?;
        let verified_key_id = JsText::from(verified_key_id);
        self.verify_exact_claim_bindings(&payload, &tenant_id, &verified_key_id)?;

        let tenant_text = tenant_id
            .to_unicode_string()
            .ok_or(PlatformTokenVerificationError::ClaimsInvalid)?;
        let identity_text = payload
            .identity_id
            .to_unicode_string()
            .ok_or(PlatformTokenVerificationError::ClaimsInvalid)?;
        let expires_at_epoch_seconds = payload.exp.value();
        let claims = VerifiedPlatformIdentityClaims(payload.into_policy_claims(tenant_id));
        let request = AccessRequest {
            claims,
            resource_tenant_id: JsText::from(tenant_text.as_str()),
            required_audience: self.expected_audience.clone(),
            required_capability: JsText::from("platform.api"),
            required_purpose: JsText::from("product_operation"),
            current_policy_version: self.current_policy_version,
            current_revocation_epoch: self.current_revocation_epoch,
            wall_now_epoch_ms,
        };
        let decision = evaluate_platform_access(&request);
        if let Some(reason) = decision.reason() {
            return Err(PlatformTokenVerificationError::PolicyDenied(reason));
        }
        Ok(AuthenticatedPlatformIdentity {
            tenant_id: tenant_text.into(),
            identity_id: identity_text.into(),
            role,
            expires_at_epoch_seconds,
        })
    }

    fn verify_exact_claim_bindings(
        &self,
        payload: &TokenPayload,
        tenant_id: &JsText,
        verified_key_id: &JsText,
    ) -> Result<(), PlatformTokenVerificationError> {
        if !bounded_text(verified_key_id)
            || payload.sub != payload.identity_id
            || payload.iss != self.expected_issuer
            || payload.issuer != self.expected_issuer
            || payload.key_id != *verified_key_id
            || self
                .expected_key_id
                .as_ref()
                .is_some_and(|expected| payload.key_id != *expected)
            || !payload.credential_strength.equals_ascii("signed_token")
            || !same_bounded_string_set(&payload.aud, &payload.audience)
            || !timestamp_matches(payload.iat.value(), &payload.issued_at)
            || !timestamp_matches(payload.nbf.value(), &payload.not_before)
            || !timestamp_matches(payload.exp.value(), &payload.expires_at)
            || payload.tid.as_ref().is_some_and(|value| value != tenant_id)
            || payload
                .tenant_id
                .as_ref()
                .is_some_and(|value| value != tenant_id)
        {
            return Err(PlatformTokenVerificationError::ClaimsInvalid);
        }
        Ok(())
    }
}

impl fmt::Debug for PlatformJwtPolicy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PlatformJwtPolicy([REDACTED])")
    }
}

#[derive(Deserialize)]
pub(super) struct CompactJwtHeader {
    pub(super) alg: String,
    pub(super) typ: String,
    pub(super) kid: String,
}

#[derive(Deserialize)]
struct TokenPayload {
    sub: JsText,
    tid: Option<JsText>,
    tenant_id: Option<JsText>,
    identity_id: JsText,
    identity_kind: JsText,
    session_id: JsText,
    token_id: JsText,
    iss: JsText,
    issuer: JsText,
    aud: Vec<JsText>,
    audience: Vec<JsText>,
    key_id: JsText,
    role: JsText,
    iat: JsSafeInteger,
    nbf: JsSafeInteger,
    exp: JsSafeInteger,
    issued_at: JsText,
    not_before: JsText,
    expires_at: JsText,
    policy_version: JsNonNegativeSafeInteger,
    revocation_epoch: JsNonNegativeSafeInteger,
    capabilities: Vec<JsText>,
    purpose: Vec<JsText>,
    credential_strength: JsText,
}

impl TokenPayload {
    fn into_policy_claims(self, tenant_id: JsText) -> PolicyClaims {
        PolicyClaims {
            tenant_id,
            identity_id: self.identity_id,
            identity_kind: self.identity_kind,
            session_id: self.session_id,
            token_id: self.token_id,
            issuer: self.issuer,
            audience: self.audience,
            key_id: self.key_id,
            issued_at: self.issued_at,
            not_before: self.not_before,
            expires_at: self.expires_at,
            policy_version: self.policy_version,
            revocation_epoch: self.revocation_epoch,
            role: self.role,
            capabilities: self.capabilities,
            purpose: self.purpose,
            credential_strength: self.credential_strength,
        }
    }
}

#[derive(Clone, Copy)]
struct JsSafeInteger(i64);

impl JsSafeInteger {
    const fn value(self) -> i64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for JsSafeInteger {
    fn deserialize<Deserializer>(deserializer: Deserializer) -> Result<Self, Deserializer::Error>
    where
        Deserializer: serde::Deserializer<'de>,
    {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        let value = raw
            .get()
            .parse::<f64>()
            .map_err(|_| Deserializer::Error::custom("value is not a JSON number"))?;
        if !value.is_finite()
            || !(-JS_MAX_SAFE_INTEGER_F64..=JS_MAX_SAFE_INTEGER_F64).contains(&value)
            || value.fract() != 0.0
        {
            return Err(Deserializer::Error::custom(
                "number is not a JavaScript safe integer",
            ));
        }
        #[allow(clippy::cast_possible_truncation)]
        Ok(Self(value as i64))
    }
}

pub(super) fn split_compact_token(
    token: &str,
) -> Result<[&str; 3], PlatformTokenVerificationError> {
    if token.is_empty() || token.len() > MAX_PLATFORM_TOKEN_BYTES {
        return Err(PlatformTokenVerificationError::EncodingInvalid);
    }
    let mut parts = token.split('.');
    let result = [
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    ];
    if result.iter().any(|part| part.is_empty()) || parts.next().is_some() {
        return Err(PlatformTokenVerificationError::EncodingInvalid);
    }
    Ok(result)
}

pub(super) fn decode_canonical_base64url(
    input: &str,
) -> Result<Vec<u8>, PlatformTokenVerificationError> {
    if input.is_empty()
        || !input
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(PlatformTokenVerificationError::EncodingInvalid);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(input)
        .map_err(|_| PlatformTokenVerificationError::EncodingInvalid)?;
    if URL_SAFE_NO_PAD.encode(&bytes) != input {
        return Err(PlatformTokenVerificationError::EncodingInvalid);
    }
    Ok(bytes)
}

pub(super) fn decode_header(
    input: &str,
) -> Result<CompactJwtHeader, PlatformTokenVerificationError> {
    let bytes = decode_canonical_base64url(input)?;
    serde_json::from_slice(&bytes).map_err(|_| PlatformTokenVerificationError::HeaderInvalid)
}

fn decode_payload(input: &str) -> Result<TokenPayload, PlatformTokenVerificationError> {
    let bytes = decode_canonical_base64url(input)?;
    serde_json::from_slice(&bytes).map_err(|_| PlatformTokenVerificationError::ClaimsInvalid)
}

fn normalized_tenant(payload: &TokenPayload) -> Result<JsText, PlatformTokenVerificationError> {
    payload
        .tenant_id
        .as_ref()
        .filter(|value| !value.units().is_empty())
        .or_else(|| {
            payload
                .tid
                .as_ref()
                .filter(|value| !value.units().is_empty())
        })
        .cloned()
        .ok_or(PlatformTokenVerificationError::ClaimsInvalid)
}

fn same_bounded_string_set(left: &[JsText], right: &[JsText]) -> bool {
    bounded_string_set(left)
        && bounded_string_set(right)
        && left.len() == right.len()
        && left.iter().all(|value| right.contains(value))
}

fn timestamp_matches(epoch_seconds: i64, canonical: &JsText) -> bool {
    epoch_seconds
        .checked_mul(1_000)
        .and_then(format_canonical_timestamp_ms)
        .is_some_and(|expected| canonical.to_unicode_string().as_deref() == Some(&expected))
}
