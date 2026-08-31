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
