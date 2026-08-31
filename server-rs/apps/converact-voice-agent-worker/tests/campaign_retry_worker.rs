use std::sync::{Arc, Mutex};

use converact_ai_outbound_core::{AttemptCommand, CallAttempt, RetryCandidate, RetryPolicy};
use converact_voice_agent_contracts::{CallAttemptId, ExecutionGeneration, IdempotencyKey};
use converact_voice_agent_worker::{
    AttemptResource, AuthenticatedTenant, CampaignRetryRequest, CampaignRetryWorker,
    RetryDurabilityPort, RetryInspectionState, RetryPersistenceRequest, RetryWorkerDecision,
    RetryWorkerError, RetryWriteDecision,
};

#[tokio::test]
async fn deterministic_retry_creates_once_and_exact_replay_creates_nothing() {
    let state = Arc::new(Mutex::new(State::default()));
    let durability = Durability(Arc::clone(&state));
    let worker = CampaignRetryWorker::new(&durability);
    let previous = no_answer_attempt();
    let tenant = AuthenticatedTenant::try_from_verified_tenant_id("tenant-a").unwrap();
    let idempotency_key = IdempotencyKey::parse("dial:attempt-002").unwrap();
    let request = || CampaignRetryRequest {
        tenant: &tenant,
        candidate: RetryCandidate {
            previous_attempt: &previous,
            previous_attempt_number: 1,
            next_attempt_id: "attempt-002",
            terminal_observed_at_ms: 1_000_000,
        },
        policy: RetryPolicy::new(3, 60_000, false).unwrap(),
        expected_generation: ExecutionGeneration::new(1).unwrap(),
        idempotency_key: &idempotency_key,
    };

    assert_eq!(
        worker.plan_and_persist(request()).await.unwrap(),
        RetryWorkerDecision::Planned {
            attempt_id: CallAttemptId::parse("attempt-002").unwrap(),
            attempt_number: 2,
            scheduled_for_ms: 1_060_000,
            write: RetryWriteDecision::Created,
        }
    );
    assert_eq!(
        worker.plan_and_persist(request()).await.unwrap(),
        RetryWorkerDecision::Planned {
            attempt_id: CallAttemptId::parse("attempt-002").unwrap(),
            attempt_number: 2,
            scheduled_for_ms: 1_060_000,
            write: RetryWriteDecision::Replayed,
        }
    );
    let state = state.lock().unwrap();
    assert_eq!(state.persist_calls, 2);
    assert_eq!(state.created, 1);
}

#[tokio::test]
async fn no_retry_exhausted_and_unknown_never_reach_durability() {
    let state = Arc::new(Mutex::new(State::default()));
    let durability = Durability(Arc::clone(&state));
    let worker = CampaignRetryWorker::new(&durability);
    let tenant = AuthenticatedTenant::try_from_verified_tenant_id("tenant-a").unwrap();
    let idempotency_key = IdempotencyKey::parse("dial:attempt-002").unwrap();
    let completed = completed_attempt();

    assert_eq!(
        worker
            .plan_and_persist(CampaignRetryRequest {
                tenant: &tenant,
                candidate: RetryCandidate {
                    previous_attempt: &completed,
                    previous_attempt_number: 1,
                    next_attempt_id: "attempt-002",
                    terminal_observed_at_ms: 1_000_000,
                },
                policy: RetryPolicy::new(3, 60_000, false).unwrap(),
                expected_generation: ExecutionGeneration::new(1).unwrap(),
                idempotency_key: &idempotency_key,
            })
            .await
            .unwrap(),
        RetryWorkerDecision::NotRetryable,
    );

    let no_answer = no_answer_attempt();
    assert_eq!(
        worker
            .plan_and_persist(CampaignRetryRequest {
                tenant: &tenant,
                candidate: RetryCandidate {
                    previous_attempt: &no_answer,
                    previous_attempt_number: 3,
                    next_attempt_id: "attempt-004",
                    terminal_observed_at_ms: 1_000_000,
                },
                policy: RetryPolicy::new(3, 60_000, false).unwrap(),
                expected_generation: ExecutionGeneration::new(1).unwrap(),
                idempotency_key: &IdempotencyKey::parse("dial:attempt-004").unwrap(),
            })
            .await
            .unwrap(),
        RetryWorkerDecision::Exhausted,
    );

    let unknown = outcome_unknown_attempt();
    let error = worker
        .plan_and_persist(CampaignRetryRequest {
            tenant: &tenant,
            candidate: RetryCandidate {
                previous_attempt: &unknown,
                previous_attempt_number: 1,
                next_attempt_id: "attempt-002",
                terminal_observed_at_ms: 1_000_000,
            },
            policy: RetryPolicy::new(3, 60_000, false).unwrap(),
            expected_generation: ExecutionGeneration::new(1).unwrap(),
            idempotency_key: &idempotency_key,
        })
        .await
        .unwrap_err();
    assert_eq!(error.code(), "ai_outbound_reconcile_required");
    assert_eq!(state.lock().unwrap().persist_calls, 0);
}

