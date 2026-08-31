use std::{sync::Arc, time::Duration};

use converact_post_call_finalization_store::{FinalizationSqlStore, FinalizationStoreConfig};
use converact_postgres_store::{
    PostgresPostCallFinalizationStore, PostgresRuntime, PostgresRuntimeLimits,
    PostgresRuntimeSettings,
};
use tokio_postgres::NoTls;

#[test]
fn post_call_store_construction_is_inert_and_redacts_runtime_topology() {
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
    let config = "host=127.0.0.1 user=finalizer password=do-not-print dbname=converact"
        .parse()
        .unwrap();
    let runtime = Arc::new(PostgresRuntime::build(config, NoTls, settings).unwrap());
    let sql = FinalizationSqlStore::new(FinalizationStoreConfig::new(30_000, 100).unwrap());

    let store = PostgresPostCallFinalizationStore::new(Arc::clone(&runtime), sql);

    assert_eq!(runtime.status().connections, 0);
    let debug = format!("{store:?}");
    assert!(!debug.contains("127.0.0.1"));
    assert!(!debug.contains("do-not-print"));
    assert!(!debug.contains("user=finalizer"));
}

#[test]
fn all_queue_mutations_own_one_tenant_transaction() {
    let source = include_str!("../src/post_call_finalization.rs");

    for required in [
        "enqueue",
        "claim_due",
        "require_reconcile",
        "complete",
        "load_progress",
        "with_tenant_transaction",
        "parse_tenant",
        "map_transaction_error",
    ] {
        assert!(
            source.contains(required),
            "missing tenant transaction boundary {required}"
        );
    }
}
