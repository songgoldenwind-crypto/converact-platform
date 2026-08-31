use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use converact_conversation_result_core::{
    ConversationResult, ConversationResultInput, Evaluation, EvaluationDimensionInput,
    EvaluationInput, EvaluationRubric, EvaluationRubricInput, OutcomeSchema, OutcomeSchemaInput,
    ResultRevision, TranscriptSegment, TranscriptSegmentInput, TranscriptSnapshot,
    TranscriptSnapshotInput, TranscriptSnapshotRevision, TranscriptSpeaker,
};
use converact_conversation_result_store::{
    ProjectionCommand, ProjectionCommandInput, ProjectionCommandKind,
};
use converact_post_call_finalization_store::{ClaimedFinalizationJob, ClaimedFinalizationJobInput};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId, ConversationResultId,
    EnvelopeContext, EnvelopeContextInput, EvaluationId, EvaluationRubricRevisionId, EventId,
    ExecutionGeneration, InteractionId, OutcomeSchemaRevisionId, ResultProjectionCommandId,
    TranscriptSegmentId, TranscriptSnapshotId, VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    ConversationEvaluationDurabilityPort, ConversationEvaluationProviderPort,
    ConversationEvidenceDurabilityPort, ConversationFinalizationEvidence,
    ConversationFinalizationProjector, ConversationProjectionDurabilityPort,
    ConversationProjectionPortError, ConversationProjectionProviderPort,
    ConversationProjectionRuntime, DurableProjectionPrepareDecision,
    DurableProjectionWriteDecision, DurableTranscriptAppendDecision, EvaluationProjectionProgress,
    FinalizationEvidenceObservation, FinalizationEvidenceSourcePort, FinalizationProjectionPort,
    FinalizationProjectionProgress, FinalizationWorkerError, ProjectionObservation,
    ResultGenerationEvidence, ResultProjectionProgress, TerminalEvidenceProgress,
};

#[tokio::test]
async fn unknown_result_is_queried_and_never_generated_twice() {
    let result = result();
    let state = Arc::new(Mutex::new(State::default()));
    let durability = Durability(Arc::clone(&state));
    let provider = Provider {
        state: Arc::clone(&state),
        result: result.clone(),
    };
    let runtime = ConversationProjectionRuntime::new(&durability, &provider);
    let command = command(&result);

    assert_eq!(
        runtime.project_result("tenant-a", &command).await.unwrap(),
        ResultProjectionProgress::Pending
    );
    assert_eq!(
        runtime.project_result("tenant-a", &command).await.unwrap(),
        ResultProjectionProgress::Applied(Box::new(result))
    );

    let state = state.lock().unwrap();
    assert_eq!(state.generate_calls, 1);
    assert_eq!(state.query_calls, 1);
    assert_eq!(state.finalize_applied_calls, 1);
}

#[tokio::test]
async fn replayed_applied_result_is_queried_without_regeneration() {
    let result = result();
    let state = Arc::new(Mutex::new(State::default()));
    let durability = ReplayAppliedDurability(Arc::clone(&state));
    let provider = Provider {
        state: Arc::clone(&state),
        result: result.clone(),
    };
    let runtime = ConversationProjectionRuntime::new(&durability, &provider);

    assert_eq!(
        runtime
            .project_result("tenant-a", &command(&result))
            .await
            .unwrap(),
        ResultProjectionProgress::Applied(Box::new(result))
    );

    let state = state.lock().unwrap();
    assert_eq!(state.generate_calls, 0);
    assert_eq!(state.query_calls, 1);
    assert_eq!(state.finalize_applied_calls, 1);
}

#[tokio::test]
async fn final_segments_accept_out_of_order_and_historical_generation_before_snapshot() {
    let result = result();
    let state = Arc::new(Mutex::new(State::default()));
    let durability = Durability(Arc::clone(&state));
    let provider = Provider {
        state: Arc::clone(&state),
        result,
    };
    let runtime = ConversationProjectionRuntime::new(&durability, &provider);
    let segments = vec![segment(2, 2, "segment-002"), segment(1, 1, "segment-001")];
    let snapshot = TranscriptSnapshot::try_new(TranscriptSnapshotInput {
        id: TranscriptSnapshotId::parse("snapshot-001").unwrap(),
        context: context(2),
        revision: TranscriptSnapshotRevision::new(1).unwrap(),
        current_generation: ExecutionGeneration::new(2).unwrap(),
        segments: segments.clone(),
        call_terminal_observed: true,
        agent_terminal_observed: true,
        transcript_terminal_observed: true,
        frozen_at_ms: 4_000,
    })
    .unwrap();

    assert_eq!(
        runtime
            .persist_terminal_evidence(&segments, &snapshot)
            .await
            .unwrap(),
        TerminalEvidenceProgress {
            final_segments: 2,
            historical_segments: 1,
            snapshot: DurableProjectionWriteDecision::Created,
        }
    );
    assert_eq!(state.lock().unwrap().snapshot_calls, 1);
}

