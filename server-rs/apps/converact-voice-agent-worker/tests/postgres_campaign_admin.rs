use std::{sync::Arc, time::Duration};

use converact_ai_outbound_core::{publish_agent, AgentDraft, ReleaseComponentDigests};
use converact_ai_outbound_store::{AiOutboundStore, StoreConfig};
use converact_contracts::canonical_sha256_with_max_bytes;
use converact_kernel_ids::TenantId;
use converact_postgres_store::{
    PostgresAgentToolSchema, PostgresCampaignAdminStore, PostgresRuntime, PostgresRuntimeLimits,
    PostgresRuntimeSettings,
};
use converact_voice_agent_contracts::{AgentDefinitionId, AgentReleaseId, IdempotencyKey};
use converact_voice_agent_worker::{
    AgentReleaseToolManifest, AuthenticatedTenant, CampaignAdminPort, PostgresCampaignAdminPort,
};
use serde_json::{json, Value};
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

    let port = PostgresCampaignAdminPort::new(store, TenantId::parse("tenant-a").unwrap());

    assert_eq!(runtime.status().connections, 0);
    let debug = format!("{port:?}");
    assert!(!debug.contains("127.0.0.1"));
    assert!(!debug.contains("do-not-print"));
    assert!(!debug.contains("user=admin"));
}

#[tokio::test]
async fn port_rejects_a_tenant_outside_the_worker_authority_before_database_access() {
    let (runtime, store) = store();
    let port = PostgresCampaignAdminPort::new(store, TenantId::parse("tenant-a").unwrap());
    let tenant = AuthenticatedTenant::try_from_verified_tenant_id("tenant-b").unwrap();
    let manifest_value = tool_manifest();
    let manifest_hash = canonical_sha256_with_max_bytes(&manifest_value, 65_536).unwrap();
    let release = release(manifest_hash);
    let manifest = AgentReleaseToolManifest::try_new(&release, manifest_value).unwrap();

    let error = port
        .publish_agent(
            &tenant,
            &release,
            &manifest,
            &IdempotencyKey::parse("publish-release-001").unwrap(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code(), "ai_outbound_admin_not_allowed");
    assert_eq!(runtime.status().connections, 0);
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

fn store() -> (Arc<PostgresRuntime>, PostgresCampaignAdminStore) {
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
    (runtime, store)
}

fn release(tool_schema_hash: String) -> converact_ai_outbound_core::AgentRelease {
    let draft = AgentDraft::try_new(
        AgentDefinitionId::parse("agent-001").unwrap(),
        AgentReleaseId::parse("release-001").unwrap(),
        "Agent",
        "zh-CN",
    )
    .unwrap();
    publish_agent(
        draft,
        ReleaseComponentDigests {
            prompt_revision_hash: "1".repeat(64),
            conversation_flow_revision_hash: "2".repeat(64),
            knowledge_revision_hash: "3".repeat(64),
            tool_schema_hash,
            speech_profile_hash: "5".repeat(64),
            compliance_policy_hash: "6".repeat(64),
            outcome_schema_hash: "7".repeat(64),
            evaluation_rubric_hash: "8".repeat(64),
        },
    )
    .unwrap()
}

fn tool_manifest() -> Value {
    let schemas = PostgresAgentToolSchema::new();
    json!([{
        "name": "customer.lookup",
        "revision_id": "customer.lookup-r1",
        "schema_hash": schemas.schema_hash("customer.lookup").unwrap(),
        "arguments_schema": schemas.schema_document("customer.lookup").unwrap(),
        "effect_class": "query",
        "risk": "low",
        "action_capability": "customer.lookup",
        "policy_decision": "allowed",
        "deadline_after_ms": 5_000,
    }])
}
