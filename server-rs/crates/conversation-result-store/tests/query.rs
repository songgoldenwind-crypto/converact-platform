use converact_conversation_result_store::{EntityCursor, QueryLimit, QueryPage};

#[test]
fn query_limit_and_entity_cursor_are_bounded_before_sql() {
    assert_eq!(QueryLimit::new(1).unwrap().get(), 1);
    assert_eq!(QueryLimit::new(100).unwrap().get(), 100);
    assert!(QueryLimit::new(0).is_err());
    assert!(QueryLimit::new(101).is_err());

    assert_eq!(
        EntityCursor::parse("segment-001").unwrap().as_str(),
        "segment-001"
    );
    assert!(EntityCursor::parse("").is_err());
    assert!(EntityCursor::parse("segment/invalid").is_err());
}

#[test]
fn query_pages_reject_unbounded_adapter_results() {
    assert!(QueryPage::try_new(vec![1_u8; 100], Some("cursor-100".to_owned())).is_ok());
    assert!(QueryPage::try_new(vec![1_u8; 101], None).is_err());
    assert!(QueryPage::<u8>::try_new(Vec::new(), Some("bad/cursor".to_owned())).is_err());
}

#[test]
fn postgres_query_contract_is_tenant_bound_cursor_verified_and_never_unbounded() {
    let source = include_str!("../src/query.rs");

    for required in [
        "load_latest_result",
        "list_transcript",
        "list_evaluations",
        "list_bad_cases",
        "tenant_id = $1",
        "LIMIT $",
        "cursor",
        "transcript_text",
        "ORDER BY execution_generation, segment_sequence, segment_id",
        "ORDER BY created_at DESC, bad_case_id DESC",
    ] {
        assert!(
            source.contains(required),
            "missing query invariant {required}"
        );
    }
}
