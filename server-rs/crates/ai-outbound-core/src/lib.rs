//! Durable business authority for Converact AI outbound calls.

mod agent_release;
mod call_attempt;
mod campaign;
mod compliance;
mod orchestrator;
mod ports;

use std::{error::Error, fmt};

pub use agent_release::{
    AgentDraft, AgentRelease, AgentReleaseError, ReleaseComponentDigests, publish_agent,
};
pub use call_attempt::CallAttempt;
pub use campaign::{Campaign, CampaignCommand};
pub use compliance::{
    ComplianceDecision, ComplianceInput, ComplianceReason, ConsentBasis, EvidenceStatus,
    GateStatus, evaluate_compliance,
};
pub use converact_voice_agent_contracts::AttemptCommand;
pub use orchestrator::{OrchestrationError, OutboundOrchestrator};
pub use ports::{
    AgentObservation, AgentReservation, AttachCall, AttemptStorePort, CallObservation,
    ChannelAgentPort, CompliancePort, EffectIntent, OriginateCall, PlayDisclosure, PortError,
    PortFailureKind, ReserveAgent, StartConversation, TelephonyPort, TerminateCall,
};

/// Stable rejection categories shared by the outbound authority aggregates.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DomainError {
    InvalidTransition,
    ReconcileRequired,
    DisclosureRequired,
    ActiveAttemptsRemain,
    CounterOverflow,
    RevisionExhausted,
    InvalidAttemptIdentifier,
    SameAttemptIdentity,
}

impl fmt::Display for DomainError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidTransition => "ai_outbound_transition_invalid",
            Self::ReconcileRequired => "ai_outbound_reconcile_required",
            Self::DisclosureRequired => "ai_outbound_disclosure_required",
            Self::ActiveAttemptsRemain => "ai_outbound_active_attempts_remain",
            Self::CounterOverflow => "ai_outbound_counter_overflow",
            Self::RevisionExhausted => "ai_outbound_revision_exhausted",
            Self::InvalidAttemptIdentifier => "ai_outbound_attempt_identifier_invalid",
            Self::SameAttemptIdentity => "ai_outbound_attempt_identity_reused",
        })
    }
}

impl Error for DomainError {}
