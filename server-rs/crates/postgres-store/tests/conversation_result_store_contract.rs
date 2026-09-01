use std::{sync::Arc, time::Duration};

use converact_conversation_result_store::ConversationResultSqlStore;
use converact_postgres_store::{
    PostgresConversationResultStore, PostgresRuntime, PostgresRuntimeLimits,
    PostgresRuntimeSettings,
};
use tokio_postgres::NoTls;

#[test]
fn conversation_result_store_construction_is_inert_and_redacts_runtime_topology() {
    let settings = PostgresRuntimeSettings::new(PostgresRuntimeLimits {
        max_connections: 2,
        max_waiters: 1,
        pool_wait_timeout: Duration::from_millis(100),
        connect_timeout: Duration::from_millis(100),
        recycle_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_millis(200),
        lock_timeout: Duration::from_millis(100),
        transaction_timeout: Duration::from_millis(300),
        rollback_timeout: Duration::from_millis(100),
    })
    .unwrap();
    let config = "host=127.0.0.1 user=result password=do-not-print dbname=converact"
        .parse()
        .unwrap();
    let runtime = Arc::new(PostgresRuntime::build(config, NoTls, settings).unwrap());

    let store = PostgresConversationResultStore::new(
        Arc::clone(&runtime),
        ConversationResultSqlStore::new(),
    );

    assert_eq!(runtime.status().connections, 0);
    let debug = format!("{store:?}");
    assert!(!debug.contains("127.0.0.1"));
    assert!(!debug.contains("do-not-print"));
    assert!(!debug.contains("user=result"));
}

#[test]
fn result_projection_adapter_owns_atomic_prepare_and_finalize_transactions() {
    let source = include_str!("../src/conversation_result.rs");

    for required in [
        "prepare_projection",
        "finalize_result_projection",
        "finalize_evaluation_projection",
        "finalize_projection_not_applied",
        "prepare_projection_command",
        "finalize_projection_applied",
        "persist_result",
        "persist_evaluation",
    ] {
        assert!(
            source.contains(required),
            "missing adapter boundary {required}"
        );
    }
}

#[test]
fn sequenced_transcript_append_owns_one_tenant_transaction() {
    let source = include_str!("../src/conversation_result.rs");
    let method = source
        .split("pub async fn append_sequenced_final_segment")
        .nth(1)
        .and_then(|tail| tail.split("pub async fn append_final_segment").next())
        .expect("sequenced append method must precede the legacy append method");

    for required in [
        "with_tenant_transaction",
        "append_sequenced_final_segment",
        "map_append_decision",
    ] {
        assert!(
            method.contains(required),
            "missing atomic boundary {required}"
        );
    }
}

#[test]
fn conversation_quality_queries_are_tenant_transaction_bound() {
    let source = include_str!("../src/conversation_result.rs");

    for required in [
        "load_latest_result",
        "list_transcript",
        "load_recent_transcript_window",
        "list_evaluations",
        "list_bad_cases",
        "with_tenant_transaction",
        "parse_tenant",
    ] {
        assert!(
            source.contains(required),
            "missing tenant query boundary {required}"
        );
    }
}
