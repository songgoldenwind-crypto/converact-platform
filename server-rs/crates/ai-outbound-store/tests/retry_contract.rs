use converact_ai_outbound_store::{PlanRetryAttempt, PlanRetryAttemptInput, StoreError};
use converact_kernel_ids::TenantId;
use converact_voice_agent_contracts::{CallAttemptId, ExecutionGeneration, IdempotencyKey};

#[test]
fn retry_command_is_bounded_tenant_scoped_and_content_free() {
    let command = PlanRetryAttempt::try_new(PlanRetryAttemptInput {
        tenant_id: TenantId::parse("tenant-a").unwrap(),
        previous_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        next_attempt_id: CallAttemptId::parse("attempt-002").unwrap(),
        expected_previous_revision: 12,
        expected_previous_generation: ExecutionGeneration::new(1).unwrap(),
        next_attempt_number: 2,
        scheduled_for_ms: 1_060_000,
        idempotency_key: IdempotencyKey::parse("dial:attempt-002").unwrap(),
        retry_failed_after_answer: false,
    })
    .unwrap();

    assert_eq!(command.tenant_id().as_str(), "tenant-a");
    assert_eq!(command.previous_attempt_id().as_str(), "attempt-001");
    assert_eq!(command.next_attempt_id().as_str(), "attempt-002");
    assert_eq!(command.next_attempt_number(), 2);
    assert_eq!(command.scheduled_for_ms(), 1_060_000);
    let debug = format!("{command:?}");
    for forbidden in ["+861", "destination", "transcript", "prompt", "credential"] {
        assert!(
            !debug.contains(forbidden),
            "leaked retry content {forbidden}"
        );
    }
}

#[test]
fn retry_command_rejects_reused_identity_and_invalid_attempt_number() {
    let base = || PlanRetryAttemptInput {
        tenant_id: TenantId::parse("tenant-a").unwrap(),
        previous_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        next_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        expected_previous_revision: 12,
        expected_previous_generation: ExecutionGeneration::new(1).unwrap(),
        next_attempt_number: 2,
        scheduled_for_ms: 1_060_000,
        idempotency_key: IdempotencyKey::parse("dial:attempt-002").unwrap(),
        retry_failed_after_answer: false,
    };
    assert_eq!(
        PlanRetryAttempt::try_new(base()).unwrap_err(),
        StoreError::InvalidInput
    );

    let mut invalid_number = base();
    invalid_number.next_attempt_id = CallAttemptId::parse("attempt-002").unwrap();
    invalid_number.next_attempt_number = 1;
    assert_eq!(
        PlanRetryAttempt::try_new(invalid_number).unwrap_err(),
        StoreError::InvalidInput
    );
}

#[test]
fn postgres_retry_insert_preserves_authority_and_gates_new_dials() {
    let source = include_str!("../src/postgres.rs");

    for required in [
        "WITH predecessor AS MATERIALIZED",
        "FOR UPDATE OF attempt, contact",
        "campaign.state = 'running'",
        "contact.state IN ('queued', 'active')",
        "previous_attempt_id",
        "interaction_id",
        "agent_release_id",
        "consent_id",
        "recording_mode",
        "retention_until",
        "dial_policy_revision",
        "dial_policy_content_hash",
        "dial_destination",
        "dial_caller_id",
        "dial_timeout_secs",
        "dial_trunk",
        "execution_generation",
        "'planned'",
        "ON CONFLICT DO NOTHING",
        "GREATEST(contact.attempt_count",
        "id = $2 OR idempotency_key = $3",
    ] {
        assert!(
            source.contains(required),
            "missing retry invariant {required}"
        );
    }
}

#[test]
fn dial_binding_loads_only_from_the_attempt_snapshot_and_fails_closed() {
    let source = include_str!("../src/postgres.rs");

    for required in [
        "load_dial_binding",
        "SELECT dial_destination, dial_caller_id, dial_timeout_secs, dial_trunk",
        "OutboundDialBinding::try_new",
        "StoreError::AttemptNotFound",
        "StoreError::StoredRowInvalid",
    ] {
        assert!(
            source.contains(required),
            "missing dial-load invariant {required}"
        );
    }
}

#[test]
fn retry_and_event_milliseconds_keep_their_i64_postgres_parameter_type() {
    let source = include_str!("../src/postgres.rs");

    assert!(source.contains("to_timestamp($7::bigint / 1000.0)"));
    assert!(source.contains("to_timestamp($9::bigint / 1000.0)"));
    assert!(source.contains("to_timestamp($10::bigint / 1000.0)"));
    assert!(!source.contains("::double precision / 1000.0"));
}
