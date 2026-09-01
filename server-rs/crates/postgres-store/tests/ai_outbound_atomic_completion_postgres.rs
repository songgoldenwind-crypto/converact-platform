use std::{env, sync::Arc, time::Duration};

use converact_ai_outbound_core::{
    AttemptCompletionPort, CallAttempt, PortFailureKind, TerminalAttemptCommit,
};
use converact_ai_outbound_store::{AiOutboundStore, AttemptLease, AttemptLeaseInput, StoreConfig};
use converact_kernel_ids::TenantId;
use converact_post_call_finalization_store::{FinalizationSqlStore, FinalizationStoreConfig};
use converact_postgres_store::{
    PostgresLeasedAttemptStore, PostgresRuntime, PostgresRuntimeLimits, PostgresRuntimeSettings,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, AttemptCommand, CallAttemptId, CallId, CampaignId, ChannelAgentSessionId,
    ExecutionGeneration,
};
use tokio_postgres::NoTls;

#[tokio::test]
#[ignore = "requires an isolated disposable PostgreSQL database"]
async fn terminal_attempt_and_post_call_job_commit_or_roll_back_together() {
    let database_url = env::var("CONVERACT_TEST_DATABASE_URL")
        .expect("CONVERACT_TEST_DATABASE_URL must be an isolated disposable database");
    let (admin, connection) = tokio_postgres::connect(&database_url, NoTls).await.unwrap();
    tokio::spawn(async move { connection.await.unwrap() });
    install_schema(&admin).await;

    let runtime =
        Arc::new(PostgresRuntime::build(database_url.parse().unwrap(), NoTls, settings()).unwrap());
    seed_attempt(&admin, "attempt-001", "lease-a").await;
    let store = leased_store(Arc::clone(&runtime), "attempt-001", "lease-a");
    let command = completion("attempt-001");

    store.complete_and_enqueue(command.clone()).await.unwrap();
    store.complete_and_enqueue(command).await.unwrap();

    let committed = admin
        .query_one(
            "SELECT attempt.state, attempt.revision, attempt.call_id,
                    attempt.channel_agent_session_id, COUNT(job.job_id), COUNT(receipt.receipt_id)
             FROM converact_outbound_call_attempts AS attempt
             LEFT JOIN converact_post_call_finalization_jobs AS job
               ON job.tenant_id = attempt.tenant_id AND job.call_attempt_id = attempt.id
             LEFT JOIN converact_post_call_finalization_receipts AS receipt
               ON receipt.tenant_id = job.tenant_id AND receipt.job_id = job.job_id
             WHERE attempt.tenant_id = 'tenant-a' AND attempt.id = 'attempt-001'
             GROUP BY attempt.state, attempt.revision, attempt.call_id,
                      attempt.channel_agent_session_id",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(committed.get::<_, &str>(0), "completed");
    assert_eq!(committed.get::<_, i64>(1), 12);
    assert_eq!(committed.get::<_, Option<&str>>(2), Some("attempt-001"));
    assert_eq!(
        committed.get::<_, Option<&str>>(3),
        Some("session-attempt-001")
    );
    assert_eq!(committed.get::<_, i64>(4), 1);
    assert_eq!(committed.get::<_, i64>(5), 1);

    seed_attempt(&admin, "attempt-002", "lease-b").await;
    admin
        .batch_execute("DROP TABLE converact_post_call_finalization_receipts")
        .await
        .unwrap();
    let error = leased_store(runtime, "attempt-002", "lease-b")
        .complete_and_enqueue(completion("attempt-002"))
        .await
        .unwrap_err();
    assert_eq!(error.kind(), PortFailureKind::Unavailable);

    let rolled_back = admin
        .query_one(
            "SELECT state, revision,
                    (SELECT COUNT(*) FROM converact_post_call_finalization_jobs
                     WHERE tenant_id = 'tenant-a' AND call_attempt_id = 'attempt-002')
             FROM converact_outbound_call_attempts
             WHERE tenant_id = 'tenant-a' AND id = 'attempt-002'",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(rolled_back.get::<_, &str>(0), "conversing");
    assert_eq!(rolled_back.get::<_, i64>(1), 10);
    assert_eq!(rolled_back.get::<_, i64>(2), 0);
}

fn leased_store(
    runtime: Arc<PostgresRuntime>,
    attempt_id: &str,
    lease_owner: &str,
) -> PostgresLeasedAttemptStore {
    let lease = AttemptLease::try_new(AttemptLeaseInput {
        tenant_id: TenantId::parse("tenant-a").unwrap(),
        attempt_id: CallAttemptId::parse(attempt_id).unwrap(),
        execution_generation: ExecutionGeneration::new(1).unwrap(),
        lease_owner: lease_owner.to_owned(),
        lease_token_hash: "a".repeat(64),
    })
    .unwrap();
    PostgresLeasedAttemptStore::new(
        runtime,
        AiOutboundStore::new(StoreConfig::new(30_000, 16).unwrap()),
        FinalizationSqlStore::new(FinalizationStoreConfig::new(30_000, 16).unwrap()),
        lease,
    )
}

fn completion(attempt_id: &str) -> TerminalAttemptCommit {
    TerminalAttemptCommit::try_new(
        completed_attempt(attempt_id),
        CampaignId::parse("campaign-001").unwrap(),
        AgentReleaseId::parse("release-001").unwrap(),
        CallId::parse(attempt_id).unwrap(),
        ChannelAgentSessionId::parse(format!("session-{attempt_id}")).unwrap(),
    )
    .unwrap()
}

fn completed_attempt(attempt_id: &str) -> CallAttempt {
    let mut attempt = CallAttempt::new(CallAttemptId::parse(attempt_id).unwrap());
    for command in [
        AttemptCommand::Claim,
        AttemptCommand::ApproveCompliance,
        AttemptCommand::ReserveAgentCapacity,
        AttemptCommand::Dial,
        AttemptCommand::ObserveAnswered,
        AttemptCommand::AttachAgent,
        AttemptCommand::AwaitDisclosure,
        AttemptCommand::CompleteDisclosure,
        AttemptCommand::StartConversation,
        AttemptCommand::Finalize,
        AttemptCommand::Complete,
    ] {
        attempt = attempt.apply(command).unwrap();
    }
    attempt
}

async fn seed_attempt(admin: &tokio_postgres::Client, attempt_id: &str, owner: &str) {
    let attempt_number = if attempt_id == "attempt-001" {
        1_i32
    } else {
        2_i32
    };
    admin
        .execute(
            "INSERT INTO converact_outbound_call_attempts (
               tenant_id, id, campaign_id, campaign_contact_id, attempt_number,
               interaction_id, agent_release_id, execution_generation, state,
               idempotency_key, consent_id, recording_mode, retention_until,
               lease_owner, lease_token_hash, lease_expires_at, revision,
               disclosure_completed, dial_policy_revision, dial_policy_content_hash,
               dial_destination, dial_timeout_secs, scheduled_for
             ) VALUES (
               'tenant-a', $1, 'campaign-001', 'contact-001', $6,
               'interaction-001', 'release-001', 1, 'conversing',
               $2, 'consent-001', 'after_disclosure', now() + interval '30 days',
               $3, $4, now() + interval '5 minutes', 10,
               TRUE, 'dial-policy-001', $5, '+8613800138000', 30, now()
             )",
            &[
                &attempt_id,
                &format!("idempotency-{attempt_id}"),
                &owner,
                &"a".repeat(64),
                &"b".repeat(64),
                &attempt_number,
            ],
        )
        .await
        .unwrap();
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
        include_str!("../../../../src/migrations/128_post_call_finalization.sql"),
        include_str!("../../../../src/migrations/129_post_call_recovery_reason.sql"),
        include_str!("../../../../src/migrations/131_converact_outbound_dial_policy.sql"),
        include_str!("../../../../src/migrations/132_converact_outbound_attempt_recovery.sql"),
    ] {
        admin.batch_execute(migration).await.unwrap();
    }
    admin
        .batch_execute(
            "INSERT INTO converact_agent_releases (
               tenant_id, id, definition_id, state, name, language, content_hash, components
             ) VALUES (
               'tenant-a', 'release-001', 'definition-001', 'published', 'Test', 'zh-CN',
               repeat('1', 64), '{}'::jsonb
             );
             INSERT INTO converact_outbound_dial_policy_revisions (
               tenant_id, id, content_hash, timeout_secs
             ) VALUES ('tenant-a', 'dial-policy-001', repeat('b', 64), 30);
             INSERT INTO converact_outbound_campaigns (
               tenant_id, id, agent_release_id, audience_id, dial_policy_revision,
               state, schedule
             ) VALUES (
               'tenant-a', 'campaign-001', 'release-001', 'audience-001',
               'dial-policy-001', 'running', '{}'::jsonb
             );
             INSERT INTO converact_outbound_campaign_contacts (
               tenant_id, id, campaign_id, external_contact_id, destination, consent_id,
               recording_mode, retention_until, state, scheduled_for
             ) VALUES (
               'tenant-a', 'contact-001', 'campaign-001', 'external-001',
               '+8613800138000', 'consent-001', 'after_disclosure',
               now() + interval '30 days', 'active', now()
             );",
        )
        .await
        .unwrap();
}

fn settings() -> PostgresRuntimeSettings {
    PostgresRuntimeSettings::new(PostgresRuntimeLimits {
        max_connections: 4,
        max_waiters: 4,
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