#[test]
fn result_generation_evidence_binds_schema_candidate_and_snapshot() {
    let schema = outcome_schema();
    let snapshot = terminal_snapshot();
    let accepted = schema.validate_intent_candidate("support").unwrap();

    let evidence =
        ResultGenerationEvidence::try_new(&snapshot, schema.id().clone(), Some(accepted), 1)
            .unwrap();

    assert_eq!(evidence.outcome_schema_revision_id(), schema.id());
    assert_eq!(evidence.intent_evidence().unwrap().intent(), "support");
    assert_eq!(evidence.payload_hash().len(), 64);
    assert!(!format!("{evidence:?}").contains("support"));
}

#[tokio::test]
async fn accepted_intent_is_forwarded_and_provider_drift_is_rejected() {
    let schema = outcome_schema();
    let snapshot = terminal_snapshot();
    let evidence = ResultGenerationEvidence::try_new(
        &snapshot,
        schema.id().clone(),
        Some(schema.validate_intent_candidate("support").unwrap()),
        1,
    )
    .unwrap();
    let provider_result = result_with_intent("sales");
    let state = Arc::new(Mutex::new(State::default()));
    let durability = Durability(Arc::clone(&state));
    let provider = CapturingProvider {
        state: Arc::clone(&state),
        result: provider_result.clone(),
    };
    let runtime = ConversationProjectionRuntime::new(&durability, &provider);

    let error = runtime
        .project_result_with_evidence(
            "tenant-a",
            &command_with_payload_hash(&provider_result, evidence.payload_hash()),
            &evidence,
        )
        .await
        .unwrap_err();

    assert_eq!(
        error.code(),
        "conversation_projection_intent_evidence_mismatch"
    );
    let state = state.lock().unwrap();
    assert_eq!(state.seen_intent.as_deref(), Some("support"));
    assert_eq!(state.finalize_applied_calls, 0);
}

#[tokio::test]
async fn query_replay_cannot_bypass_accepted_intent_evidence() {
    let schema = outcome_schema();
    let snapshot = terminal_snapshot();
    let evidence = ResultGenerationEvidence::try_new(
        &snapshot,
        schema.id().clone(),
        Some(schema.validate_intent_candidate("support").unwrap()),
        1,
    )
    .unwrap();
    let provider_result = result_with_intent("sales");
    let state = Arc::new(Mutex::new(State::default()));
    let durability = ReplayAppliedDurability(Arc::clone(&state));
    let provider = CapturingProvider {
        state: Arc::clone(&state),
        result: provider_result.clone(),
    };
    let runtime = ConversationProjectionRuntime::new(&durability, &provider);

    let error = runtime
        .project_result_with_evidence(
            "tenant-a",
            &command_with_payload_hash(&provider_result, evidence.payload_hash()),
            &evidence,
        )
        .await
        .unwrap_err();

    assert_eq!(
        error.code(),
        "conversation_projection_intent_evidence_mismatch"
    );
    let state = state.lock().unwrap();
    assert_eq!(state.query_calls, 1);
    assert_eq!(state.finalize_applied_calls, 0);
}

#[tokio::test]
async fn bad_case_identity_is_platform_derived_before_atomic_evaluation_finalize() {
    let result = result();
    let evaluation = evaluation(&result);
    let state = Arc::new(Mutex::new(State::default()));
    let durability = Durability(Arc::clone(&state));
    let provider = EvaluationProvider(evaluation.clone());
    let runtime = ConversationProjectionRuntime::new(&durability, &provider);
    let command = evaluation_command(&result);

    assert_eq!(
        runtime
            .project_evaluation("tenant-a", &command, &result)
            .await
            .unwrap(),
        EvaluationProjectionProgress::Applied(Box::new(evaluation))
    );

    let state = state.lock().unwrap();
    assert!(
        state
            .bad_case_id
            .as_deref()
            .unwrap()
            .starts_with("bad-case-")
    );
    assert_eq!(state.finalize_evaluation_calls, 1);
}

