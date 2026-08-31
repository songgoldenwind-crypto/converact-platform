use serde_json::Value;

use crate::AdapterError;

const MAX_LIFECYCLE_EVENT_BYTES: usize = 131_072;
const MAX_IDENTIFIER_BYTES: usize = 255;

/// Minimal validated event projection needed by the Channel Agent lifecycle.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActiveCallLifecycleEvent {
    MediaReady,
    PlaybackCompleted { play_id: Box<str> },
    Terminal,
}

/// Projects only lifecycle-relevant fields from one pinned Active Call event.
///
/// Unknown valid event kinds are ignored. A recognized lifecycle event fails closed when its
/// identifiers, timestamp or playback duration are malformed.
///
/// # Errors
///
/// Rejects oversized/malformed JSON and invalid fields on recognized lifecycle events.
pub fn decode_lifecycle_event(
    input: &[u8],
) -> Result<Option<ActiveCallLifecycleEvent>, AdapterError> {
    if input.len() > MAX_LIFECYCLE_EVENT_BYTES {
        return Err(AdapterError::EventTooLarge);
    }
    let value: Value = serde_json::from_slice(input).map_err(|_| AdapterError::InvalidJson)?;
    let object = value.as_object().ok_or(AdapterError::InvalidEvent)?;
    let event = object
        .get("event")
        .and_then(Value::as_str)
        .ok_or(AdapterError::InvalidEvent)?;
    match event {
        "mediaReady" => {
            validate_common_fields(object)?;
            Ok(Some(ActiveCallLifecycleEvent::MediaReady))
        }
        "trackEnd" => {
            validate_common_fields(object)?;
            let duration = object
                .get("duration")
                .and_then(Value::as_u64)
                .ok_or(AdapterError::InvalidPlaybackTiming)?;
            if duration == 0 {
                return Err(AdapterError::InvalidPlaybackTiming);
            }
            let ssrc = object
                .get("ssrc")
                .and_then(Value::as_u64)
                .ok_or(AdapterError::InvalidEvent)?;
            u32::try_from(ssrc).map_err(|_| AdapterError::InvalidEvent)?;
            let Some(play_id) = object.get("playId").and_then(Value::as_str) else {
                return Ok(None);
            };
            validate_identifier(play_id)?;
            Ok(Some(ActiveCallLifecycleEvent::PlaybackCompleted {
                play_id: play_id.into(),
            }))
        }
        "hangup" => {
            validate_common_fields(object)?;
            Ok(Some(ActiveCallLifecycleEvent::Terminal))
        }
        _ => Ok(None),
    }
}

fn validate_common_fields(object: &serde_json::Map<String, Value>) -> Result<(), AdapterError> {
    let track_id = object
        .get("trackId")
        .and_then(Value::as_str)
        .ok_or(AdapterError::InvalidIdentifier)?;
    validate_identifier(track_id)?;
    let timestamp = object
        .get("timestamp")
        .and_then(Value::as_u64)
        .ok_or(AdapterError::InvalidTimestamp)?;
    if timestamp == 0 {
        return Err(AdapterError::InvalidTimestamp);
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), AdapterError> {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return Err(AdapterError::InvalidIdentifier);
    };
    if bytes.len() > MAX_IDENTIFIER_BYTES
        || !first.is_ascii_alphanumeric()
        || !remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(AdapterError::InvalidIdentifier);
    }
    Ok(())
}
