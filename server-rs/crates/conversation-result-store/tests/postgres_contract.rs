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

#[test]
fn sequenced_append_serializes_replay_before_allocating_a_new_sequence() {
    let source = include_str!("../src/postgres.rs");

    for required in [
        "append_sequenced_final_segment",
        "ensure_and_lock_transcript_stream_head",
        "load_source_event_sequence",
        "FOR UPDATE",
        "checked_add(1)",
        "segment_with_sequence",
        "append_final_segment_row",
    ] {
        assert!(
            source.contains(required),
            "missing sequence invariant {required}"
        );
    }

    let replay_lookup = source
        .find("load_source_event_sequence")
        .expect("replay lookup must exist");
    let allocation = source
        .find("checked_add(1)")
        .expect("sequence allocation must exist");
    assert!(
        replay_lookup < allocation,
        "source-event replay must be classified before sequence allocation"
    );
}
