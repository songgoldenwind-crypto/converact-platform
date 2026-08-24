use std::{collections::HashSet, error::Error, fmt};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;

const MAX_JWKS_DOCUMENT_BYTES: usize = 131_072;
const MAX_JWKS_KEYS: usize = 64;
const MIN_MODULUS_BYTES: usize = 256;
// The active wire contract caps the encoded modulus at 1,024 characters,
// which permits at most a 6,144-bit canonical modulus.
const MAX_MODULUS_BYTES: usize = 768;
const MIN_ENCODED_MODULUS_BYTES: usize = 64;
const MAX_ENCODED_MODULUS_BYTES: usize = 1_024;
const MAX_ENCODED_EXPONENT_BYTES: usize = 16;

/// Stable, value-free failure for a malformed or cryptographically unusable
/// RS256 JSON Web Key Set snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Rs256JwksError;

impl fmt::Display for Rs256JwksError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("platform_rs256_jwks_invalid")
    }
}

impl Error for Rs256JwksError {}

/// One immutable, bounded set of cryptographically usable RS256 public keys.
/// Fetching, freshness and refresh scheduling belong to the runtime adapter,
/// not this deterministic parser.
#[derive(Eq, PartialEq)]
pub struct Rs256JwksSnapshot {
    keys: Box<[Rs256PublicKey]>,
}

/// Borrowed vendor-neutral RSA public-key components for a signature provider.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct Rs256PublicKeyComponents<'a> {
    modulus: &'a [u8],
    exponent: u32,
}

impl Rs256PublicKeyComponents<'_> {
    #[must_use]
    pub const fn modulus(&self) -> &[u8] {
        self.modulus
    }

    #[must_use]
    pub const fn exponent(&self) -> u32 {
        self.exponent
    }
}

impl fmt::Debug for Rs256PublicKeyComponents<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Rs256PublicKeyComponents([REDACTED])")
    }
}

impl Rs256JwksSnapshot {
    /// Parses one complete bounded JWKS response.
    ///
    /// # Errors
    ///
    /// Rejects oversized JSON, invalid key counts, duplicate identifiers,
    /// unsupported metadata and RSA parameters outside the target policy.
    pub fn parse_json(document: &str) -> Result<Self, Rs256JwksError> {
        if document.is_empty() || document.len() > MAX_JWKS_DOCUMENT_BYTES {
            return Err(Rs256JwksError);
        }
        let document: JwksDocument = serde_json::from_str(document).map_err(|_| Rs256JwksError)?;
        if document.keys.is_empty() || document.keys.len() > MAX_JWKS_KEYS {
            return Err(Rs256JwksError);
        }

        let mut seen = HashSet::with_capacity(document.keys.len());
        let mut keys = Vec::with_capacity(document.keys.len());
        for candidate in document.keys {
            if !valid_key_id(&candidate.kid) || !seen.insert(candidate.kid.clone()) {
                return Err(Rs256JwksError);
            }
            keys.push(parse_key(candidate)?);
        }
        Ok(Self {
            keys: keys.into_boxed_slice(),
        })
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.keys.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// Performs one bounded exact key-id lookup over at most 64 keys.
    #[must_use]
    pub fn contains_key(&self, key_id: &str) -> bool {
        self.key_components(key_id).is_some()
    }

    /// Returns bounded public components without exposing a crypto-library
    /// type across the tenant-auth boundary.
    #[must_use]
    pub fn key_components(&self, key_id: &str) -> Option<Rs256PublicKeyComponents<'_>> {
        self.keys
            .iter()
            .find(|key| key.key_id.as_ref() == key_id)
            .map(|key| Rs256PublicKeyComponents {
                modulus: &key.modulus,
                exponent: key.exponent,
            })
    }
}

impl fmt::Debug for Rs256JwksSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Rs256JwksSnapshot(keys={})", self.keys.len())
    }
}

#[derive(Eq, PartialEq)]
struct Rs256PublicKey {
    key_id: Box<str>,
    modulus: Box<[u8]>,
    exponent: u32,
}

#[derive(Deserialize)]
struct JwksDocument {
    keys: Vec<JwkCandidate>,
}

#[derive(Deserialize)]
struct JwkCandidate {
    kty: String,
    kid: String,
    n: String,
    e: String,
    #[serde(rename = "use")]
    use_: Option<String>,
    alg: Option<String>,
    key_ops: Option<Vec<String>>,
}

fn parse_key(candidate: JwkCandidate) -> Result<Rs256PublicKey, Rs256JwksError> {
    if candidate.kty != "RSA"
        || candidate
            .use_
            .as_deref()
            .is_some_and(|value| value != "sig")
        || candidate
            .alg
            .as_deref()
            .is_some_and(|value| value != "RS256")
        || candidate
            .key_ops
            .as_deref()
            .is_some_and(|operations| operations != ["verify"])
        || !(MIN_ENCODED_MODULUS_BYTES..=MAX_ENCODED_MODULUS_BYTES).contains(&candidate.n.len())
        || candidate.e.is_empty()
        || candidate.e.len() > MAX_ENCODED_EXPONENT_BYTES
    {
        return Err(Rs256JwksError);
    }
    let modulus = decode_canonical_base64url(&candidate.n).ok_or(Rs256JwksError)?;
    if !(MIN_MODULUS_BYTES..=MAX_MODULUS_BYTES).contains(&modulus.len())
        || modulus.first().is_none_or(|byte| byte & 0x80 == 0)
        || modulus.last().is_none_or(|byte| byte & 1 == 0)
    {
        return Err(Rs256JwksError);
    }
    let exponent = decode_exponent(&candidate.e).ok_or(Rs256JwksError)?;
    Ok(Rs256PublicKey {
        key_id: candidate.kid.into_boxed_str(),
        modulus: modulus.into_boxed_slice(),
        exponent,
    })
}

fn decode_exponent(encoded: &str) -> Option<u32> {
    let bytes = decode_canonical_base64url(encoded)?;
    if bytes.is_empty() || bytes.len() > size_of::<u32>() || bytes.first() == Some(&0) {
        return None;
    }
    let value = bytes
        .into_iter()
        .fold(0_u32, |value, byte| (value << 8) | u32::from(byte));
    (value >= 3 && value & 1 == 1).then_some(value)
}

fn decode_canonical_base64url(input: &str) -> Option<Vec<u8>> {
    if input.is_empty()
        || !input
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(input).ok()?;
    (URL_SAFE_NO_PAD.encode(&bytes) == input).then_some(bytes)
}

pub(super) fn valid_key_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
        })
}
