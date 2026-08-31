mod support;

use converact_ai_outbound_core::{
    AttemptCommand, CallAttempt, CallAttemptRestoreInput, DomainError,
};
use converact_voice_agent_contracts::{CallAttemptId, CallAttemptState};
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

#[test]
fn durable_claimed_snapshot_restores_without_replaying_claim() {
    let restored = CallAttempt::restore(CallAttemptRestoreInput {
        id: CallAttemptId::parse("attempt-001").unwrap(),
        previous_attempt_id: None,
        state: CallAttemptState::Claimed,
        revision: 2,
        disclosure_completed: false,
    })
    .unwrap();

    assert_eq!(restored.state(), CallAttemptState::Claimed);
    assert_eq!(restored.revision(), 2);
    assert_eq!(
        restored.apply(AttemptCommand::Claim),
        Err(DomainError::InvalidTransition)
    );
}

#[test]
fn malformed_or_impossible_durable_snapshots_fail_closed() {
    let input = |state, revision, disclosure_completed| CallAttemptRestoreInput {
        id: CallAttemptId::parse("attempt-001").unwrap(),
        previous_attempt_id: None,
        state,
        revision,
        disclosure_completed,
    };

    assert_eq!(
        CallAttempt::restore(input(CallAttemptState::Claimed, 0, false)),
        Err(DomainError::InvalidAttemptSnapshot)
    );
    assert_eq!(
        CallAttempt::restore(input(CallAttemptState::Dialing, 5, true)),
        Err(DomainError::InvalidAttemptSnapshot)
    );
    assert_eq!(
        CallAttempt::restore(input(CallAttemptState::Conversing, 10, false)),
        Err(DomainError::InvalidAttemptSnapshot)
    );
    assert_eq!(
        CallAttempt::restore(CallAttemptRestoreInput {
            id: CallAttemptId::parse("attempt-001").unwrap(),
            previous_attempt_id: Some(CallAttemptId::parse("attempt-001").unwrap()),
            state: CallAttemptState::NoAnswer,
            revision: 6,
            disclosure_completed: false,
        }),
        Err(DomainError::InvalidAttemptSnapshot)
    );
}
