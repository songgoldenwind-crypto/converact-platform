use std::{error::Error, fmt};

use converact_agent_handoff_core::{ControlOwner, HandoffSession};
use converact_voice_agent_contracts::{
    CallId, ChannelAgentSessionId, ExecutionGeneration, HandoffCommandId, HandoffId, HumanLegId,
};

/// Stable command IDs required to make a complete human activation replay-safe.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HumanActivationCommandIds {
    pub request: HandoffCommandId,
    pub prepare: HandoffCommandId,
    pub dial: HandoffCommandId,
    pub observe_answered: HandoffCommandId,
    pub commit: HandoffCommandId,
    pub mark_active: HandoffCommandId,
    pub abort_before_dial: HandoffCommandId,
    pub abort_after_dial: HandoffCommandId,
}

/// Stable command IDs required to make AI resume replay-safe.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AiResumeCommandIds {
    pub prepare: HandoffCommandId,
    pub commit: HandoffCommandId,
}

/// Closed external effect observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectObservation {
    Applied,
    NotApplied(&'static str),
    OutcomeUnknown,
}

/// Read-only human Leg observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HumanLegObservation {
    Dialing,
    Answered,
    Ended(&'static str),
    NotFound,
    OutcomeUnknown,
}

/// Durable progress returned without pretending a pending external fact completed.
#[derive(Debug)]
pub enum HandoffProgress {
    HumanActive(HandoffSession),
    AiResumed(HandoffSession),
    Pending(HandoffSession),
    Aborted(HandoffSession),
    NotApplied {
        session: HandoffSession,
        failure_code: &'static str,
    },
    ReconcileRequired(HandoffSession),
}

/// Idempotent platform request to establish a preallocated human Leg identity.
#[derive(Clone)]
pub struct HumanDialRequest {
    tenant_id: Box<str>,
    handoff_id: HandoffId,
    call_id: CallId,
    human_leg_id: HumanLegId,
    queue: Box<str>,
    skills: Box<[Box<str>]>,
    preferred_seat: Option<Box<str>>,
    execution_generation: ExecutionGeneration,
    idempotency_key: HandoffCommandId,
}

impl HumanDialRequest {
    pub(crate) fn from_handoff(
        handoff: &HandoffSession,
        human_leg_id: HumanLegId,
        idempotency_key: HandoffCommandId,
    ) -> Self {
        Self {
            tenant_id: handoff.context().tenant_id().into(),
            handoff_id: handoff.id().clone(),
            call_id: handoff.call_id().clone(),
            human_leg_id,
            queue: handoff.target().queue().into(),
            skills: handoff.target().skills().to_vec().into_boxed_slice(),
            preferred_seat: handoff.target().preferred_seat().map(Into::into),
            execution_generation: handoff.execution_generation(),
            idempotency_key,
        }
    }

    #[must_use]
    pub fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    #[must_use]
    pub const fn handoff_id(&self) -> &HandoffId {
        &self.handoff_id
    }

    #[must_use]
    pub const fn call_id(&self) -> &CallId {
        &self.call_id
    }

    #[must_use]
    pub const fn human_leg_id(&self) -> &HumanLegId {
        &self.human_leg_id
    }

    #[must_use]
    pub fn queue(&self) -> &str {
        &self.queue
    }

    #[must_use]
    pub fn skills(&self) -> &[Box<str>] {
        &self.skills
    }

    #[must_use]
    pub fn preferred_seat(&self) -> Option<&str> {
        self.preferred_seat.as_deref()
    }

    #[must_use]
    pub const fn execution_generation(&self) -> ExecutionGeneration {
        self.execution_generation
    }

    #[must_use]
    pub const fn idempotency_key(&self) -> &HandoffCommandId {
        &self.idempotency_key
    }
}

impl fmt::Debug for HumanDialRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HumanDialRequest")
            .field("handoff_id", &self.handoff_id)
            .field("call_id", &self.call_id)
            .field("human_leg_id", &self.human_leg_id)
            .field("execution_generation", &self.execution_generation)
            .field("idempotency_key", &self.idempotency_key)
            .finish_non_exhaustive()
    }
}

