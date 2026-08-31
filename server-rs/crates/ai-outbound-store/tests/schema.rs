#[test]
fn migration_has_attempt_identity_lease_fence_event_receipts_and_compliance() {
    let sql = include_str!("../../../../src/migrations/124_converact_ai_outbound.sql");
    for required in [
        "converact_agent_releases",
        "converact_outbound_campaigns",
        "converact_outbound_campaign_contacts",
        "converact_outbound_call_attempts",
        "converact_outbound_attempt_events",
        "previous_attempt_id",
        "execution_generation",
        "lease_owner",
        "lease_token_hash",
        "lease_expires_at",
        "idempotency_key",
        "payload_hash",
        "consent_id",
        "recording_mode",
        "retention_until",
        "ENABLE ROW LEVEL SECURITY",
        "FORCE ROW LEVEL SECURITY",
    ] {
        assert!(sql.contains(required), "missing {required}");
    }
}

#[test]
fn migration_keeps_attempt_and_event_indexes_tenant_scoped() {
    let sql = include_str!("../../../../src/migrations/124_converact_ai_outbound.sql");
    assert!(sql.contains("PRIMARY KEY (tenant_id, id)"));
    assert!(sql.contains("UNIQUE (tenant_id, campaign_contact_id, attempt_number)"));
    assert!(sql.contains("PRIMARY KEY (tenant_id, event_id)"));
    assert!(sql.contains("WHERE state = 'planned'"));
}

#[test]
fn development_schema_tracks_the_same_compliance_and_identity_fields() {
    let sql = include_str!("../../../../src/schema.sql");
    for required in [
        "converact_agent_releases",
        "converact_outbound_call_attempts",
        "converact_outbound_attempt_events",
        "previous_attempt_id",
        "execution_generation",
        "consent_id",
        "recording_mode",
        "retention_until",
    ] {
        assert!(
            sql.contains(required),
            "missing development field {required}"
        );
    }
}

#[test]
fn dial_policy_migration_is_additive_tenant_scoped_and_snapshots_each_attempt() {
    let sql = include_str!("../../../../src/migrations/131_converact_outbound_dial_policy.sql");
    for required in [
        "converact_outbound_dial_policy_revisions",
        "content_hash",
        "caller_id",
        "timeout_secs",
        "trunk",
        "dial_policy_revision",
        "dial_policy_content_hash",
        "dial_destination",
        "dial_caller_id",
        "dial_timeout_secs",
        "dial_trunk",
        "FOREIGN KEY (tenant_id, dial_policy_revision, dial_policy_content_hash)",
        "converact_outbound_dial_snapshot_immutable_guard",
        "NOT VALID",
        "converact_outbound_immutable_history_guard",
        "ENABLE ROW LEVEL SECURITY",
        "FORCE ROW LEVEL SECURITY",
        "GRANT SELECT, INSERT",
    ] {
        assert!(
            sql.contains(required),
            "missing dial-policy invariant {required}"
        );
    }
}

#[test]
fn development_schema_has_dial_policy_authority_and_attempt_snapshot() {
    let sql = include_str!("../../../../src/schema.sql");
    for required in [
        "converact_outbound_dial_policy_revisions",
        "dial_policy_revision TEXT",
        "dial_policy_content_hash TEXT",
        "dial_destination TEXT",
        "dial_caller_id TEXT",
        "dial_timeout_secs INTEGER",
        "dial_trunk TEXT",
    ] {
        assert!(
            sql.contains(required),
            "missing development dial field {required}"
        );
    }
    let attempts = sql
        .split_once("CREATE TABLE IF NOT EXISTS converact_outbound_call_attempts")
        .unwrap()
        .1
        .split_once("CREATE TABLE IF NOT EXISTS converact_outbound_attempt_events")
        .unwrap()
        .0;
    assert!(attempts.contains("dial_destination TEXT"));
    let contacts = sql
        .split_once("CREATE TABLE IF NOT EXISTS converact_outbound_campaign_contacts")
        .unwrap()
        .1
        .split_once("CREATE TABLE IF NOT EXISTS converact_outbound_call_attempts")
        .unwrap()
        .0;
    assert!(!contacts.contains("dial_destination"));
}

#[test]
fn recovery_migration_persists_disclosure_without_rewriting_existing_attempts() {
    let sql =
        include_str!("../../../../src/migrations/132_converact_outbound_attempt_recovery.sql");
    for required in [
        "ADD COLUMN IF NOT EXISTS disclosure_completed BOOLEAN NOT NULL DEFAULT FALSE",
        "converact_outbound_attempt_disclosure_state_check",
        "NOT VALID",
        "state IN ('conversing', 'handoff_pending', 'human_active', 'ai_resuming', 'finalizing', 'completed')",
        "disclosure_completed",
    ] {
        assert!(
            sql.contains(required),
            "missing recovery invariant {required}"
        );
    }
}

#[test]
fn development_schema_persists_attempt_disclosure_fact() {
    let sql = include_str!("../../../../src/schema.sql");
    let attempts = sql
        .split_once("CREATE TABLE IF NOT EXISTS converact_outbound_call_attempts")
        .unwrap()
        .1
        .split_once("CREATE TABLE IF NOT EXISTS converact_outbound_attempt_events")
        .unwrap()
        .0;

    assert!(attempts.contains("disclosure_completed INTEGER NOT NULL DEFAULT 0"));
}
