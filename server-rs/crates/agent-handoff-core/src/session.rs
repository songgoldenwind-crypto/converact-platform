use std::fmt;

use converact_voice_agent_contracts::{
    CallId, ChannelAgentSessionId, EnvelopeContext, ExecutionGeneration, HandoffId, HumanLegId,
};

use crate::{ContextPacket, ControlOwner, HandoffError, HandoffState, HandoffTarget};

/// One durable ownership transaction within an established Call.
#[derive(Clone, Eq, PartialEq)]
pub struct HandoffSession {
    id: HandoffId,
    context: EnvelopeContext,
    context_packet: ContextPacket,
    target: HandoffTarget,
    state: HandoffState,
    owner: ControlOwner,
    execution_generation: ExecutionGeneration,
    revision: u64,
    human_leg_id: Option<HumanLegId>,
    ai_session_id: ChannelAgentSessionId,
    reconcile_from: Option<HandoffState>,
}

impl HandoffSession {
    /// Requests a Handoff on an established AI-controlled Call.
    ///
    /// # Errors
    ///
    /// Rejects contexts without a Call or active AI session.
    pub fn request(
        id: HandoffId,
        context: EnvelopeContext,
        context_packet: ContextPacket,
        target: HandoffTarget,
    ) -> Result<Self, HandoffError> {
        if context.call_id().is_none() {
            return Err(HandoffError::CallRequired);
        }
        let ai_session_id = context
            .channel_agent_session_id()
            .cloned()
            .ok_or(HandoffError::AiSessionRequired)?;
        let execution_generation = context.execution_generation();
        Ok(Self {
            id,
            context,
            context_packet,
            target,
            state: HandoffState::Requested,
            owner: ControlOwner::Ai,
            execution_generation,
            revision: 1,
            human_leg_id: None,
            ai_session_id,
            reconcile_from: None,
        })
    }

    /// Freezes the Context Packet and target before any human dialing effect.
    ///
    /// # Errors
    ///
    /// Rejects a stale fence, unresolved Handoff or invalid state transition.
    pub fn prepare(
        &self,
        expected_revision: u64,
        expected_generation: ExecutionGeneration,
    ) -> Result<Self, HandoffError> {
        self.transition(
            expected_revision,
            expected_generation,
            HandoffState::Requested,
            HandoffState::Prepared,
        )
    }

    /// Records the exact `RustPBX` human Leg chosen by a prepared effect.
    ///
    /// # Errors
    ///
    /// Rejects a stale fence, unresolved Handoff or invalid state transition.
    pub fn observe_human_leg_dialing(
        &self,
        expected_revision: u64,
        expected_generation: ExecutionGeneration,
        leg_id: HumanLegId,
    ) -> Result<Self, HandoffError> {
        let mut next = self.transition(
            expected_revision,
            expected_generation,
            HandoffState::Prepared,
            HandoffState::HumanLegDialing,
        )?;
        next.human_leg_id = Some(leg_id);
        Ok(next)
    }

    /// Records an answered observation for the already bound human Leg.
    ///
    /// # Errors
    ///
    /// Rejects a missing Leg, stale fence, unresolved Handoff or invalid state transition.
    pub fn observe_human_leg_answered(
        &self,
        expected_revision: u64,
        expected_generation: ExecutionGeneration,
    ) -> Result<Self, HandoffError> {
        if self.human_leg_id.is_none() {
            return Err(HandoffError::HumanLegRequired);
        }
        self.transition(
            expected_revision,
            expected_generation,
            HandoffState::HumanLegDialing,
            HandoffState::HumanLegAnswered,
        )
    }

    /// Atomically fences the AI generation and grants control to the answered human Leg.
    ///
    /// # Errors
    ///
    /// Rejects a stale fence, unresolved Handoff, invalid transition or generation overflow.
    pub fn commit_human(
        &self,
        expected_revision: u64,
        expected_generation: ExecutionGeneration,
    ) -> Result<Self, HandoffError> {
        let mut next = self.transition(
            expected_revision,
            expected_generation,
            HandoffState::HumanLegAnswered,
            HandoffState::Committed,
        )?;
        next.execution_generation = next_generation(self.execution_generation)?;
        next.owner = ControlOwner::Human;
        Ok(next)
    }

    /// Marks the committed human generation media-active without changing ownership again.
    ///
    /// # Errors
    ///
    /// Rejects a stale fence, unresolved Handoff or invalid state transition.
    pub fn mark_human_active(
        &self,
        expected_revision: u64,
        expected_generation: ExecutionGeneration,
    ) -> Result<Self, HandoffError> {
        self.transition(
            expected_revision,
            expected_generation,
            HandoffState::Committed,
            HandoffState::HumanActive,
        )
    }

    /// Binds a prepared replacement AI session while the human remains the owner.
    ///
    /// # Errors
    ///
    /// Rejects a reused session, stale fence, unresolved Handoff or invalid transition.
    pub fn prepare_ai_resume(
        &self,
        expected_revision: u64,
        expected_generation: ExecutionGeneration,
        ai_session_id: ChannelAgentSessionId,
    ) -> Result<Self, HandoffError> {
        self.verify(expected_revision, expected_generation)?;
        if self.state != HandoffState::HumanActive {
            return Err(HandoffError::InvalidTransition);
        }
        if ai_session_id == self.ai_session_id {
            return Err(HandoffError::AiSessionReused);
        }
        let mut next = self.with_state(HandoffState::AiResumePreparing)?;
        next.ai_session_id = ai_session_id;
        Ok(next)
    }

