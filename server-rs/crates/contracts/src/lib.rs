//! Cross-language wire contracts shared by Converact Rust runtimes.

use std::{error::Error, fmt};

use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_CANONICAL_BYTES: usize = 65_536;
const MAX_CANONICAL_DEPTH: usize = 32;
const MAX_CANONICAL_NODES: usize = 8_192;

/// A value cannot be represented inside the frozen canonical JSON bounds.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CanonicalJsonError {
    /// The document exceeded its byte, depth or node budget.
    BoundsExceeded,
    /// `serde_json` could not encode a JSON scalar or key.
    EncodingFailed,
}

impl fmt::Display for CanonicalJsonError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::BoundsExceeded => "canonical JSON bounds exceeded",
            Self::EncodingFailed => "canonical JSON encoding failed",
        })
    }
}

impl Error for CanonicalJsonError {}

/// Encodes JSON with lexicographically sorted object keys and fixed budgets.
///
/// This matches the existing TypeScript contract for JSON values inside the
/// supported wire subset. Numbers must already be represented by
/// [`serde_json::Value`] and are never coerced.
///
/// # Errors
///
/// Returns [`CanonicalJsonError`] if the value exceeds 65,536 encoded bytes,
/// 32 levels or 8,192 nodes, or if scalar encoding fails.
pub fn canonical_json(value: &Value) -> Result<String, CanonicalJsonError> {
    let mut output = String::new();
    let mut nodes = 0;
    encode(value, 0, &mut nodes, &mut output)?;
    check_bytes(&output)?;
    Ok(output)
}

/// Returns the lowercase SHA-256 of [`canonical_json`].
///
/// # Errors
///
/// Returns [`CanonicalJsonError`] when canonical encoding fails.
pub fn canonical_sha256(value: &Value) -> Result<String, CanonicalJsonError> {
    let canonical = canonical_json(value)?;
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}

fn encode(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
    output: &mut String,
) -> Result<(), CanonicalJsonError> {
    *nodes = nodes
        .checked_add(1)
        .ok_or(CanonicalJsonError::BoundsExceeded)?;
    if depth > MAX_CANONICAL_DEPTH || *nodes > MAX_CANONICAL_NODES {
        return Err(CanonicalJsonError::BoundsExceeded);
    }
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(boolean) => output.push_str(if *boolean { "true" } else { "false" }),
        Value::Number(number) => output.push_str(&javascript_number(number)?),
        Value::String(text) => {
            check_input_bytes(text)?;
            output.push_str(
                &serde_json::to_string(text).map_err(|_| CanonicalJsonError::EncodingFailed)?,
            );
        }
        Value::Array(items) => {
            if items.len() > MAX_CANONICAL_NODES {
                return Err(CanonicalJsonError::BoundsExceeded);
            }
            output.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                encode(item, depth + 1, nodes, output)?;
                check_bytes(output)?;
            }
            output.push(']');
        }
        Value::Object(object) => {
            if object.len() > MAX_CANONICAL_NODES {
                return Err(CanonicalJsonError::BoundsExceeded);
            }
            let mut aggregate_key_bytes: usize = 0;
            for key in object.keys() {
                check_input_bytes(key)?;
                let encoded_key_bytes = serde_json::to_string(key)
                    .map_err(|_| CanonicalJsonError::EncodingFailed)?
                    .len();
                aggregate_key_bytes = aggregate_key_bytes
                    .checked_add(encoded_key_bytes)
                    .ok_or(CanonicalJsonError::BoundsExceeded)?;
                if aggregate_key_bytes > MAX_CANONICAL_BYTES {
                    return Err(CanonicalJsonError::BoundsExceeded);
                }
            }
            output.push('{');
            let mut keys: Vec<_> = object.keys().collect();
            keys.sort_unstable_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key).map_err(|_| CanonicalJsonError::EncodingFailed)?,
                );
                output.push(':');
                encode(&object[key], depth + 1, nodes, output)?;
                check_bytes(output)?;
            }
            output.push('}');
        }
    }
    check_bytes(output)
}

fn check_bytes(value: &str) -> Result<(), CanonicalJsonError> {
    if value.len() > MAX_CANONICAL_BYTES {
        Err(CanonicalJsonError::BoundsExceeded)
    } else {
        Ok(())
    }
}

fn check_input_bytes(value: &str) -> Result<(), CanonicalJsonError> {
    if value.len() > MAX_CANONICAL_BYTES {
        Err(CanonicalJsonError::BoundsExceeded)
    } else {
        Ok(())
    }
}

fn javascript_number(number: &serde_json::Number) -> Result<String, CanonicalJsonError> {
    let value = number
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or(CanonicalJsonError::EncodingFailed)?;
    if value == 0.0 {
        return Ok("0".to_owned());
    }
    let mut buffer = ryu::Buffer::new();
    Ok(javascript_number_from_ryu(buffer.format_finite(value)))
}

fn javascript_number_from_ryu(raw: &str) -> String {
    let (sign, unsigned) = raw
        .strip_prefix('-')
        .map_or(("", raw), |unsigned| ("-", unsigned));
    let (mantissa, explicit_exponent) =
        unsigned
            .split_once(['e', 'E'])
            .map_or((unsigned, 0), |(mantissa, exponent)| {
                (
                    mantissa,
                    exponent
                        .strip_prefix('+')
                        .unwrap_or(exponent)
                        .parse::<i32>()
                        .expect("Ryu exponent is a bounded decimal"),
                )
            });
    let decimal_index = mantissa.find('.').unwrap_or(mantissa.len());
    let mut digits: String = mantissa
        .chars()
        .filter(|character| *character != '.')
        .collect();
    let leading_zeroes = digits.bytes().take_while(|byte| *byte == b'0').count();
    digits.drain(..leading_zeroes);
    while digits.ends_with('0') {
        digits.pop();
    }
    let decimal_position = i32::try_from(decimal_index).expect("Ryu mantissa length is bounded")
        + explicit_exponent
        - i32::try_from(leading_zeroes).expect("Ryu mantissa length is bounded");
    let scientific_exponent = decimal_position - 1;

    if (-6..21).contains(&scientific_exponent) {
        let mut output = String::from(sign);
        if decimal_position <= 0 {
            output.push_str("0.");
            output.extend(std::iter::repeat_n(
                '0',
                usize::try_from(-decimal_position).expect("decimal position is bounded"),
            ));
            output.push_str(&digits);
        } else {
            let decimal_position =
                usize::try_from(decimal_position).expect("positive decimal position");
            if decimal_position >= digits.len() {
                output.push_str(&digits);
                output.extend(std::iter::repeat_n('0', decimal_position - digits.len()));
            } else {
                output.push_str(&digits[..decimal_position]);
                output.push('.');
                output.push_str(&digits[decimal_position..]);
            }
        }
        output
    } else {
        let mut output = String::from(sign);
        output.push(digits.as_bytes()[0] as char);
        if digits.len() > 1 {
            output.push('.');
            output.push_str(&digits[1..]);
        }
        output.push('e');
        if scientific_exponent >= 0 {
            output.push('+');
        }
        output.push_str(&scientific_exponent.to_string());
        output
    }
}
