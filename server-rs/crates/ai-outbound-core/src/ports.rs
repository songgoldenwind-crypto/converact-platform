use std::{error::Error, fmt, future::Future};

use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, ChannelAgentSessionId,
};

use crate::{
    CallAttempt, ComplianceDecision, ReleaseComponentDigests, agent_release::is_lowercase_sha256,
};

/// Invalid immutable Agent Release identity at the execution boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentReleaseBindingError {
    InvalidContentHash,
    InvalidComponents,
}

impl fmt::Display for AgentReleaseBindingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidContentHash => "agent_release_binding_content_hash_invalid",
            Self::InvalidComponents => "agent_release_binding_components_invalid",
        })
    }
}

impl Error for AgentReleaseBindingError {}

/// Exact immutable Agent Release selected by the Campaign for one execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentReleaseBinding {
    id: AgentReleaseId,
    content_hash: Box<str>,
    components: ReleaseComponentDigests,
}

impl AgentReleaseBinding {
    /// Binds an execution to a published Release identity and canonical content digest.
    ///
    /// # Errors
    ///
    /// Rejects anything other than a lowercase SHA-256 digest.
    pub fn try_new(
        id: AgentReleaseId,
        content_hash: impl AsRef<str>,
        components: ReleaseComponentDigests,
    ) -> Result<Self, AgentReleaseBindingError> {
        let content_hash = content_hash.as_ref();
        if !is_lowercase_sha256(content_hash) {
            return Err(AgentReleaseBindingError::InvalidContentHash);
        }
        if !components.is_valid() {
            return Err(AgentReleaseBindingError::InvalidComponents);
        }
        Ok(Self {
            id,
            content_hash: content_hash.into(),
            components,
        })
    }

    #[must_use]
    pub const fn id(&self) -> &AgentReleaseId {
        &self.id
    }

    #[must_use]
    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }

    #[must_use]
    pub const fn components(&self) -> &ReleaseComponentDigests {
        &self.components
    }
}

/// Stable failure category at a side-effect boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PortFailureKind {
    Unavailable,
    OutcomeUnknown,
    Rejected,
}

/// A bounded, sanitized failure returned by a narrow outbound port.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PortError {
    kind: PortFailureKind,
    code: &'static str,
}

impl PortError {
    /// Creates an unavailable dependency failure.
    #[must_use]
    pub const fn unavailable(code: &'static str) -> Self {
        Self {
            kind: PortFailureKind::Unavailable,
            code,
        }
    }

    /// Creates an indeterminate mutation result that must be reconciled.
    #[must_use]
    pub const fn outcome_unknown(code: &'static str) -> Self {
        Self {
            kind: PortFailureKind::OutcomeUnknown,
            code,
        }
    }

    /// Creates a deterministic dependency rejection.
    #[must_use]
    pub const fn rejected(code: &'static str) -> Self {
        Self {
            kind: PortFailureKind::Rejected,
            code,
        }
    }

    /// Returns the stable failure category.
    #[must_use]
    pub const fn kind(self) -> PortFailureKind {
        self.kind
    }

    /// Returns the sanitized machine code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

/// Effect intent durably recorded before the corresponding external mutation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectIntent {
    ReserveAgent,
    OriginateCall,
    AttachAgent,
    PlayDisclosure,
    StartConversation,
}

/// Request to reserve one bounded channel-agent slot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReserveAgent {
    pub attempt_id: CallAttemptId,
    pub release: AgentReleaseBinding,
    pub session_id: ChannelAgentSessionId,
}

/// Confirmed reservation returned by the channel-agent authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentReservation {
    pub session_id: ChannelAgentSessionId,
}

/// Request to attach a reserved agent session to an answered call.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachCall {
    pub attempt_id: CallAttemptId,
    pub call_id: CallId,
    pub session_id: ChannelAgentSessionId,
}

/// Request to play mandatory identity and recording disclosure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayDisclosure {
    pub attempt_id: CallAttemptId,
    pub session_id: ChannelAgentSessionId,
}

/// Request to begin the configured conversation only after disclosure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartConversation {
    pub attempt_id: CallAttemptId,
    pub session_id: ChannelAgentSessionId,
}

/// Closed observations accepted from the channel-agent adapter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentObservation {
    MediaReady,
    DisclosureCompleted,
    Conversing,
    Terminal,
    NotFound,
}

/// Request to originate one physical call with a stable identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OriginateCall {
    pub attempt_id: CallAttemptId,
    pub call_id: CallId,
}

/// Closed observations accepted from the `RustPBX` adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CallObservation {
    Answered(CallId),
    Active(CallId),
    Terminal(CallId),
    NotFound(CallId),
}

/// Request to terminate a call by its stable authority identifier.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminateCall {
    pub call_id: CallId,
}

/// Resolves compliance facts without performing telephony effects.
pub trait CompliancePort {
    /// Resolves the current pre-dial decision.
    ///
    /// # Errors
    ///
    /// Returns a sanitized dependency failure when required policy evidence cannot be resolved.
    fn evaluate(&self, attempt: &CallAttempt) -> Result<ComplianceDecision, PortError>;
}

/// Narrow boundary around the pinned channel-agent runtime.
pub trait ChannelAgentPort {
    fn reserve(
        &self,
        request: ReserveAgent,
    ) -> impl Future<Output = Result<AgentReservation, PortError>> + Send;

    fn attach(&self, request: AttachCall) -> impl Future<Output = Result<(), PortError>> + Send;

    fn play_disclosure(
        &self,
        request: PlayDisclosure,
    ) -> impl Future<Output = Result<(), PortError>> + Send;

    fn start_conversation(
        &self,
        request: StartConversation,
    ) -> impl Future<Output = Result<(), PortError>> + Send;

    fn query(
        &self,
        session: &ChannelAgentSessionId,
    ) -> impl Future<Output = Result<AgentObservation, PortError>> + Send;
}

/// Narrow boundary around `RustPBX` call control.
pub trait TelephonyPort {
    fn originate(
        &self,
        request: OriginateCall,
    ) -> impl Future<Output = Result<CallObservation, PortError>> + Send;

    fn query(
        &self,
        call_id: &CallId,
    ) -> impl Future<Output = Result<CallObservation, PortError>> + Send;

    fn terminate(
        &self,
        request: TerminateCall,
    ) -> impl Future<Output = Result<(), PortError>> + Send;
}

/// Durable Attempt authority used by the orchestrator.
pub trait AttemptStorePort {
    fn load(
        &self,
        attempt_id: &CallAttemptId,
    ) -> impl Future<Output = Result<CallAttempt, PortError>> + Send;

    fn persist_intent(
        &self,
        attempt: &CallAttempt,
        intent: EffectIntent,
    ) -> impl Future<Output = Result<(), PortError>> + Send;

    fn persist_observation(
        &self,
        attempt: &CallAttempt,
    ) -> impl Future<Output = Result<(), PortError>> + Send;
}
