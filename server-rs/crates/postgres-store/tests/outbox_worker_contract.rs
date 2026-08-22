use std::time::Duration;

use converact_idempotency::EffectReceipt;
use converact_outbox_worker::{
    AttemptSnapshot, CoordinatorAction, DeliveryFailureCode, DeliveryObservation,
    DurableEffectProgress, DurableOutboxProgress, OutboxWorkerPolicy, action_after_observation,
};
use converact_postgres_store::{
    DeliveryLeaseToken, OutboxDeliveryFinalizationCommand, OutboxDeliveryFinalizationCommandError,
    OutboxTransitionCommand,
};
use serde_json::json;

const ADAPTER_SOURCE: &str = include_str!("../src/outbox_worker.rs");

fn receipt(receipt_id: &str, effect_id: &str, stage: &str, digest: char) -> EffectReceipt {
    EffectReceipt::try_from(&json!({
        "receipt_id": receipt_id,
        "tenant_id": "tenant-a",
        "effect_id": effect_id,
        "event_id": "event-a",
        "correlation_id": "correlation-a",
        "stage": stage,
        "generation": 4,
        "writer_id": "worker-a",
        "owner_epoch": 7,
        "receipt_digest": digest.to_string().repeat(64),
        "observed_at": "2026-08-22T06:20:00.000Z"
    }))
    .expect("valid receipt")
}

fn complete_plan() -> converact_outbox_worker::DeliveryFinalizationPlan {
    let snapshot = AttemptSnapshot::new(
        1,
        3,
        DurableEffectProgress::recovered_accepted(),
        DurableOutboxProgress::Claimed,
    )
    .expect("valid snapshot");
    let policy = OutboxWorkerPolicy::new(Duration::from_secs(5), Duration::from_secs(7))
        .expect("valid policy");
    let CoordinatorAction::FinalizeAtomically(plan) =
        action_after_observation(DeliveryObservation::Applied, &snapshot, policy)
    else {
        panic!("applied observation must finalize");
    };
    plan
}

fn retry_plan() -> converact_outbox_worker::DeliveryFinalizationPlan {
    let snapshot = AttemptSnapshot::new(
        1,
        3,
        DurableEffectProgress::recovered_accepted(),
        DurableOutboxProgress::Claimed,
    )
    .expect("valid snapshot");
    let policy = OutboxWorkerPolicy::new(Duration::from_secs(5), Duration::from_secs(7))
        .expect("valid policy");
    let CoordinatorAction::FinalizeAtomically(plan) = action_after_observation(
        DeliveryObservation::NotAppliedRetryable(
            DeliveryFailureCode::new("provider_unavailable").expect("valid code"),
        ),
        &snapshot,
        policy,
    ) else {
        panic!("definitive observation must finalize");
    };
    plan
}

fn dead_letter_plan() -> converact_outbox_worker::DeliveryFinalizationPlan {
    let snapshot = AttemptSnapshot::new(
        3,
        3,
        DurableEffectProgress::recovered_accepted(),
        DurableOutboxProgress::Claimed,
    )
    .expect("valid snapshot");
    let policy = OutboxWorkerPolicy::new(Duration::from_secs(5), Duration::from_secs(7))
        .expect("valid policy");
    let CoordinatorAction::FinalizeAtomically(plan) = action_after_observation(
        DeliveryObservation::NotAppliedRetryable(
            DeliveryFailureCode::new("provider_unavailable").expect("valid code"),
        ),
        &snapshot,
        policy,
    ) else {
        panic!("terminal retry must finalize");
    };
    plan
}

fn complete_transition() -> OutboxTransitionCommand {
    OutboxTransitionCommand::complete(
        "transition-a",
        "outbox-a",
        "worker-a",
        1,
        DeliveryLeaseToken::parse(&"a".repeat(64)).expect("valid token"),
    )
    .expect("valid transition")
}

#[test]
fn command_binds_private_plan_exact_receipt_lineage_and_transition() {
    let command = OutboxDeliveryFinalizationCommand::new(
        &complete_plan(),
        receipt("receipt-completed", "effect-a", "completed", 'b'),
        receipt("receipt-observed", "effect-a", "state_observed", 'c'),
        complete_transition(),
    )
    .expect("valid finalization");

    assert_eq!(command.effect_id(), "effect-a");
    assert_eq!(command.attempt_count(), 1);
    assert_eq!(command.max_attempts(), 3);
    assert_eq!(command.transition_command().outbox_id(), "outbox-a");
    assert_eq!(
        format!("{command:?}"),
        "OutboxDeliveryFinalizationCommand([REDACTED])"
    );
    assert!(!format!("{command:?}").contains(&"a".repeat(64)));
}