#[tokio::test]
async fn finalization_projector_reuses_terminal_result_and_evaluation_pipeline() {
    let schema = outcome_schema();
    let result = result();
    let evaluation = evaluation(&result);
    let segments = vec![segment(1, 1, "segment-001")];
    let snapshot = TranscriptSnapshot::try_new(TranscriptSnapshotInput {
        id: TranscriptSnapshotId::parse("snapshot-001").unwrap(),
        context: context(1),
        revision: TranscriptSnapshotRevision::new(1).unwrap(),
        current_generation: ExecutionGeneration::new(1).unwrap(),
        segments: segments.clone(),
        call_terminal_observed: true,
        agent_terminal_observed: true,
        transcript_terminal_observed: true,
        frozen_at_ms: 4_000,
    })
    .unwrap();
    let generation_evidence = ResultGenerationEvidence::try_new(
        &snapshot,
        schema.id().clone(),
        Some(schema.validate_intent_candidate("support").unwrap()),
        result.revision().get(),
    )
    .unwrap();
    let evidence = ConversationFinalizationEvidence::try_new(
        segments,
        snapshot,
        command_with_payload_hash(&result, generation_evidence.payload_hash()),
        evaluation_command(&result),
        generation_evidence,
    )
    .unwrap();
    let source = EvidenceSource(FinalizationEvidenceObservation::Ready(Box::new(evidence)));
    let state = Arc::new(Mutex::new(State::default()));
    let durability = Durability(Arc::clone(&state));
    let provider = FullProvider { result, evaluation };
    let projector = ConversationFinalizationProjector::new(&source, &durability, &provider);

    assert_eq!(
        projector
            .finalize("tenant-a", &finalization_claim("interaction-001"))
            .await
            .unwrap(),
        FinalizationProjectionProgress::Projected
    );
    let state = state.lock().unwrap();
    assert_eq!(state.snapshot_calls, 1);
    assert_eq!(state.finalize_applied_calls, 1);
    assert_eq!(state.finalize_evaluation_calls, 1);
}

#[test]
fn finalization_rejects_a_result_command_not_bound_to_generation_evidence() {
    let schema = outcome_schema();
    let result = result();
    let snapshot = terminal_snapshot();
    let generation_evidence = ResultGenerationEvidence::try_new(
        &snapshot,
        schema.id().clone(),
        Some(schema.validate_intent_candidate("support").unwrap()),
        result.revision().get(),
    )
    .unwrap();

    let rejected = ConversationFinalizationEvidence::try_new(
        vec![segment(1, 1, "segment-001")],
        snapshot,
        command(&result),
        evaluation_command(&result),
        generation_evidence,
    );

    let Err(error) = rejected else {
        panic!("unbound result command must be rejected")
    };
    assert_eq!(
        error.code(),
        "conversation_finalization_result_evidence_hash_mismatch"
    );
}

#[test]
fn finalization_rejects_generation_evidence_from_another_snapshot() {
    let schema = outcome_schema();
    let result = result();
    let generation_snapshot = TranscriptSnapshot::try_new(TranscriptSnapshotInput {
        id: TranscriptSnapshotId::parse("snapshot-002").unwrap(),
        context: context(1),
        revision: TranscriptSnapshotRevision::new(1).unwrap(),
        current_generation: ExecutionGeneration::new(1).unwrap(),
        segments: vec![segment(1, 2, "segment-002")],
        call_terminal_observed: true,
        agent_terminal_observed: true,
        transcript_terminal_observed: true,
        frozen_at_ms: 4_001,
    })
    .unwrap();
    let generation_evidence = ResultGenerationEvidence::try_new(
        &generation_snapshot,
        schema.id().clone(),
        Some(schema.validate_intent_candidate("support").unwrap()),
        result.revision().get(),
    )
    .unwrap();

    let rejected = ConversationFinalizationEvidence::try_new(
        vec![segment(1, 1, "segment-001")],
        terminal_snapshot(),
        command_with_payload_hash(&result, generation_evidence.payload_hash()),
        evaluation_command(&result),
        generation_evidence,
    );

    let Err(error) = rejected else {
        panic!("generation evidence from another snapshot must be rejected")
    };
    assert_eq!(
        error.code(),
        "conversation_finalization_result_evidence_snapshot_mismatch"
    );
}

