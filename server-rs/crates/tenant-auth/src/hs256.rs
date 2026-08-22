use std::fmt;

use hmac::{Hmac, KeyInit, Mac};
use sha2_11::Sha256;

use super::jwt::{
    AuthenticatedPlatformIdentity, PlatformJwtPolicy, PlatformTokenVerificationError,
    PlatformTokenVerifierConfigError, decode_canonical_base64url, decode_header,
    split_compact_token,
};

const MAX_HS256_SECRET_BYTES: usize = 4_096;
const HMAC_SHA256_BYTES: usize = 32;

/// One inert local-HS256 verifier. It owns no clock, key loader or runtime
/// route; callers supply the exact wall clock for deterministic policy checks.
pub struct Hs256PlatformTokenVerifier {
    secret: Box<[u8]>,
    policy: PlatformJwtPolicy,
}

impl Hs256PlatformTokenVerifier {
    /// Creates a bounded verifier from an already-loaded UTF-8 secret and
    /// normalized platform policy values.
    ///
    /// # Errors
    ///
    /// Rejects empty/oversized secrets, malformed policy text and unsafe
    /// policy or revocation epochs.
    pub fn new(
        secret: &str,
        expected_issuer: &str,
        expected_audience: &str,
        expected_key_id: &str,
        current_policy_version: u64,
        current_revocation_epoch: u64,
    ) -> Result<Self, PlatformTokenVerifierConfigError> {
        if secret.is_empty() || secret.len() > MAX_HS256_SECRET_BYTES {
            return Err(PlatformTokenVerifierConfigError);
        }
        let policy = PlatformJwtPolicy::new(
            expected_issuer,
            expected_audience,
            Some(expected_key_id),
            current_policy_version,
            current_revocation_epoch,
        )?;
        Ok(Self {
            secret: secret.as_bytes().into(),
            policy,
        })
    }

    /// Verifies one canonical compact HS256 token and applies the frozen
    /// platform identity policy.
    ///
    /// # Errors
    ///
    /// Returns a stable closed error for malformed encoding, signature,
    /// header, claim binding or policy denial.
    pub fn verify(
        &self,
        token: &str,
        wall_now_epoch_ms: i64,
    ) -> Result<AuthenticatedPlatformIdentity, PlatformTokenVerificationError> {
        let [header_raw, payload_raw, signature_raw] = split_compact_token(token)?;
        self.verify_signature(header_raw, payload_raw, signature_raw)?;
        let header = decode_header(header_raw)?;
        if header.alg != "HS256"
            || header.typ != "JWT"
            || !self.policy.configured_key_matches(&header.kid)
        {
            return Err(PlatformTokenVerificationError::HeaderInvalid);
        }
        self.policy
            .verify_claims(payload_raw, &header.kid, wall_now_epoch_ms)
    }

    fn verify_signature(
        &self,
        header_raw: &str,
        payload_raw: &str,
        signature_raw: &str,
    ) -> Result<(), PlatformTokenVerificationError> {
        let signature = decode_canonical_base64url(signature_raw)?;
        if signature.len() != HMAC_SHA256_BYTES {
            return Err(PlatformTokenVerificationError::SignatureInvalid);
        }
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&self.secret)
            .map_err(|_| PlatformTokenVerificationError::SignatureInvalid)?;
        mac.update(header_raw.as_bytes());
        mac.update(b".");
        mac.update(payload_raw.as_bytes());
        mac.verify_slice(&signature)
            .map_err(|_| PlatformTokenVerificationError::SignatureInvalid)
    }
}

impl fmt::Debug for Hs256PlatformTokenVerifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Hs256PlatformTokenVerifier([REDACTED])")
    }
}
