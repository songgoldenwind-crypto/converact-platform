#[test]
fn postgres_adapter_keeps_replay_fencing_and_bad_case_in_one_transaction_boundary() {
    let source = include_str!("../src/postgres.rs");

    for required in [
        "append_final_segment",
        "prepare_projection_command",
        "finalize_projection_applied",
        "finalize_projection_not_applied",
        "generation_status",
        "freeze_snapshot",
        "verify_next_snapshot_revision",
        "persist_result",
        "persist_evaluation",
        "verify_evaluation_evidence",
        "ON CONFLICT DO NOTHING",
        "FOR UPDATE",
        "payload_hash",
        "execution_generation",
        "result_revision",
        "transcript_snapshot_digest",
        "canonical_bad_case_payload_hash",
        "converact_conversation_bad_cases",
    ] {
        assert!(
            source.contains(required),
            "missing adapter invariant {required}"
        );
    }
}