#[test]
fn finalization_rejects_generation_evidence_for_another_result_revision() {
    let schema = outcome_schema();
    let result = result();
    let snapshot = terminal_snapshot();
    let generation_evidence = ResultGenerationEvidence::try_new(
        &snapshot,
        schema.id().clone(),
        Some(schema.validate_intent_candidate("support").unwrap()),
        result.revision().get() + 1,
    )
    .unwrap();

    let rejected = ConversationFinalizationEvidence::try_new(
        vec![segment(1, 1, "segment-001")],
        snapshot,
        command_with_payload_hash(&result, generation_evidence.payload_hash()),
        evaluation_command(&result),
        generation_evidence,
    );

    let Err(error) = rejected else {
        panic!("generation evidence for another result revision must be rejected")
    };
    assert_eq!(
        error.code(),
        "conversation_finalization_result_evidence_revision_mismatch"
    );
}

#[tokio::test]
async fn missing_or_unknown_terminal_evidence_never_invents_a_result() {
    let state = Arc::new(Mutex::new(State::default()));
    let durability = Durability(Arc::clone(&state));
    let provider = FullProvider {
        result: result(),
        evaluation: evaluation(&result()),
    };
    let incomplete_source = EvidenceSource(FinalizationEvidenceObservation::Incomplete);
    let incomplete =
        ConversationFinalizationProjector::new(&incomplete_source, &durability, &provider);
    assert_eq!(
        incomplete
            .finalize("tenant-a", &finalization_claim("interaction-001"))
            .await
            .unwrap(),
        FinalizationProjectionProgress::Incomplete
    );

    let unknown_source = EvidenceSource(FinalizationEvidenceObservation::OutcomeUnknown);
    let unknown = ConversationFinalizationProjector::new(&unknown_source, &durability, &provider);
    assert_eq!(
        unknown
            .finalize("tenant-a", &finalization_claim("interaction-001"))
            .await
            .unwrap(),
        FinalizationProjectionProgress::ReconcileRequired(
            "conversation_terminal_evidence_outcome_unknown"
        )
    );
    assert_eq!(state.lock().unwrap().generate_calls, 0);
}

#[derive(Default)]
struct State {
    prepared: bool,
    generate_calls: usize,
    query_calls: usize,
    finalize_applied_calls: usize,
    finalize_evaluation_calls: usize,
    bad_case_id: Option<String>,
    snapshot_calls: usize,
    seen_intent: Option<String>,
}

impl ConversationEvaluationDurabilityPort for Durability {
    async fn finalize_evaluation_applied(
        &self,
        _command: &ProjectionCommand,
        _result: &ConversationResult,
        _evaluation: &Evaluation,
        bad_case_id: Option<converact_voice_agent_contracts::BadCaseId>,
    ) -> Result<(), ConversationProjectionPortError> {
        let mut state = self.0.lock().unwrap();
        state.finalize_evaluation_calls += 1;
        state.bad_case_id = bad_case_id.map(|id| id.as_str().to_owned());
        Ok(())
    }
}

struct Durability(Arc<Mutex<State>>);

struct ReplayAppliedDurability(Arc<Mutex<State>>);

impl ConversationProjectionDurabilityPort for ReplayAppliedDurability {
    async fn prepare(
        &self,
        _tenant_id: &str,
        _command: &ProjectionCommand,
    ) -> Result<DurableProjectionPrepareDecision, ConversationProjectionPortError> {
        Ok(DurableProjectionPrepareDecision::ReplayApplied)
    }

    async fn finalize_result_applied(
        &self,
        _command: &ProjectionCommand,
        _result: &ConversationResult,
    ) -> Result<(), ConversationProjectionPortError> {
        self.0.lock().unwrap().finalize_applied_calls += 1;
        Ok(())
    }

    async fn finalize_not_applied(
        &self,
        _tenant_id: &str,
        _command: &ProjectionCommand,
        _failure_code: &'static str,
    ) -> Result<(), ConversationProjectionPortError> {
        panic!("an applied replay cannot finalize as not applied")
    }
}

