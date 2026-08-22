use std::{
    error::Error,
    fmt,
    net::{IpAddr, Ipv6Addr},
    str::FromStr,
};

use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use sha2_11::Sha256;

use super::is_ecmascript_trim_character;

const KEY_BYTES: usize = 32;
const KEY_BASE64_UNPADDED_BYTES: usize = 43;

/// Stable closed error at the source-IP privacy boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuditIpHmacError {
    /// The base64 key is not the exact encoding of 32 bytes.
    InvalidKey,
    /// The first forwarded value is not an IP address after ECMAScript trim.
    InvalidSourceIp,
}

impl AuditIpHmacError {
    /// Returns the stable machine-readable reason.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidKey => "audit_ip_hmac_key_invalid",
            Self::InvalidSourceIp => "audit_source_ip_invalid",
        }
    }
}

impl fmt::Display for AuditIpHmacError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Error for AuditIpHmacError {}

/// Opaque 256-bit key used only to pseudonymize audit source IP addresses.
pub struct AuditIpHmacKey([u8; KEY_BYTES]);

impl AuditIpHmacKey {
    /// Parses the exact base64 key contract accepted by the active TypeScript service.
    ///
    /// # Errors
    ///
    /// Returns [`AuditIpHmacError::InvalidKey`] unless the input is the standard
    /// base64 encoding of exactly 32 bytes. Missing or surplus trailing padding
    /// is accepted to preserve the current Node.js boundary.
    pub fn parse_base64(value: &str) -> Result<Self, AuditIpHmacError> {
        let unpadded = value.trim_end_matches('=');
        if unpadded.len() != KEY_BASE64_UNPADDED_BYTES {
            return Err(AuditIpHmacError::InvalidKey);
        }
        let bytes = STANDARD_NO_PAD
            .decode(unpadded)
            .map_err(|_| AuditIpHmacError::InvalidKey)?;
        let key: [u8; KEY_BYTES] = bytes.try_into().map_err(|_| AuditIpHmacError::InvalidKey)?;
        if STANDARD_NO_PAD.encode(key) != unpadded {
            return Err(AuditIpHmacError::InvalidKey);
        }
        Ok(Self(key))
    }
}

impl fmt::Debug for AuditIpHmacKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AuditIpHmacKey([REDACTED])")
    }
}

/// Produces the opaque audit source-IP digest used by the current service.
///
/// Only the first comma-separated value is considered. Its original textual
/// form is preserved apart from ECMAScript trim and ASCII lowercase so that
/// expanded IPv6 spellings and Node.js scope IDs remain compatible with the
/// active TypeScript hash.
///
/// # Errors
///
/// Returns [`AuditIpHmacError::InvalidSourceIp`] when a non-empty input does
/// not contain a valid first IP address.
pub fn audit_source_ip_hmac(
    source_ip: Option<&str>,
    key: &AuditIpHmacKey,
) -> Result<String, AuditIpHmacError> {
    let Some(source_ip) = source_ip else {
        return Ok(String::new());
    };
    if source_ip.is_empty() {
        return Ok(String::new());
    }

    let first = source_ip.split(',').next().unwrap_or_default();
    let normalized = first.trim_matches(is_ecmascript_trim_character);
    if !valid_node_ip(normalized) {
        return Err(AuditIpHmacError::InvalidSourceIp);
    }
    let normalized = normalized.to_ascii_lowercase();

    let mut hmac = <Hmac<Sha256> as KeyInit>::new_from_slice(&key.0)
        .map_err(|_| AuditIpHmacError::InvalidKey)?;
    hmac.update(normalized.as_bytes());
    Ok(hex::encode(hmac.finalize().into_bytes()))
}

fn valid_node_ip(value: &str) -> bool {
    if IpAddr::from_str(value).is_ok() {
        return true;
    }
    let Some((address, zone)) = value.rsplit_once('%') else {
        return false;
    };
    !zone.is_empty()
        && zone
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b':'))
        && Ipv6Addr::from_str(address).is_ok()
}
