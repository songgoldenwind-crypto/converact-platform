use std::{env, sync::Arc, time::Duration};

use converact_ai_outbound_core::{
    publish_agent, AgentDraft, CampaignCommand, CampaignSchedule, CampaignTransition,
    CreateCampaign, DialPolicyRevision, DialPolicyRevisionInput, ImportContact, ImportContactInput,
    ImportContacts, RecordingMode, ReleaseComponentDigests,
};
use converact_ai_outbound_store::{AiOutboundStore, StoreConfig};
use converact_contracts::canonical_sha256_with_max_bytes;
use converact_kernel_ids::TenantId;
use converact_post_call_finalization_store::{FinalizationSqlStore, FinalizationStoreConfig};
use converact_postgres_store::{
    PostgresAgentToolSchema, PostgresAiOutboundAttemptStore, PostgresCampaignAdminStore,
    PostgresRuntime, PostgresRuntimeLimits, PostgresRuntimeSettings,
};
use converact_voice_agent_contracts::{
    AgentDefinitionId, AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId,
    IdempotencyKey, InteractionId,
};
use serde_json::{json, Value};
use tokio_postgres::NoTls;

#[tokio::test]
#[ignore = "requires an isolated disposable PostgreSQL database"]
async fn campaign_authoring_creates_one_claimable_physical_attempt() {
    let database_url = env::var("CONVERACT_TEST_DATABASE_URL")
        .expect("CONVERACT_TEST_DATABASE_URL must be an isolated disposable database");
    let (admin, connection) = tokio_postgres::connect(&database_url, NoTls).await.unwrap();
    tokio::spawn(async move { connection.await.unwrap() });
    install_schema(&admin).await;

    let runtime =
        Arc::new(PostgresRuntime::build(database_url.parse().unwrap(), NoTls, settings()).unwrap());
    let sql = AiOutboundStore::new(StoreConfig::new(30_000, 4).unwrap());
    let authoring = PostgresCampaignAdminStore::new(Arc::clone(&runtime), sql);
    let tenant = TenantId::parse("tenant-a").unwrap();
    let tool_manifest = tool_manifest();
    let release = release(canonical_sha256_with_max_bytes(&tool_manifest, 65_536).unwrap());

    let published = authoring
        .publish_agent(
            &tenant,
            &release,
            &tool_manifest,
            &IdempotencyKey::parse("publish-release-001").unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(published.state(), "published");
    assert!(!published.replayed());
    assert!(authoring
        .publish_agent(
            &tenant,
            &release,
            &tool_manifest,
            &IdempotencyKey::parse("publish-release-001").unwrap(),
        )
        .await
        .unwrap()
        .replayed());

    let campaign = campaign();
    let created = authoring
        .create_campaign(
            &tenant,
            &campaign,
            &IdempotencyKey::parse("create-campaign-001").unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(created.state(), "draft");
    assert_eq!(created.revision(), 1);

    let imported = authoring
        .import_contacts(&tenant, &contacts())
        .await
        .unwrap();
    assert_eq!(imported.accepted_count(), 1);
    assert_eq!(imported.revision(), 2);

    let scheduled = authoring
        .transition_campaign(
            &tenant,
            &transition(CampaignCommand::Schedule, 2, "campaign-schedule-002"),
        )
        .await
        .unwrap();
    assert_eq!(scheduled.state(), "scheduled");
    assert_eq!(scheduled.revision(), 3);

    let running = authoring
        .transition_campaign(
            &tenant,
            &transition(CampaignCommand::Start, 3, "campaign-start-003"),
        )
        .await
        .unwrap();
    assert_eq!(running.state(), "running");
    assert_eq!(running.revision(), 4);

    let claim_store = PostgresAiOutboundAttemptStore::new(
        Arc::clone(&runtime),
        sql,
        FinalizationSqlStore::new(FinalizationStoreConfig::new(30_000, 4).unwrap()),
    );
    let claimed = claim_store
        .claim_planned(&tenant, "worker-a", &"a".repeat(64), 1)
        .await
        .unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].attempt_id().as_str(), "attempt-001");

    assert_persisted_campaign(&admin).await;
}

