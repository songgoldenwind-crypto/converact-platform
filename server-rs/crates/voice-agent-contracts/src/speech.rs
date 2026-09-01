use std::{error::Error, fmt};

use serde::{
    Deserialize, Deserializer, Serialize,
    de::{Error as _, SeqAccess, Visitor},
};

use crate::{
    AgentRunId, ChannelBindingId, ExecutionGeneration, InteractionId, SpeechResponseId,
    SpeechSessionId, TenantId,
};

const PCM_BYTES_PER_SAMPLE: usize = 2;
const MAX_AUDIO_FRAME_DURATION_MS: usize = 60;
const MAX_CANONICAL_PCM_BYTES: usize = 11_520;

/// Stable rejection categories for provider-neutral Speech Runtime wire values.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpeechContractError {
    InvalidGeneration,
    UnsupportedSampleRate,
    UnsupportedChannels,
    InvalidAudioFrame,
    AudioFrameTooLarge,
}

impl fmt::Display for SpeechContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidGeneration => "speech_runtime_generation_invalid",
            Self::UnsupportedSampleRate => "speech_runtime_sample_rate_unsupported",
            Self::UnsupportedChannels => "speech_runtime_channels_unsupported",
            Self::InvalidAudioFrame => "speech_runtime_audio_frame_invalid",
            Self::AudioFrameTooLarge => "speech_runtime_audio_frame_too_large",
        })
    }
}

impl Error for SpeechContractError {}

macro_rules! positive_speech_value {
    ($name:ident) => {
        #[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
        #[serde(transparent)]
        pub struct $name(u64);

        impl $name {
            /// Creates a positive authority value.
            ///
            /// # Errors
            ///
            /// Rejects zero because it cannot identify an issued authority generation.
            pub const fn new(value: u64) -> Result<Self, SpeechContractError> {
                if value == 0 {
                    Err(SpeechContractError::InvalidGeneration)
                } else {
                    Ok(Self(value))
                }
            }

            #[must_use]
            pub const fn get(self) -> u64 {
                self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                Self::new(u64::deserialize(deserializer)?).map_err(D::Error::custom)
            }
        }
    };
}

positive_speech_value!(SpeechControlFence);
positive_speech_value!(ResponseFence);
positive_speech_value!(ContextRevision);
positive_speech_value!(ResponseLeaseGeneration);
positive_speech_value!(ResponseGeneration);

/// Exact authority binding for one provider-neutral speech session.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SpeechSessionBinding {
    tenant_id: TenantId,
    interaction_id: InteractionId,
    agent_run_id: AgentRunId,
    speech_session_id: SpeechSessionId,
    channel_binding_id: ChannelBindingId,
    session_generation: ExecutionGeneration,
    media_generation: ExecutionGeneration,
    control_fence: SpeechControlFence,
}

impl SpeechSessionBinding {
    #[allow(clippy::too_many_arguments)]
    #[must_use]
    pub const fn new(
        tenant_id: TenantId,
        interaction_id: InteractionId,
        agent_run_id: AgentRunId,
        speech_session_id: SpeechSessionId,
        channel_binding_id: ChannelBindingId,
        session_generation: ExecutionGeneration,
        media_generation: ExecutionGeneration,
        control_fence: SpeechControlFence,
    ) -> Self {
        Self {
            tenant_id,
            interaction_id,
            agent_run_id,
            speech_session_id,
            channel_binding_id,
            session_generation,
            media_generation,
            control_fence,
        }
    }

    #[must_use]
    pub const fn tenant_id(&self) -> &TenantId {
        &self.tenant_id
    }

    #[must_use]
    pub const fn interaction_id(&self) -> &InteractionId {
        &self.interaction_id
    }

    #[must_use]
    pub const fn agent_run_id(&self) -> &AgentRunId {
        &self.agent_run_id
    }

    #[must_use]
    pub const fn speech_session_id(&self) -> &SpeechSessionId {
        &self.speech_session_id
    }

    #[must_use]
    pub const fn channel_binding_id(&self) -> &ChannelBindingId {
        &self.channel_binding_id
    }

    #[must_use]
    pub const fn session_generation(&self) -> ExecutionGeneration {
        self.session_generation
    }

    #[must_use]
    pub const fn media_generation(&self) -> ExecutionGeneration {
        self.media_generation
    }

    #[must_use]
    pub const fn control_fence(&self) -> SpeechControlFence {
        self.control_fence
    }
}

/// Exact output lease for one response generation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResponseLease {
    response_id: SpeechResponseId,
    context_revision: ContextRevision,
    lease_generation: ResponseLeaseGeneration,
    response_generation: ResponseGeneration,
    response_fence: ResponseFence,
}

impl ResponseLease {
    #[must_use]
    pub const fn new(
        response_id: SpeechResponseId,
        context_revision: ContextRevision,
        lease_generation: ResponseLeaseGeneration,
        response_generation: ResponseGeneration,
        response_fence: ResponseFence,
    ) -> Self {
        Self {
            response_id,
            context_revision,
            lease_generation,
            response_generation,
            response_fence,
        }
    }

    #[must_use]
    pub const fn response_id(&self) -> &SpeechResponseId {
        &self.response_id
    }

    #[must_use]
    pub const fn context_revision(&self) -> ContextRevision {
        self.context_revision
    }

    #[must_use]
    pub const fn lease_generation(&self) -> ResponseLeaseGeneration {
        self.lease_generation
    }

    #[must_use]
    pub const fn response_generation(&self) -> ResponseGeneration {
        self.response_generation
    }

    #[must_use]
    pub const fn response_fence(&self) -> ResponseFence {
        self.response_fence
    }
}

