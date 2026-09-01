use converact_voice_agent_contracts::{AttemptCommand, CallAttemptId, CallAttemptState};

use crate::DomainError;

/// Hard ceiling for one Contact's physical Attempt lineage.
pub const MAX_PHYSICAL_ATTEMPTS: u8 = 20;

/// One physical dial. A retry always creates another value with another identifier.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CallAttempt {
    id: CallAttemptId,
    previous_attempt_id: Option<CallAttemptId>,
    state: CallAttemptState,
    revision: u64,
    disclosure_completed: bool,
}

/// Untrusted durable fields used to restore one physical Attempt aggregate.
pub struct CallAttemptRestoreInput {
    pub id: CallAttemptId,
    pub previous_attempt_id: Option<CallAttemptId>,
    pub state: CallAttemptState,
    pub revision: u64,
    pub disclosure_completed: bool,
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

    /// Restores an aggregate from one complete durable snapshot without replaying commands.
    ///
    /// # Errors
    ///
    /// Rejects zero/impossible revisions, reused lineage identities and disclosure facts that
    /// contradict the frozen state graph.
    pub fn restore(input: CallAttemptRestoreInput) -> Result<Self, DomainError> {
        if input.revision < minimum_revision(input.state, input.disclosure_completed)
            || input.previous_attempt_id.as_ref() == Some(&input.id)
            || disclosure_snapshot_invalid(input.state, input.disclosure_completed)
        {
            return Err(DomainError::InvalidAttemptSnapshot);
        }
        Ok(Self {
            id: input.id,
            previous_attempt_id: input.previous_attempt_id,
            state: input.state,
            revision: input.revision,
            disclosure_completed: input.disclosure_completed,
        })
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
        if matches!(
            (self.state, command, self.disclosure_completed),
            (
                CallAttemptState::DisclosurePending,
                AttemptCommand::StartConversation,
                false
            )
        ) {
            return Err(DomainError::DisclosureRequired);
        }
        if matches!(
            (self.state, command, self.disclosure_completed),
            (
                CallAttemptState::DisclosurePending,
                AttemptCommand::CompleteDisclosure,
                false
            )
        ) {
            let mut attempt = self.clone();
            attempt.revision = attempt
                .revision
                .checked_add(1)
                .ok_or(DomainError::RevisionExhausted)?;
            attempt.disclosure_completed = true;
            return Ok(attempt);
        }
        let next = next_attempt_state(self.state, command, self.disclosure_completed)
            .ok_or(DomainError::InvalidTransition)?;
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

    /// Returns whether mandatory AI identity and recording disclosure completed.
    #[must_use]
    pub const fn disclosure_completed(&self) -> bool {
        self.disclosure_completed
    }
}

const fn minimum_revision(state: CallAttemptState, disclosure_completed: bool) -> u64 {
    match state {
        CallAttemptState::Planned => 1,
        CallAttemptState::Claimed
        | CallAttemptState::Cancelled
        | CallAttemptState::FailedBeforeAnswer => 2,
        CallAttemptState::ComplianceApproved | CallAttemptState::ComplianceBlocked => 3,
        CallAttemptState::AgentCapacityReserved | CallAttemptState::OutcomeUnknown => 4,
        CallAttemptState::Dialing | CallAttemptState::ReconcileRequired => 5,
        CallAttemptState::Ringing
        | CallAttemptState::Answered
        | CallAttemptState::Busy
        | CallAttemptState::NoAnswer
        | CallAttemptState::Rejected => 6,
        CallAttemptState::AgentConnecting | CallAttemptState::FailedAfterAnswer => 7,
        CallAttemptState::DisclosurePending if disclosure_completed => 9,
        CallAttemptState::DisclosurePending => 8,
        CallAttemptState::Conversing => 10,
        CallAttemptState::HandoffPending | CallAttemptState::Finalizing => 11,
        CallAttemptState::HumanActive | CallAttemptState::Completed => 12,
        CallAttemptState::AiResuming => 13,
    }
}

const fn disclosure_snapshot_invalid(state: CallAttemptState, disclosure_completed: bool) -> bool {
    if disclosure_completed {
        matches!(
            state,
            CallAttemptState::Planned
                | CallAttemptState::Claimed
                | CallAttemptState::ComplianceApproved
                | CallAttemptState::ComplianceBlocked
                | CallAttemptState::AgentCapacityReserved
                | CallAttemptState::Dialing
                | CallAttemptState::Ringing
                | CallAttemptState::Answered
                | CallAttemptState::AgentConnecting
                | CallAttemptState::Busy
                | CallAttemptState::NoAnswer
                | CallAttemptState::Rejected
                | CallAttemptState::FailedBeforeAnswer
        )
    } else {
        matches!(
            state,
            CallAttemptState::Conversing
                | CallAttemptState::HandoffPending
                | CallAttemptState::HumanActive
                | CallAttemptState::AiResuming
                | CallAttemptState::Finalizing
                | CallAttemptState::Completed
        )
    }
}

fn next_attempt_state(
    state: CallAttemptState,
    command: AttemptCommand,
    disclosure_completed: bool,
) -> Option<CallAttemptState> {
    pre_conversation_transition(state, command, disclosure_completed)
        .or_else(|| handoff_transition(state, command))
        .or_else(|| outcome_transition(state, command))
}

fn pre_conversation_transition(
    state: CallAttemptState,
    command: AttemptCommand,
    disclosure_completed: bool,
) -> Option<CallAttemptState> {
    match (state, command) {
        (CallAttemptState::Planned, AttemptCommand::Claim) => Some(CallAttemptState::Claimed),
        (CallAttemptState::Claimed, AttemptCommand::ApproveCompliance) => {
            Some(CallAttemptState::ComplianceApproved)
        }
        (CallAttemptState::Claimed, AttemptCommand::BlockCompliance) => {
            Some(CallAttemptState::ComplianceBlocked)
        }
        (CallAttemptState::ComplianceApproved, AttemptCommand::ReserveAgentCapacity) => {
            Some(CallAttemptState::AgentCapacityReserved)
        }
        (CallAttemptState::AgentCapacityReserved, AttemptCommand::Dial) => {
            Some(CallAttemptState::Dialing)
        }
        (CallAttemptState::Dialing, AttemptCommand::ObserveRinging) => {
            Some(CallAttemptState::Ringing)
        }
        (
            CallAttemptState::Dialing | CallAttemptState::Ringing,
            AttemptCommand::ObserveAnswered,
        ) => Some(CallAttemptState::Answered),
        (CallAttemptState::Answered, AttemptCommand::AttachAgent) => {
            Some(CallAttemptState::AgentConnecting)
        }
        (CallAttemptState::AgentConnecting, AttemptCommand::AwaitDisclosure) => {
            Some(CallAttemptState::DisclosurePending)
        }
        (CallAttemptState::DisclosurePending, AttemptCommand::StartConversation)
            if disclosure_completed =>
        {
            Some(CallAttemptState::Conversing)
        }
        _ => None,
    }
}

fn handoff_transition(
    state: CallAttemptState,
    command: AttemptCommand,
) -> Option<CallAttemptState> {
    match (state, command) {
        (CallAttemptState::Conversing, AttemptCommand::RequestHandoff) => {
            Some(CallAttemptState::HandoffPending)
        }
        (CallAttemptState::HandoffPending, AttemptCommand::CommitHumanHandoff) => {
            Some(CallAttemptState::HumanActive)
        }
        (CallAttemptState::HumanActive, AttemptCommand::ResumeAi) => {
            Some(CallAttemptState::AiResuming)
        }
        (CallAttemptState::AiResuming, AttemptCommand::StartConversation) => {
            Some(CallAttemptState::Conversing)
        }
        (
            CallAttemptState::Conversing
            | CallAttemptState::HandoffPending
            | CallAttemptState::HumanActive
            | CallAttemptState::AiResuming,
            AttemptCommand::Finalize,
        ) => Some(CallAttemptState::Finalizing),
        (CallAttemptState::Finalizing, AttemptCommand::Complete) => {
            Some(CallAttemptState::Completed)
        }
        _ => None,
    }
}

fn outcome_transition(
    state: CallAttemptState,
    command: AttemptCommand,
) -> Option<CallAttemptState> {
    match (state, command) {
        (CallAttemptState::Dialing | CallAttemptState::Ringing, AttemptCommand::MarkBusy) => {
            Some(CallAttemptState::Busy)
        }
        (CallAttemptState::Dialing | CallAttemptState::Ringing, AttemptCommand::MarkNoAnswer) => {
            Some(CallAttemptState::NoAnswer)
        }
        (CallAttemptState::Dialing | CallAttemptState::Ringing, AttemptCommand::MarkRejected) => {
            Some(CallAttemptState::Rejected)
        }
        (state, AttemptCommand::MarkFailedBeforeAnswer) if is_before_answer(state) => {
            Some(CallAttemptState::FailedBeforeAnswer)
        }
        (state, AttemptCommand::MarkFailedAfterAnswer) if is_after_answer(state) => {
            Some(CallAttemptState::FailedAfterAnswer)
        }
        (state, AttemptCommand::MarkOutcomeUnknown) if has_external_effect(state) => {
            Some(CallAttemptState::OutcomeUnknown)
        }
        (CallAttemptState::OutcomeUnknown, AttemptCommand::RequireReconcile) => {
            Some(CallAttemptState::ReconcileRequired)
        }
        (state, AttemptCommand::Cancel) if can_cancel(state) => Some(CallAttemptState::Cancelled),
        _ => None,
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
    // The reservation intent is persisted while the Attempt is ComplianceApproved. A timed-out
    // reservation may therefore have taken effect even though capacity was never observed.
    matches!(
        state,
        CallAttemptState::ComplianceApproved
            | CallAttemptState::Dialing
            | CallAttemptState::Ringing
    ) || is_after_answer(state)
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
