use std::fmt;

use converact_contracts::canonical_sha256;
use converact_voice_agent_contracts::{
    EnvelopeContext, EventId, ExecutionGeneration, TranscriptSegmentId, TranscriptSnapshotId,
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
const MAX_SNAPSHOT_SEGMENTS: usize = 262_144;

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
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Customer => "customer",
            Self::AiAgent => "ai_agent",
            Self::HumanAgent => "human_agent",
            Self::System => "system",
        }
    }
}

/// Positive immutable transcript snapshot revision.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct TranscriptSnapshotRevision(u64);

impl TranscriptSnapshotRevision {
    /// Creates a positive transcript snapshot revision.
    ///
    /// # Errors
    ///
    /// Rejects zero.
    pub const fn new(value: u64) -> Result<Self, ResultError> {
        if value == 0 {
            Err(ResultError::InvalidTranscriptSnapshot)
        } else {
            Ok(Self(value))
        }
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
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

/// Unvalidated terminal snapshot of immutable final transcript segments.
pub struct TranscriptSnapshotInput {
    pub id: TranscriptSnapshotId,
    pub context: EnvelopeContext,
    pub revision: TranscriptSnapshotRevision,
    pub current_generation: ExecutionGeneration,
    pub segments: Vec<TranscriptSegment>,
    pub call_terminal_observed: bool,
    pub agent_terminal_observed: bool,
    pub transcript_terminal_observed: bool,
    pub frozen_at_ms: u64,
}

/// Content-addressed terminal transcript boundary consumed by result generation.
#[derive(Clone, Eq, PartialEq)]
pub struct TranscriptSnapshot {
    id: TranscriptSnapshotId,
    context: EnvelopeContext,
    revision: TranscriptSnapshotRevision,
    current_generation: ExecutionGeneration,
    segment_ids: Box<[TranscriptSegmentId]>,
    digest: Box<str>,
    call_terminal_observed: bool,
    agent_terminal_observed: bool,
    transcript_terminal_observed: bool,
    frozen_at_ms: u64,
    payload_hash: Box<str>,
}

impl TranscriptSnapshot {
    /// Freezes an ordered, terminal, interaction-scoped list of final segments.
    ///
    /// # Errors
    ///
    /// Rejects incomplete terminal evidence, mixed identities, future generations, duplicate
    /// generation/sequence positions, unbounded segment counts or canonical hash failure.
    pub fn try_new(input: TranscriptSnapshotInput) -> Result<Self, ResultError> {
        if input.frozen_at_ms == 0
            || input.segments.len() > MAX_SNAPSHOT_SEGMENTS
            || input.current_generation != input.context.execution_generation()
            || !input.call_terminal_observed
            || !input.agent_terminal_observed
            || !input.transcript_terminal_observed
        {
            return Err(ResultError::InvalidTranscriptSnapshot);
        }

        let mut ordered = input.segments;
        for segment in &ordered {
            let segment_context = segment.context();
            if segment_context.tenant_id() != input.context.tenant_id()
                || segment_context.interaction_id() != input.context.interaction_id()
                || segment_context.call_attempt_id() != input.context.call_attempt_id()
                || segment_context.agent_release_id() != input.context.agent_release_id()
                || segment.generation_status(input.current_generation).is_err()
            {
                return Err(ResultError::InvalidTranscriptSnapshot);
            }
        }
        ordered.sort_unstable_by(|left, right| {
            left.context()
                .execution_generation()
                .cmp(&right.context().execution_generation())
                .then_with(|| left.sequence().cmp(&right.sequence()))
                .then_with(|| left.id().cmp(right.id()))
        });
        if ordered.windows(2).any(|pair| {
            pair[0].context().execution_generation() == pair[1].context().execution_generation()
                && pair[0].sequence() == pair[1].sequence()
        }) {
            return Err(ResultError::InvalidTranscriptSnapshot);
        }

        let segment_refs = ordered
            .iter()
            .map(|segment| {
                json!({
                    "segment_id": segment.id().as_str(),
                    "execution_generation": segment.context().execution_generation().get(),
                    "segment_sequence": segment.sequence(),
                    "payload_hash": segment.payload_hash()
                })
            })
            .collect::<Vec<_>>();
        let segment_count = segment_refs.len();
        let transcript_snapshot_digest = canonical_sha256(&json!(segment_refs))
            .map_err(|_| ResultError::CanonicalPayloadInvalid)?;
        let payload_hash = canonical_sha256(&json!({
            "tenant_id": input.context.tenant_id(),
            "snapshot_id": input.id.as_str(),
            "interaction_id": input.context.interaction_id().as_str(),
            "call_attempt_id": input.context.call_attempt_id().as_str(),
            "agent_release_id": input.context.agent_release_id().as_str(),
            "snapshot_revision": input.revision.get(),
            "current_generation": input.current_generation.get(),
            "transcript_snapshot_digest": transcript_snapshot_digest,
            "segment_count": segment_count,
            "call_terminal_observed": input.call_terminal_observed,
            "agent_terminal_observed": input.agent_terminal_observed,
            "transcript_terminal_observed": input.transcript_terminal_observed,
            "frozen_at_ms": input.frozen_at_ms
        }))
        .map_err(|_| ResultError::CanonicalPayloadInvalid)?;

        Ok(Self {
            id: input.id,
            context: input.context,
            revision: input.revision,
            current_generation: input.current_generation,
            segment_ids: ordered.into_iter().map(|segment| segment.id).collect(),
            digest: transcript_snapshot_digest.into(),
            call_terminal_observed: input.call_terminal_observed,
            agent_terminal_observed: input.agent_terminal_observed,
            transcript_terminal_observed: input.transcript_terminal_observed,
            frozen_at_ms: input.frozen_at_ms,
            payload_hash: payload_hash.into(),
        })
    }

    #[must_use]
    pub const fn id(&self) -> &TranscriptSnapshotId {
        &self.id
    }

    #[must_use]
    pub const fn context(&self) -> &EnvelopeContext {
        &self.context
    }

    #[must_use]
    pub const fn revision(&self) -> TranscriptSnapshotRevision {
        self.revision
    }

    #[must_use]
    pub const fn current_generation(&self) -> ExecutionGeneration {
        self.current_generation
    }

    #[must_use]
    pub const fn segment_ids(&self) -> &[TranscriptSegmentId] {
        &self.segment_ids
    }

    #[must_use]
    pub fn segment_count(&self) -> usize {
        self.segment_ids.len()
    }

    #[must_use]
    pub fn transcript_snapshot_digest(&self) -> &str {
        &self.digest
    }

    #[must_use]
    pub const fn call_terminal_observed(&self) -> bool {
        self.call_terminal_observed
    }

    #[must_use]
    pub const fn agent_terminal_observed(&self) -> bool {
        self.agent_terminal_observed
    }

    #[must_use]
    pub const fn transcript_terminal_observed(&self) -> bool {
        self.transcript_terminal_observed
    }

    #[must_use]
    pub const fn frozen_at_ms(&self) -> u64 {
        self.frozen_at_ms
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }
}

impl fmt::Debug for TranscriptSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TranscriptSnapshot")
            .field("id", &self.id)
            .field("revision", &self.revision)
            .field("segment_count", &self.segment_ids.len())
            .field("transcript_snapshot_digest", &self.digest)
            .field("payload_hash", &self.payload_hash)
            .finish_non_exhaustive()
    }
}
