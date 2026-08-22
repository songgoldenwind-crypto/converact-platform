use converact_audit::{AuditAppendInput, AuditEvent};
use converact_migration_store::WriterFenceBinding;
use converact_postgres_store::{AuditAppendResult, AuditAppendStatus, PostgresRuntime};

const AUDIT_STORE_SOURCE: &str = include_str!("../src/audit.rs");
const AUDIT_MIGRATION: &str =
    include_str!("../../../../src/migrations/121_converact_audit_runtime_fencing.sql");

#[test]
fn audit_append_outcome_is_closed() {
    assert_eq!(AuditAppendStatus::Inserted.as_str(), "inserted");
    assert_eq!(AuditAppendStatus::Replay.as_str(), "replay");
}

#[test]
fn audit_adapter_uses_only_the_fenced_database_capabilities() {
    assert!(AUDIT_STORE_SOURCE.contains("converact_audit_writer_fence("));
    assert!(AUDIT_STORE_SOURCE.contains("converact_audit_chain_head("));
    assert!(AUDIT_STORE_SOURCE.contains("converact_audit_event_append("));
    assert!(AUDIT_STORE_SOURCE.contains("947113"));
    assert!(!AUDIT_STORE_SOURCE.contains("INSERT INTO ivekit_audit_events"));
    assert!(!AUDIT_STORE_SOURCE.contains("converact_authority_writer_fence("));
    assert!(!AUDIT_STORE_SOURCE.contains("ORDER BY occurred_at DESC"));
    assert!(AUDIT_MIGRATION.contains("SECURITY DEFINER"));
}

#[allow(dead_code)]
fn append_signature<'a>(
    runtime: &'a PostgresRuntime,
    fence: &'a WriterFenceBinding<'a>,
    audit_id: &'a str,
    input: &'a AuditAppendInput,
) -> impl Future<Output = Result<AuditAppendResult, converact_postgres_store::AuditStoreFailure>> + 'a
{
    runtime.append_audit_event(fence, audit_id, input)
}

#[allow(dead_code)]
fn query_signature<'a>(
    runtime: &'a PostgresRuntime,
    tenant_id: &'a converact_kernel_ids::TenantId,
    idempotency_key: &'a str,
) -> impl Future<Output = Result<Option<AuditEvent>, converact_postgres_store::AuditStoreFailure>> + 'a
{
    runtime.query_audit_event(tenant_id, idempotency_key)
}
