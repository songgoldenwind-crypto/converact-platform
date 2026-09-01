use std::{error::Error, fmt};

use converact_active_call_adapter::NormalizedEvent;
use converact_contracts::canonical_sha256;
use converact_conversation_result_core::{
    TranscriptSegmentDraft, TranscriptSegmentDraftInput, TranscriptSpeaker,
};
use converact_voice_agent_contracts::{
    ChannelAgentSessionId, EventId, ExecutionGeneration, TranscriptSegmentId,
};
use serde_json::json;

const MAX_TRACK_ID_BYTES: usize = 255;
const MAX_LANGUAGE_BYTES: usize = 35;
const MAX_RETENTION_REF_BYTES: usize = 255;
const SOURCE_ID_DOMAIN: &str = "converact_active_call_final_transcript_v1";

/// Untrusted binding between one Active Call session and its customer-input track.
pub struct ActiveCallTranscriptBindingInput {
    pub channel_agent_session_id: ChannelAgentSessionId,
    pub customer_track_id: String,
    pub call_started_at_ms: u64,
    pub language: String,
    pub retention_policy_ref: String,
}

/// Immutable source binding used to admit only final customer speech from one exact session.
#[derive(Clone, Eq, PartialEq)]
pub struct ActiveCallTranscriptBinding {
    channel_agent_session_id: ChannelAgentSessionId,
    customer_track_id: Box<str>,
    call_started_at_ms: u64,
    language: Box<str>,
    retention_policy_ref: Box<str>,
}

/// Stable transcript-ingest rejection without customer text or provider metadata.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveCallTranscriptIngestError {
    InvalidBinding,
    AuthorityMismatch,
    InvalidTiming,
    InvalidIdentity,
    InvalidDraft,
    StoreUnavailable,
}

impl ActiveCallTranscriptIngestError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidBinding => "active_call_transcript_binding_invalid",
            Self::AuthorityMismatch => "active_call_transcript_authority_mismatch",
            Self::InvalidTiming => "active_call_transcript_timing_invalid",
            Self::InvalidIdentity => "active_call_transcript_identity_invalid",
            Self::InvalidDraft => "active_call_transcript_draft_invalid",
            Self::StoreUnavailable => "active_call_transcript_store_unavailable",
        }
    }
}

impl fmt::Display for ActiveCallTranscriptIngestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ActiveCallTranscriptIngestError {}

/// Atomic durable boundary that allocates the final-transcript stream sequence.
pub trait ActiveCallTranscriptDurabilityPort: Sync {
    type Append: Send;

    fn append_sequenced_final_segment(
        &self,
        draft: &TranscriptSegmentDraft,
        current_generation: ExecutionGeneration,
    ) -> impl Future<Output = Result<Self::Append, ActiveCallTranscriptIngestError>> + Send;
}

impl ActiveCallTranscriptBinding {
    /// Validates one exact customer-input track and its call-relative clock origin.
    ///
    /// # Errors
    ///
    /// Rejects missing clocks and malformed bounded metadata.
    pub fn try_new(
        input: ActiveCallTranscriptBindingInput,
    ) -> Result<Self, ActiveCallTranscriptIngestError> {
        if input.call_started_at_ms == 0
            || !bounded_identifier(&input.customer_track_id, MAX_TRACK_ID_BYTES)
            || !bounded_identifier(&input.language, MAX_LANGUAGE_BYTES)
            || !bounded_reference(&input.retention_policy_ref, MAX_RETENTION_REF_BYTES)
        {
            return Err(ActiveCallTranscriptIngestError::InvalidBinding);
        }
        Ok(Self {
            channel_agent_session_id: input.channel_agent_session_id,
            customer_track_id: input.customer_track_id.into(),
            call_started_at_ms: input.call_started_at_ms,
            language: input.language.into(),
            retention_policy_ref: input.retention_policy_ref.into(),
        })
    }