#[test]
fn retry_worker_has_no_telephony_or_media_authority() {
    let source = include_str!("../src/campaign_retry.rs");
    for forbidden in [
        "TelephonyPort",
        "originate",
        "ActiveCall",
        "ChannelAgentPort",
        "MediaEngine",
    ] {
        assert!(
            !source.contains(forbidden),
            "unexpected authority {forbidden}"
        );
    }
}

#[test]
fn attempt_inspection_exposes_only_bounded_retry_state_and_reason() {
    let exhausted =
        AttemptResource::terminal_pending("campaign-001", "release-001", &no_answer_attempt())
            .with_retry_decision(&RetryWorkerDecision::Exhausted);

    assert_eq!(
        exhausted.retry_state(),
        Some(RetryInspectionState::Exhausted)
    );
    assert_eq!(
        exhausted.retry_reason_code(),
        Some("ai_outbound_retry_attempts_exhausted")
    );
    let json = serde_json::to_string(&exhausted).unwrap();
    assert!(json.contains(r#""retry_state":"exhausted""#));
    assert!(json.contains(r#""retry_reason_code":"ai_outbound_retry_attempts_exhausted""#));
    for forbidden in ["destination", "transcript", "prompt", "credential"] {
        assert!(
            !json.contains(forbidden),
            "leaked retry content {forbidden}"
        );
    }
}

#[derive(Default)]
struct State {
    persist_calls: usize,
    created: usize,
}

struct Durability(Arc<Mutex<State>>);

impl RetryDurabilityPort for Durability {
    async fn persist_retry(
        &self,
        _request: RetryPersistenceRequest<'_>,
    ) -> Result<RetryWriteDecision, RetryWorkerError> {
        let mut state = self.0.lock().unwrap();
        state.persist_calls += 1;
        if state.created == 0 {
            state.created = 1;
            Ok(RetryWriteDecision::Created)
        } else {
            Ok(RetryWriteDecision::Replayed)
        }
    }
}

fn no_answer_attempt() -> CallAttempt {
    dialing_attempt()
        .apply(AttemptCommand::MarkNoAnswer)
        .unwrap()
}

fn outcome_unknown_attempt() -> CallAttempt {
    dialing_attempt()
        .apply(AttemptCommand::MarkOutcomeUnknown)
        .unwrap()
}

fn dialing_attempt() -> CallAttempt {
    CallAttempt::new(CallAttemptId::parse("attempt-001").unwrap())
        .apply(AttemptCommand::Claim)
        .unwrap()
        .apply(AttemptCommand::ApproveCompliance)
        .unwrap()
        .apply(AttemptCommand::ReserveAgentCapacity)
        .unwrap()
        .apply(AttemptCommand::Dial)
        .unwrap()
}

fn completed_attempt() -> CallAttempt {
    dialing_attempt()
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
        .apply(AttemptCommand::Finalize)
        .unwrap()
        .apply(AttemptCommand::Complete)
        .unwrap()
}
