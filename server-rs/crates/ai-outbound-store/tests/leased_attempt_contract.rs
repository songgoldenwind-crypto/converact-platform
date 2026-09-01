use converact_ai_outbound_core::{AttemptCommand, CallAttempt, EffectIntent};
use converact_ai_outbound_store::{
    AdvanceAttempt, AppendEffectIntent, AttemptLease, AttemptLeaseInput, StoreError,
};
use converact_kernel_ids::TenantId;
use converact_voice_agent_contracts::{CallAttemptId, ExecutionGeneration};

#[test]
fn lease_authority_is_bounded_and_effect_intent_identity_is_deterministic() {
    let lease = lease();
    let attempt = CallAttempt::new(CallAttemptId::parse("attempt-001").unwrap())
        .apply(AttemptCommand::Claim)
        .unwrap()
        .apply(AttemptCommand::ApproveCompliance)
        .unwrap();

    let first = AppendEffectIntent::try_new(&lease, &attempt, EffectIntent::ReserveAgent).unwrap();
    let replay = AppendEffectIntent::try_new(&lease, &attempt, EffectIntent::ReserveAgent).unwrap();
    let different =
        AppendEffectIntent::try_new(&lease, &attempt, EffectIntent::OriginateCall).unwrap();

    assert_eq!(first.event_id(), replay.event_id());
    assert_eq!(first.idempotency_key(), replay.idempotency_key());
    assert_eq!(first.payload_hash(), replay.payload_hash());
    assert_ne!(first.event_id(), different.event_id());
    assert_eq!(first.expected_revision(), attempt.revision());
    assert_eq!(first.event_type(), "effect_intent.reserve_agent");
    let next = attempt.apply(AttemptCommand::ReserveAgentCapacity).unwrap();
    let advance = AdvanceAttempt::try_from_observation(&lease, &next).unwrap();
    let debug = format!("{lease:?} {first:?} {advance:?}");
    assert!(!debug.contains(&"a".repeat(64)));
}

#[test]
fn lease_and_effect_intent_reject_malformed_or_cross_attempt_authority() {
    let invalid = AttemptLease::try_new(AttemptLeaseInput {
        tenant_id: TenantId::parse("tenant-a").unwrap(),
        attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        execution_generation: ExecutionGeneration::new(1).unwrap(),
        lease_owner: "worker-a".to_owned(),
        lease_token_hash: "A".repeat(64),
    });
    assert_eq!(invalid.unwrap_err(), StoreError::InvalidInput);

    let other = CallAttempt::new(CallAttemptId::parse("attempt-002").unwrap())
        .apply(AttemptCommand::Claim)
        .unwrap();
    assert_eq!(
        AppendEffectIntent::try_new(&lease(), &other, EffectIntent::ReserveAgent).unwrap_err(),
        StoreError::InvalidInput
    );
}

#[test]
fn leased_store_sql_fences_reads_transitions_and_effect_intents() {
    let source = include_str!("../src/postgres.rs");

    for required in [
        "load_leased_attempt",
        "load_dial_binding_with_lease",
        "append_effect_intent_with_lease",
        "disclosure_completed",
        "execution_generation = $4",
        "lease_owner = $5",
        "lease_token_hash = $6",
        "lease_expires_at > transaction_timestamp()",
        "INSERT INTO converact_outbound_attempt_events",
        "FROM converact_outbound_call_attempts AS attempt",
    ] {
        assert!(
            source.contains(required),
            "missing leased-store invariant {required}"
        );
    }
}

#[test]
fn claim_lease_milliseconds_keep_their_i64_postgres_parameter_type() {
    let source = include_str!("../src/postgres.rs");

    assert!(source.contains("$5::bigint * interval '1 millisecond'"));
}

fn lease() -> AttemptLease {
    AttemptLease::try_new(AttemptLeaseInput {
        tenant_id: TenantId::parse("tenant-a").unwrap(),
        attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        execution_generation: ExecutionGeneration::new(1).unwrap(),
        lease_owner: "worker-a".to_owned(),
        lease_token_hash: "a".repeat(64),
    })
    .unwrap()
}
