use std::{error::Error, fmt};

use converact_voice_agent_contracts::{
    AudioWriteOutcome, ContextRevision, PcmAudioFrame, ResponseFence, ResponseGeneration,
    ResponseLease, ResponseLeaseGeneration, SpeechControlFence, SpeechSessionBinding,
    SpeechSessionState,
};

/// Stable failures returned by the pure Speech Runtime authority aggregate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpeechSessionError {
    StaleControlFence,
    StaleResponseFence,
    SessionNotActive,
    ResponseAlreadyActive,
    ResponseNotActive,
    ResponseGenerationNotMonotonic,
    AudioSequenceNotMonotonic,
    AudioClockNotMonotonic,
}

impl fmt::Display for SpeechSessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::StaleControlFence => "speech_session_control_fence_stale",
            Self::StaleResponseFence => "speech_session_response_fence_stale",
            Self::SessionNotActive => "speech_session_not_active",
            Self::ResponseAlreadyActive => "speech_session_response_already_active",
            Self::ResponseNotActive => "speech_session_response_not_active",
            Self::ResponseGenerationNotMonotonic => {
                "speech_session_response_generation_not_monotonic"
            }
            Self::AudioSequenceNotMonotonic => "speech_session_audio_sequence_not_monotonic",
            Self::AudioClockNotMonotonic => "speech_session_audio_clock_not_monotonic",
        })
    }
}

impl Error for SpeechSessionError {}

/// Pure provider-neutral Speech session authority.
///
/// This aggregate owns no socket, task, lock, queue or Provider resource. A durable adapter must
/// persist it before applying directed external effects.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpeechSession {
    binding: SpeechSessionBinding,
    state: SpeechSessionState,
    current_response: Option<ResponseLease>,
    last_response_fence: Option<ResponseFence>,
    last_context_revision: Option<ContextRevision>,
    last_lease_generation: Option<ResponseLeaseGeneration>,
    last_response_generation: Option<ResponseGeneration>,
    last_audio_sequence: Option<u64>,
    last_audio_capture_mono_ns: Option<u64>,
}

impl SpeechSession {
    /// Creates a blocked session that cannot consume audio or create output before commit.
    #[must_use]
    pub const fn prepare(binding: SpeechSessionBinding) -> Self {
        Self {
            binding,
            state: SpeechSessionState::PreparedBlocked,
            current_response: None,
            last_response_fence: None,
            last_context_revision: None,
            last_lease_generation: None,
            last_response_generation: None,
            last_audio_sequence: None,
            last_audio_capture_mono_ns: None,
        }
    }

    #[must_use]
    pub const fn binding(&self) -> &SpeechSessionBinding {
        &self.binding
    }

    #[must_use]
    pub const fn state(&self) -> SpeechSessionState {
        self.state
    }

    #[must_use]
    pub const fn current_response(&self) -> Option<&ResponseLease> {
        self.current_response.as_ref()
    }

    /// Commits the prepared session under its exact control fence.
    ///
    /// # Errors
    ///
    /// Rejects stale authority and states other than prepared or already active.
    pub fn commit(&mut self, fence: SpeechControlFence) -> Result<(), SpeechSessionError> {
        self.require_control(fence)?;
        match self.state {
            SpeechSessionState::PreparedBlocked => {
                self.state = SpeechSessionState::Active;
                Ok(())
            }
            SpeechSessionState::Active => Ok(()),
            SpeechSessionState::ReconcileRequired | SpeechSessionState::Closed => {
                Err(SpeechSessionError::SessionNotActive)
            }
        }
    }

    /// Validates one canonical audio frame without storing or copying its payload.
    ///
    /// `queue_has_capacity` is supplied by the bounded Provider adapter. A dropped frame consumes
    /// its sequence so that delayed retries cannot reorder the media stream.
    ///
    /// # Errors
    ///
    /// Rejects stale control authority, pre-commit audio and non-monotonic sequence numbers.
    pub fn try_write_audio(
        &mut self,
        fence: SpeechControlFence,
        frame: &PcmAudioFrame,
        queue_has_capacity: bool,
    ) -> Result<AudioWriteOutcome, SpeechSessionError> {
        self.require_control(fence)?;
        if self.state == SpeechSessionState::Closed {
            return Ok(AudioWriteOutcome::Closed);
        }
        if self.state != SpeechSessionState::Active {
            return Err(SpeechSessionError::SessionNotActive);
        }
        if self
            .last_audio_sequence
            .is_some_and(|sequence| frame.sequence() <= sequence)
        {
            return Err(SpeechSessionError::AudioSequenceNotMonotonic);
        }
        if self
            .last_audio_capture_mono_ns
            .is_some_and(|captured| frame.captured_at_mono_ns() <= captured)
        {
            return Err(SpeechSessionError::AudioClockNotMonotonic);
        }
        self.last_audio_sequence = Some(frame.sequence());
        self.last_audio_capture_mono_ns = Some(frame.captured_at_mono_ns());
        Ok(if queue_has_capacity {
            AudioWriteOutcome::Accepted
        } else {
            AudioWriteOutcome::DroppedOverflow
        })
    }

