mod support;

use converact_ai_outbound_core::{AttemptCommand, DomainError};
use support::{no_answer_attempt, outcome_unknown_attempt, planned_attempt};

#[test]
fn attempt_requires_compliance_and_agent_capacity_before_dialing() {
    let planned = planned_attempt();
    assert_eq!(
        planned.clone().apply(AttemptCommand::Dial),
        Err(DomainError::InvalidTransition),
    );
    let ready = planned
        .apply(AttemptCommand::Claim)
        .unwrap()
        .apply(AttemptCommand::ApproveCompliance)
        .unwrap()
        .apply(AttemptCommand::ReserveAgentCapacity)
        .unwrap();
    assert!(ready.apply(AttemptCommand::Dial).is_ok());
}

#[test]
fn unknown_outcome_must_reconcile_before_retry() {
    let unknown = outcome_unknown_attempt();
    assert_eq!(
        unknown.apply(AttemptCommand::Retry),
        Err(DomainError::ReconcileRequired),
    );
}

#[test]
fn retry_creates_a_new_attempt_identity() {
    let completed = no_answer_attempt();
    let retry = completed.plan_retry("attempt-002").unwrap();
    assert_ne!(retry.id(), completed.id());
    assert_eq!(retry.previous_attempt_id(), Some(completed.id()));
}

#[test]
fn retry_cannot_reuse_the_physical_attempt_identity() {
    let completed = no_answer_attempt();
    assert_eq!(
        completed.plan_retry(completed.id().as_str()),
        Err(DomainError::SameAttemptIdentity),
    );
}
