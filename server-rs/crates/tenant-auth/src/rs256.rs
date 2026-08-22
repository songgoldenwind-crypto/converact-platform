use std::fmt;

use ring::signature::RSA_PKCS1_2048_8192_SHA256;
use ring::signature::RsaPublicKeyComponents;

use super::{
    jwks::Rs256JwksSnapshot,
    jwt::{
        AuthenticatedPlatformIdentity, PlatformJwtPolicy, PlatformTokenVerificationError,
        PlatformTokenVerifierConfigError, decode_canonical_base64url, decode_header,
        split_compact_token,
    },
};

/// One inert external-RS256 verifier backed by an immutable public-key
/// snapshot. Fetching, refresh, clocks and runtime routing remain caller-owned.
pub struct Rs256PlatformTokenVerifier {
    keys: Rs256JwksSnapshot,
    policy: PlatformJwtPolicy,
}

impl Rs256PlatformTokenVerifier {
    /// Creates a verifier from an already validated public-key snapshot and
    /// normalized platform policy values.
    ///
    /// # Errors
    ///
    /// Rejects malformed policy text and out-of-range policy or revocation epochs.
    pub fn new(
        keys: Rs256JwksSnapshot,
        expected_issuer: &str,
        expected_audience: &str,
        current_policy_version: u64,
        current_revocation_epoch: u64,
    ) -> Result<Self, PlatformTokenVerifierConfigError> {
        let policy = PlatformJwtPolicy::new(
            expected_issuer,
            expected_audience,
            None,
            current_policy_version,
            current_revocation_epoch,
        )?;
        Ok(Self { keys, policy })
    }

    /// Verifies one canonical compact RS256 token against the immutable key
    /// snapshot and applies the frozen platform identity policy.
    ///
    /// # Errors
    ///
    /// Returns a stable closed error for malformed encoding, key selection,
    /// signature, claim binding or policy denial.
    pub fn verify(
        &self,
        token: &str,
        wall_now_epoch_ms: i64,
    ) -> Result<AuthenticatedPlatformIdentity, PlatformTokenVerificationError> {
        let [header_raw, payload_raw, signature_raw] = split_compact_token(token)?;
        let header = decode_header(header_raw)?;
        if header.alg != "RS256" || header.typ != "JWT" {
            return Err(PlatformTokenVerificationError::HeaderInvalid);
        }
        let key = self
            .keys
            .key_components(&header.kid)
            .ok_or(PlatformTokenVerificationError::HeaderInvalid)?;
        let signature = decode_canonical_base64url(signature_raw)?;
        if signature.len() != key.modulus().len() {
            return Err(PlatformTokenVerificationError::SignatureInvalid);
        }

        let signing_input_len = header_raw.len() + 1 + payload_raw.len();
        let signing_input = token
            .as_bytes()
            .get(..signing_input_len)
            .ok_or(PlatformTokenVerificationError::EncodingInvalid)?;
        let exponent = key.exponent().to_be_bytes();
        let first = exponent
            .iter()
            .position(|byte| *byte != 0)
            .ok_or(PlatformTokenVerificationError::SignatureInvalid)?;
        RsaPublicKeyComponents {
            n: key.modulus(),
            e: &exponent[first..],
        }
        .verify(&RSA_PKCS1_2048_8192_SHA256, signing_input, &signature)
        .map_err(|_| PlatformTokenVerificationError::SignatureInvalid)?;

        self.policy
            .verify_claims(payload_raw, &header.kid, wall_now_epoch_ms)
    }
}

impl fmt::Debug for Rs256PlatformTokenVerifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Rs256PlatformTokenVerifier([REDACTED])")
    }
}
