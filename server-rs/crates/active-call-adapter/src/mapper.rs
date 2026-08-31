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
const MAX_INTENT_CANDIDATE_BYTES: usize = 256;

/// Validated Converact authority context attached to every normalized event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterContext {
    authority: EnvelopeContext,
}

/// One validated keypad symbol without accidental log disclosure.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct DtmfDigit(char);

impl DtmfDigit {
    /// Returns the digit only to the explicit real-time input consumer.
    #[must_use]
    pub const fn as_char(self) -> char {
        self.0
    }
}

impl fmt::Debug for DtmfDigit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DtmfDigit([REDACTED])")
    }
}

/// One untrusted Channel Agent intent candidate with redacted diagnostics.
#[derive(Clone, Eq, PartialEq)]
pub struct IntentCandidate(Box<str>);

impl IntentCandidate {
    /// Returns the candidate only to the explicit schema-validation consumer.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for IntentCandidate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("IntentCandidate([REDACTED])")
    }
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
    SpeechStarted {
        authority: EnvelopeContext,
        track_id: Box<str>,
        timestamp_ms: u64,
        start_time_ms: u64,
        is_filler: bool,
        confidence: Option<f32>,
    },
    UtteranceEnded {
        authority: EnvelopeContext,
        track_id: Box<str>,
        timestamp_ms: u64,
        completed: bool,
    },
    PlaybackInterrupted {
        authority: EnvelopeContext,
        track_id: Box<str>,
        timestamp_ms: u64,
        total_duration_ms: u32,
        elapsed_ms: u32,
    },
    DtmfInput {
        authority: EnvelopeContext,
        track_id: Box<str>,
        timestamp_ms: u64,
        digit: DtmfDigit,
    },
    HoldChanged {
        authority: EnvelopeContext,
        track_id: Box<str>,
        timestamp_ms: u64,
        on_hold: bool,
    },
    InactivityDetected {
        authority: EnvelopeContext,
        track_id: Box<str>,
        timestamp_ms: u64,
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
        intent_candidate: Option<IntentCandidate>,
    },
}

impl NormalizedEvent {
    /// Returns the generation that rejects stale Agent events.
    #[must_use]
    pub const fn execution_generation(&self) -> ExecutionGeneration {
        self.authority().execution_generation()
    }

    /// Content-free state observations are durable; raw real-time controls stay transient.
    #[must_use]
    pub const fn is_durable(&self) -> bool {
        !matches!(
            self,
            Self::TranscriptDelta { .. }
                | Self::SpeechStarted { .. }
                | Self::UtteranceEnded { .. }
                | Self::DtmfInput { .. }
        )
    }

    const fn authority(&self) -> &EnvelopeContext {
        match self {
            Self::MediaReady { authority, .. }
            | Self::TranscriptFinal { authority, .. }
            | Self::TranscriptDelta { authority, .. }
            | Self::SpeechStarted { authority, .. }
            | Self::UtteranceEnded { authority, .. }
            | Self::PlaybackInterrupted { authority, .. }
            | Self::DtmfInput { authority, .. }
            | Self::HoldChanged { authority, .. }
            | Self::InactivityDetected { authority, .. }
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
    InvalidDtmf,
    InvalidPlaybackTiming,
    InvalidToolName,
    InvalidToolArguments,
    InvalidTimeText,
    InvalidIntentCandidate,
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
            Self::InvalidDtmf => "active_call_dtmf_invalid",
            Self::InvalidPlaybackTiming => "active_call_playback_timing_invalid",
            Self::InvalidToolName => "active_call_tool_name_invalid",
            Self::InvalidToolArguments => "active_call_tool_arguments_invalid",
            Self::InvalidTimeText => "active_call_time_text_invalid",
            Self::InvalidIntentCandidate => "active_call_intent_candidate_invalid",
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
        "mediaReady"
            | "asrFinal"
            | "asrDelta"
            | "speaking"
            | "eou"
            | "interruption"
            | "dtmf"
            | "hold"
            | "inactivity"
            | "functionCall"
            | "hangup"
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
        } => map_media_ready(context, track_id, timestamp),
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
        UpstreamEvent::Speaking {
            track_id,
            timestamp,
            start_time,
            is_filler,
            confidence,
        } => map_speech_started(
            context, track_id, timestamp, start_time, is_filler, confidence,
        ),
        UpstreamEvent::Eou {
            track_id,
            timestamp,
            completed,
        } => map_utterance_ended(context, track_id, timestamp, completed),
        UpstreamEvent::Interruption {
            track_id,
            timestamp,
            total_duration,
            current,
        } => map_playback_interrupted(context, track_id, timestamp, total_duration, current),
        UpstreamEvent::Dtmf {
            track_id,
            timestamp,
            digit,
        } => map_dtmf_input(context, track_id, timestamp, &digit),
        UpstreamEvent::Hold {
            track_id,
            timestamp,
            on_hold,
        } => map_hold_changed(context, track_id, timestamp, on_hold),
        UpstreamEvent::Inactivity {
            track_id,
            timestamp,
        } => map_inactivity(context, track_id, timestamp),
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
            extra,
        } => {
            map_conversation_completed(context, track_id, timestamp, start_time, hangup_time, extra)
        }
    }
}