    /// Activates one strictly newer response lease.
    ///
    /// # Errors
    ///
    /// Rejects stale control authority, inactive sessions, concurrent responses and any response,
    /// lease, fence or context generation that moves backwards.
    pub fn create_response(
        &mut self,
        fence: SpeechControlFence,
        lease: ResponseLease,
    ) -> Result<(), SpeechSessionError> {
        self.require_control(fence)?;
        if self.state != SpeechSessionState::Active {
            return Err(SpeechSessionError::SessionNotActive);
        }
        if self.current_response.is_some() {
            return Err(SpeechSessionError::ResponseAlreadyActive);
        }
        if is_not_newer(
            self.last_response_generation.map(ResponseGeneration::get),
            lease.response_generation().get(),
        ) || is_not_newer(
            self.last_lease_generation.map(ResponseLeaseGeneration::get),
            lease.lease_generation().get(),
        ) || is_not_newer(
            self.last_response_fence.map(ResponseFence::get),
            lease.response_fence().get(),
        ) || self
            .last_context_revision
            .is_some_and(|revision| lease.context_revision() < revision)
        {
            return Err(SpeechSessionError::ResponseGenerationNotMonotonic);
        }
        self.last_context_revision = Some(lease.context_revision());
        self.last_lease_generation = Some(lease.lease_generation());
        self.last_response_generation = Some(lease.response_generation());
        self.last_response_fence = Some(lease.response_fence());
        self.current_response = Some(lease);
        Ok(())
    }

    /// Cancels the current response under both current fences.
    ///
    /// Returns `false` for an idempotent replay of the most recently completed cancellation.
    ///
    /// # Errors
    ///
    /// Rejects stale control/response authority and a fence that never identified a response.
    pub fn cancel_response(
        &mut self,
        control_fence: SpeechControlFence,
        response_fence: ResponseFence,
    ) -> Result<bool, SpeechSessionError> {
        self.require_control(control_fence)?;
        let Some(current) = self.current_response.as_ref() else {
            return if self.last_response_fence == Some(response_fence) {
                Ok(false)
            } else {
                Err(SpeechSessionError::ResponseNotActive)
            };
        };
        if current.response_fence() != response_fence {
            return Err(SpeechSessionError::StaleResponseFence);
        }
        self.current_response = None;
        Ok(true)
    }

    /// Moves the session into reconcile-required and revokes the current response.
    ///
    /// # Errors
    ///
    /// Rejects stale control authority or an already closed session.
    pub fn require_reconcile(
        &mut self,
        fence: SpeechControlFence,
    ) -> Result<(), SpeechSessionError> {
        self.require_control(fence)?;
        if self.state == SpeechSessionState::Closed {
            return Err(SpeechSessionError::SessionNotActive);
        }
        self.current_response = None;
        self.state = SpeechSessionState::ReconcileRequired;
        Ok(())
    }

    /// Idempotently closes the session and revokes any active response.
    ///
    /// # Errors
    ///
    /// Rejects stale control authority.
    pub fn close(&mut self, fence: SpeechControlFence) -> Result<(), SpeechSessionError> {
        self.require_control(fence)?;
        self.current_response = None;
        self.state = SpeechSessionState::Closed;
        Ok(())
    }

    fn require_control(&self, fence: SpeechControlFence) -> Result<(), SpeechSessionError> {
        if self.binding.control_fence() == fence {
            Ok(())
        } else {
            Err(SpeechSessionError::StaleControlFence)
        }
    }
}

fn is_not_newer(previous: Option<u64>, candidate: u64) -> bool {
    previous.is_some_and(|value| candidate <= value)
}
