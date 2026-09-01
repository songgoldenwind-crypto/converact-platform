//! Durable business authority for Converact AI outbound calls.

mod agent_release;
mod authoring;
mod call_attempt;
mod campaign;
mod compliance;
mod dial;
mod orchestrator;
mod ports;
mod retry;

use std::{error::Error, fmt};

pub use agent_release::{
    AgentDraft, AgentRelease, AgentReleaseError, ReleaseComponentDigests, publish_agent,
};
pub use authoring::{
    AuthoringError, CampaignSchedule, CampaignTransition, CreateCampaign, DialPolicyRevision,
    DialPolicyRevisionInput, ImportContact, ImportContactInput, ImportContacts, RecordingMode,
};
pub use call_attempt::{CallAttempt, CallAttemptRestoreInput};
pub use campaign::{Campaign, CampaignCommand};
pub use compliance::{
    ComplianceDecision, ComplianceInput, ComplianceReason, ConsentBasis, EvidenceStatus,
    GateStatus, evaluate_compliance,
};
pub use converact_voice_agent_contracts::AttemptCommand;
pub use orchestrator::{OrchestrationError, OutboundOrchestrator};
pub use ports::{
    AgentLegBinding, AgentObservation, AgentReleaseBinding, AgentReleaseBindingError,
    AgentReservation, AttemptCompletionPort, AttemptStorePort, CallObservation, ChannelAgentPort,
    CompliancePort, EffectIntent, OriginateCall, OutboundDialBinding, OutboundDialBindingError,
    OutboundDialBindingInput, PlayDisclosure, PortError, PortFailureKind, ReserveAgent,
    StartConversation, TelephonyPort, TerminalAttemptCommit, TerminateCall,
};
pub use retry::{RetryCandidate, RetryDecision, RetryPlan, RetryPolicy, plan_retry};

/// Stable rejection categories shared by the outbound authority aggregates.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DomainError {
    InvalidTransition,
    ReconcileRequired,
    DisclosureRequired,
    ActiveAttemptsRemain,
    CounterOverflow,
    InvalidRevision,
    InvalidAttemptSnapshot,
    RevisionExhausted,
    InvalidAttemptIdentifier,
    SameAttemptIdentity,
    InvalidRetryPolicy,
    InvalidAttemptNumber,
    InvalidRetrySchedule,
}

impl fmt::Display for DomainError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidTransition => "ai_outbound_transition_invalid",
            Self::ReconcileRequired => "ai_outbound_reconcile_required",
            Self::DisclosureRequired => "ai_outbound_disclosure_required",
            Self::ActiveAttemptsRemain => "ai_outbound_active_attempts_remain",
            Self::CounterOverflow => "ai_outbound_counter_overflow",
            Self::InvalidRevision => "ai_outbound_revision_invalid",
            Self::InvalidAttemptSnapshot => "ai_outbound_attempt_snapshot_invalid",
            Self::RevisionExhausted => "ai_outbound_revision_exhausted",
            Self::InvalidAttemptIdentifier => "ai_outbound_attempt_identifier_invalid",
            Self::SameAttemptIdentity => "ai_outbound_attempt_identity_reused",
            Self::InvalidRetryPolicy => "ai_outbound_retry_policy_invalid",
            Self::InvalidAttemptNumber => "ai_outbound_attempt_number_invalid",
            Self::InvalidRetrySchedule => "ai_outbound_retry_schedule_invalid",
        })
    }
}

impl Error for DomainError {}
