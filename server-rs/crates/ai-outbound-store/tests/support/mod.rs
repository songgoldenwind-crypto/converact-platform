use std::env;

use converact_kernel_ids::TenantId;
use tokio::task::JoinHandle;
use tokio_postgres::{Client, NoTls, Transaction};

pub fn tenant(value: &str) -> TenantId {
    TenantId::parse(value).unwrap()
}

pub async fn connect() -> (Client, JoinHandle<Result<(), tokio_postgres::Error>>) {
    let database_url = env::var("CONVERACT_TEST_DATABASE_URL")
        .expect("CONVERACT_TEST_DATABASE_URL must be an isolated disposable database");
    let (client, connection) = tokio_postgres::connect(&database_url, NoTls)
        .await
        .expect("connect isolated PostgreSQL");
    (client, tokio::spawn(connection))
}

pub async fn tenant_transaction<'a>(client: &'a mut Client, tenant: &TenantId) -> Transaction<'a> {
    let transaction = client.transaction().await.unwrap();
    transaction
        .query_one(
            "SELECT set_config('app.current_tenant', $1, true)",
            &[&tenant.as_str()],
        )
        .await
        .unwrap();
    transaction
}

pub async fn seed_attempts(client: &mut Client, tenant: &TenantId) {
    let transaction = tenant_transaction(client, tenant).await;
    transaction
        .execute(
            "INSERT INTO tenants (id, name) VALUES ($1, 'Voice store test')
             ON CONFLICT (id) DO NOTHING",
            &[&tenant.as_str()],
        )
        .await
        .unwrap();
    transaction
        .execute(
            "INSERT INTO converact_agent_releases (
               tenant_id, id, definition_id, state, name, language, content_hash, components
             ) VALUES ($1, 'release-001', 'agent-001', 'published', 'Agent', 'zh-CN',
               repeat('a', 64), '{}'::jsonb)
             ON CONFLICT (tenant_id, id) DO NOTHING",
            &[&tenant.as_str()],
        )
        .await
        .unwrap();
    transaction
        .execute(
            "INSERT INTO converact_outbound_dial_policy_revisions (
               tenant_id, id, content_hash, caller_id, timeout_secs, trunk
             ) VALUES ($1, 'policy-r1', repeat('b', 64), '+8610000000000', 30, 'carrier-a')
             ON CONFLICT (tenant_id, id) DO NOTHING",
            &[&tenant.as_str()],
        )
        .await
        .unwrap();
    transaction
        .execute(
            "INSERT INTO converact_outbound_campaigns (
               tenant_id, id, agent_release_id, audience_id, dial_policy_revision, state, schedule
             ) VALUES ($1, 'campaign-001', 'release-001', 'audience-001', 'policy-r1',
               'running', '{}'::jsonb)
             ON CONFLICT (tenant_id, id) DO NOTHING",
            &[&tenant.as_str()],
        )
        .await
        .unwrap();
    transaction
        .execute(
            "INSERT INTO converact_outbound_campaign_contacts (
               tenant_id, id, campaign_id, external_contact_id, destination, consent_id,
               recording_mode, retention_until, scheduled_for
             ) VALUES ($1, 'contact-001', 'campaign-001', 'external-001', '+8613800138000',
               'consent-001', 'after_disclosure', transaction_timestamp() + interval '30 days',
               transaction_timestamp())
             ON CONFLICT (tenant_id, id) DO NOTHING",
            &[&tenant.as_str()],
        )
        .await
        .unwrap();
    for attempt_number in 1_i32..=2 {
        let id = format!("attempt-{attempt_number:03}");
        let interaction_id = format!("interaction-{attempt_number:03}");
        let idempotency_key = format!("dial:{id}");
        transaction
            .execute(
                "INSERT INTO converact_outbound_call_attempts (
                   tenant_id, id, campaign_id, campaign_contact_id, attempt_number,
                   interaction_id, agent_release_id, execution_generation, state,
                   idempotency_key, consent_id, recording_mode, retention_until,
                   dial_policy_revision, dial_policy_content_hash, dial_destination,
                   dial_caller_id, dial_timeout_secs, dial_trunk, scheduled_for
                 ) VALUES ($1, $2, 'campaign-001', 'contact-001', $3, $4, 'release-001', 1,
                   'planned', $5, 'consent-001', 'after_disclosure',
                   transaction_timestamp() + interval '30 days', 'policy-r1', repeat('b', 64),
                   '+8613800138000', '+8610000000000', 30, 'carrier-a',
                   transaction_timestamp())
                 ON CONFLICT (tenant_id, id) DO NOTHING",
                &[
                    &tenant.as_str(),
                    &id,
                    &attempt_number,
                    &interaction_id,
                    &idempotency_key,
                ],
            )
            .await
            .unwrap();
    }
    transaction.commit().await.unwrap();
}