    /// Atomically fences the human generation and grants control to the ready AI session.
    ///
    /// # Errors
    ///
    /// Rejects a stale fence, unresolved Handoff, invalid transition or generation overflow.
    pub fn commit_ai_resume(
        &self,
        expected_revision: u64,
        expected_generation: ExecutionGeneration,
    ) -> Result<Self, HandoffError> {
        let mut next = self.transition(
            expected_revision,
            expected_generation,
            HandoffState::AiResumePreparing,
            HandoffState::AiResumed,
        )?;
        next.execution_generation = next_generation(self.execution_generation)?;
        next.owner = ControlOwner::Ai;
        Ok(next)
    }

    /// Aborts only before an answered human Leg can acquire control.
    ///
    /// # Errors
    ///
    /// Rejects a stale fence, unresolved Handoff or transition after answer.
    pub fn abort(
        &self,
        expected_revision: u64,
        expected_generation: ExecutionGeneration,
    ) -> Result<Self, HandoffError> {
        self.verify(expected_revision, expected_generation)?;
        if !matches!(
            self.state,
            HandoffState::Requested | HandoffState::Prepared | HandoffState::HumanLegDialing
        ) {
            return Err(HandoffError::InvalidTransition);
        }
        self.with_state(HandoffState::Aborted)
    }

    /// Suspends normal transitions until typed external observations are reconciled.
    ///
    /// # Errors
    ///
    /// Rejects a stale fence, already unresolved Handoff or terminal state.
    pub fn require_reconcile(
        &self,
        expected_revision: u64,
        expected_generation: ExecutionGeneration,
    ) -> Result<Self, HandoffError> {
        self.verify(expected_revision, expected_generation)?;
        if self.state.is_terminal() {
            return Err(HandoffError::InvalidTransition);
        }
        let mut next = self.with_state(HandoffState::ReconcileRequired)?;
        next.reconcile_from = Some(self.state);
        Ok(next)
    }

    fn transition(
        &self,
        expected_revision: u64,
        expected_generation: ExecutionGeneration,
        expected_state: HandoffState,
        next_state: HandoffState,
    ) -> Result<Self, HandoffError> {
        self.verify(expected_revision, expected_generation)?;
        if self.state != expected_state {
            return Err(HandoffError::InvalidTransition);
        }
        self.with_state(next_state)
    }

    fn verify(
        &self,
        expected_revision: u64,
        expected_generation: ExecutionGeneration,
    ) -> Result<(), HandoffError> {
        if self.state == HandoffState::ReconcileRequired {
            return Err(HandoffError::ReconcileRequired);
        }
        if self.revision != expected_revision {
            return Err(HandoffError::StaleRevision);
        }
        if self.execution_generation != expected_generation {
            return Err(HandoffError::StaleGeneration);
        }
        Ok(())
    }

    fn with_state(&self, state: HandoffState) -> Result<Self, HandoffError> {
        let mut next = self.clone();
        next.revision = self
            .revision
            .checked_add(1)
            .ok_or(HandoffError::RevisionExhausted)?;
        next.state = state;
        Ok(next)
    }

    #[must_use]
    pub const fn id(&self) -> &HandoffId {
        &self.id
    }

    #[must_use]
    pub const fn context(&self) -> &EnvelopeContext {
        &self.context
    }

    #[must_use]
    pub const fn call_id(&self) -> &CallId {
        match self.context.call_id() {
            Some(call_id) => call_id,
            None => unreachable!(),
        }
    }

    #[must_use]
    pub const fn context_packet(&self) -> &ContextPacket {
        &self.context_packet
    }

    #[must_use]
    pub const fn target(&self) -> &HandoffTarget {
        &self.target
    }

    #[must_use]
    pub const fn state(&self) -> HandoffState {
        self.state
    }

    #[must_use]
    pub const fn owner(&self) -> ControlOwner {
        self.owner
    }

    #[must_use]
    pub const fn execution_generation(&self) -> ExecutionGeneration {
        self.execution_generation
    }

    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    #[must_use]
    pub const fn human_leg_id(&self) -> Option<&HumanLegId> {
        self.human_leg_id.as_ref()
    }

    #[must_use]
    pub const fn ai_session_id(&self) -> &ChannelAgentSessionId {
        &self.ai_session_id
    }

    #[must_use]
    pub const fn reconcile_from(&self) -> Option<HandoffState> {
        self.reconcile_from
    }
}

impl fmt::Debug for HandoffSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HandoffSession")
            .field("id", &self.id)
            .field("state", &self.state)
            .field("owner", &self.owner)
            .field("execution_generation", &self.execution_generation)
            .field("revision", &self.revision)
            .finish_non_exhaustive()
    }
}

fn next_generation(generation: ExecutionGeneration) -> Result<ExecutionGeneration, HandoffError> {
    generation
        .next()
        .map_err(|_| HandoffError::GenerationExhausted)
}
