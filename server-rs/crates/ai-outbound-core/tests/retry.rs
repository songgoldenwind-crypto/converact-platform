mod support;

use converact_ai_outbound_core::{
    AttemptCommand, DomainError, RetryCandidate, RetryDecision, RetryPolicy, plan_retry,
};
use converact_voice_agent_contracts::CallAttemptState;
use support::{disclosure_pending_attempt, no_answer_attempt, outcome_unknown_attempt};

#[test]
fn no_answer_plans_a_distinct_delayed_attempt() {
    let previous = no_answer_attempt();
    let policy = RetryPolicy::new(3, 60_000, false).unwrap();

    let decision = plan_retry(
        RetryCandidate {
            previous_attempt: &previous,
            previous_attempt_number: 1,
            next_attempt_id: "attempt-002",
            terminal_observed_at_ms: 1_000_000,
        },
        policy,
    )
    .unwrap();

    let RetryDecision::Planned(plan) = decision else {
        panic!("expected a retry plan");
    };
    assert_eq!(plan.attempt().state(), CallAttemptState::Planned);
    assert_eq!(plan.attempt().id().as_str(), "attempt-002");
    assert_eq!(
        plan.attempt().previous_attempt_id().unwrap().as_str(),
        "attempt-001"
    );
    assert_eq!(plan.attempt_number(), 2);
    assert_eq!(plan.scheduled_for_ms(), 1_060_000);
}

#[test]
fn unknown_outcome_requires_reconciliation_instead_of_retry() {
    let previous = outcome_unknown_attempt();

    assert_eq!(
        plan_retry(
            RetryCandidate {
                previous_attempt: &previous,
                previous_attempt_number: 1,
                next_attempt_id: "attempt-002",
                terminal_observed_at_ms: 1_000_000,
            },
            RetryPolicy::new(3, 60_000, false).unwrap(),
        ),
        Err(DomainError::ReconcileRequired),
    );
}

#[test]
fn exhausted_or_definitive_results_do_not_create_an_attempt() {
    let no_answer = no_answer_attempt();
    assert_eq!(
        plan_retry(
            RetryCandidate {
                previous_attempt: &no_answer,
                previous_attempt_number: 3,
                next_attempt_id: "attempt-004",
                terminal_observed_at_ms: 1_000_000,
            },
            RetryPolicy::new(3, 60_000, false).unwrap(),
        )
        .unwrap(),
        RetryDecision::Exhausted,
    );

    let completed = disclosure_pending_attempt()
        .apply(AttemptCommand::CompleteDisclosure)
        .unwrap()
        .apply(AttemptCommand::StartConversation)
        .unwrap()
        .apply(AttemptCommand::Finalize)
        .unwrap()
        .apply(AttemptCommand::Complete)
        .unwrap();
    assert_eq!(
        plan_retry(
            RetryCandidate {
                previous_attempt: &completed,
                previous_attempt_number: 1,
                next_attempt_id: "attempt-002",
                terminal_observed_at_ms: 1_000_000,
            },
            RetryPolicy::new(3, 60_000, false).unwrap(),
        )
        .unwrap(),
        RetryDecision::NotRetryable,
    );
}

#[test]
fn failed_after_answer_requires_explicit_policy_and_bounds_are_closed() {
    let failed = disclosure_pending_attempt()
        .apply(AttemptCommand::MarkFailedAfterAnswer)
        .unwrap();
    let candidate = RetryCandidate {
        previous_attempt: &failed,
        previous_attempt_number: 1,
        next_attempt_id: "attempt-002",
        terminal_observed_at_ms: 1_000_000,
    };

    assert_eq!(
        plan_retry(candidate, RetryPolicy::new(3, 60_000, false).unwrap()).unwrap(),
        RetryDecision::NotRetryable,
    );
    assert!(matches!(
        plan_retry(candidate, RetryPolicy::new(3, 60_000, true).unwrap()).unwrap(),
        RetryDecision::Planned(_)
    ));
    assert_eq!(
        RetryPolicy::new(0, 60_000, false),
        Err(DomainError::InvalidRetryPolicy)
    );
    assert_eq!(
        RetryPolicy::new(3, 999, false),
        Err(DomainError::InvalidRetryPolicy)
    );
    assert_eq!(
        RetryPolicy::new(21, 60_000, false),
        Err(DomainError::InvalidRetryPolicy)
    );
    assert_eq!(
        plan_retry(
            RetryCandidate {
                previous_attempt: &no_answer_attempt(),
                previous_attempt_number: 1,
                next_attempt_id: "attempt-002",
                terminal_observed_at_ms: u64::MAX,
            },
            RetryPolicy::new(3, 1_000, false).unwrap(),
        ),
        Err(DomainError::InvalidRetrySchedule),
    );
}
