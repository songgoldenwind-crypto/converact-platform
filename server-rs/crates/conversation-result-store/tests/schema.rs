#[test]
fn migration_freezes_final_transcript_result_evaluation_and_bad_case_authority() {
    let migration = include_str!("../../../../src/migrations/127_conversation_result_quality.sql");
    let development = include_str!("../../../../src/schema.sql");

    for required in [
        "converact_conversation_transcript_segments",
        "converact_conversation_snapshots",
        "converact_conversation_results",
        "converact_conversation_evaluations",
        "converact_conversation_bad_cases",
        "converact_conversation_projection_commands",
        "converact_conversation_projection_receipts",
        "PRIMARY KEY (tenant_id, segment_id)",
        "UNIQUE (tenant_id, interaction_id, source_event_id)",
        "UNIQUE (tenant_id, interaction_id, execution_generation, segment_sequence)",
        "UNIQUE (tenant_id, interaction_id, result_revision)",
        "payload_hash",
        "transcript_snapshot_digest",
        "outcome_schema_revision_id",
        "evaluation_rubric_revision_id",
        "overall_score_bps",
        "bad_case_reasons",
        "prepared",
        "state_observed",
        "FOR UPDATE SKIP LOCKED",
        "ENABLE ROW LEVEL SECURITY",
        "FORCE ROW LEVEL SECURITY",
        "transcript segments are immutable",
        "conversation snapshots are immutable",
        "conversation results are immutable",
        "conversation evaluations are immutable",
        "projection receipts are immutable",
        "ai_agent",
    ] {
        assert!(migration.contains(required), "missing invariant {required}");
    }

    for required in [
        "converact_conversation_transcript_segments",
        "converact_conversation_snapshots",
        "converact_conversation_results",
        "converact_conversation_evaluations",
        "converact_conversation_bad_cases",
        "converact_conversation_projection_commands",
        "converact_conversation_projection_receipts",
        "transcript_snapshot_digest",
        "overall_score_bps",
        "bad_case_reasons",
    ] {
        assert!(
            development.contains(required),
            "missing development invariant {required}"
        );
    }
}
