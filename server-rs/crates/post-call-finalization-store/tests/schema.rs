#[test]
fn schema_freezes_post_call_job_receipt_and_tenant_authority() {
    let migration = include_str!("../../../../src/migrations/128_post_call_finalization.sql");
    let development = include_str!("../../../../src/schema.sql");

    for required in [
        "converact_post_call_finalization_jobs",
        "converact_post_call_finalization_receipts",
        "UNIQUE (tenant_id, call_attempt_id)",
        "PRIMARY KEY (tenant_id, job_id)",
        "pending",
        "claimed",
        "reconcile_required",
        "completed",
        "projected",
        "incomplete",
        "FOR UPDATE SKIP LOCKED",
        "ENABLE ROW LEVEL SECURITY",
        "FORCE ROW LEVEL SECURITY",
        "post-call finalization receipts are immutable",
    ] {
        assert!(migration.contains(required), "missing invariant {required}");
    }

    for required in [
        "converact_post_call_finalization_jobs",
        "converact_post_call_finalization_receipts",
        "reconcile_required",
        "retention_policy_ref",
    ] {
        assert!(
            development.contains(required),
            "missing development invariant {required}"
        );
    }
}