#[test]
fn command_accepts_exact_retry_and_dead_letter_decisions() {
    let retry = OutboxTransitionCommand::retry(
        "transition-retry",
        "outbox-a",
        "worker-a",
        1,
        DeliveryLeaseToken::parse(&"b".repeat(64)).expect("valid token"),
        "provider_unavailable",
        Duration::from_secs(5),
    )
    .expect("valid transition");
    OutboxDeliveryFinalizationCommand::new(
        &retry_plan(),
        receipt("receipt-retry-completed", "effect-retry", "completed", 'd'),
        receipt(
            "receipt-retry-observed",
            "effect-retry",
            "state_observed",
            'e',
        ),
        retry,
    )
    .expect("matching retry plan");

    let dead_letter = OutboxTransitionCommand::dead_letter(
        "transition-dead-letter",
        "outbox-a",
        "worker-a",
        1,
        DeliveryLeaseToken::parse(&"c".repeat(64)).expect("valid token"),
        "provider_unavailable",
    )
    .expect("valid transition");
    OutboxDeliveryFinalizationCommand::new(
        &dead_letter_plan(),
        receipt("receipt-dead-completed", "effect-dead", "completed", 'f'),
        receipt(
            "receipt-dead-observed",
            "effect-dead",
            "state_observed",
            '0',
        ),
        dead_letter,
    )
    .expect("matching dead-letter plan");
}

#[test]
fn command_rejects_plan_transition_or_receipt_lineage_mismatch() {
    assert_eq!(
        OutboxDeliveryFinalizationCommand::new(
            &retry_plan(),
            receipt("receipt-completed", "effect-a", "completed", 'b'),
            receipt("receipt-observed", "effect-a", "state_observed", 'c'),
            complete_transition(),
        )
        .unwrap_err(),
        OutboxDeliveryFinalizationCommandError
    );
    assert_eq!(
        OutboxDeliveryFinalizationCommand::new(
            &complete_plan(),
            receipt("receipt-completed", "effect-a", "accepted", 'b'),
            receipt("receipt-observed", "effect-a", "state_observed", 'c'),
            complete_transition(),
        )
        .unwrap_err(),
        OutboxDeliveryFinalizationCommandError
    );
    assert_eq!(
        OutboxDeliveryFinalizationCommand::new(
            &complete_plan(),
            receipt("receipt-completed", "effect-a", "completed", 'b'),
            receipt("receipt-observed", "effect-b", "state_observed", 'c'),
            complete_transition(),
        )
        .unwrap_err(),
        OutboxDeliveryFinalizationCommandError
    );
    assert_eq!(
        OutboxDeliveryFinalizationCommand::new(
            &complete_plan(),
            receipt("receipt-shared", "effect-a", "completed", 'b'),
            receipt("receipt-shared", "effect-a", "state_observed", 'c'),
            complete_transition(),
        )
        .unwrap_err(),
        OutboxDeliveryFinalizationCommandError
    );
    assert_eq!(
        OutboxDeliveryFinalizationCommand::new(
            &complete_plan(),
            receipt("receipt-completed", "effect-a", "completed", 'b'),
            receipt("receipt-observed", "effect-a", "state_observed", 'b'),
            complete_transition(),
        )
        .unwrap_err(),
        OutboxDeliveryFinalizationCommandError
    );
}

#[test]
fn adapter_uses_one_tenant_transaction_and_existing_fenced_store_primitives() {
    assert_eq!(ADAPTER_SOURCE.matches("with_tenant_transaction").count(), 2);
    for required in [
        "append_effect_in_transaction",
        "apply_transition_in_transaction",
        "reconcile_transition_in_transaction",
    ] {
        assert!(ADAPTER_SOURCE.contains(required), "missing {required}");
    }
    assert!(!ADAPTER_SOURCE.contains("INSERT INTO"));
    assert!(!ADAPTER_SOURCE.contains("UPDATE converact_platform_outbox"));
}
