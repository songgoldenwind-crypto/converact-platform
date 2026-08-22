use std::time::Duration;

use converact_outbox_worker::{
    AttemptSnapshot, CoordinatorAction, DeliveryFailureCode, DeliveryObservation,
    DeliveryResolution, DurableEffectProgress, DurableOutboxProgress, OutboxTransitionDecision,
    OutboxWorkerPolicy, SnapshotError, action_after_observation, next_action,
};

fn policy() -> OutboxWorkerPolicy {
    OutboxWorkerPolicy::new(Duration::from_secs(5), Duration::from_secs(7)).expect("valid policy")
}

fn snapshot(
    attempt_count: u16,
    max_attempts: u16,
    effect: DurableEffectProgress,
    outbox: DurableOutboxProgress,
) -> AttemptSnapshot {
    AttemptSnapshot::new(attempt_count, max_attempts, effect, outbox).expect("valid snapshot")
}

fn retryable() -> DeliveryResolution {
    DeliveryResolution::NotAppliedRetryable(
        DeliveryFailureCode::new("provider_unavailable").expect("valid failure code"),
    )
}

fn permanent() -> DeliveryResolution {
    DeliveryResolution::NotAppliedPermanent(
        DeliveryFailureCode::new("recipient_rejected").expect("valid failure code"),
    )
}

#[test]
fn new_attempt_persists_acceptance_before_delivery() {
    let attempt = snapshot(
        1,
        3,
        DurableEffectProgress::Absent,
        DurableOutboxProgress::Claimed,
    );

    assert_eq!(
        next_action(&attempt, policy()),
        CoordinatorAction::PersistAccepted
    );
}

#[test]
fn fresh_acceptance_delivers_but_recovered_acceptance_queries() {
    let fresh = snapshot(
        1,
        3,
        DurableEffectProgress::accepted_in_current_cycle(),
        DurableOutboxProgress::Claimed,
    );
    let recovered = snapshot(
        1,
        3,
        DurableEffectProgress::recovered_accepted(),
        DurableOutboxProgress::Claimed,
    );

    assert_eq!(next_action(&fresh, policy()), CoordinatorAction::Deliver);
    assert_eq!(
        next_action(&recovered, policy()),
        CoordinatorAction::QueryDelivery
    );
}

#[test]
fn unknown_observation_waits_without_transition() {
    assert_eq!(
        action_after_observation(DeliveryObservation::Unknown, policy()),
        CoordinatorAction::WaitForReconcile {
            retry_after: Duration::from_secs(7),
        }
    );
}

#[test]
fn applied_delivery_completes_receipt_then_outbox_then_state_observed() {
    assert_eq!(
        action_after_observation(DeliveryObservation::Applied, policy()),
        CoordinatorAction::PersistCompleted(DeliveryResolution::Applied)
    );

    let completed = snapshot(
        1,
        3,
        DurableEffectProgress::Completed(DeliveryResolution::Applied),
        DurableOutboxProgress::Claimed,
    );
    assert_eq!(
        next_action(&completed, policy()),
        CoordinatorAction::ApplyOutboxTransition(OutboxTransitionDecision::Complete)
    );

    let transitioned = snapshot(
        1,
        3,
        DurableEffectProgress::Completed(DeliveryResolution::Applied),
        DurableOutboxProgress::TransitionApplied(OutboxTransitionDecision::Complete),
    );
    assert_eq!(
        next_action(&transitioned, policy()),
        CoordinatorAction::PersistStateObserved
    );

    let observed = snapshot(
        1,
        3,
        DurableEffectProgress::StateObserved(DeliveryResolution::Applied),
        DurableOutboxProgress::TransitionApplied(OutboxTransitionDecision::Complete),
    );
    assert_eq!(next_action(&observed, policy()), CoordinatorAction::Done);
}

#[test]
fn retryable_not_applied_retries_before_attempt_limit() {
    let resolution = retryable();
    let error_code = resolution.failure_code().expect("failure code").clone();
    assert_eq!(
        action_after_observation(
            DeliveryObservation::NotAppliedRetryable(error_code),
            policy(),
        ),
        CoordinatorAction::PersistCompleted(resolution.clone())
    );
    let attempt = snapshot(
        2,
        3,
        DurableEffectProgress::Completed(resolution.clone()),
        DurableOutboxProgress::Claimed,
    );

    assert_eq!(
        next_action(&attempt, policy()),
        CoordinatorAction::ApplyOutboxTransition(OutboxTransitionDecision::Retry {
            error_code: resolution.failure_code().expect("failure code").clone(),
            retry_delay: Duration::from_secs(5),
        })
    );
}