/// Idempotent request to prepare a new AI session under the current human generation.
#[derive(Clone)]
pub struct AiResumeRequest {
    tenant_id: Box<str>,
    handoff_id: HandoffId,
    call_id: CallId,
    ai_session_id: ChannelAgentSessionId,
    execution_generation: ExecutionGeneration,
    idempotency_key: HandoffCommandId,
}

impl AiResumeRequest {
    pub(crate) fn from_handoff(
        handoff: &HandoffSession,
        ai_session_id: ChannelAgentSessionId,
        idempotency_key: HandoffCommandId,
    ) -> Self {
        Self {
            tenant_id: handoff.context().tenant_id().into(),
            handoff_id: handoff.id().clone(),
            call_id: handoff.call_id().clone(),
            ai_session_id,
            execution_generation: handoff.execution_generation(),
            idempotency_key,
        }
    }

    #[must_use]
    pub fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    #[must_use]
    pub const fn handoff_id(&self) -> &HandoffId {
        &self.handoff_id
    }

    #[must_use]
    pub const fn call_id(&self) -> &CallId {
        &self.call_id
    }

    #[must_use]
    pub const fn ai_session_id(&self) -> &ChannelAgentSessionId {
        &self.ai_session_id
    }

    #[must_use]
    pub const fn execution_generation(&self) -> ExecutionGeneration {
        self.execution_generation
    }

    #[must_use]
    pub const fn idempotency_key(&self) -> &HandoffCommandId {
        &self.idempotency_key
    }
}

impl fmt::Debug for AiResumeRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AiResumeRequest")
            .field("handoff_id", &self.handoff_id)
            .field("call_id", &self.call_id)
            .field("ai_session_id", &self.ai_session_id)
            .field("execution_generation", &self.execution_generation)
            .field("idempotency_key", &self.idempotency_key)
            .finish_non_exhaustive()
    }
}

/// Idempotent notification that a durable owner generation was already committed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GenerationCommit {
    tenant_id: Box<str>,
    handoff_id: HandoffId,
    call_id: CallId,
    ai_session_id: ChannelAgentSessionId,
    owner: ControlOwner,
    generation: ExecutionGeneration,
    idempotency_key: HandoffCommandId,
}

impl GenerationCommit {
    pub(crate) fn from_handoff(
        handoff: &HandoffSession,
        idempotency_key: HandoffCommandId,
    ) -> Self {
        Self {
            tenant_id: handoff.context().tenant_id().into(),
            handoff_id: handoff.id().clone(),
            call_id: handoff.call_id().clone(),
            ai_session_id: handoff.ai_session_id().clone(),
            owner: handoff.owner(),
            generation: handoff.execution_generation(),
            idempotency_key,
        }
    }

    #[must_use]
    pub fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    #[must_use]
    pub const fn handoff_id(&self) -> &HandoffId {
        &self.handoff_id
    }

    #[must_use]
    pub const fn call_id(&self) -> &CallId {
        &self.call_id
    }

    #[must_use]
    pub const fn ai_session_id(&self) -> &ChannelAgentSessionId {
        &self.ai_session_id
    }

    #[must_use]
    pub const fn owner(&self) -> ControlOwner {
        self.owner
    }

    #[must_use]
    pub const fn generation(&self) -> ExecutionGeneration {
        self.generation
    }

    #[must_use]
    pub const fn idempotency_key(&self) -> &HandoffCommandId {
        &self.idempotency_key
    }
}

/// Low-cardinality orchestration failure safe for logs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VoiceHandoffRuntimeError {
    code: &'static str,
}

impl VoiceHandoffRuntimeError {
    pub(crate) const fn new(code: &'static str) -> Self {
        Self { code }
    }

    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for VoiceHandoffRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for VoiceHandoffRuntimeError {}
