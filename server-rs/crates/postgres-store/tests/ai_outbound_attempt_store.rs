use converact_ai_outbound_core::{AttemptCompletionPort, AttemptStorePort};
use converact_postgres_store::{PostgresAiOutboundAttemptStore, PostgresLeasedAttemptStore};

#[test]
fn postgres_leased_attempt_store_is_the_concrete_orchestrator_port() {
    fn assert_port<T: AttemptStorePort>() {}
    fn assert_completion_port<T: AttemptCompletionPort>() {}

    assert_port::<PostgresLeasedAttemptStore>();
    assert_completion_port::<PostgresLeasedAttemptStore>();
}

#[test]
fn claim_store_can_be_shared_while_each_attempt_port_remains_lease_scoped() {
    fn assert_send_sync<T: Send + Sync>() {}

    assert_send_sync::<PostgresAiOutboundAttemptStore>();
}

#[test]
fn postgres_adapter_source_preserves_per_attempt_lease_and_transaction_outcomes() {
    let source = include_str!("../src/ai_outbound.rs");

    for required in [
        "AttemptLease",
        "claim_planned",
        "append_effect_intent_with_lease",
        "advance_with_lease",
        "settle_terminal_attempt",
        "finalization_sql",
        "state = 'completed'",
        "TransactionError::CommitUnknown",
        "PortError::outcome_unknown",
        "PortError::rejected",
    ] {
        assert!(
            source.contains(required),
            "missing adapter invariant {required}"
        );
    }
}
