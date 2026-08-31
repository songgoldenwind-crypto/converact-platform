use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

use converact_post_call_finalization_core::FinalizationResolution;
use converact_post_call_finalization_store::{
    ClaimedFinalizationJob, ClaimedFinalizationJobInput, FinalizationLease,
    FinalizationLeaseCommand, FinalizationReconcileCommand,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, ConversationFinalizationJobId, ExecutionGeneration,
    InteractionId,
};
use converact_voice_agent_worker::{
    ConversationFinalizationWorker, FinalizationProjectionPort, FinalizationProjectionProgress,
    FinalizationQueuePort, FinalizationWorkerError,
};

#[tokio::test]
async fn bounded_batch_settles_projected_incomplete_and_reconcile_outcomes() {
    let state = Arc::new(Mutex::new(State {
        claims: VecDeque::from([claim(1), claim(2), claim(3)]),
        projections: VecDeque::from([
            Ok(FinalizationProjectionProgress::Projected),
            Ok(FinalizationProjectionProgress::Incomplete),
            Ok(FinalizationProjectionProgress::ReconcileRequired(
                "conversation_projection_outcome_unknown",
            )),
        ]),
        ..State::default()
    }));
    let queue = Queue(Arc::clone(&state));
    let projector = Projector(Arc::clone(&state));
    let worker = ConversationFinalizationWorker::new(&queue, &projector);

    let progress = worker
        .run_batch(
            "tenant-a",
            &FinalizationLease::try_new("worker-001", "a".repeat(64)).unwrap(),
            3,
        )
        .await
        .unwrap();

    assert_eq!(progress.claimed, 3);
    assert_eq!(progress.projected, 1);
    assert_eq!(progress.incomplete, 1);
    assert_eq!(progress.reconcile_required, 1);
    let state = state.lock().unwrap();
    assert_eq!(
        state.completed,
        vec![
            FinalizationResolution::Projected,
            FinalizationResolution::Incomplete
        ]
    );
    assert_eq!(
        state.reconcile_codes,
        vec!["conversation_projection_outcome_unknown"]
    );
}

#[tokio::test]
async fn projection_failure_is_fenced_for_reconciliation_instead_of_repeated() {
    let state = Arc::new(Mutex::new(State {
        claims: VecDeque::from([claim(1)]),
        projections: VecDeque::from([Err(FinalizationWorkerError::new(
            "conversation_projection_provider_unavailable",
        ))]),
        ..State::default()
    }));
    let queue = Queue(Arc::clone(&state));
    let projector = Projector(Arc::clone(&state));
    let worker = ConversationFinalizationWorker::new(&queue, &projector);

    let progress = worker
        .run_batch(
            "tenant-a",
            &FinalizationLease::try_new("worker-001", "a".repeat(64)).unwrap(),
            1,
        )
        .await
        .unwrap();

    assert_eq!(progress.reconcile_required, 1);
    let state = state.lock().unwrap();
    assert!(state.completed.is_empty());
    assert_eq!(
        state.reconcile_codes,
        vec!["conversation_projection_provider_unavailable"]
    );
}

#[test]
fn finalization_worker_has_no_telephony_or_media_authority() {
    let source = include_str!("../src/post_call_finalization.rs");
    for forbidden in ["TelephonyPort", "originate", "terminate", "MediaEngine"] {
        assert!(
            !source.contains(forbidden),
            "unexpected authority {forbidden}"
        );
    }
}

#[derive(Default)]
struct State {
    claims: VecDeque<ClaimedFinalizationJob>,
    projections: VecDeque<Result<FinalizationProjectionProgress, FinalizationWorkerError>>,
    completed: Vec<FinalizationResolution>,
    reconcile_codes: Vec<String>,
}

struct Queue(Arc<Mutex<State>>);

impl FinalizationQueuePort for Queue {
    async fn claim_due(
        &self,
        _tenant_id: &str,
        _lease: &FinalizationLease,
        requested_limit: u16,
    ) -> Result<Vec<ClaimedFinalizationJob>, FinalizationWorkerError> {
        let mut state = self.0.lock().unwrap();
        Ok((0..requested_limit)
            .filter_map(|_| state.claims.pop_front())
            .collect())
    }

    async fn complete(
        &self,
        _command: &FinalizationLeaseCommand,
        resolution: FinalizationResolution,
    ) -> Result<(), FinalizationWorkerError> {
        self.0.lock().unwrap().completed.push(resolution);
        Ok(())
    }

    async fn require_reconcile(
        &self,
        command: &FinalizationReconcileCommand,
    ) -> Result<(), FinalizationWorkerError> {
        self.0
            .lock()
            .unwrap()
            .reconcile_codes
            .push(command.error_code().to_owned());
        Ok(())
    }
}

struct Projector(Arc<Mutex<State>>);

impl FinalizationProjectionPort for Projector {
    async fn finalize(
        &self,
        _tenant_id: &str,
        _job: &ClaimedFinalizationJob,
    ) -> Result<FinalizationProjectionProgress, FinalizationWorkerError> {
        self.0.lock().unwrap().projections.pop_front().unwrap()
    }
}

fn claim(index: u8) -> ClaimedFinalizationJob {
    ClaimedFinalizationJob::try_from_claim(ClaimedFinalizationJobInput {
        id: ConversationFinalizationJobId::parse(format!("job-{index:03}")).unwrap(),
        interaction_id: InteractionId::parse(format!("interaction-{index:03}")).unwrap(),
        call_attempt_id: CallAttemptId::parse(format!("attempt-{index:03}")).unwrap(),
        agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
        execution_generation: ExecutionGeneration::new(1).unwrap(),
        retention_policy_ref: "retention:voice-default-v1".to_owned(),
        payload_hash: "a".repeat(64),
        revision: 2,
    })
    .unwrap()
}