impl ConversationEvidenceDurabilityPort for Durability {
    async fn append_final_segment(
        &self,
        segment: &TranscriptSegment,
        current_generation: ExecutionGeneration,
    ) -> Result<DurableTranscriptAppendDecision, ConversationProjectionPortError> {
        let status = segment.generation_status(current_generation).unwrap();
        Ok(DurableTranscriptAppendDecision::Appended(status))
    }

    async fn freeze_snapshot(
        &self,
        _snapshot: &TranscriptSnapshot,
    ) -> Result<DurableProjectionWriteDecision, ConversationProjectionPortError> {
        self.0.lock().unwrap().snapshot_calls += 1;
        Ok(DurableProjectionWriteDecision::Created)
    }
}

impl ConversationProjectionDurabilityPort for Durability {
    async fn prepare(
        &self,
        _tenant_id: &str,
        _command: &ProjectionCommand,
    ) -> Result<DurableProjectionPrepareDecision, ConversationProjectionPortError> {
        let mut state = self.0.lock().unwrap();
        if state.prepared {
            Ok(DurableProjectionPrepareDecision::Query)
        } else {
            state.prepared = true;
            Ok(DurableProjectionPrepareDecision::Execute)
        }
    }

    async fn finalize_result_applied(
        &self,
        _command: &ProjectionCommand,
        _result: &ConversationResult,
    ) -> Result<(), ConversationProjectionPortError> {
        self.0.lock().unwrap().finalize_applied_calls += 1;
        Ok(())
    }

    async fn finalize_not_applied(
        &self,
        _tenant_id: &str,
        _command: &ProjectionCommand,
        _failure_code: &'static str,
    ) -> Result<(), ConversationProjectionPortError> {
        Ok(())
    }
}

struct EvaluationProvider(Evaluation);

impl ConversationEvaluationProviderPort for EvaluationProvider {
    async fn generate_evaluation(
        &self,
        _command: &ProjectionCommand,
        _result: &ConversationResult,
    ) -> Result<ProjectionObservation<Evaluation>, ConversationProjectionPortError> {
        Ok(ProjectionObservation::Applied(self.0.clone()))
    }

    async fn query_evaluation(
        &self,
        _command: &ProjectionCommand,
        _result: &ConversationResult,
    ) -> Result<ProjectionObservation<Evaluation>, ConversationProjectionPortError> {
        Ok(ProjectionObservation::Applied(self.0.clone()))
    }
}

#[derive(Clone)]
struct EvidenceSource(FinalizationEvidenceObservation);

impl FinalizationEvidenceSourcePort for EvidenceSource {
    async fn load(
        &self,
        _tenant_id: &str,
        _job: &ClaimedFinalizationJob,
    ) -> Result<FinalizationEvidenceObservation, FinalizationWorkerError> {
        Ok(self.0.clone())
    }
}

struct FullProvider {
    result: ConversationResult,
    evaluation: Evaluation,
}

impl ConversationProjectionProviderPort for FullProvider {
    async fn generate_result(
        &self,
        _command: &ProjectionCommand,
        _evidence: Option<&ResultGenerationEvidence>,
    ) -> Result<ProjectionObservation<ConversationResult>, ConversationProjectionPortError> {
        Ok(ProjectionObservation::Applied(self.result.clone()))
    }

    async fn query_result(
        &self,
        _command: &ProjectionCommand,
    ) -> Result<ProjectionObservation<ConversationResult>, ConversationProjectionPortError> {
        Ok(ProjectionObservation::Applied(self.result.clone()))
    }
}

impl ConversationEvaluationProviderPort for FullProvider {
    async fn generate_evaluation(
        &self,
        _command: &ProjectionCommand,
        _result: &ConversationResult,
    ) -> Result<ProjectionObservation<Evaluation>, ConversationProjectionPortError> {
        Ok(ProjectionObservation::Applied(self.evaluation.clone()))
    }

    async fn query_evaluation(
        &self,
        _command: &ProjectionCommand,
        _result: &ConversationResult,
    ) -> Result<ProjectionObservation<Evaluation>, ConversationProjectionPortError> {
        Ok(ProjectionObservation::Applied(self.evaluation.clone()))
    }
}

struct Provider {
    state: Arc<Mutex<State>>,
    result: ConversationResult,
}

