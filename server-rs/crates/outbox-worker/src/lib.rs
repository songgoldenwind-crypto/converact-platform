//! Pure durable outbox delivery and crash-recovery decisions.

#![forbid(unsafe_code)]

use std::{error::Error, fmt, time::Duration};

const MAX_ATTEMPTS: u16 = 1_000;
const MAX_FAILURE_CODE_BYTES: usize = 255;
const MAX_RETRY_DELAY: Duration = Duration::from_secs(86_400);

/// Stable provider failure code compatible with the durable outbox schema.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeliveryFailureCode(Box<str>);

impl DeliveryFailureCode {
    /// Validates a bounded lowercase machine code.
    ///
    /// # Errors
    ///
    /// Rejects empty, overlong or non-canonical codes.
    pub fn new(value: &str) -> Result<Self, DeliveryFailureCodeError> {
        let bytes = value.as_bytes();
        let valid = bytes.split_first().is_some_and(|(first, rest)| {
            first.is_ascii_lowercase()
                && rest
                    .iter()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
        });
        if !valid || bytes.len() > MAX_FAILURE_CODE_BYTES {
            return Err(DeliveryFailureCodeError);
        }
        Ok(Self(value.into()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Invalid provider failure code without echoing the rejected value.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeliveryFailureCodeError;

impl fmt::Display for DeliveryFailureCodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("outbox_delivery_failure_code_invalid")
    }
}

impl Error for DeliveryFailureCodeError {}

/// Definitive external delivery result recorded in the durable receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeliveryResolution {
    Applied,
    NotAppliedRetryable(DeliveryFailureCode),
    NotAppliedPermanent(DeliveryFailureCode),
}

impl DeliveryResolution {
    #[must_use]
    pub const fn failure_code(&self) -> Option<&DeliveryFailureCode> {
        match self {
            Self::Applied => None,
            Self::NotAppliedRetryable(code) | Self::NotAppliedPermanent(code) => Some(code),
        }
    }
}

/// Provider observation after a delivery attempt or provider query.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeliveryObservation {
    Applied,
    NotAppliedRetryable(DeliveryFailureCode),
    NotAppliedPermanent(DeliveryFailureCode),
    Unknown,
}

/// Durable effect receipt progress plus the non-durable current-cycle marker.
///
/// A completed resolution must come from a durable, versioned resolution
/// document bound by the receipt digest. A digest by itself is not a
/// reversible resolution store, so adapters must query/reconcile instead of
/// inventing a value when that document is unavailable.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DurableEffectProgress {
    Absent,
    AcceptedInCurrentCycle,
    RecoveredAccepted,
    Completed(DeliveryResolution),
    StateObserved(DeliveryResolution),
}

impl DurableEffectProgress {
    /// Marks an acceptance receipt that this process has just persisted and
    /// has not yet dispatched. A runner must consume this permission once and
    /// use [`Self::RecoveredAccepted`] after dispatch until it has a
    /// definitive observation.
    #[must_use]
    pub const fn accepted_in_current_cycle() -> Self {
        Self::AcceptedInCurrentCycle
    }

    /// Marks an acceptance receipt recovered without a definitive result.
    #[must_use]
    pub const fn recovered_accepted() -> Self {
        Self::RecoveredAccepted
    }
}

/// Exact durable transition that must be applied to the claimed outbox row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OutboxTransitionDecision {
    Complete,
    Retry {
        error_code: DeliveryFailureCode,
        retry_delay: Duration,
    },
    DeadLetter {
        error_code: DeliveryFailureCode,
    },
}

/// Durable outbox progress visible to the coordinator.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DurableOutboxProgress {
    Claimed,
    TransitionApplied(OutboxTransitionDecision),
}

/// Bounded retry policy shared with the durable `PostgreSQL` outbox contract.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OutboxWorkerPolicy {
    retry_delay: Duration,
    reconcile_delay: Duration,
}

