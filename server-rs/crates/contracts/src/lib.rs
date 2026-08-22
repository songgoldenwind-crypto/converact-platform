//! Cross-language wire contracts shared by Converact Rust runtimes.

pub mod health;

use std::{error::Error, fmt};

use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_CANONICAL_BYTES: usize = 65_536;
const MAX_ESCAPED_PAYLOAD_BYTES: usize = MAX_CANONICAL_BYTES * 6 + 2;
const MAX_CANONICAL_DEPTH: usize = 32;
const MAX_CANONICAL_NODES: usize = 8_192;
const JS_DATE_LIMIT_MS: i64 = 8_640_000_000_000_000;

/// A value cannot be represented inside the frozen canonical JSON bounds.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CanonicalJsonError {
    /// The document exceeded its byte, depth or node budget.
    BoundsExceeded,
    /// `serde_json` could not encode a JSON scalar or key.
    EncodingFailed,
}

/// Closed object-key ordering contracts used by frozen cross-runtime JSON.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CanonicalKeyOrder {
    /// JavaScript `Array.prototype.sort()` order over UTF-16 code units.
    #[default]
    Utf16CodeUnit,
    /// Node 24 `en-US` variant collation over `[A-Za-z0-9_.-]` keys.
    ///
    /// This is intentionally limited to the active audit metadata key domain.
    /// Any other object key fails closed instead of pretending to implement
    /// general Unicode collation.
    Node24EnUsAscii,
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
    canonical_json_with_max_bytes(value, MAX_CANONICAL_BYTES)
}

/// Encodes canonical JSON under an explicit byte budget.
///
/// The upper limit is the largest representation accepted by the frozen
/// TypeScript event contract: a 65,536-byte string with every byte escaped.
/// This keeps callers from turning a compatibility helper into an unbounded
/// encoder.
///
/// # Errors
///
/// Returns [`CanonicalJsonError`] for a zero or oversized budget, or when the
/// value exceeds the requested byte, depth or node bound.
pub fn canonical_json_with_max_bytes(
    value: &Value,
    max_bytes: usize,
) -> Result<String, CanonicalJsonError> {
    canonical_json_with_max_bytes_and_key_order(value, max_bytes, CanonicalKeyOrder::Utf16CodeUnit)
}

/// Encodes canonical JSON under explicit byte and object-key-order contracts.
///
/// # Errors
///
/// Returns [`CanonicalJsonError`] when the value exceeds the requested bounds
/// or contains an object key outside the selected order's closed key domain.
pub fn canonical_json_with_max_bytes_and_key_order(
    value: &Value,
    max_bytes: usize,
    key_order: CanonicalKeyOrder,
) -> Result<String, CanonicalJsonError> {
    if max_bytes == 0 || max_bytes > MAX_ESCAPED_PAYLOAD_BYTES {
        return Err(CanonicalJsonError::BoundsExceeded);
    }
    let mut output = String::new();
    let mut nodes = 0;
    encode(value, 0, &mut nodes, &mut output, max_bytes, key_order)?;
    check_bytes(&output, max_bytes)?;
    Ok(output)
}

/// Returns the lowercase SHA-256 of [`canonical_json`].
///
/// # Errors
///
/// Returns [`CanonicalJsonError`] when canonical encoding fails.
pub fn canonical_sha256(value: &Value) -> Result<String, CanonicalJsonError> {
    canonical_sha256_with_max_bytes(value, MAX_CANONICAL_BYTES)
}

/// Returns a lowercase SHA-256 under an explicit object-key-order contract.
///
/// # Errors
///
/// Returns [`CanonicalJsonError`] when canonical encoding fails.
pub fn canonical_sha256_with_key_order(
    value: &Value,
    key_order: CanonicalKeyOrder,
) -> Result<String, CanonicalJsonError> {
    let canonical =
        canonical_json_with_max_bytes_and_key_order(value, MAX_CANONICAL_BYTES, key_order)?;
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}

/// Returns the lowercase SHA-256 of canonical JSON under an explicit bounded
/// byte budget.
///
/// # Errors
///
/// Returns [`CanonicalJsonError`] under the same conditions as
/// [`canonical_json_with_max_bytes`].
pub fn canonical_sha256_with_max_bytes(
    value: &Value,
    max_bytes: usize,
) -> Result<String, CanonicalJsonError> {
    let canonical = canonical_json_with_max_bytes(value, max_bytes)?;
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}

fn encode(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
    output: &mut String,
    max_bytes: usize,
    key_order: CanonicalKeyOrder,
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
            check_input_bytes(text, max_bytes)?;
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
                encode(item, depth + 1, nodes, output, max_bytes, key_order)?;
                check_bytes(output, max_bytes)?;
            }
            output.push(']');
        }
        Value::Object(object) => {
            if object.len() > MAX_CANONICAL_NODES {
                return Err(CanonicalJsonError::BoundsExceeded);
            }
            let mut aggregate_key_bytes: usize = 0;
            for key in object.keys() {
                check_input_bytes(key, max_bytes)?;
                if key_order == CanonicalKeyOrder::Node24EnUsAscii
                    && !key.bytes().all(|byte| node24_en_us_primary(byte).is_some())
                {
                    return Err(CanonicalJsonError::EncodingFailed);
                }
                let encoded_key_bytes = serde_json::to_string(key)
                    .map_err(|_| CanonicalJsonError::EncodingFailed)?
                    .len();
                aggregate_key_bytes = aggregate_key_bytes
                    .checked_add(encoded_key_bytes)
                    .ok_or(CanonicalJsonError::BoundsExceeded)?;
                if aggregate_key_bytes > max_bytes {
                    return Err(CanonicalJsonError::BoundsExceeded);
                }
            }
            output.push('{');
            let mut keys: Vec<_> = object.keys().collect();
            keys.sort_unstable_by(|left, right| match key_order {
                CanonicalKeyOrder::Utf16CodeUnit => left.encode_utf16().cmp(right.encode_utf16()),
                CanonicalKeyOrder::Node24EnUsAscii => node24_en_us_ascii_cmp(left, right),
            });
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key).map_err(|_| CanonicalJsonError::EncodingFailed)?,
                );
                output.push(':');
                encode(&object[key], depth + 1, nodes, output, max_bytes, key_order)?;
                check_bytes(output, max_bytes)?;
            }
            output.push('}');
        }
    }
    check_bytes(output, max_bytes)
}

