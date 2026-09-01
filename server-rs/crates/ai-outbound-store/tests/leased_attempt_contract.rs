use converact_ai_outbound_core::{
    ActiveAttemptExecution, AttemptCommand, CallAttempt, EffectIntent,
};
use converact_ai_outbound_store::{
    AdvanceActiveAttempt, AdvanceAttempt, AppendEffectIntent, AttemptLease, AttemptLeaseInput,
    StoreError,
};
use converact_kernel_ids::TenantId;
use converact_voice_agent_contracts::{
    CallAttemptId, CallId, ChannelAgentSessionId, ExecutionGeneration,
};

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
fn active_execution_binds_call_and_agent_session_to_the_exact_lease() {
    let active = ActiveAttemptExecution::try_new(
        conversing_attempt("attempt-001"),
        CallId::parse("attempt-001").unwrap(),
        ChannelAgentSessionId::parse("agent-session-001").unwrap(),
    )
    .unwrap();

    let command = AdvanceActiveAttempt::try_from_execution(&lease(), &active).unwrap();
    let debug = format!("{command:?}");
    assert!(debug.contains("attempt-001"));
    assert!(debug.contains("agent-session-001"));
    assert!(!debug.contains(&"a".repeat(64)));

    let other = ActiveAttemptExecution::try_new(
        conversing_attempt("attempt-002"),
        CallId::parse("attempt-002").unwrap(),
        ChannelAgentSessionId::parse("agent-session-002").unwrap(),
    )
    .unwrap();
    assert_eq!(
        AdvanceActiveAttempt::try_from_execution(&lease(), &other).unwrap_err(),
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
        "advance_active_with_lease",
        "disclosure_completed",
        "execution_generation = $4",
        "lease_owner = $5",
        "lease_token_hash = $6",
        "lease_expires_at > transaction_timestamp()",
        "call_id = $7",
        "channel_agent_session_id = $8",
        "call_id IS NULL AND channel_agent_session_id IS NULL",
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

fn conversing_attempt(id: &str) -> CallAttempt {
    CallAttempt::new(CallAttemptId::parse(id).unwrap())
        .apply(AttemptCommand::Claim)
        .unwrap()
        .apply(AttemptCommand::ApproveCompliance)
        .unwrap()
        .apply(AttemptCommand::ReserveAgentCapacity)
        .unwrap()
        .apply(AttemptCommand::Dial)
        .unwrap()
        .apply(AttemptCommand::ObserveAnswered)
        .unwrap()
        .apply(AttemptCommand::AttachAgent)
        .unwrap()
        .apply(AttemptCommand::AwaitDisclosure)
        .unwrap()
        .apply(AttemptCommand::CompleteDisclosure)
        .unwrap()
        .apply(AttemptCommand::StartConversation)
        .unwrap()
}
