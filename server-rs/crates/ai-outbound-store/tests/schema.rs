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
