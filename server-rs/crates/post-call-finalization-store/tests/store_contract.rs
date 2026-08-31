use converact_kernel_ids::TenantId;
use converact_post_call_finalization_store::{
    FinalizationLease, FinalizationLeaseCommand, FinalizationReconcileCommand,
    FinalizationStoreConfig, FinalizationStoreError,
};
use converact_voice_agent_contracts::ConversationFinalizationJobId;

#[test]
fn claim_and_lease_limits_are_bounded_before_sql() {
    assert!(FinalizationStoreConfig::new(30_000, 100).is_ok());
    assert_eq!(
        FinalizationStoreConfig::new(0, 100).unwrap_err(),
        FinalizationStoreError::InvalidInput
    );
    assert_eq!(
        FinalizationStoreConfig::new(30_000, 0).unwrap_err(),
        FinalizationStoreError::InvalidInput
    );

    assert!(FinalizationLease::try_new("worker-001", "a".repeat(64)).is_ok());
    assert!(FinalizationLease::try_new("bad worker", "a".repeat(64)).is_err());
    assert!(FinalizationLease::try_new("worker-001", "not-a-hash").is_err());
}

#[test]
fn reconciliation_reason_is_bounded_and_content_free() {
    let lease_command = FinalizationLeaseCommand {
        tenant_id: TenantId::parse("tenant-a").unwrap(),
        job_id: ConversationFinalizationJobId::parse("job-001").unwrap(),
        expected_revision: 2,
        lease: FinalizationLease::try_new("worker-001", "a".repeat(64)).unwrap(),
    };

    assert!(
        FinalizationReconcileCommand::try_new(
            lease_command.clone(),
            "conversation_projection_outcome_unknown"
        )
        .is_ok()
    );
    assert_eq!(
        FinalizationReconcileCommand::try_new(lease_command, "provider said: customer 13800138000")
            .unwrap_err(),
        FinalizationStoreError::InvalidInput
    );
}

#[test]
fn postgres_queue_contract_is_bounded_fenced_and_database_clocked() {
    let source = include_str!("../src/postgres.rs");

    for required in [
        "enqueue",
        "claim_due",
        "require_reconcile",
        "complete",
        "converact_claim_post_call_finalization_jobs",
        "transaction_timestamp()",
        "lease_owner",
        "lease_token_hash",
        "lease_expires_at",
        "expected_revision",
        "LIMIT $",
        "payload_hash",
    ] {
        assert!(
            source.contains(required),
            "missing queue invariant {required}"
        );
    }
}
