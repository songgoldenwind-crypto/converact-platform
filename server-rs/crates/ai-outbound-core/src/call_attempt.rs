use converact_voice_agent_contracts::{AttemptCommand, CallAttemptId, CallAttemptState};

use crate::DomainError;

/// One physical dial. A retry always creates another value with another identifier.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CallAttempt {
    id: CallAttemptId,
    previous_attempt_id: Option<CallAttemptId>,
    state: CallAttemptState,
    revision: u64,
    disclosure_completed: bool,
}

impl CallAttempt {
    /// Creates a planned physical dial.
    #[must_use]
    pub const fn new(id: CallAttemptId) -> Self {
        Self {
            id,
            previous_attempt_id: None,
            state: CallAttemptState::Planned,
            revision: 1,
            disclosure_completed: false,
        }
    }

    /// Applies one exhaustive physical-Attempt transition.
    ///
    /// # Errors
    ///
    /// Rejects transitions outside the frozen graph, attempts to retry an unknown outcome,
    /// and revision overflow.
    pub fn apply(&self, command: AttemptCommand) -> Result<Self, DomainError> {
        if matches!(
            (self.state, command),
            (
                CallAttemptState::OutcomeUnknown | CallAttemptState::ReconcileRequired,
                AttemptCommand::Retry
            )
        ) {
            return Err(DomainError::ReconcileRequired);
        }
        let next = match (self.state, command) {
            (CallAttemptState::Planned, AttemptCommand::Claim) => CallAttemptState::Claimed,
            (CallAttemptState::Claimed, AttemptCommand::ApproveCompliance) => {
                CallAttemptState::ComplianceApproved
            }
            (CallAttemptState::Claimed, AttemptCommand::BlockCompliance) => {
                CallAttemptState::ComplianceBlocked
            }
            (CallAttemptState::ComplianceApproved, AttemptCommand::ReserveAgentCapacity) => {
                CallAttemptState::AgentCapacityReserved
            }
            (CallAttemptState::AgentCapacityReserved, AttemptCommand::Dial) => {
                CallAttemptState::Dialing
            }
            (CallAttemptState::Dialing, AttemptCommand::ObserveRinging) => {
                CallAttemptState::Ringing
            }
            (
                CallAttemptState::Dialing | CallAttemptState::Ringing,
                AttemptCommand::ObserveAnswered,
            ) => CallAttemptState::Answered,
            (CallAttemptState::Answered, AttemptCommand::AttachAgent) => {
                CallAttemptState::AgentConnecting
            }
            (CallAttemptState::AgentConnecting, AttemptCommand::AwaitDisclosure) => {
                CallAttemptState::DisclosurePending
            }
            (CallAttemptState::Conversing, AttemptCommand::RequestHandoff) => {
                CallAttemptState::HandoffPending
            }
            (CallAttemptState::HandoffPending, AttemptCommand::CommitHumanHandoff) => {
                CallAttemptState::HumanActive
            }
            (CallAttemptState::HumanActive, AttemptCommand::ResumeAi) => {
                CallAttemptState::AiResuming
            }
            (
                CallAttemptState::Conversing | CallAttemptState::HumanActive,
                AttemptCommand::Finalize,
            ) => CallAttemptState::Finalizing,
            (CallAttemptState::Finalizing, AttemptCommand::Complete) => CallAttemptState::Completed,
            (CallAttemptState::Dialing | CallAttemptState::Ringing, AttemptCommand::MarkBusy) => {
                CallAttemptState::Busy
            }
            (
                CallAttemptState::Dialing | CallAttemptState::Ringing,
                AttemptCommand::MarkNoAnswer,
            ) => CallAttemptState::NoAnswer,
            (
                CallAttemptState::Dialing | CallAttemptState::Ringing,
                AttemptCommand::MarkRejected,
            ) => CallAttemptState::Rejected,
            (state, AttemptCommand::MarkFailedBeforeAnswer) if is_before_answer(state) => {
                CallAttemptState::FailedBeforeAnswer
            }
            (state, AttemptCommand::MarkFailedAfterAnswer) if is_after_answer(state) => {
                CallAttemptState::FailedAfterAnswer
            }
            (state, AttemptCommand::MarkOutcomeUnknown) if has_external_effect(state) => {
                CallAttemptState::OutcomeUnknown
            }
            (CallAttemptState::OutcomeUnknown, AttemptCommand::RequireReconcile) => {
                CallAttemptState::ReconcileRequired
            }
            (state, AttemptCommand::Cancel) if can_cancel(state) => CallAttemptState::Cancelled,
            _ => return Err(DomainError::InvalidTransition),
        };
        let mut attempt = self.clone();
        attempt.revision = attempt
            .revision
            .checked_add(1)
            .ok_or(DomainError::RevisionExhausted)?;
        attempt.state = next;
        Ok(attempt)
    }

