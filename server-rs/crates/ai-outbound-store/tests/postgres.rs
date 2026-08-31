mod support;

use converact_ai_outbound_store::{AdvanceAttempt, AiOutboundStore, StoreConfig, StoreError};
use converact_voice_agent_contracts::{CallAttemptId, CallAttemptState, ExecutionGeneration};
use support::{connect, seed_attempts, tenant, tenant_transaction};

#[ignore = "requires an isolated PostgreSQL database migrated through 132"]
#[tokio::test]
async fn claim_uses_database_clock_and_skip_locked() {
    let tenant = tenant("voice-store-claim");
    let (mut seed_client, seed_connection) = connect().await;
    seed_attempts(&mut seed_client, &tenant).await;
    drop(seed_client);
    seed_connection.await.unwrap().unwrap();

    let store = AiOutboundStore::new(StoreConfig::new(30_000, 1).unwrap());
    let (mut client_a, connection_a) = connect().await;
    let (mut client_b, connection_b) = connect().await;
    let transaction_a = tenant_transaction(&mut client_a, &tenant).await;
    let transaction_b = tenant_transaction(&mut client_b, &tenant).await;
    let token_a = "a".repeat(64);
    let token_b = "b".repeat(64);
    let (first, second) = tokio::join!(
        store.claim_planned(&transaction_a, &tenant, "worker-a", &token_a, 1),
        store.claim_planned(&transaction_b, &tenant, "worker-b", &token_b, 1),
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(second.len(), 1);
    assert_ne!(first[0].id(), second[0].id());
    transaction_a.commit().await.unwrap();
    transaction_b.commit().await.unwrap();
    drop(client_a);
    drop(client_b);
    connection_a.await.unwrap().unwrap();
    connection_b.await.unwrap().unwrap();
}

#[ignore = "requires an isolated PostgreSQL database migrated through 132"]
#[tokio::test]
async fn stale_fence_cannot_advance_attempt() {
    let tenant = tenant("voice-store-stale");
    let (mut client, connection) = connect().await;
    seed_attempts(&mut client, &tenant).await;
    let store = AiOutboundStore::new(StoreConfig::new(30_000, 1).unwrap());

    let first_transaction = tenant_transaction(&mut client, &tenant).await;
    let first = store
        .claim_planned(&first_transaction, &tenant, "worker-a", &"a".repeat(64), 1)
        .await
        .unwrap()
        .remove(0);
    first_transaction.commit().await.unwrap();

    let expire_transaction = tenant_transaction(&mut client, &tenant).await;
    expire_transaction
        .execute(
            "UPDATE converact_outbound_call_attempts
             SET lease_expires_at = transaction_timestamp() - interval '1 second'
             WHERE tenant_id = $1 AND id = $2",
            &[&tenant.as_str(), &first.id().as_str()],
        )
        .await
        .unwrap();
    expire_transaction.commit().await.unwrap();

    let reclaim_transaction = tenant_transaction(&mut client, &tenant).await;
    let reclaimed = store
        .claim_planned(
            &reclaim_transaction,
            &tenant,
            "worker-b",
            &"b".repeat(64),
            1,
        )
        .await
        .unwrap()
        .remove(0);
    assert_eq!(reclaimed.id(), first.id());
    reclaim_transaction.commit().await.unwrap();

    let stale_transaction = tenant_transaction(&mut client, &tenant).await;
    let result = store
        .advance_with_lease(
            &stale_transaction,
            &AdvanceAttempt {
                tenant_id: tenant.clone(),
                attempt_id: first.id().clone(),
                expected_revision: first.revision(),
                expected_generation: ExecutionGeneration::new(1).unwrap(),
                lease_owner: "worker-a".to_owned(),
                lease_token_hash: "a".repeat(64),
                next_state: CallAttemptState::Dialing,
                disclosure_completed: false,
            },
        )
        .await;
    assert_eq!(result, Err(StoreError::LeaseStale));
    stale_transaction.rollback().await.unwrap();
    drop(client);
    connection.await.unwrap().unwrap();
}

#[ignore = "requires an isolated PostgreSQL database migrated through 132"]
#[tokio::test]
async fn dial_binding_is_loaded_from_one_attempt_and_legacy_rows_fail_closed() {
    let tenant = tenant("voice-store-dial-binding");
    let (mut client, connection) = connect().await;
    seed_attempts(&mut client, &tenant).await;
    let store = AiOutboundStore::new(StoreConfig::new(30_000, 1).unwrap());
    let attempt_id = CallAttemptId::parse("attempt-001").unwrap();

    let transaction = tenant_transaction(&mut client, &tenant).await;
    let binding = store
        .load_dial_binding(&transaction, &tenant, &attempt_id)
        .await
        .unwrap();
    assert_eq!(binding.destination(), "+8613800138000");
    assert_eq!(binding.caller_id(), Some("+8610000000000"));
    assert_eq!(binding.timeout_secs(), 30);
    assert_eq!(binding.trunk(), Some("carrier-a"));
    transaction.rollback().await.unwrap();

    let legacy_id = CallAttemptId::parse("attempt-legacy").unwrap();
    let legacy_insert = tenant_transaction(&mut client, &tenant).await;
    legacy_insert
        .execute(
            "INSERT INTO converact_outbound_call_attempts (
               tenant_id, id, campaign_id, campaign_contact_id, attempt_number,
               interaction_id, agent_release_id, execution_generation, state,
               idempotency_key, consent_id, recording_mode, retention_until, scheduled_for
             ) VALUES ($1, $2, 'campaign-001', 'contact-001', 3, 'interaction-legacy',
               'release-001', 1, 'planned', 'dial:attempt-legacy', 'consent-001',
               'after_disclosure', transaction_timestamp() + interval '30 days',
               transaction_timestamp())",
            &[&tenant.as_str(), &legacy_id.as_str()],
        )
        .await
        .unwrap();
    legacy_insert.commit().await.unwrap();

    let legacy = tenant_transaction(&mut client, &tenant).await;
    assert_eq!(
        store.load_dial_binding(&legacy, &tenant, &legacy_id).await,
        Err(StoreError::StoredRowInvalid),
    );
    legacy.rollback().await.unwrap();
    drop(client);
    connection.await.unwrap().unwrap();
}
