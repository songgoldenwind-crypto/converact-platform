use std::{sync::Arc, time::Duration};

use converact_post_call_finalization_store::{FinalizationSqlStore, FinalizationStoreConfig};
use converact_postgres_store::{
    PostgresRuntime, PostgresRuntimeLimits, PostgresRuntimeSettings, PostgresVoiceAgentStore,
};
use converact_voice_agent_worker::{PostgresVoiceAgentRepository, VoiceAgentRepository};
use tokio_postgres::NoTls;

#[test]
fn concrete_postgres_repository_is_inert_shareable_and_redacted() {
    fn assert_repository<T: VoiceAgentRepository + Send + Sync>() {}
    assert_repository::<PostgresVoiceAgentRepository>();

    let runtime = Arc::new(
        PostgresRuntime::build(
            "host=127.0.0.1 user=worker password=do-not-print dbname=converact"
                .parse()
                .unwrap(),
            NoTls,
            settings(),
        )
        .unwrap(),
    );
    let store = PostgresVoiceAgentStore::new(
        Arc::clone(&runtime),
        FinalizationSqlStore::new(FinalizationStoreConfig::new(30_000, 16).unwrap()),
    );
    let repository = PostgresVoiceAgentRepository::new(store);

    assert_eq!(runtime.status().connections, 0);
    let debug = format!("{repository:?}");
    assert!(!debug.contains("127.0.0.1"));
    assert!(!debug.contains("do-not-print"));
    assert!(!debug.contains("user=worker"));
}

fn settings() -> PostgresRuntimeSettings {
    PostgresRuntimeSettings::new(PostgresRuntimeLimits {
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
    .unwrap()
}
