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

    assert_eq!(next_action(&attempt), CoordinatorAction::PersistAccepted);
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

    assert_eq!(next_action(&fresh), CoordinatorAction::Deliver);
    assert_eq!(next_action(&recovered), CoordinatorAction::QueryDelivery);
}

#[test]
fn unknown_observation_waits_without_transition() {
    let recovered = snapshot(
        1,
        3,
        DurableEffectProgress::recovered_accepted(),
        DurableOutboxProgress::Claimed,
    );
    assert_eq!(
        action_after_observation(DeliveryObservation::Unknown, &recovered, policy()),
        CoordinatorAction::WaitForReconcile {
            retry_after: Duration::from_secs(7),
        }
    );
}

#[test]
fn applied_delivery_builds_one_atomic_finalization_plan() {
    let accepted = snapshot(
        1,
        3,
        DurableEffectProgress::recovered_accepted(),
        DurableOutboxProgress::Claimed,
    );
    let CoordinatorAction::FinalizeAtomically(plan) =
        action_after_observation(DeliveryObservation::Applied, &accepted, policy())
    else {
        panic!("definitive observation must create a finalization plan");
    };
    assert_eq!(plan.resolution(), &DeliveryResolution::Applied);
    assert_eq!(plan.transition(), &OutboxTransitionDecision::Complete);

    let observed = snapshot(
        1,
        3,
        DurableEffectProgress::StateObserved,
        DurableOutboxProgress::TransitionApplied(OutboxTransitionDecision::Complete),
    );
    assert_eq!(next_action(&observed), CoordinatorAction::Done);
}

#[test]
fn retryable_not_applied_retries_before_attempt_limit() {
    let resolution = retryable();
    let error_code = resolution.failure_code().expect("failure code").clone();
    let accepted = snapshot(
        2,
        3,
        DurableEffectProgress::recovered_accepted(),
        DurableOutboxProgress::Claimed,
    );
    let CoordinatorAction::FinalizeAtomically(plan) = action_after_observation(
        DeliveryObservation::NotAppliedRetryable(error_code),
        &accepted,
        policy(),
    ) else {
        panic!("definitive observation must create a finalization plan");
    };
    assert_eq!(plan.resolution(), &resolution);
    assert_eq!(
        plan.transition(),
        &OutboxTransitionDecision::Retry {
            error_code: resolution.failure_code().expect("failure code").clone(),
            retry_delay: Duration::from_secs(5),
        }
    );
}

#[test]
fn retryable_not_applied_dead_letters_at_attempt_limit() {
    let resolution = retryable();
    let error_code = resolution.failure_code().expect("failure code").clone();
    let accepted = snapshot(
        3,
        3,
        DurableEffectProgress::recovered_accepted(),
        DurableOutboxProgress::Claimed,
    );
    let CoordinatorAction::FinalizeAtomically(plan) = action_after_observation(
        DeliveryObservation::NotAppliedRetryable(error_code.clone()),
        &accepted,
        policy(),
    ) else {
        panic!("definitive observation must create a finalization plan");
    };
    assert_eq!(plan.resolution(), &resolution);
    assert_eq!(
        plan.transition(),
        &OutboxTransitionDecision::DeadLetter { error_code }
    );
}

#[test]
fn permanent_not_applied_dead_letters() {
    let resolution = permanent();
    let error_code = resolution.failure_code().expect("failure code").clone();
    let accepted = snapshot(
        1,
        3,
        DurableEffectProgress::recovered_accepted(),
        DurableOutboxProgress::Claimed,
    );
    let CoordinatorAction::FinalizeAtomically(plan) = action_after_observation(
        DeliveryObservation::NotAppliedPermanent(error_code.clone()),
        &accepted,
        policy(),
    ) else {
        panic!("definitive observation must create a finalization plan");
    };
    assert_eq!(plan.resolution(), &resolution);
    assert_eq!(
        plan.transition(),
        &OutboxTransitionDecision::DeadLetter { error_code }
    );
}

#[test]
fn partial_completed_state_conflicts_even_if_transition_exists() {
    let attempt = snapshot(
        1,
        3,
        DurableEffectProgress::Completed,
        DurableOutboxProgress::TransitionApplied(OutboxTransitionDecision::DeadLetter {
            error_code: DeliveryFailureCode::new("unexpected_failure").expect("valid code"),
        }),
    );

    assert_eq!(next_action(&attempt), CoordinatorAction::Conflict);
}

#[test]
fn persisted_retry_finalization_replays_without_policy_recomputation() {
    let error_code = DeliveryFailureCode::new("provider_unavailable").expect("valid code");
    let attempt = snapshot(
        1,
        3,
        DurableEffectProgress::StateObserved,
        DurableOutboxProgress::TransitionApplied(OutboxTransitionDecision::Retry {
            error_code,
            retry_delay: Duration::from_secs(5),
        }),
    );
    assert_eq!(next_action(&attempt), CoordinatorAction::Done);
}

#[test]
fn definitive_observation_outside_an_accepted_claim_conflicts() {
    let absent = snapshot(
        1,
        3,
        DurableEffectProgress::Absent,
        DurableOutboxProgress::Claimed,
    );
    let not_yet_dispatched = snapshot(
        1,
        3,
        DurableEffectProgress::accepted_in_current_cycle(),
        DurableOutboxProgress::Claimed,
    );

    assert_eq!(
        action_after_observation(DeliveryObservation::Applied, &absent, policy()),
        CoordinatorAction::Conflict
    );
    assert_eq!(
        action_after_observation(DeliveryObservation::Applied, &not_yet_dispatched, policy(),),
        CoordinatorAction::Conflict
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
            DurableEffectProgress::Completed,
            DurableOutboxProgress::TransitionApplied(OutboxTransitionDecision::Retry {
                error_code: DeliveryFailureCode::new("provider_unavailable").expect("valid code"),
                retry_delay: Duration::from_nanos(1),
            }),
        ),
        Err(SnapshotError)
    );
    assert_eq!(
        AttemptSnapshot::new(
            3,
            3,
            DurableEffectProgress::StateObserved,
            DurableOutboxProgress::TransitionApplied(OutboxTransitionDecision::Retry {
                error_code: DeliveryFailureCode::new("provider_unavailable").expect("valid code"),
                retry_delay: Duration::from_secs(1),
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
        DurableEffectProgress::StateObserved,
        DurableOutboxProgress::Claimed,
    );

    assert_eq!(
        next_action(&transitioned_without_receipt),
        CoordinatorAction::Conflict
    );
    assert_eq!(
        next_action(&observed_without_transition),
        CoordinatorAction::Conflict
    );
}