/// Encoding accepted by the first canonical audio boundary.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioEncoding {
    PcmS16le,
}

/// Bounded canonical PCM frame. Raw audio is intentionally redacted from `Debug`.
#[derive(Clone, Eq, PartialEq, Serialize)]
pub struct PcmAudioFrame {
    sequence: u64,
    captured_at_mono_ns: u64,
    encoding: AudioEncoding,
    sample_rate_hz: u32,
    channels: u8,
    payload: Box<[u8]>,
}

#[derive(Deserialize)]
struct PcmAudioFrameWire {
    sequence: u64,
    captured_at_mono_ns: u64,
    encoding: AudioEncoding,
    sample_rate_hz: u32,
    channels: u8,
    payload: BoundedPcmPayload,
}

struct BoundedPcmPayload(Box<[u8]>);

struct BoundedPcmPayloadVisitor;

impl<'de> Visitor<'de> for BoundedPcmPayloadVisitor {
    type Value = BoundedPcmPayload;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("at most 11520 canonical PCM bytes")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        if sequence
            .size_hint()
            .is_some_and(|size| size > MAX_CANONICAL_PCM_BYTES)
        {
            return Err(A::Error::custom(SpeechContractError::AudioFrameTooLarge));
        }
        let mut payload = Vec::with_capacity(
            sequence
                .size_hint()
                .unwrap_or_default()
                .min(MAX_CANONICAL_PCM_BYTES),
        );
        while let Some(byte) = sequence.next_element::<u8>()? {
            if payload.len() == MAX_CANONICAL_PCM_BYTES {
                return Err(A::Error::custom(SpeechContractError::AudioFrameTooLarge));
            }
            payload.push(byte);
        }
        Ok(BoundedPcmPayload(payload.into_boxed_slice()))
    }
}

impl<'de> Deserialize<'de> for BoundedPcmPayload {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_seq(BoundedPcmPayloadVisitor)
    }
}

impl PcmAudioFrame {
    /// Validates canonical PCM geometry and a maximum duration of 60 milliseconds.
    ///
    /// # Errors
    ///
    /// Rejects unsupported rates/channels, zero authority fields, malformed sample alignment and
    /// frames longer than 60 milliseconds.
    pub fn try_new(
        sequence: u64,
        captured_at_mono_ns: u64,
        sample_rate_hz: u32,
        channels: u8,
        payload: Vec<u8>,
    ) -> Result<Self, SpeechContractError> {
        let samples_per_second = match sample_rate_hz {
            8_000 => 8_000_usize,
            16_000 => 16_000_usize,
            24_000 => 24_000_usize,
            48_000 => 48_000_usize,
            _ => return Err(SpeechContractError::UnsupportedSampleRate),
        };
        if !matches!(channels, 1 | 2) {
            return Err(SpeechContractError::UnsupportedChannels);
        }
        if sequence == 0 || captured_at_mono_ns == 0 || payload.is_empty() {
            return Err(SpeechContractError::InvalidAudioFrame);
        }
        let sample_width = PCM_BYTES_PER_SAMPLE * usize::from(channels);
        if !payload.len().is_multiple_of(sample_width) {
            return Err(SpeechContractError::InvalidAudioFrame);
        }
        let max_bytes = samples_per_second * sample_width * MAX_AUDIO_FRAME_DURATION_MS / 1_000;
        if payload.len() > max_bytes {
            return Err(SpeechContractError::AudioFrameTooLarge);
        }
        Ok(Self {
            sequence,
            captured_at_mono_ns,
            encoding: AudioEncoding::PcmS16le,
            sample_rate_hz,
            channels,
            payload: payload.into_boxed_slice(),
        })
    }

    #[must_use]
    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    #[must_use]
    pub const fn captured_at_mono_ns(&self) -> u64 {
        self.captured_at_mono_ns
    }

    #[must_use]
    pub const fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    #[must_use]
    pub const fn channels(&self) -> u8 {
        self.channels
    }

    #[must_use]
    pub const fn payload(&self) -> &[u8] {
        &self.payload
    }
}

impl fmt::Debug for PcmAudioFrame {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PcmAudioFrame")
            .field("sequence", &self.sequence)
            .field("captured_at_mono_ns", &self.captured_at_mono_ns)
            .field("encoding", &self.encoding)
            .field("sample_rate_hz", &self.sample_rate_hz)
            .field("channels", &self.channels)
            .field("payload_bytes", &self.payload.len())
            .finish()
    }
}

impl<'de> Deserialize<'de> for PcmAudioFrame {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = PcmAudioFrameWire::deserialize(deserializer)?;
        if wire.encoding != AudioEncoding::PcmS16le {
            return Err(D::Error::custom(SpeechContractError::InvalidAudioFrame));
        }
        Self::try_new(
            wire.sequence,
            wire.captured_at_mono_ns,
            wire.sample_rate_hz,
            wire.channels,
            wire.payload.0.into_vec(),
        )
        .map_err(D::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechSessionState {
    PreparedBlocked,
    Active,
    ReconcileRequired,
    Closed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioWriteOutcome {
    Accepted,
    DroppedOverflow,
    Closed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechRuntimeEventKind {
    SpeechStarted,
    SpeechStopped,
    TranscriptPartial,
    TranscriptFinal,
    TurnCommitted,
    ResponseCreated,
    ResponseTextDelta,
    ResponseAudioDelta,
    ResponseToolCall,
    ResponseCancelled,
    ResponseDone,
    UsageReported,
    SessionDegraded,
    SessionFailed,
    SessionClosed,
}