fn map_conversation_completed(
    context: &AdapterContext,
    track_id: String,
    timestamp: u64,
    start_time: String,
    hangup_time: String,
    mut extra: Option<std::collections::HashMap<String, Value>>,
) -> Result<NormalizedEvent, AdapterError> {
    let intent_candidate = extra
        .as_mut()
        .and_then(|values| values.remove("intent"))
        .map(valid_intent_candidate)
        .transpose()?;
    Ok(NormalizedEvent::ConversationCompleted {
        authority: context.authority.clone(),
        track_id: bounded_identifier(track_id)?,
        timestamp_ms: valid_timestamp(timestamp)?,
        start_time: bounded_time_text(start_time)?,
        hangup_time: bounded_time_text(hangup_time)?,
        intent_candidate,
    })
}

fn valid_intent_candidate(value: Value) -> Result<IntentCandidate, AdapterError> {
    let Value::String(value) = value else {
        return Err(AdapterError::InvalidIntentCandidate);
    };
    if value.is_empty()
        || value.len() > MAX_INTENT_CANDIDATE_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(AdapterError::InvalidIntentCandidate);
    }
    Ok(IntentCandidate(value.into()))
}

fn map_media_ready(
    context: &AdapterContext,
    track_id: String,
    timestamp: u64,
) -> Result<NormalizedEvent, AdapterError> {
    Ok(NormalizedEvent::MediaReady {
        authority: context.authority.clone(),
        track_id: bounded_identifier(track_id)?,
        timestamp_ms: valid_timestamp(timestamp)?,
    })
}

fn map_speech_started(
    context: &AdapterContext,
    track_id: String,
    timestamp: u64,
    start_time: u64,
    is_filler: Option<bool>,
    confidence: Option<f32>,
) -> Result<NormalizedEvent, AdapterError> {
    let timestamp_ms = valid_timestamp(timestamp)?;
    let start_time_ms = valid_timestamp(start_time)?;
    if start_time_ms > timestamp_ms {
        return Err(AdapterError::InvalidTimestamp);
    }
    Ok(NormalizedEvent::SpeechStarted {
        authority: context.authority.clone(),
        track_id: bounded_identifier(track_id)?,
        timestamp_ms,
        start_time_ms,
        is_filler: is_filler.unwrap_or(false),
        confidence: valid_confidence(confidence)?,
    })
}

fn map_utterance_ended(
    context: &AdapterContext,
    track_id: String,
    timestamp: u64,
    completed: bool,
) -> Result<NormalizedEvent, AdapterError> {
    Ok(NormalizedEvent::UtteranceEnded {
        authority: context.authority.clone(),
        track_id: bounded_identifier(track_id)?,
        timestamp_ms: valid_timestamp(timestamp)?,
        completed,
    })
}

fn map_playback_interrupted(
    context: &AdapterContext,
    track_id: String,
    timestamp: u64,
    total_duration: u32,
    current: u32,
) -> Result<NormalizedEvent, AdapterError> {
    if total_duration == 0 || current > total_duration {
        return Err(AdapterError::InvalidPlaybackTiming);
    }
    Ok(NormalizedEvent::PlaybackInterrupted {
        authority: context.authority.clone(),
        track_id: bounded_identifier(track_id)?,
        timestamp_ms: valid_timestamp(timestamp)?,
        total_duration_ms: total_duration,
        elapsed_ms: current,
    })
}

fn map_dtmf_input(
    context: &AdapterContext,
    track_id: String,
    timestamp: u64,
    digit: &str,
) -> Result<NormalizedEvent, AdapterError> {
    Ok(NormalizedEvent::DtmfInput {
        authority: context.authority.clone(),
        track_id: bounded_identifier(track_id)?,
        timestamp_ms: valid_timestamp(timestamp)?,
        digit: valid_dtmf(digit)?,
    })
}

fn map_hold_changed(
    context: &AdapterContext,
    track_id: String,
    timestamp: u64,
    on_hold: bool,
) -> Result<NormalizedEvent, AdapterError> {
    Ok(NormalizedEvent::HoldChanged {
        authority: context.authority.clone(),
        track_id: bounded_identifier(track_id)?,
        timestamp_ms: valid_timestamp(timestamp)?,
        on_hold,
    })
}

fn map_inactivity(
    context: &AdapterContext,
    track_id: String,
    timestamp: u64,
) -> Result<NormalizedEvent, AdapterError> {
    Ok(NormalizedEvent::InactivityDetected {
        authority: context.authority.clone(),
        track_id: bounded_identifier(track_id)?,
        timestamp_ms: valid_timestamp(timestamp)?,
    })
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

fn valid_dtmf(value: &str) -> Result<DtmfDigit, AdapterError> {
    let mut characters = value.chars();
    let digit = characters.next().ok_or(AdapterError::InvalidDtmf)?;
    if characters.next().is_some() || !matches!(digit, '0'..='9' | '*' | '#' | 'A'..='D') {
        return Err(AdapterError::InvalidDtmf);
    }
    Ok(DtmfDigit(digit))
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