    /// Maps one normalized Active Call final into a sequence-free durable transcript draft.
    ///
    /// Non-final, filler, referred-leg and non-customer-track events are deliberately ignored.
    /// The durable Store, never Active Call's provider-local index, owns stream sequencing.
    ///
    /// # Errors
    ///
    /// Rejects session-authority drift, impossible call-relative timing and identity failures.
    pub fn draft_for_event(
        &self,
        event: &NormalizedEvent,
    ) -> Result<Option<TranscriptSegmentDraft>, ActiveCallTranscriptIngestError> {
        let NormalizedEvent::TranscriptFinal {
            authority,
            track_id,
            timestamp_ms,
            index,
            start_time_ms,
            end_time_ms,
            text,
            is_filler,
            refer,
            ..
        } = event
        else {
            return Ok(None);
        };
        if authority.channel_agent_session_id() != Some(&self.channel_agent_session_id) {
            return Err(ActiveCallTranscriptIngestError::AuthorityMismatch);
        }
        if track_id.as_ref() != self.customer_track_id.as_ref()
            || *is_filler
            || *refer == Some(true)
        {
            return Ok(None);
        }
        if *timestamp_ms < self.call_started_at_ms {
            return Err(ActiveCallTranscriptIngestError::InvalidTiming);
        }
        let (start_offset_ms, end_offset_ms) = match (start_time_ms, end_time_ms) {
            (None, None) => {
                let point = timestamp_ms - self.call_started_at_ms;
                (point, point)
            }
            (Some(start), Some(end))
                if *start >= self.call_started_at_ms && *start <= *end && *end <= *timestamp_ms =>
            {
                (
                    start - self.call_started_at_ms,
                    end - self.call_started_at_ms,
                )
            }
            _ => return Err(ActiveCallTranscriptIngestError::InvalidTiming),
        };

        let digest = canonical_sha256(&json!({
            "domain": SOURCE_ID_DOMAIN,
            "schema_version": authority.schema_version(),
            "tenant_id": authority.tenant_id(),
            "interaction_id": authority.interaction_id().as_str(),
            "campaign_id": authority.campaign_id().as_str(),
            "campaign_contact_id": authority.campaign_contact_id().as_str(),
            "call_attempt_id": authority.call_attempt_id().as_str(),
            "call_id": authority.call_id().map(converact_voice_agent_contracts::CallId::as_str),
            "agent_release_id": authority.agent_release_id().as_str(),
            "channel_agent_session_id": self.channel_agent_session_id.as_str(),
            "execution_generation": authority.execution_generation().get(),
            "event_kind": "asr_final",
            "track_id": track_id,
            "timestamp_ms": timestamp_ms,
            "upstream_index": index,
        }))
        .map_err(|_| ActiveCallTranscriptIngestError::InvalidIdentity)?;
        let source_event_id = EventId::parse(format!("active-call-final.{digest}"))
            .map_err(|_| ActiveCallTranscriptIngestError::InvalidIdentity)?;
        let id = TranscriptSegmentId::parse(format!("transcript.active-call-final.{digest}"))
            .map_err(|_| ActiveCallTranscriptIngestError::InvalidIdentity)?;

        TranscriptSegmentDraft::try_new(TranscriptSegmentDraftInput {
            id,
            context: authority.clone(),
            source_event_id,
            speaker: TranscriptSpeaker::Customer,
            language: self.language.to_string(),
            text: text.as_str().to_owned(),
            start_offset_ms,
            end_offset_ms,
            observed_at_ms: *timestamp_ms,
            retention_policy_ref: self.retention_policy_ref.to_string(),
        })
        .map(Some)
        .map_err(|_| ActiveCallTranscriptIngestError::InvalidDraft)
    }
}

impl fmt::Debug for ActiveCallTranscriptBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActiveCallTranscriptBinding")
            .field("has_customer_track", &true)
            .field("call_started_at_ms", &self.call_started_at_ms)
            .field("language", &self.language)
            .field("retention_policy_ref", &self.retention_policy_ref)
            .finish_non_exhaustive()
    }
}

/// Atomically allocates the stream sequence and appends one eligible final transcript.
///
/// # Errors
///
/// Returns a low-cardinality ingest failure and never exposes Store details or transcript text.
pub async fn append_active_call_final_transcript<D>(
    store: &D,
    binding: &ActiveCallTranscriptBinding,
    event: &NormalizedEvent,
    current_generation: ExecutionGeneration,
) -> Result<Option<D::Append>, ActiveCallTranscriptIngestError>
where
    D: ActiveCallTranscriptDurabilityPort,
{
    let Some(draft) = binding.draft_for_event(event)? else {
        return Ok(None);
    };
    store
        .append_sequenced_final_segment(&draft, current_generation)
        .await
        .map(Some)
}

fn bounded_identifier(value: &str, maximum: usize) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= maximum
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn bounded_reference(value: &str, maximum: usize) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= maximum
        && first.is_ascii_alphanumeric()
        && remainder.iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
        })
}
