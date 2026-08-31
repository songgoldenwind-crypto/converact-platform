pub(crate) const MAX_DIAL_TIMEOUT_SECONDS: u32 = 120;

const MAX_DIAL_DESTINATION_BYTES: usize = 512;
const MAX_DIAL_IDENTIFIER_BYTES: usize = 255;

pub(crate) fn valid_dial_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_DIAL_IDENTIFIER_BYTES
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

pub(crate) fn valid_dial_destination(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_DIAL_DESTINATION_BYTES
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return false;
    }
    if let Some(number) = value.strip_prefix('+') {
        return (8..=15).contains(&number.len())
            && number.as_bytes().first() != Some(&b'0')
            && number.bytes().all(|byte| byte.is_ascii_digit());
    }
    let Some(address) = value
        .strip_prefix("sip:")
        .or_else(|| value.strip_prefix("sips:"))
    else {
        return false;
    };
    let Some((user, host)) = address.split_once('@') else {
        return false;
    };
    !user.is_empty() && !host.is_empty() && !host.contains('@')
}