async fn assert_persisted_campaign(admin: &tokio_postgres::Client) {
    let row = admin
        .query_one(
            "SELECT campaign.state, campaign.revision, contact.attempt_count,
                    attempt.state, attempt.dial_destination, COUNT(receipt.idempotency_key)
             FROM converact_outbound_campaigns AS campaign
             JOIN converact_outbound_campaign_contacts AS contact
               ON contact.tenant_id = campaign.tenant_id AND contact.campaign_id = campaign.id
             JOIN converact_outbound_call_attempts AS attempt
               ON attempt.tenant_id = contact.tenant_id
              AND attempt.campaign_contact_id = contact.id
             JOIN converact_outbound_admin_receipts AS receipt
               ON receipt.tenant_id = campaign.tenant_id
             WHERE campaign.tenant_id = 'tenant-a' AND campaign.id = 'campaign-001'
             GROUP BY campaign.state, campaign.revision, contact.attempt_count,
                      attempt.state, attempt.dial_destination",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(row.get::<_, &str>(0), "running");
    assert_eq!(row.get::<_, i64>(1), 4);
    assert_eq!(row.get::<_, i32>(2), 1);
    assert_eq!(row.get::<_, &str>(3), "claimed");
    assert_eq!(row.get::<_, &str>(4), "+8613800138000");
    assert_eq!(row.get::<_, i64>(5), 5);
}

fn release(tool_schema_hash: String) -> converact_ai_outbound_core::AgentRelease {
    let draft = AgentDraft::try_new(
        AgentDefinitionId::parse("agent-001").unwrap(),
        AgentReleaseId::parse("release-001").unwrap(),
        "General service agent",
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

fn campaign() -> CreateCampaign {
    let policy = DialPolicyRevision::try_new(DialPolicyRevisionInput {
        revision_id: "dial-policy-001".to_owned(),
        caller_id: Some("+8610000000000".to_owned()),
        timeout_secs: 30,
        trunk: Some("carrier-a".to_owned()),
    })
    .unwrap();
    CreateCampaign::try_new(
        CampaignId::parse("campaign-001").unwrap(),
        AgentReleaseId::parse("release-001").unwrap(),
        "audience-001",
        policy,
        CampaignSchedule::try_new(1_700_000_000_000, "Asia/Shanghai").unwrap(),
    )
    .unwrap()
}

fn contacts() -> ImportContacts {
    let contact = ImportContact::try_new(ImportContactInput {
        contact_id: CampaignContactId::parse("contact-001").unwrap(),
        external_contact_id: "external-001".to_owned(),
        destination: "+8613800138000".to_owned(),
        consent_id: "consent-001".to_owned(),
        recording_mode: RecordingMode::AfterDisclosure,
        retention_until_ms: 1_900_000_000_000,
        scheduled_for_ms: 1_700_000_000_000,
        attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        idempotency_key: IdempotencyKey::parse("dial-attempt-001").unwrap(),
    })
    .unwrap();
    ImportContacts::try_new(
        CampaignId::parse("campaign-001").unwrap(),
        1,
        IdempotencyKey::parse("import-campaign-001").unwrap(),
        vec![contact],
    )
    .unwrap()
}

fn transition(command: CampaignCommand, revision: u64, key: &str) -> CampaignTransition {
    CampaignTransition::try_new(
        CampaignId::parse("campaign-001").unwrap(),
        command,
        revision,
        IdempotencyKey::parse(key).unwrap(),
    )
    .unwrap()
}

async fn install_schema(admin: &tokio_postgres::Client) {
    admin
        .batch_execute(
            "CREATE TABLE tenants (id TEXT PRIMARY KEY);
             CREATE FUNCTION opc_current_tenant() RETURNS TEXT LANGUAGE sql STABLE AS
               $$ SELECT current_setting('app.current_tenant', true) $$;
             CREATE FUNCTION opc_rls_bypass() RETURNS BOOLEAN LANGUAGE sql STABLE AS
               $$ SELECT TRUE $$;
             INSERT INTO tenants(id) VALUES ('tenant-a');",
        )
        .await
        .unwrap();
    for migration in [
        include_str!("../../../../src/migrations/124_converact_ai_outbound.sql"),
        include_str!("../../../../src/migrations/130_converact_outbound_admin_receipts.sql"),
        include_str!("../../../../src/migrations/131_converact_outbound_dial_policy.sql"),
        include_str!("../../../../src/migrations/132_converact_outbound_attempt_recovery.sql"),
        include_str!("../../../../src/migrations/141_converact_agent_release_tool_manifests.sql"),
    ] {
        admin.batch_execute(migration).await.unwrap();
    }
}

fn settings() -> PostgresRuntimeSettings {
    PostgresRuntimeSettings::new(PostgresRuntimeLimits {
        max_connections: 2,
        max_waiters: 2,
        pool_wait_timeout: Duration::from_secs(1),
        connect_timeout: Duration::from_secs(1),
        recycle_timeout: Duration::from_secs(1),
        statement_timeout: Duration::from_secs(2),
        lock_timeout: Duration::from_secs(1),
        transaction_timeout: Duration::from_secs(4),
        rollback_timeout: Duration::from_secs(1),
    })
    .unwrap()
}
