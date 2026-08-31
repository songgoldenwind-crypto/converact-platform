//! Durable AI-to-human ownership transitions for Converact interactions.

#![forbid(unsafe_code)]

mod model;
mod session;

use std::{error::Error, fmt};

pub use model::{
    ContextPacket, ContextPacketInput, ContextRevision, ControlOwner, HandoffState, HandoffTarget,
};
pub use session::HandoffSession;

/// Stable fail-closed Handoff rejection categories.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HandoffError {
    InvalidTransition,
    StaleRevision,
    StaleGeneration,
    ReconcileRequired,
    CallRequired,
    AiSessionRequired,
    HumanLegRequired,
    AiSessionReused,
    GenerationExhausted,
    RevisionExhausted,
    InvalidContextRevision,
    InvalidContextPacket,
    InvalidTarget,
}

impl HandoffError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidTransition => "agent_handoff_transition_invalid",
            Self::StaleRevision => "agent_handoff_revision_stale",
            Self::StaleGeneration => "agent_handoff_generation_stale",
            Self::ReconcileRequired => "agent_handoff_reconcile_required",
            Self::CallRequired => "agent_handoff_call_required",
            Self::AiSessionRequired => "agent_handoff_ai_session_required",
            Self::HumanLegRequired => "agent_handoff_human_leg_required",
            Self::AiSessionReused => "agent_handoff_ai_session_reused",
            Self::GenerationExhausted => "agent_handoff_generation_exhausted",
            Self::RevisionExhausted => "agent_handoff_revision_exhausted",
            Self::InvalidContextRevision => "agent_handoff_context_revision_invalid",
            Self::InvalidContextPacket => "agent_handoff_context_packet_invalid",
            Self::InvalidTarget => "agent_handoff_target_invalid",
        }
    }
}

impl fmt::Display for HandoffError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for HandoffError {}