impl OutboxWorkerPolicy {
    /// Validates whole-millisecond delivery and reconciliation delays no
    /// greater than 24 hours. Reconciliation must wait at least one
    /// millisecond so an unknown provider outcome cannot form a busy loop.
    ///
    /// # Errors
    ///
    /// Rejects sub-millisecond or over-policy delays.
    pub fn new(
        retry_delay: Duration,
        reconcile_delay: Duration,
    ) -> Result<Self, OutboxWorkerPolicyError> {
        if retry_delay > MAX_RETRY_DELAY
            || !retry_delay.subsec_nanos().is_multiple_of(1_000_000)
            || reconcile_delay.is_zero()
            || reconcile_delay > MAX_RETRY_DELAY
            || !reconcile_delay.subsec_nanos().is_multiple_of(1_000_000)
        {
            return Err(OutboxWorkerPolicyError);
        }
        Ok(Self {
            retry_delay,
            reconcile_delay,
        })
    }

    #[must_use]
    pub const fn retry_delay(self) -> Duration {
        self.retry_delay
    }

    #[must_use]
    pub const fn reconcile_delay(self) -> Duration {
        self.reconcile_delay
    }
}

/// Invalid worker policy without exposing the rejected value.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OutboxWorkerPolicyError;

impl fmt::Display for OutboxWorkerPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("outbox_worker_policy_invalid")
    }
}

impl Error for OutboxWorkerPolicyError {}

/// One bounded, durable view of a claimed delivery attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttemptSnapshot {
    attempt_count: u16,
    max_attempts: u16,
    effect: DurableEffectProgress,
    outbox: DurableOutboxProgress,
}

impl AttemptSnapshot {
    /// Builds a fail-closed snapshot from durable adapter results.
    ///
    /// # Errors
    ///
    /// Rejects zero, over-policy or internally inconsistent attempt counts.
    pub fn new(
        attempt_count: u16,
        max_attempts: u16,
        effect: DurableEffectProgress,
        outbox: DurableOutboxProgress,
    ) -> Result<Self, SnapshotError> {
        if attempt_count == 0
            || max_attempts == 0
            || max_attempts > MAX_ATTEMPTS
            || attempt_count > max_attempts
            || !valid_outbox_progress(&outbox)
        {
            return Err(SnapshotError);
        }
        Ok(Self {
            attempt_count,
            max_attempts,
            effect,
            outbox,
        })
    }
}

/// Invalid attempt snapshot without exposing source values.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SnapshotError;

impl fmt::Display for SnapshotError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("outbox_attempt_snapshot_invalid")
    }
}

impl Error for SnapshotError {}

/// One exact next step. Every persistence action must be reconciled before the
/// coordinator advances to a later action.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CoordinatorAction {
    PersistAccepted,
    Deliver,
    QueryDelivery,
    PersistCompleted(DeliveryResolution),
    ApplyOutboxTransition(OutboxTransitionDecision),
    PersistStateObserved,
    WaitForReconcile { retry_after: Duration },
    Done,
    Conflict,
}

/// Converts one provider observation to a persistence or reconciliation step.
#[must_use]
pub fn action_after_observation(
    observation: DeliveryObservation,
    policy: OutboxWorkerPolicy,
) -> CoordinatorAction {
    match observation {
        DeliveryObservation::Applied => {
            CoordinatorAction::PersistCompleted(DeliveryResolution::Applied)
        }
        DeliveryObservation::NotAppliedRetryable(error_code) => {
            CoordinatorAction::PersistCompleted(DeliveryResolution::NotAppliedRetryable(error_code))
        }
        DeliveryObservation::NotAppliedPermanent(error_code) => {
            CoordinatorAction::PersistCompleted(DeliveryResolution::NotAppliedPermanent(error_code))
        }
        DeliveryObservation::Unknown => CoordinatorAction::WaitForReconcile {
            retry_after: policy.reconcile_delay(),
        },
    }
}

