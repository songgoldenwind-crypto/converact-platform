use std::{sync::Arc, time::Duration};

use converact_ai_outbound_store::{AiOutboundStore, StoreConfig};
use converact_kernel_ids::TenantId;
use converact_post_call_finalization_store::{FinalizationSqlStore, FinalizationStoreConfig};
use converact_postgres_store::{
    PostgresAiOutboundAttemptStore, PostgresRuntime, PostgresRuntimeLimits, PostgresRuntimeSettings,
};
use converact_voice_agent_worker::{
    LeaseTokenDigestSource, PostgresAttemptClaimSource, SystemLeaseTokenDigestSource,
};
use tokio_postgres::NoTls;

const SOURCE: &str = include_str!("../src/postgres_claim_source.rs");

#[test]
fn postgres_claim_source_is_inert_shareable_and_redacted() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<PostgresAttemptClaimSource<SystemLeaseTokenDigestSource>>();

    let source = PostgresAttemptClaimSource::try_new(
        attempt_store(),
        TenantId::parse("tenant-a").unwrap(),
        "voice-worker-a",
        SystemLeaseTokenDigestSource::new(),
    )
    .unwrap();

    let debug = format!("{source:?}");
    assert_eq!(debug, "PostgresAttemptClaimSource { .. }");
    assert!(!debug.contains("tenant-a"));
    assert!(!debug.contains("do-not-print"));
}

#[test]
fn claim_source_rejects_invalid_owner_and_system_digests_are_unique_sha256_shapes() {
    assert!(
        PostgresAttemptClaimSource::try_new(
            attempt_store(),
            TenantId::parse("tenant-a").unwrap(),
            "invalid owner",
            SystemLeaseTokenDigestSource::new(),
        )
        .is_err()
    );

    let source = SystemLeaseTokenDigestSource::new();
    let first = source.next_digest().unwrap();
    let second = source.next_digest().unwrap();
    for digest in [&first, &second] {
        assert_eq!(digest.len(), 64);
        assert!(
            digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        );
    }
    assert_ne!(first, second);
}

#[test]
fn production_source_claims_new_and_expired_active_attempts() {
    assert!(SOURCE.contains(".claim_ready("));
    assert!(!SOURCE.contains(".claim_planned("));
}

fn attempt_store() -> PostgresAiOutboundAttemptStore {
    let runtime = Arc::new(
        PostgresRuntime::build(
            "host=127.0.0.1 user=worker password=do-not-print dbname=converact"
                .parse()
                .unwrap(),
            NoTls,
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
            .unwrap(),
        )
        .unwrap(),
    );
    PostgresAiOutboundAttemptStore::new(
        runtime,
        AiOutboundStore::new(StoreConfig::new(30_000, 16).unwrap()),
        FinalizationSqlStore::new(FinalizationStoreConfig::new(30_000, 16).unwrap()),
    )
}
