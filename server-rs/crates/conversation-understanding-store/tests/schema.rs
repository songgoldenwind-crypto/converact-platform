#[test]
fn migration_freezes_immutable_records_and_fenced_heads() {
    let migration =
        include_str!("../../../../src/migrations/133_converact_conversation_understanding.sql");

    for required in [
        "converact_conversation_understanding_records",
        "converact_conversation_understanding_heads",
        "intent_observation",
        "emotion_observation",
        "emotion_fusion",
        "customer_state_snapshot",
        "dialogue_recommendation",
        "intent",
        "emotion",
        "customer_state",
        "dialogue",
        "execution_generation BIGINT NOT NULL CHECK (execution_generation > 0)",
        "turn_index BIGINT NOT NULL CHECK (turn_index >= 0)",
        "retention_policy_ref",
        "retention_until",
        "payload JSONB NOT NULL",
        "payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$')",
        "PRIMARY KEY (tenant_id, record_id)",
        "PRIMARY KEY (tenant_id, interaction_id, call_attempt_id, execution_generation, domain)",
        "FOREIGN KEY (",
        "head_revision = OLD.head_revision + 1",
        "NEW.record_id = OLD.record_id",
        "NEW.turn_index < OLD.turn_index",
        "understanding records are immutable",
        "converact_purge_conversation_understanding",
        "FOR UPDATE SKIP LOCKED",
        "p_limit BETWEEN 1 AND 1000",
        "ENABLE ROW LEVEL SECURITY",
        "FORCE ROW LEVEL SECURITY",
        "GRANT SELECT, INSERT ON converact_conversation_understanding_records",
        "GRANT SELECT, INSERT, UPDATE ON converact_conversation_understanding_heads",
        "GRANT EXECUTE ON FUNCTION converact_purge_conversation_understanding",
    ] {
        assert!(migration.contains(required), "missing invariant {required}");
    }
}

#[test]
fn migration_has_bounded_recovery_indexes_without_global_scan() {
    let migration =
        include_str!("../../../../src/migrations/133_converact_conversation_understanding.sql");

    for required in [
        "idx_converact_understanding_attempt_records",
        "tenant_id, call_attempt_id, execution_generation, domain, turn_index, observed_at",
        "idx_converact_understanding_attempt_heads",
        "tenant_id, call_attempt_id, execution_generation, domain",
        "octet_length(payload::TEXT) <= 131072",
    ] {
        assert!(migration.contains(required), "missing recovery invariant {required}");
    }
}

#[test]
fn development_schema_mirrors_record_and_head_authority() {
    let schema = include_str!("../../../../src/schema.sql");

    for required in [
        "converact_conversation_understanding_records",
        "converact_conversation_understanding_heads",
        "record_kind TEXT NOT NULL CHECK",
        "domain TEXT NOT NULL CHECK",
        "execution_generation INTEGER NOT NULL CHECK (execution_generation > 0)",
        "payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object')",
        "retention_until TEXT NOT NULL",
        "head_revision INTEGER NOT NULL CHECK (head_revision > 0)",
    ] {
        assert!(schema.contains(required), "missing development invariant {required}");
    }
}
