use std::{error::Error, fmt};

use converact_voice_agent_contracts::{EnvelopeContext, ExecutionGeneration};
use serde_json::Value;

use crate::upstream::UpstreamEvent;

const MAX_IDENTIFIER_BYTES: usize = 255;
const MAX_TOOL_NAME_BYTES: usize = 128;
const MAX_TOOL_ARGUMENT_BYTES: usize = 65_536;
const MAX_TRANSCRIPT_BYTES: usize = 16_384;
const MAX_UPSTREAM_EVENT_BYTES: usize = 131_072;
const MAX_TIME_TEXT_BYTES: usize = 64;

/// Validated Converact authority context attached to every normalized event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterContext {
    authority: EnvelopeContext,
}

impl AdapterContext {
    /// Creates a context from previously validated authority fields.
    #[must_use]
    pub const fn new(authority: EnvelopeContext) -> Self {
        Self { authority }
    }

    /// Returns the underlying Converact authority binding.
    #[must_use]
    pub const fn authority(&self) -> &EnvelopeContext {
        &self.authority
    }
}

/// Events understood by Converact without exposing upstream Rust types.
#[derive(Clone, Debug, PartialEq)]
pub enum NormalizedEvent {
    MediaReady {
        authority: EnvelopeContext,
        track_id: Box<str>,
        timestamp_ms: u64,
    },
    TranscriptFinal {
        authority: EnvelopeContext,
        track_id: Box<str>,
        timestamp_ms: u64,
        index: u32,
        text: Box<str>,
        confidence: Option<f32>,
    },
    TranscriptDelta {
        authority: EnvelopeContext,
        track_id: Box<str>,
        timestamp_ms: u64,
        index: u32,
        text: Box<str>,
        confidence: Option<f32>,
    },
    ToolProposed {
        authority: EnvelopeContext,
        track_id: Box<str>,
        proposal_id: Box<str>,
        tool_name: Box<str>,
        arguments: Value,
        timestamp_ms: u64,
    },
    ConversationCompleted {
        authority: EnvelopeContext,
        track_id: Box<str>,
        timestamp_ms: u64,
        start_time: Box<str>,
        hangup_time: Box<str>,
    },
}

impl NormalizedEvent {
    /// Returns the generation that rejects stale Agent events.
    #[must_use]
    pub const fn execution_generation(&self) -> ExecutionGeneration {
        self.authority().execution_generation()
    }

    /// Final transcripts and effect proposals are durable; deltas are transient UI data.
    #[must_use]
    pub const fn is_durable(&self) -> bool {
        !matches!(self, Self::TranscriptDelta { .. })
    }

    const fn authority(&self) -> &EnvelopeContext {
        match self {
            Self::MediaReady { authority, .. }
            | Self::TranscriptFinal { authority, .. }
            | Self::TranscriptDelta { authority, .. }
            | Self::ToolProposed { authority, .. }
            | Self::ConversationCompleted { authority, .. } => authority,
        }
    }
}

/// Stable adapter rejection; callers branch only on [`Self::code`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdapterError {
    EventTooLarge,
    InvalidJson,
    UnknownEvent,
    InvalidEvent,
    InvalidIdentifier,
    InvalidTimestamp,
    InvalidTranscript,
    InvalidConfidence,
    InvalidToolName,
    InvalidToolArguments,
    InvalidTimeText,
}

impl AdapterError {
    /// Returns a stable low-cardinality error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::EventTooLarge => "active_call_event_too_large",
            Self::InvalidJson => "active_call_json_invalid",
            Self::UnknownEvent => "active_call_event_unknown",
            Self::InvalidEvent => "active_call_event_invalid",
            Self::InvalidIdentifier => "active_call_identifier_invalid",
            Self::InvalidTimestamp => "active_call_timestamp_invalid",
            Self::InvalidTranscript => "active_call_transcript_invalid",
            Self::InvalidConfidence => "active_call_confidence_invalid",
            Self::InvalidToolName => "active_call_tool_name_invalid",
            Self::InvalidToolArguments => "active_call_tool_arguments_invalid",
            Self::InvalidTimeText => "active_call_time_text_invalid",
        }
    }
}

impl fmt::Display for AdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for AdapterError {}

/// Parses one pinned Active Call event and maps it into a bounded Converact event.
///
/// # Errors
///
/// Unknown event tags and malformed or unbounded fields fail closed.
pub fn normalize_event(
    context: &AdapterContext,
    wire: &str,
) -> Result<NormalizedEvent, AdapterError> {
    if wire.len() > MAX_UPSTREAM_EVENT_BYTES {
        return Err(AdapterError::EventTooLarge);
    }
    let value: Value = serde_json::from_str(wire).map_err(|_| AdapterError::InvalidJson)?;
    let event_name = value
        .get("event")
        .and_then(Value::as_str)
        .ok_or(AdapterError::InvalidEvent)?;
    if !matches!(
        event_name,
        "mediaReady" | "asrFinal" | "asrDelta" | "functionCall" | "hangup"
    ) {
        return Err(AdapterError::UnknownEvent);
    }
    let upstream: UpstreamEvent =
        serde_json::from_value(value).map_err(|_| AdapterError::InvalidEvent)?;
    map_event(context, upstream)
}