fn node24_en_us_ascii_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.bytes()
        .map(|byte| node24_en_us_primary(byte).expect("validated ASCII collation key"))
        .cmp(
            right
                .bytes()
                .map(|byte| node24_en_us_primary(byte).expect("validated ASCII collation key")),
        )
        .then_with(|| {
            left.bytes()
                .map(node24_en_us_case_weight)
                .cmp(right.bytes().map(node24_en_us_case_weight))
        })
        .then_with(|| left.as_bytes().cmp(right.as_bytes()))
}

const fn node24_en_us_primary(byte: u8) -> Option<u8> {
    match byte {
        b'_' => Some(0),
        b'-' => Some(1),
        b'.' => Some(2),
        b'0'..=b'9' => Some(3 + byte - b'0'),
        b'A'..=b'Z' => Some(13 + byte - b'A'),
        b'a'..=b'z' => Some(13 + byte - b'a'),
        _ => None,
    }
}

const fn node24_en_us_case_weight(byte: u8) -> u8 {
    if byte.is_ascii_uppercase() { 1 } else { 0 }
}

fn check_bytes(value: &str, max_bytes: usize) -> Result<(), CanonicalJsonError> {
    if value.len() > max_bytes {
        Err(CanonicalJsonError::BoundsExceeded)
    } else {
        Ok(())
    }
}

fn check_input_bytes(value: &str, max_bytes: usize) -> Result<(), CanonicalJsonError> {
    if value.len() > max_bytes {
        Err(CanonicalJsonError::BoundsExceeded)
    } else {
        Ok(())
    }
}

/// Parses the exact string emitted by JavaScript `Date::toISOString`,
/// including the ECMAScript time-clip boundary and extended signed years.
#[must_use]
pub fn parse_canonical_timestamp_ms(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    let (year, year_end) = match bytes.len() {
        24 => (parse_digits(bytes, 0, 4)?, 4),
        27 if matches!(bytes.first(), Some(b'+' | b'-')) => {
            let magnitude = parse_digits(bytes, 1, 7)?;
            if (bytes[0] == b'+' && magnitude < 10_000) || (bytes[0] == b'-' && magnitude == 0) {
                return None;
            }
            let signed = if bytes[0] == b'-' {
                -magnitude
            } else {
                magnitude
            };
            (signed, 7)
        }
        _ => return None,
    };
    if bytes.get(year_end) != Some(&b'-')
        || bytes.get(year_end + 3) != Some(&b'-')
        || bytes.get(year_end + 6) != Some(&b'T')
        || bytes.get(year_end + 9) != Some(&b':')
        || bytes.get(year_end + 12) != Some(&b':')
        || bytes.get(year_end + 15) != Some(&b'.')
        || bytes.get(year_end + 19) != Some(&b'Z')
    {
        return None;
    }
    let month = parse_digits(bytes, year_end + 1, year_end + 3)?;
    let day = parse_digits(bytes, year_end + 4, year_end + 6)?;
    let hour = parse_digits(bytes, year_end + 7, year_end + 9)?;
    let minute = parse_digits(bytes, year_end + 10, year_end + 12)?;
    let second = parse_digits(bytes, year_end + 13, year_end + 15)?;
    let millisecond = parse_digits(bytes, year_end + 16, year_end + 19)?;
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let milliseconds = i128::from(days_from_civil(year, month, day)) * 86_400_000
        + i128::from(hour) * 3_600_000
        + i128::from(minute) * 60_000
        + i128::from(second) * 1_000
        + i128::from(millisecond);
    if milliseconds < -i128::from(JS_DATE_LIMIT_MS) || milliseconds > i128::from(JS_DATE_LIMIT_MS) {
        return None;
    }
    i64::try_from(milliseconds).ok()
}

/// Formats one ECMAScript time-clip millisecond exactly as
/// JavaScript `Date::toISOString`.
#[must_use]
pub fn format_canonical_timestamp_ms(milliseconds: i64) -> Option<String> {
    if !(-JS_DATE_LIMIT_MS..=JS_DATE_LIMIT_MS).contains(&milliseconds) {
        return None;
    }
    let days = milliseconds.div_euclid(86_400_000);
    let day_milliseconds = milliseconds.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let hour = day_milliseconds / 3_600_000;
    let minute = day_milliseconds % 3_600_000 / 60_000;
    let second = day_milliseconds % 60_000 / 1_000;
    let millisecond = day_milliseconds % 1_000;

    let year = if (0..=9_999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{magnitude:06}", magnitude = year.unsigned_abs())
    } else {
        format!("+{year:06}")
    };
    Some(format!(
        "{year}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millisecond:03}Z"
    ))
}

fn parse_digits(bytes: &[u8], start: usize, end: usize) -> Option<i64> {
    let digits = bytes.get(start..end)?;
    if digits.iter().any(|digit| !digit.is_ascii_digit()) {
        return None;
    }
    Some(
        digits
            .iter()
            .fold(0_i64, |value, digit| value * 10 + i64::from(digit - b'0')),
    )
}

const fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

const fn is_leap_year(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let days = days_since_epoch + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = shifted_month + if shifted_month < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
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