    /// Plans another physical dial linked to this deterministic terminal Attempt.
    ///
    /// # Errors
    ///
    /// Rejects malformed or reused identifiers, non-retryable states and unresolved outcomes.
    pub fn plan_retry(&self, new_id: impl AsRef<str>) -> Result<Self, DomainError> {
        if matches!(
            self.state,
            CallAttemptState::OutcomeUnknown | CallAttemptState::ReconcileRequired
        ) {
            return Err(DomainError::ReconcileRequired);
        }
        if !is_retryable(self.state) {
            return Err(DomainError::InvalidTransition);
        }
        let new_id =
            CallAttemptId::parse(new_id).map_err(|_| DomainError::InvalidAttemptIdentifier)?;
        if new_id == self.id {
            return Err(DomainError::SameAttemptIdentity);
        }
        Ok(Self {
            id: new_id,
            previous_attempt_id: Some(self.id.clone()),
            state: CallAttemptState::Planned,
            revision: 1,
            disclosure_completed: false,
        })
    }

    /// Returns the physical Attempt identifier.
    #[must_use]
    pub const fn id(&self) -> &CallAttemptId {
        &self.id
    }

    /// Returns the previous physical Attempt in this retry lineage.
    #[must_use]
    pub const fn previous_attempt_id(&self) -> Option<&CallAttemptId> {
        self.previous_attempt_id.as_ref()
    }

    /// Returns the current state.
    #[must_use]
    pub const fn state(&self) -> CallAttemptState {
        self.state
    }

    /// Returns the checked aggregate revision.
    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }
}

const fn is_before_answer(state: CallAttemptState) -> bool {
    matches!(
        state,
        CallAttemptState::Planned
            | CallAttemptState::Claimed
            | CallAttemptState::ComplianceApproved
            | CallAttemptState::AgentCapacityReserved
            | CallAttemptState::Dialing
            | CallAttemptState::Ringing
    )
}

const fn is_after_answer(state: CallAttemptState) -> bool {
    matches!(
        state,
        CallAttemptState::Answered
            | CallAttemptState::AgentConnecting
            | CallAttemptState::DisclosurePending
            | CallAttemptState::Conversing
            | CallAttemptState::HandoffPending
            | CallAttemptState::HumanActive
            | CallAttemptState::AiResuming
            | CallAttemptState::Finalizing
    )
}

const fn has_external_effect(state: CallAttemptState) -> bool {
    matches!(state, CallAttemptState::Dialing | CallAttemptState::Ringing) || is_after_answer(state)
}

const fn can_cancel(state: CallAttemptState) -> bool {
    matches!(
        state,
        CallAttemptState::Planned
            | CallAttemptState::Claimed
            | CallAttemptState::ComplianceApproved
            | CallAttemptState::AgentCapacityReserved
            | CallAttemptState::Dialing
            | CallAttemptState::Ringing
            | CallAttemptState::Answered
            | CallAttemptState::AgentConnecting
            | CallAttemptState::DisclosurePending
            | CallAttemptState::Conversing
            | CallAttemptState::HandoffPending
            | CallAttemptState::HumanActive
            | CallAttemptState::AiResuming
    )
}

const fn is_retryable(state: CallAttemptState) -> bool {
    matches!(
        state,
        CallAttemptState::Busy
            | CallAttemptState::NoAnswer
            | CallAttemptState::Rejected
            | CallAttemptState::FailedBeforeAnswer
            | CallAttemptState::FailedAfterAnswer
    )
}
