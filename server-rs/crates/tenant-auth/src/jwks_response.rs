use std::{error::Error, fmt, str};

use super::jwks::Rs256JwksSnapshot;

const SUCCESS_STATUS: u16 = 200;
const MAX_RESPONSE_BYTES: usize = 131_072;
const MAX_CONTENT_TYPE_BYTES: usize = 256;
const MAX_CONTENT_LENGTH_BYTES: usize = 20;

/// Closed value-free failure for the JWKS HTTP response boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Rs256JwksResponseError {
    StatusRejected,
    ContentTypeRejected,
    ContentLengthInvalid,
    ContentLengthMismatch,
    BodyTooLarge,
    BodyInvalid,
}

impl Rs256JwksResponseError {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::StatusRejected => "platform_rs256_jwks_response_status_rejected",
            Self::ContentTypeRejected => "platform_rs256_jwks_response_content_type_rejected",
            Self::ContentLengthInvalid => "platform_rs256_jwks_response_content_length_invalid",
            Self::ContentLengthMismatch => "platform_rs256_jwks_response_content_length_mismatch",
            Self::BodyTooLarge => "platform_rs256_jwks_response_body_too_large",
            Self::BodyInvalid => "platform_rs256_jwks_response_body_invalid",
        }
    }
}

impl fmt::Display for Rs256JwksResponseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Error for Rs256JwksResponseError {}

/// Incrementally collects one successful JWKS response under a fixed memory
/// budget. Network cancellation remains the caller's responsibility whenever
/// `start` or `push_chunk` rejects input.
pub struct Rs256JwksResponseCollector {
    body: Vec<u8>,
    declared_length: Option<usize>,
}

impl Rs256JwksResponseCollector {
    /// Validates the response head before any body is consumed or allocated.
    ///
    /// # Errors
    ///
    /// Rejects every status except 200, missing or unsupported media types,
    /// non-canonical lengths, and declared bodies above 128 KiB.
    pub fn start(
        status: u16,
        content_type: Option<&str>,
        content_length: Option<&str>,
    ) -> Result<Self, Rs256JwksResponseError> {
        if status != SUCCESS_STATUS {
            return Err(Rs256JwksResponseError::StatusRejected);
        }
        if content_type.is_none_or(|value| !valid_content_type(value)) {
            return Err(Rs256JwksResponseError::ContentTypeRejected);
        }
        let declared_length = content_length.map(parse_content_length).transpose()?;
        let capacity = declared_length.unwrap_or(4_096);
        Ok(Self {
            body: Vec::with_capacity(capacity),
            declared_length,
        })
    }

    /// Appends one transport chunk without allowing the accumulated body or a
    /// declared body to be exceeded.
    ///
    /// # Errors
    ///
    /// Returns a closed error before copying a chunk that crosses either bound.
    pub fn push_chunk(&mut self, chunk: &[u8]) -> Result<(), Rs256JwksResponseError> {
        if chunk.len() > MAX_RESPONSE_BYTES - self.body.len() {
            return Err(Rs256JwksResponseError::BodyTooLarge);
        }
        let next_length = self.body.len() + chunk.len();
        if self
            .declared_length
            .is_some_and(|declared| next_length > declared)
        {
            return Err(Rs256JwksResponseError::ContentLengthMismatch);
        }
        self.body.extend_from_slice(chunk);
        Ok(())
    }

    /// Validates the final length, UTF-8 document and bounded RSA key set.
    ///
    /// # Errors
    ///
    /// Returns a closed error for truncated bodies, invalid UTF-8/JSON or a
    /// cryptographically unusable key set.
    pub fn finish(self) -> Result<Rs256JwksSnapshot, Rs256JwksResponseError> {
        if self
            .declared_length
            .is_some_and(|declared| declared != self.body.len())
        {
            return Err(Rs256JwksResponseError::ContentLengthMismatch);
        }
        let document =
            str::from_utf8(&self.body).map_err(|_| Rs256JwksResponseError::BodyInvalid)?;
        Rs256JwksSnapshot::parse_json(document).map_err(|_| Rs256JwksResponseError::BodyInvalid)
    }
}

impl fmt::Debug for Rs256JwksResponseCollector {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Rs256JwksResponseCollector(bytes={}, declared={})",
            self.body.len(),
            self.declared_length.is_some()
        )
    }
}

fn parse_content_length(value: &str) -> Result<usize, Rs256JwksResponseError> {
    if value.is_empty()
        || value.len() > MAX_CONTENT_LENGTH_BYTES
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(Rs256JwksResponseError::ContentLengthInvalid);
    }
    let length = value
        .parse::<usize>()
        .map_err(|_| Rs256JwksResponseError::ContentLengthInvalid)?;
    if length > MAX_RESPONSE_BYTES {
        return Err(Rs256JwksResponseError::BodyTooLarge);
    }
    Ok(length)
}

fn valid_content_type(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_CONTENT_TYPE_BYTES || value.contains(',') {
        return false;
    }
    let mut parts = value.split(';');
    let essence = parts.next().unwrap_or_default().trim();
    if !essence.eq_ignore_ascii_case("application/json")
        && !essence.eq_ignore_ascii_case("application/jwk-set+json")
    {
        return false;
    }

    let mut charset_seen = false;
    for parameter in parts {
        let Some((name, raw_value)) = parameter.trim().split_once('=') else {
            return false;
        };
        if charset_seen || !name.trim().eq_ignore_ascii_case("charset") {
            return false;
        }
        let charset = raw_value.trim();
        let charset = charset
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .unwrap_or(charset);
        if !charset.eq_ignore_ascii_case("utf-8") {
            return false;
        }
        charset_seen = true;
    }
    true
}
