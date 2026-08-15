use std::time::Duration;

use converact_kernel_ids::{Generation, OwnerEpoch, TenantId};
use converact_migration_routing::{AuthorityKind, MutationScope, PartitionKey, RouteKey};
use converact_migration_store::{LeaseToken, WriterFenceBinding};
use converact_postgres_store::{
    DeliveryLeaseToken, OutboxClaimCommand, OutboxClaimCommandError, OutboxTransitionCommand,
    OutboxTransitionCommandError, OutboxTransitionKind, PlatformStorePolicy,
    PlatformStorePolicyError,
};

const PLATFORM_EVENT_SOURCE: &str = include_str!("../src/platform_event.rs");
const PLATFORM_OUTBOX_SOURCE: &str = include_str!("../src/platform_outbox.rs");
const PLATFORM_EVENT_MIGRATION: &str =
    include_str!("../../../../src/migrations/118_converact_platform_event_runtime_fencing.sql");

#[test]
fn route_writer_and_delivery_capabilities_are_distinct_and_redacted() {
    let route_key = RouteKey::new(
        TenantId::parse("tenant-a").unwrap(),
        AuthorityKind::parse("platform-event").unwrap(),
        PartitionKey::parse("partition-a").unwrap(),
    );
    let route_lease = LeaseToken::parse(&"a".repeat(64)).unwrap();
    let binding = WriterFenceBinding::new(
        &route_key,
        Generation::new(11).unwrap(),
        OwnerEpoch::parse("23").unwrap(),
        &route_lease,
        MutationScope::ExistingObject {
            starting_generation: Generation::new(11).unwrap(),
        },
    );
    let delivery_lease = DeliveryLeaseToken::parse(&"b".repeat(64)).unwrap();

    assert_eq!(binding.generation().get(), 11);
    assert_eq!(binding.owner_epoch().get(), 23);
    assert_eq!(format!("{binding:?}"), "WriterFenceBinding([REDACTED])");
    assert_eq!(
        format!("{delivery_lease:?}"),
        "DeliveryLeaseToken([REDACTED])"
    );
    assert!(!format!("{binding:?}").contains(&"a".repeat(64)));
    assert!(!format!("{delivery_lease:?}").contains(&"b".repeat(64)));
}

#[test]
fn event_store_policy_bounds_every_lease_retry_attempt_and_batch() {
    let policy =
        PlatformStorePolicy::new(Duration::from_secs(60), Duration::from_secs(30), 20, 200)
            .unwrap();
    assert_eq!(policy.claim_batch_limit(), 200);
    assert_eq!(policy.max_attempts(), 20);

    for (lease, retry, attempts, batch, expected) in [
        (
            Duration::ZERO,
            Duration::ZERO,
            20,
            20,
            PlatformStorePolicyError::InvalidLease,
        ),
        (
            Duration::from_secs(901),
            Duration::ZERO,
            20,
            20,
            PlatformStorePolicyError::InvalidLease,
        ),
        (
            Duration::from_secs(60),
            Duration::from_secs(86_401),
            20,
            20,
            PlatformStorePolicyError::InvalidRetry,
        ),
        (
            Duration::from_secs(60),
            Duration::ZERO,
            0,
            20,
            PlatformStorePolicyError::InvalidAttempts,
        ),
        (
            Duration::from_secs(60),
            Duration::ZERO,
            1_001,
            20,
            PlatformStorePolicyError::InvalidAttempts,
        ),
        (
            Duration::from_secs(60),
            Duration::ZERO,
            20,
            0,
            PlatformStorePolicyError::InvalidBatch,
        ),
        (
            Duration::from_secs(60),
            Duration::ZERO,
            20,
            201,
            PlatformStorePolicyError::InvalidBatch,
        ),
    ] {
        assert_eq!(
            PlatformStorePolicy::new(lease, retry, attempts, batch),
            Err(expected)
        );
    }
}

