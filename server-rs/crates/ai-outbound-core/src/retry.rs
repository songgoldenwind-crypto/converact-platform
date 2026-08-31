use converact_voice_agent_contracts::CallAttemptState;

use crate::{CallAttempt, DomainError};

const MAX_ATTEMPTS: u8 = 20;
const MIN_RETRY_DELAY_MS: u64 = 1_000;
const MAX_RETRY_DELAY_MS: u64 = 7 * 24 * 60 * 60 * 1_000;

/// Closed retry policy frozen into a Campaign dial-policy revision.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RetryPolicy {
    max_attempts: u8,
    delay_ms: u64,
    retry_failed_after_answer: bool,
}

impl RetryPolicy {
    /// Creates a bounded retry policy.
    ///
    /// # Errors
    ///
    /// Rejects zero/oversized attempt counts and delays outside one second through seven days.
    pub const fn new(
        max_attempts: u8,
        delay_ms: u64,
        retry_failed_after_answer: bool,
    ) -> Result<Self, DomainError> {
        if max_attempts == 0
            || max_attempts > MAX_ATTEMPTS
            || delay_ms < MIN_RETRY_DELAY_MS
            || delay_ms > MAX_RETRY_DELAY_MS
        {
            return Err(DomainError::InvalidRetryPolicy);
        }
        Ok(Self {
            max_attempts,
            delay_ms,
            retry_failed_after_answer,
        })
    }
}

/// Definitive predecessor and caller-issued identity for one possible retry.
#[derive(Clone, Copy, Debug)]
pub struct RetryCandidate<'a> {
    pub previous_attempt: &'a CallAttempt,
    pub previous_attempt_number: u8,
    pub next_attempt_id: &'a str,
    pub terminal_observed_at_ms: u64,
}

/// A new physical Attempt and its durable scheduling metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RetryPlan {
    attempt: CallAttempt,
    attempt_number: u8,
    scheduled_for_ms: u64,
}

impl RetryPlan {
    #[must_use]
    pub const fn attempt(&self) -> &CallAttempt {
        &self.attempt
    }

    #[must_use]
    pub const fn attempt_number(&self) -> u8 {
        self.attempt_number
    }

    #[must_use]
    pub const fn scheduled_for_ms(&self) -> u64 {
        self.scheduled_for_ms
    }
}

/// Closed planning result. Only `Planned` authorizes a durable new Attempt insert.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RetryDecision {
    Planned(RetryPlan),
    NotRetryable,
    Exhausted,
}

/// Plans a separate physical Attempt from one definitive terminal predecessor.
///
/// # Errors
///
/// Rejects unresolved outcomes, non-terminal predecessors, malformed numbering/identity and
/// timestamp overflow.
pub fn plan_retry(
    candidate: RetryCandidate<'_>,
    policy: RetryPolicy,
) -> Result<RetryDecision, DomainError> {
    let state = candidate.previous_attempt.state();
    if matches!(
        state,
        CallAttemptState::OutcomeUnknown | CallAttemptState::ReconcileRequired
    ) {
        return Err(DomainError::ReconcileRequired);
    }
    if candidate.previous_attempt_number == 0
        || candidate.previous_attempt_number > policy.max_attempts
    {
        return Err(DomainError::InvalidAttemptNumber);
    }
    if candidate.terminal_observed_at_ms == 0 {
        return Err(DomainError::InvalidRetrySchedule);
    }

    let retryable = match state {
        CallAttemptState::Busy
        | CallAttemptState::NoAnswer
        | CallAttemptState::Rejected
        | CallAttemptState::FailedBeforeAnswer => true,
        CallAttemptState::FailedAfterAnswer => policy.retry_failed_after_answer,
        CallAttemptState::Completed
        | CallAttemptState::ComplianceBlocked
        | CallAttemptState::Cancelled => false,
        _ => return Err(DomainError::InvalidTransition),
    };
    if !retryable {
        return Ok(RetryDecision::NotRetryable);
    }
    if candidate.previous_attempt_number == policy.max_attempts {
        return Ok(RetryDecision::Exhausted);
    }

    let attempt_number = candidate
        .previous_attempt_number
        .checked_add(1)
        .ok_or(DomainError::InvalidAttemptNumber)?;
    let scheduled_for_ms = candidate
        .terminal_observed_at_ms
        .checked_add(policy.delay_ms)
        .ok_or(DomainError::InvalidRetrySchedule)?;
    let attempt = candidate
        .previous_attempt
        .plan_retry(candidate.next_attempt_id)?;
    Ok(RetryDecision::Planned(RetryPlan {
        attempt,
        attempt_number,
        scheduled_for_ms,
    }))
}
