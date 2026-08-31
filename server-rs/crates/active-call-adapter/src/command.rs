use serde_json::{Value, json};

use crate::AdapterError;

const MAX_DISCLOSURE_BYTES: usize = 4_096;
const MAX_PLAY_ID_BYTES: usize = 255;
const MAX_FADE_OUT_MS: u32 = 2_000;

/// Safe subset of commands emitted to the private Active Call process.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterCommand {
    PlayDisclosure { text: String, play_id: String },
    InterruptOutput { fade_out_ms: Option<u32> },
    PauseOutput,
    ResumeOutput,
}

/// Encodes one validated command using the pinned Active Call camel-case wire shape.
///
/// # Errors
///
/// Rejects empty, control-bearing or oversized disclosure fields.
pub fn encode_command(command: AdapterCommand) -> Result<Value, AdapterError> {
    match command {
        AdapterCommand::PlayDisclosure { text, play_id } => {
            if text.is_empty()
                || text.len() > MAX_DISCLOSURE_BYTES
                || text.chars().any(char::is_control)
            {
                return Err(AdapterError::InvalidTranscript);
            }
            if !is_valid_play_id(&play_id) {
                return Err(AdapterError::InvalidIdentifier);
            }
            Ok(json!({
                "command": "tts",
                "text": text,
                "playId": play_id,
                "autoHangup": false,
            }))
        }
        AdapterCommand::InterruptOutput { fade_out_ms } => {
            if fade_out_ms.is_some_and(|duration| duration > MAX_FADE_OUT_MS) {
                return Err(AdapterError::InvalidPlaybackTiming);
            }
            let mut payload = json!({
                "command": "interrupt",
                "graceful": false,
            });
            if let Some(duration) = fade_out_ms {
                payload["fadeOutMs"] = json!(duration);
            }
            Ok(payload)
        }
        AdapterCommand::PauseOutput => Ok(json!({ "command": "pause" })),
        AdapterCommand::ResumeOutput => Ok(json!({ "command": "resume" })),
    }
}

fn is_valid_play_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_PLAY_ID_BYTES
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