#[test]
fn outbox_transition_command_is_bounded_and_redacts_delivery_capability() {
    let complete = OutboxTransitionCommand::complete(
        "transition-complete-a",
        "outbox-a",
        "worker-a",
        1,
        DeliveryLeaseToken::parse(&"c".repeat(64)).unwrap(),
    )
    .unwrap();
    assert_eq!(complete.kind(), OutboxTransitionKind::Complete);
    assert_eq!(complete.claim_revision(), 1);
    assert_eq!(
        format!("{complete:?}"),
        "OutboxTransitionCommand([REDACTED])"
    );
    assert!(!format!("{complete:?}").contains(&"c".repeat(64)));

    let retry = OutboxTransitionCommand::retry(
        "transition-retry-a",
        "outbox-a",
        "worker-a",
        2,
        DeliveryLeaseToken::parse(&"d".repeat(64)).unwrap(),
        "temporary_delivery_failure",
        Duration::from_secs(30),
    )
    .unwrap();
    assert_eq!(retry.kind(), OutboxTransitionKind::Retry);
    assert_eq!(retry.error_code(), Some("temporary_delivery_failure"));

    let dead_letter = OutboxTransitionCommand::dead_letter(
        "transition-dead-a",
        "outbox-a",
        "worker-a",
        3,
        DeliveryLeaseToken::parse(&"e".repeat(64)).unwrap(),
        "delivery_attempts_exhausted",
    )
    .unwrap();
    assert_eq!(dead_letter.kind(), OutboxTransitionKind::DeadLetter);

    assert_eq!(
        OutboxTransitionCommand::retry(
            "transition-retry-a",
            "outbox-a",
            "worker-a",
            0,
            DeliveryLeaseToken::parse(&"f".repeat(64)).unwrap(),
            "temporary_delivery_failure",
            Duration::from_secs(30),
        )
        .unwrap_err(),
        OutboxTransitionCommandError::InvalidRevision
    );
    assert_eq!(
        OutboxTransitionCommand::dead_letter(
            "transition-dead-a",
            "outbox-a",
            "worker-a",
            3,
            DeliveryLeaseToken::parse(&"f".repeat(64)).unwrap(),
            "contains secret=value",
        )
        .unwrap_err(),
        OutboxTransitionCommandError::InvalidErrorCode
    );
}

#[test]
fn outbox_claim_command_has_one_exact_operation_identity() {
    let command = OutboxClaimCommand::new(
        "claim-operation-a",
        "worker-a",
        DeliveryLeaseToken::parse(&"1".repeat(64)).unwrap(),
    )
    .unwrap();
    assert_eq!(command.operation_id(), "claim-operation-a");
    assert_eq!(command.worker_id(), "worker-a");
    assert_eq!(format!("{command:?}"), "OutboxClaimCommand([REDACTED])");
    assert!(!format!("{command:?}").contains(&"1".repeat(64)));
    assert_eq!(
        OutboxClaimCommand::new(
            "contains space",
            "worker-a",
            DeliveryLeaseToken::parse(&"2".repeat(64)).unwrap(),
        )
        .unwrap_err(),
        OutboxClaimCommandError::InvalidIdentifier
    );
}

#[test]
fn durable_sql_keeps_fence_claim_clock_and_delivery_token_in_postgres() {
    for required in [
        "converact_authority_writer_fence(",
        "converact_authority_claim_generation_work(",
        "converact_authority_release_generation_work(",
        "transaction_timestamp()",
        "FOR UPDATE SKIP LOCKED",
        "sha256(convert_to(",
        "route_generation",
        "generation",
        "transition_revision",
        "claim_operation_id",
    ] {
        assert!(
            PLATFORM_EVENT_SOURCE.contains(required)
                || PLATFORM_OUTBOX_SOURCE.contains(required)
                || PLATFORM_EVENT_MIGRATION.contains(required),
            "missing {required}"
        );
    }
    let durable_source = format!("{PLATFORM_EVENT_SOURCE}{PLATFORM_OUTBOX_SOURCE}");
    let platform_outbox_adapter = PLATFORM_OUTBOX_SOURCE
        .split_once("#[cfg(test)]")
        .map_or(PLATFORM_OUTBOX_SOURCE, |(adapter, _)| adapter);
    assert!(!durable_source.contains("caller_now"));
    assert!(!durable_source.contains("lease_token_hash: String"));
    assert!(!PLATFORM_EVENT_SOURCE.contains("INSERT INTO converact_platform_inbox"));
    assert!(!PLATFORM_EVENT_SOURCE.contains("INSERT INTO converact_platform_effect_receipts"));
    assert!(!platform_outbox_adapter.contains("INSERT INTO converact_platform_outbox"));
    assert!(!platform_outbox_adapter.contains("UPDATE converact_platform_outbox"));
    assert!(PLATFORM_EVENT_SOURCE.contains("converact_platform_effect_append("));
    assert!(PLATFORM_OUTBOX_SOURCE.contains("converact_platform_outbox_claim("));
}
