use std::fmt;

use converact_contracts::canonical_sha256;
use converact_voice_agent_contracts::{
    EnvelopeContext, EventId, ExecutionGeneration, TranscriptSegmentId,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    ResultError,
    validation::{bounded_identifier, bounded_reference, bounded_text},
};

const MAX_LANGUAGE_BYTES: usize = 35;
const MAX_TRANSCRIPT_TEXT_BYTES: usize = 32_768;
const MAX_RETENTION_REF_BYTES: usize = 255;

/// Closed speaker role for one final transcript segment.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptSpeaker {
    Customer,
    AiAgent,
    HumanAgent,
    System,
}

impl TranscriptSpeaker {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Customer => "customer",
            Self::AiAgent => "ai_agent",
            Self::HumanAgent => "human_agent",
            Self::System => "system",
        }
    }
}

/// Relation between segment generation and current control generation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TranscriptGenerationStatus {
    Current,
    Historical,
}

/// Unvalidated final transcript observation.
pub struct TranscriptSegmentInput {
    pub id: TranscriptSegmentId,
    pub context: EnvelopeContext,
    pub source_event_id: EventId,
    pub sequence: u64,
    pub speaker: TranscriptSpeaker,
    pub language: String,
    pub text: String,
    pub start_offset_ms: u64,
    pub end_offset_ms: u64,
    pub observed_at_ms: u64,
    pub retention_policy_ref: String,
}

/// Immutable final transcript segment. Debug output intentionally omits text.
#[derive(Clone, Eq, PartialEq)]
pub struct TranscriptSegment {
    id: TranscriptSegmentId,
    context: EnvelopeContext,
    source_event_id: EventId,
    sequence: u64,
    speaker: TranscriptSpeaker,
    language: Box<str>,
    text: Box<str>,
    start_offset_ms: u64,
    end_offset_ms: u64,
    observed_at_ms: u64,
    retention_policy_ref: Box<str>,
    payload_hash: Box<str>,
}

impl TranscriptSegment {
    /// Validates and hashes one final-only transcript observation.
    ///
    /// # Errors
    ///
    /// Rejects unbounded text/metadata, missing sequence/time, inverted offsets or hash failure.
    pub fn try_new(input: TranscriptSegmentInput) -> Result<Self, ResultError> {
        if input.sequence == 0
            || !bounded_identifier(&input.language, MAX_LANGUAGE_BYTES)
            || !bounded_text(&input.text, MAX_TRANSCRIPT_TEXT_BYTES)
            || input.end_offset_ms < input.start_offset_ms
            || input.observed_at_ms == 0
            || !bounded_reference(&input.retention_policy_ref, MAX_RETENTION_REF_BYTES)
        {
            return Err(ResultError::InvalidTranscriptSegment);
        }
        let payload_hash = canonical_sha256(&json!({
            "tenant_id": input.context.tenant_id(),
            "interaction_id": input.context.interaction_id().as_str(),
            "call_attempt_id": input.context.call_attempt_id().as_str(),
            "call_id": input.context.call_id().map(converact_voice_agent_contracts::CallId::as_str),
            "agent_release_id": input.context.agent_release_id().as_str(),
            "execution_generation": input.context.execution_generation().get(),
            "segment_id": input.id.as_str(),
            "source_event_id": input.source_event_id.as_str(),
            "sequence": input.sequence,
            "speaker": input.speaker.as_str(),
            "language": input.language,
            "text": input.text,
            "start_offset_ms": input.start_offset_ms,
            "end_offset_ms": input.end_offset_ms,
            "observed_at_ms": input.observed_at_ms,
            "retention_policy_ref": input.retention_policy_ref
        }))
        .map_err(|_| ResultError::CanonicalPayloadInvalid)?;
        Ok(Self {
            id: input.id,
            context: input.context,
            source_event_id: input.source_event_id,
            sequence: input.sequence,
            speaker: input.speaker,
            language: input.language.into(),
            text: input.text.into(),
            start_offset_ms: input.start_offset_ms,
            end_offset_ms: input.end_offset_ms,
            observed_at_ms: input.observed_at_ms,
            retention_policy_ref: input.retention_policy_ref.into(),
            payload_hash: payload_hash.into(),
        })
    }

    /// Classifies a late segment without allowing a future generation observation.
    ///
    /// # Errors
    ///
    /// Rejects a segment claiming a generation newer than the durable owner generation.
    pub fn generation_status(
        &self,
        current: ExecutionGeneration,
    ) -> Result<TranscriptGenerationStatus, ResultError> {
        match self.context.execution_generation().cmp(&current) {
            std::cmp::Ordering::Equal => Ok(TranscriptGenerationStatus::Current),
            std::cmp::Ordering::Less => Ok(TranscriptGenerationStatus::Historical),
            std::cmp::Ordering::Greater => Err(ResultError::FutureGeneration),
        }
    }

    #[must_use]
    pub const fn id(&self) -> &TranscriptSegmentId {
        &self.id
    }

    #[must_use]
    pub const fn context(&self) -> &EnvelopeContext {
        &self.context
    }

    #[must_use]
    pub const fn source_event_id(&self) -> &EventId {
        &self.source_event_id
    }

    #[must_use]
    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    #[must_use]
    pub const fn speaker(&self) -> TranscriptSpeaker {
        self.speaker
    }

    #[must_use]
    pub fn language(&self) -> &str {
        &self.language
    }

    #[must_use]
    pub fn text(&self) -> &str {
        &self.text
    }

    #[must_use]
    pub const fn start_offset_ms(&self) -> u64 {
        self.start_offset_ms
    }

    #[must_use]
    pub const fn end_offset_ms(&self) -> u64 {
        self.end_offset_ms
    }

    #[must_use]
    pub const fn observed_at_ms(&self) -> u64 {
        self.observed_at_ms
    }

    #[must_use]
    pub fn retention_policy_ref(&self) -> &str {
        &self.retention_policy_ref
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }
}

impl fmt::Debug for TranscriptSegment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TranscriptSegment")
            .field("id", &self.id)
            .field("sequence", &self.sequence)
            .field("speaker", &self.speaker)
            .field("payload_hash", &self.payload_hash)
            .finish_non_exhaustive()
    }
}
