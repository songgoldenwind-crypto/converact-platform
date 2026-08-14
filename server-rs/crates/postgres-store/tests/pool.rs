use std::time::Duration;

use converact_postgres_store::{PostgresRuntime, PostgresRuntimeLimits, PostgresRuntimeSettings};
use tokio_postgres::NoTls;

#[test]
fn pool_is_inert_bounded_and_has_wait_create_recycle_deadlines() {
    let settings = PostgresRuntimeSettings::new(PostgresRuntimeLimits {
        max_connections: 3,
        max_waiters: 2,
        pool_wait_timeout: Duration::from_millis(101),
        connect_timeout: Duration::from_millis(202),
        recycle_timeout: Duration::from_millis(303),
        statement_timeout: Duration::from_millis(404),
        lock_timeout: Duration::from_millis(100),
        transaction_timeout: Duration::from_millis(505),
        rollback_timeout: Duration::from_millis(100),
    })
    .expect("valid settings");
    let pg_config = "host=127.0.0.1 user=opc_runtime password=never-print-me dbname=converact"
        .parse()
        .expect("PostgreSQL config");

    let runtime = PostgresRuntime::build(pg_config, NoTls, settings).expect("inert pool");
    let status = runtime.status();
    assert_eq!(status.max_connections, 3);
    assert_eq!(status.connections, 0);
    assert_eq!(status.available, 0);
    assert_eq!(status.waiting, 0);
    assert_eq!(runtime.pool_wait_timeout(), Duration::from_millis(101));
    assert_eq!(runtime.connect_timeout(), Duration::from_millis(202));
    assert_eq!(runtime.recycle_timeout(), Duration::from_millis(303));
    assert_eq!(runtime.max_waiters(), 2);
    let debug = format!("{runtime:?}");
    assert!(!debug.contains("never-print-me"));
    assert!(!debug.contains("127.0.0.1"));
    assert!(!debug.contains("opc_runtime"));
}
