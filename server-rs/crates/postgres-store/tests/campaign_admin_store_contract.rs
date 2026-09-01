use std::{sync::Arc, time::Duration};

use converact_ai_outbound_store::{AiOutboundStore, StoreConfig};
use converact_postgres_store::{
    PostgresCampaignAdminStore, PostgresRuntime, PostgresRuntimeLimits, PostgresRuntimeSettings,
};
use tokio_postgres::NoTls;

#[test]
fn campaign_admin_store_construction_is_inert_and_redacts_runtime_topology() {
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
    let config = "host=127.0.0.1 user=campaign password=do-not-print dbname=converact"
        .parse()
        .unwrap();
    let runtime = Arc::new(PostgresRuntime::build(config, NoTls, settings).unwrap());
    let sql = AiOutboundStore::new(StoreConfig::new(30_000, 8).unwrap());

    let store = PostgresCampaignAdminStore::new(Arc::clone(&runtime), sql);

    assert_eq!(runtime.status().connections, 0);
    let debug = format!("{store:?}");
    assert!(!debug.contains("127.0.0.1"));
    assert!(!debug.contains("do-not-print"));
    assert!(!debug.contains("user=campaign"));
}

#[test]
fn every_campaign_admin_mutation_owns_one_tenant_transaction() {
    let source = include_str!("../src/campaign_admin.rs");

    for method in [
        "publish_agent",
        "create_campaign",
        "import_contacts",
        "transition_campaign",
    ] {
        let body = source
            .split(&format!("pub async fn {method}"))
            .nth(1)
            .and_then(|tail| tail.split("\n    ///").next())
            .unwrap_or_else(|| panic!("missing Campaign Admin method {method}"));
        assert_eq!(
            body.matches("with_tenant_transaction").count(),
            1,
            "{method} must own exactly one tenant transaction"
        );
    }
}

#[test]
fn campaign_transition_replays_before_reapplying_the_state_machine() {
    let source = include_str!("../src/campaign_admin.rs");
    let transition = source
        .split("pub async fn transition_campaign")
        .nth(1)
        .expect("transition method");
    let replay = transition
        .find("replay_admin_command")
        .expect("replay lookup");
    let lock = transition.find("lock_campaign").expect("campaign lock");
    let apply = transition.find(".apply(").expect("Core transition");

    assert!(replay < lock && lock < apply);
}

#[test]
fn release_and_tool_manifest_share_one_authoritative_transaction() {
    let source = include_str!("../src/campaign_admin.rs");
    let publish = source
        .split("pub async fn publish_agent")
        .nth(1)
        .and_then(|tail| tail.split("\n    ///").next())
        .expect("publish method");
    let release = publish
        .find("publish_agent_release")
        .expect("release write");
    let manifest = publish
        .find("persist_release_tool_manifest")
        .expect("manifest write");

    assert!(release < manifest);
    assert_eq!(publish.matches("with_tenant_transaction").count(), 1);
    assert!(source.contains("ON CONFLICT DO NOTHING RETURNING agent_release_id"));
}