fn map_event(
    context: &AdapterContext,
    event: UpstreamEvent,
) -> Result<NormalizedEvent, AdapterError> {
    match event {
        UpstreamEvent::MediaReady {
            track_id,
            timestamp,
        } => Ok(NormalizedEvent::MediaReady {
            authority: context.authority.clone(),
            track_id: bounded_identifier(track_id)?,
            timestamp_ms: valid_timestamp(timestamp)?,
        }),
        UpstreamEvent::AsrFinal {
            track_id,
            timestamp,
            index,
            text,
            confidence,
        } => map_transcript(
            context,
            TranscriptKind::Final,
            TranscriptFields {
                track_id,
                timestamp,
                index,
                text,
                confidence,
            },
        ),
        UpstreamEvent::AsrDelta {
            track_id,
            timestamp,
            index,
            text,
            confidence,
        } => map_transcript(
            context,
            TranscriptKind::Delta,
            TranscriptFields {
                track_id,
                timestamp,
                index,
                text,
                confidence,
            },
        ),
        UpstreamEvent::FunctionCall {
            track_id,
            call_id,
            name,
            arguments,
            timestamp,
        } => Ok(NormalizedEvent::ToolProposed {
            authority: context.authority.clone(),
            track_id: bounded_identifier(track_id)?,
            proposal_id: bounded_identifier(call_id)?,
            tool_name: bounded_tool_name(name)?,
            arguments: bounded_tool_arguments(&arguments)?,
            timestamp_ms: valid_timestamp(timestamp)?,
        }),
        UpstreamEvent::Hangup {
            track_id,
            timestamp,
            start_time,
            hangup_time,
        } => Ok(NormalizedEvent::ConversationCompleted {
            authority: context.authority.clone(),
            track_id: bounded_identifier(track_id)?,
            timestamp_ms: valid_timestamp(timestamp)?,
            start_time: bounded_time_text(start_time)?,
            hangup_time: bounded_time_text(hangup_time)?,
        }),
    }
}

#[derive(Clone, Copy)]
enum TranscriptKind {
    Final,
    Delta,
}

struct TranscriptFields {
    track_id: String,
    timestamp: u64,
    index: u32,
    text: String,
    confidence: Option<f32>,
}

fn map_transcript(
    context: &AdapterContext,
    kind: TranscriptKind,
    fields: TranscriptFields,
) -> Result<NormalizedEvent, AdapterError> {
    let authority = context.authority.clone();
    let track_id = bounded_identifier(fields.track_id)?;
    let timestamp_ms = valid_timestamp(fields.timestamp)?;
    let text = bounded_transcript(fields.text)?;
    let confidence = valid_confidence(fields.confidence)?;
    Ok(match kind {
        TranscriptKind::Final => NormalizedEvent::TranscriptFinal {
            authority,
            track_id,
            timestamp_ms,
            index: fields.index,
            text,
            confidence,
        },
        TranscriptKind::Delta => NormalizedEvent::TranscriptDelta {
            authority,
            track_id,
            timestamp_ms,
            index: fields.index,
            text,
            confidence,
        },
    })
}

fn bounded_identifier(value: String) -> Result<Box<str>, AdapterError> {
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
    Ok(value.into())
}

fn valid_timestamp(value: u64) -> Result<u64, AdapterError> {
    (value != 0)
        .then_some(value)
        .ok_or(AdapterError::InvalidTimestamp)
}

fn bounded_transcript(value: String) -> Result<Box<str>, AdapterError> {
    if value.is_empty() || value.len() > MAX_TRANSCRIPT_BYTES {
        return Err(AdapterError::InvalidTranscript);
    }
    Ok(value.into())
}

fn valid_confidence(value: Option<f32>) -> Result<Option<f32>, AdapterError> {
    if value.is_some_and(|confidence| !confidence.is_finite() || !(0.0..=1.0).contains(&confidence))
    {
        return Err(AdapterError::InvalidConfidence);
    }
    Ok(value)
}

fn bounded_tool_name(value: String) -> Result<Box<str>, AdapterError> {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return Err(AdapterError::InvalidToolName);
    };
    if bytes.len() > MAX_TOOL_NAME_BYTES
        || !(first.is_ascii_alphabetic() || first == b'_')
        || !remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(AdapterError::InvalidToolName);
    }
    Ok(value.into())
}

fn bounded_tool_arguments(value: &str) -> Result<Value, AdapterError> {
    if value.len() > MAX_TOOL_ARGUMENT_BYTES {
        return Err(AdapterError::InvalidToolArguments);
    }
    let arguments: Value =
        serde_json::from_str(value).map_err(|_| AdapterError::InvalidToolArguments)?;
    if !arguments.is_object() {
        return Err(AdapterError::InvalidToolArguments);
    }
    Ok(arguments)
}

fn bounded_time_text(value: String) -> Result<Box<str>, AdapterError> {
    if value.is_empty() || value.len() > MAX_TIME_TEXT_BYTES || !value.is_ascii() {
        return Err(AdapterError::InvalidTimeText);
    }
    Ok(value.into())
}
