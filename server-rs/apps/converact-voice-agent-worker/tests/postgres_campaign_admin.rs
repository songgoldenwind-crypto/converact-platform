use std::{sync::Arc, time::Duration};

use converact_ai_outbound_store::{AiOutboundStore, StoreConfig};
use converact_postgres_store::{
    PostgresCampaignAdminStore, PostgresRuntime, PostgresRuntimeLimits, PostgresRuntimeSettings,
};
use converact_voice_agent_worker::PostgresCampaignAdminPort;
use tokio_postgres::NoTls;

#[test]
fn postgres_campaign_admin_port_is_inert_and_redacted() {
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
    let config = "host=127.0.0.1 user=admin password=do-not-print dbname=converact"
        .parse()
        .unwrap();
    let runtime = Arc::new(PostgresRuntime::build(config, NoTls, settings).unwrap());
    let sql = AiOutboundStore::new(StoreConfig::new(30_000, 8).unwrap());
    let store = PostgresCampaignAdminStore::new(Arc::clone(&runtime), sql);

    let port = PostgresCampaignAdminPort::new(store);

    assert_eq!(runtime.status().connections, 0);
    let debug = format!("{port:?}");
    assert!(!debug.contains("127.0.0.1"));
    assert!(!debug.contains("do-not-print"));
    assert!(!debug.contains("user=admin"));
}

#[test]
fn postgres_port_implements_all_campaign_admin_commands_without_call_authority() {
    let source = include_str!("../src/postgres_campaign_admin.rs");

    for required in [
        "impl CampaignAdminPort for PostgresCampaignAdminPort",
        ".publish_agent(",
        ".create_campaign(",
        ".import_contacts(",
        ".transition_campaign(",
        "map_store_error",
        "map_receipt",
    ] {
        assert!(
            source.contains(required),
            "missing adapter behavior {required}"
        );
    }
    for forbidden in ["TelephonyPort", "ActiveCall", "originate", "MediaEngine"] {
        assert!(
            !source.contains(forbidden),
            "Campaign Admin gained call authority: {forbidden}"
        );
    }
}