struct CapturingProvider {
    state: Arc<Mutex<State>>,
    result: ConversationResult,
}

impl ConversationProjectionProviderPort for CapturingProvider {
    async fn generate_result(
        &self,
        _command: &ProjectionCommand,
        evidence: Option<&ResultGenerationEvidence>,
    ) -> Result<ProjectionObservation<ConversationResult>, ConversationProjectionPortError> {
        let mut state = self.state.lock().unwrap();
        state.generate_calls += 1;
        state.seen_intent = evidence
            .and_then(ResultGenerationEvidence::intent_evidence)
            .map(|intent| intent.intent().to_owned());
        Ok(ProjectionObservation::Applied(self.result.clone()))
    }

    async fn query_result(
        &self,
        _command: &ProjectionCommand,
    ) -> Result<ProjectionObservation<ConversationResult>, ConversationProjectionPortError> {
        self.state.lock().unwrap().query_calls += 1;
        Ok(ProjectionObservation::Applied(self.result.clone()))
    }
}

impl ConversationProjectionProviderPort for Provider {
    async fn generate_result(
        &self,
        _command: &ProjectionCommand,
        _evidence: Option<&ResultGenerationEvidence>,
    ) -> Result<ProjectionObservation<ConversationResult>, ConversationProjectionPortError> {
        self.state.lock().unwrap().generate_calls += 1;
        Ok(ProjectionObservation::OutcomeUnknown)
    }

    async fn query_result(
        &self,
        _command: &ProjectionCommand,
    ) -> Result<ProjectionObservation<ConversationResult>, ConversationProjectionPortError> {
        self.state.lock().unwrap().query_calls += 1;
        Ok(ProjectionObservation::Applied(self.result.clone()))
    }
}

fn command(result: &ConversationResult) -> ProjectionCommand {
    command_with_payload_hash(result, &"f".repeat(64))
}

fn command_with_payload_hash(result: &ConversationResult, payload_hash: &str) -> ProjectionCommand {
    ProjectionCommand::try_new(ProjectionCommandInput {
        id: ResultProjectionCommandId::parse("projection-result-001").unwrap(),
        interaction_id: result.context().interaction_id().clone(),
        kind: ProjectionCommandKind::PersistResult,
        payload_hash: payload_hash.to_owned(),
        expected_result_revision: Some(result.revision().get()),
        expected_generation: result.context().execution_generation(),
    })
    .unwrap()
}

fn evaluation_command(result: &ConversationResult) -> ProjectionCommand {
    ProjectionCommand::try_new(ProjectionCommandInput {
        id: ResultProjectionCommandId::parse("projection-evaluation-001").unwrap(),
        interaction_id: result.context().interaction_id().clone(),
        kind: ProjectionCommandKind::PersistEvaluation,
        payload_hash: "e".repeat(64),
        expected_result_revision: Some(result.revision().get()),
        expected_generation: result.context().execution_generation(),
    })
    .unwrap()
}