/// Chooses the next side effect from durable receipt and outbox progress.
///
/// A recovered acceptance never produces [`CoordinatorAction::Deliver`]. Its
/// only forward path is provider query/reconcile, which prevents blind replay
/// after a crash with an unknown external outcome.
#[must_use]
pub fn next_action(snapshot: &AttemptSnapshot, policy: OutboxWorkerPolicy) -> CoordinatorAction {
    match (&snapshot.effect, &snapshot.outbox) {
        (DurableEffectProgress::Absent, DurableOutboxProgress::Claimed) => {
            CoordinatorAction::PersistAccepted
        }
        (DurableEffectProgress::AcceptedInCurrentCycle, DurableOutboxProgress::Claimed) => {
            CoordinatorAction::Deliver
        }
        (DurableEffectProgress::RecoveredAccepted, DurableOutboxProgress::Claimed) => {
            CoordinatorAction::QueryDelivery
        }
        (DurableEffectProgress::Completed(resolution), DurableOutboxProgress::Claimed) => {
            CoordinatorAction::ApplyOutboxTransition(transition_for(
                resolution,
                snapshot.attempt_count,
                snapshot.max_attempts,
                policy,
            ))
        }
        (
            DurableEffectProgress::Completed(resolution),
            DurableOutboxProgress::TransitionApplied(applied),
        ) => {
            if transition_matches(snapshot, resolution, applied) {
                CoordinatorAction::PersistStateObserved
            } else {
                CoordinatorAction::Conflict
            }
        }
        (
            DurableEffectProgress::StateObserved(resolution),
            DurableOutboxProgress::TransitionApplied(applied),
        ) => {
            if transition_matches(snapshot, resolution, applied) {
                CoordinatorAction::Done
            } else {
                CoordinatorAction::Conflict
            }
        }
        _ => CoordinatorAction::Conflict,
    }
}

fn transition_matches(
    snapshot: &AttemptSnapshot,
    resolution: &DeliveryResolution,
    applied: &OutboxTransitionDecision,
) -> bool {
    match (resolution, applied) {
        (DeliveryResolution::Applied, OutboxTransitionDecision::Complete) => true,
        (
            DeliveryResolution::NotAppliedRetryable(expected),
            OutboxTransitionDecision::Retry { error_code, .. },
        ) => snapshot.attempt_count < snapshot.max_attempts && expected == error_code,
        (
            DeliveryResolution::NotAppliedRetryable(expected)
            | DeliveryResolution::NotAppliedPermanent(expected),
            OutboxTransitionDecision::DeadLetter { error_code },
        ) => {
            (matches!(resolution, DeliveryResolution::NotAppliedPermanent(_))
                || snapshot.attempt_count == snapshot.max_attempts)
                && expected == error_code
        }
        _ => false,
    }
}

fn valid_outbox_progress(progress: &DurableOutboxProgress) -> bool {
    match progress {
        DurableOutboxProgress::Claimed
        | DurableOutboxProgress::TransitionApplied(
            OutboxTransitionDecision::Complete | OutboxTransitionDecision::DeadLetter { .. },
        ) => true,
        DurableOutboxProgress::TransitionApplied(OutboxTransitionDecision::Retry {
            retry_delay,
            ..
        }) => {
            *retry_delay <= MAX_RETRY_DELAY && retry_delay.subsec_nanos().is_multiple_of(1_000_000)
        }
    }
}

fn transition_for(
    resolution: &DeliveryResolution,
    attempt_count: u16,
    max_attempts: u16,
    policy: OutboxWorkerPolicy,
) -> OutboxTransitionDecision {
    match resolution {
        DeliveryResolution::Applied => OutboxTransitionDecision::Complete,
        DeliveryResolution::NotAppliedRetryable(error_code) if attempt_count < max_attempts => {
            OutboxTransitionDecision::Retry {
                error_code: error_code.clone(),
                retry_delay: policy.retry_delay(),
            }
        }
        DeliveryResolution::NotAppliedRetryable(error_code)
        | DeliveryResolution::NotAppliedPermanent(error_code) => {
            OutboxTransitionDecision::DeadLetter {
                error_code: error_code.clone(),
            }
        }
    }
}