#[test]
fn retryable_not_applied_dead_letters_at_attempt_limit() {
    let resolution = retryable();
    let error_code = resolution.failure_code().expect("failure code").clone();
    let attempt = snapshot(
        3,
        3,
        DurableEffectProgress::Completed(resolution),
        DurableOutboxProgress::Claimed,
    );

    assert_eq!(
        next_action(&attempt, policy()),
        CoordinatorAction::ApplyOutboxTransition(OutboxTransitionDecision::DeadLetter {
            error_code,
        })
    );
}

#[test]
fn permanent_not_applied_dead_letters() {
    let resolution = permanent();
    let error_code = resolution.failure_code().expect("failure code").clone();
    assert_eq!(
        action_after_observation(
            DeliveryObservation::NotAppliedPermanent(error_code.clone()),
            policy(),
        ),
        CoordinatorAction::PersistCompleted(resolution.clone())
    );
    let attempt = snapshot(
        1,
        3,
        DurableEffectProgress::Completed(resolution),
        DurableOutboxProgress::Claimed,
    );

    assert_eq!(
        next_action(&attempt, policy()),
        CoordinatorAction::ApplyOutboxTransition(OutboxTransitionDecision::DeadLetter {
            error_code,
        })
    );
}

#[test]
fn mismatched_persisted_transition_conflicts() {
    let attempt = snapshot(
        1,
        3,
        DurableEffectProgress::Completed(DeliveryResolution::Applied),
        DurableOutboxProgress::TransitionApplied(OutboxTransitionDecision::DeadLetter {
            error_code: DeliveryFailureCode::new("unexpected_failure").expect("valid code"),
        }),
    );

    assert_eq!(next_action(&attempt, policy()), CoordinatorAction::Conflict);
}

#[test]
fn persisted_retry_survives_policy_change_after_restart() {
    let resolution = retryable();
    let error_code = resolution.failure_code().expect("failure code").clone();
    let attempt = snapshot(
        1,
        3,
        DurableEffectProgress::Completed(resolution),
        DurableOutboxProgress::TransitionApplied(OutboxTransitionDecision::Retry {
            error_code,
            retry_delay: Duration::from_secs(5),
        }),
    );
    let changed_policy = OutboxWorkerPolicy::new(Duration::from_secs(30), Duration::from_secs(7))
        .expect("valid policy");

    assert_eq!(
        next_action(&attempt, changed_policy),
        CoordinatorAction::PersistStateObserved
    );
}

#[test]
fn invalid_bounds_and_failure_codes_fail_closed() {
    assert_eq!(
        AttemptSnapshot::new(
            0,
            3,
            DurableEffectProgress::Absent,
            DurableOutboxProgress::Claimed,
        ),
        Err(SnapshotError)
    );
    assert_eq!(
        AttemptSnapshot::new(
            1,
            3,
            DurableEffectProgress::Completed(retryable()),
            DurableOutboxProgress::TransitionApplied(OutboxTransitionDecision::Retry {
                error_code: DeliveryFailureCode::new("provider_unavailable").expect("valid code"),
                retry_delay: Duration::from_nanos(1),
            }),
        ),
        Err(SnapshotError)
    );
    assert_eq!(
        AttemptSnapshot::new(
            4,
            3,
            DurableEffectProgress::Absent,
            DurableOutboxProgress::Claimed,
        ),
        Err(SnapshotError)
    );
    assert_eq!(
        AttemptSnapshot::new(
            1,
            1_001,
            DurableEffectProgress::Absent,
            DurableOutboxProgress::Claimed,
        ),
        Err(SnapshotError)
    );
    assert!(OutboxWorkerPolicy::new(Duration::from_nanos(1), Duration::from_secs(1)).is_err());
    assert!(OutboxWorkerPolicy::new(Duration::from_secs(86_401), Duration::from_secs(1)).is_err());
    assert!(OutboxWorkerPolicy::new(Duration::ZERO, Duration::ZERO).is_err());
    assert!(OutboxWorkerPolicy::new(Duration::ZERO, Duration::from_nanos(1)).is_err());
    assert!(OutboxWorkerPolicy::new(Duration::ZERO, Duration::from_secs(86_401)).is_err());
    assert!(DeliveryFailureCode::new("").is_err());
    assert!(DeliveryFailureCode::new("Provider-Unavailable").is_err());
    assert!(DeliveryFailureCode::new(&"a".repeat(256)).is_err());
}

#[test]
fn impossible_progress_combinations_conflict() {
    let transitioned_without_receipt = snapshot(
        1,
        3,
        DurableEffectProgress::Absent,
        DurableOutboxProgress::TransitionApplied(OutboxTransitionDecision::Complete),
    );
    let observed_without_transition = snapshot(
        1,
        3,
        DurableEffectProgress::StateObserved(DeliveryResolution::Applied),
        DurableOutboxProgress::Claimed,
    );

    assert_eq!(
        next_action(&transitioned_without_receipt, policy()),
        CoordinatorAction::Conflict
    );
    assert_eq!(
        next_action(&observed_without_transition, policy()),
        CoordinatorAction::Conflict
    );
}