fn evaluation(result: &ConversationResult) -> Evaluation {
    let rubric = EvaluationRubric::try_new(EvaluationRubricInput {
        id: EvaluationRubricRevisionId::parse("rubric-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
        dimensions: vec![EvaluationDimensionInput {
            id: "compliance".to_owned(),
            weight_bps: 10_000,
        }],
        pass_threshold_bps: 8_000,
        bad_case_threshold_bps: 6_000,
        mandatory_violation_codes: vec!["privacy_breach".to_owned()],
    })
    .unwrap();
    Evaluation::try_new(
        EvaluationInput {
            id: EvaluationId::parse("evaluation-001").unwrap(),
            evaluator_release_id: AgentReleaseId::parse("evaluator-release-001").unwrap(),
            result_id: result.id().clone(),
            result_revision: result.revision(),
            rubric_revision_id: EvaluationRubricRevisionId::parse("rubric-001").unwrap(),
            dimension_scores_bps: BTreeMap::from([("compliance".to_owned(), 9_000)]),
            evidence_segment_ids: vec![TranscriptSegmentId::parse("segment-001").unwrap()],
            violation_codes: vec!["privacy_breach".to_owned()],
            created_at_ms: 3_000,
        },
        result,
        &rubric,
    )
    .unwrap()
}

fn result() -> ConversationResult {
    result_with_intent("support")
}

fn result_with_intent(intent: &str) -> ConversationResult {
    let schema = outcome_schema();
    ConversationResult::try_new(
        ConversationResultInput {
            id: ConversationResultId::parse("result-001").unwrap(),
            context: EnvelopeContext::try_new(EnvelopeContextInput {
                schema_version: VOICE_AGENT_SCHEMA_VERSION,
                tenant_id: "tenant-a".to_owned(),
                interaction_id: InteractionId::parse("interaction-001").unwrap(),
                campaign_id: CampaignId::parse("campaign-001").unwrap(),
                campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
                call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
                call_id: None,
                agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
                channel_agent_session_id: None,
                execution_generation: ExecutionGeneration::new(1).unwrap(),
                trace_id: "trace-001".to_owned(),
            })
            .unwrap(),
            revision: ResultRevision::new(1).unwrap(),
            outcome_schema_revision_id: OutcomeSchemaRevisionId::parse("outcome-schema-001")
                .unwrap(),
            transcript_snapshot_digest: "a".repeat(64),
            summary_artifact_ref: "artifact:summary-001".to_owned(),
            intent: intent.to_owned(),
            disposition: "completed".to_owned(),
            outcome_code: "resolved".to_owned(),
            confidence_bps: 9_000,
            attributes: BTreeMap::new(),
            created_at_ms: 2_000,
        },
        &schema,
    )
    .unwrap()
}

fn outcome_schema() -> OutcomeSchema {
    OutcomeSchema::try_new(OutcomeSchemaInput {
        id: OutcomeSchemaRevisionId::parse("outcome-schema-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
        intents: vec!["support".to_owned(), "sales".to_owned()],
        dispositions: vec!["completed".to_owned()],
        outcome_codes: vec!["resolved".to_owned()],
        attribute_keys: Vec::new(),
    })
    .unwrap()
}

fn terminal_snapshot() -> TranscriptSnapshot {
    let segments = vec![segment(1, 1, "segment-001")];
    TranscriptSnapshot::try_new(TranscriptSnapshotInput {
        id: TranscriptSnapshotId::parse("snapshot-001").unwrap(),
        context: context(1),
        revision: TranscriptSnapshotRevision::new(1).unwrap(),
        current_generation: ExecutionGeneration::new(1).unwrap(),
        segments,
        call_terminal_observed: true,
        agent_terminal_observed: true,
        transcript_terminal_observed: true,
        frozen_at_ms: 4_000,
    })
    .unwrap()
}

fn segment(generation: u64, sequence: u64, id: &str) -> TranscriptSegment {
    TranscriptSegment::try_new(TranscriptSegmentInput {
        id: TranscriptSegmentId::parse(id).unwrap(),
        context: context(generation),
        source_event_id: EventId::parse(format!("event-{id}")).unwrap(),
        sequence,
        speaker: TranscriptSpeaker::Customer,
        language: "zh-CN".to_owned(),
        text: format!("final {sequence}"),
        start_offset_ms: sequence * 100,
        end_offset_ms: sequence * 100 + 80,
        observed_at_ms: 3_000 + sequence,
        retention_policy_ref: "retention:voice-default-v1".to_owned(),
    })
    .unwrap()
}

fn context(generation: u64) -> EnvelopeContext {
    EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version: VOICE_AGENT_SCHEMA_VERSION,
        tenant_id: "tenant-a".to_owned(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        campaign_id: CampaignId::parse("campaign-001").unwrap(),
        campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
        call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        call_id: None,
        agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
        channel_agent_session_id: None,
        execution_generation: ExecutionGeneration::new(generation).unwrap(),
        trace_id: "trace-001".to_owned(),
    })
    .unwrap()
}

fn finalization_claim(interaction_id: &str) -> ClaimedFinalizationJob {
    ClaimedFinalizationJob::try_from_claim(ClaimedFinalizationJobInput {
        id: converact_voice_agent_contracts::ConversationFinalizationJobId::parse("job-001")
            .unwrap(),
        interaction_id: InteractionId::parse(interaction_id).unwrap(),
        call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
        execution_generation: ExecutionGeneration::new(1).unwrap(),
        retention_policy_ref: "retention:voice-default-v1".to_owned(),
        payload_hash: "a".repeat(64),
        revision: 2,
    })
    .unwrap()
}
