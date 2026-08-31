use std::collections::BTreeMap;

use converact_conversation_result_core::{
    ConversationResult, ConversationResultInput, Evaluation, EvaluationDimensionInput,
    EvaluationInput, EvaluationRubric, EvaluationRubricInput, OutcomeSchema, OutcomeSchemaInput,
    QualityGrade, ResultError, ResultRevision, TranscriptGenerationStatus, TranscriptSegment,
    TranscriptSegmentInput, TranscriptSnapshot, TranscriptSnapshotInput,
    TranscriptSnapshotRevision, TranscriptSpeaker,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    ConversationResultId, EnvelopeContext, EnvelopeContextInput, EvaluationId,
    EvaluationRubricRevisionId, EventId, ExecutionGeneration, InteractionId,
    OutcomeSchemaRevisionId, TranscriptSegmentId, TranscriptSnapshotId, VOICE_AGENT_SCHEMA_VERSION,
};

#[test]
fn final_segment_is_bounded_hashed_redacted_and_generation_classified() {
    let segment =
        TranscriptSegment::try_new(segment_input(2, "customer account is active")).unwrap();

    assert_eq!(segment.sequence(), 2);
    assert_eq!(segment.speaker(), TranscriptSpeaker::Customer);
    assert_eq!(segment.payload_hash().len(), 64);
    assert_eq!(
        segment
            .generation_status(ExecutionGeneration::new(2).unwrap())
            .unwrap(),
        TranscriptGenerationStatus::Current
    );
    assert_eq!(
        segment
            .generation_status(ExecutionGeneration::new(3).unwrap())
            .unwrap(),
        TranscriptGenerationStatus::Historical
    );
    assert_eq!(
        segment.generation_status(ExecutionGeneration::new(1).unwrap()),
        Err(ResultError::FutureGeneration)
    );
    assert!(!format!("{segment:?}").contains("customer account is active"));

    let mut invalid = segment_input(2, "final");
    invalid.sequence = 0;
    invalid.end_offset_ms = 99;
    invalid.start_offset_ms = 100;
    assert_eq!(
        TranscriptSegment::try_new(invalid),
        Err(ResultError::InvalidTranscriptSegment)
    );
}

#[test]
fn result_is_bound_to_release_schema_revision_and_canonical_values() {
    let schema = outcome_schema();
    let result = ConversationResult::try_new(result_input(), &schema).unwrap();

    assert_eq!(result.revision().get(), 1);
    assert_eq!(result.outcome_code(), "resolved");
    assert_eq!(result.confidence_bps(), 8_750);
    assert_eq!(result.payload_hash().len(), 64);
    assert!(!format!("{result:?}").contains("summary:interaction-001"));

    let mut invalid = result_input();
    invalid.outcome_code = "invented".to_owned();
    assert_eq!(
        ConversationResult::try_new(invalid, &schema),
        Err(ResultError::OutcomeSchemaMismatch)
    );
    let mut invalid = result_input();
    invalid.confidence_bps = 10_001;
    assert_eq!(
        ConversationResult::try_new(invalid, &schema),
        Err(ResultError::InvalidConversationResult)
    );
}

#[test]
fn terminal_transcript_snapshot_is_bounded_ordered_and_content_addressed() {
    let segment = TranscriptSegment::try_new(segment_input(2, "final segment")).unwrap();
    let snapshot = TranscriptSnapshot::try_new(TranscriptSnapshotInput {
        id: TranscriptSnapshotId::parse("snapshot-001").unwrap(),
        context: context(2),
        revision: TranscriptSnapshotRevision::new(1).unwrap(),
        current_generation: ExecutionGeneration::new(2).unwrap(),
        segments: vec![segment],
        call_terminal_observed: true,
        agent_terminal_observed: true,
        transcript_terminal_observed: true,
        frozen_at_ms: 1_500,
    })
    .unwrap();

    assert_eq!(snapshot.revision().get(), 1);
    assert_eq!(snapshot.segment_count(), 1);
    assert_eq!(snapshot.transcript_snapshot_digest().len(), 64);
    assert_eq!(snapshot.payload_hash().len(), 64);
    assert_eq!(snapshot.segment_ids()[0].as_str(), "segment-001");

    let invalid = TranscriptSnapshot::try_new(TranscriptSnapshotInput {
        id: TranscriptSnapshotId::parse("snapshot-incomplete").unwrap(),
        context: context(2),
        revision: TranscriptSnapshotRevision::new(1).unwrap(),
        current_generation: ExecutionGeneration::new(2).unwrap(),
        segments: Vec::new(),
        call_terminal_observed: false,
        agent_terminal_observed: true,
        transcript_terminal_observed: true,
        frozen_at_ms: 1_500,
    });
    assert_eq!(invalid, Err(ResultError::InvalidTranscriptSnapshot));
}

#[test]
fn evaluation_recomputes_weighted_score_and_derives_bad_case() {
    let result = ConversationResult::try_new(result_input(), &outcome_schema()).unwrap();
    let rubric = rubric();
    let evaluation = Evaluation::try_new(
        evaluation_input([("compliance", 9_000), ("resolution", 5_000)], Vec::new()),
        &result,
        &rubric,
    )
    .unwrap();

    assert_eq!(evaluation.overall_score_bps(), 7_400);
    assert_eq!(evaluation.grade(), QualityGrade::Warn);
    assert_eq!(evaluation.id().as_str(), "evaluation-001");
    assert_eq!(evaluation.rubric_revision_id().as_str(), "rubric-001");
    assert_eq!(evaluation.dimension_scores_bps()["compliance"], 9_000);
    assert_eq!(evaluation.evidence_segment_ids()[0].as_str(), "segment-001");
    assert_eq!(evaluation.created_at_ms(), 3_000);
    assert!(!evaluation.is_bad_case());

    let bad_case = Evaluation::try_new(
        evaluation_input(
            [("compliance", 9_000), ("resolution", 5_000)],
            vec!["privacy_breach".to_owned()],
        ),
        &result,
        &rubric,
    )
    .unwrap();
    assert!(bad_case.is_bad_case());

    let missing_dimension = Evaluation::try_new(
        evaluation_input([("compliance", 9_000)], Vec::new()),
        &result,
        &rubric,
    );
    assert_eq!(missing_dimension, Err(ResultError::RubricMismatch));

    let rubric_without_mandatory_violations = EvaluationRubric::try_new(EvaluationRubricInput {
        id: EvaluationRubricRevisionId::parse("rubric-optional-violations").unwrap(),
        agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
        dimensions: vec![EvaluationDimensionInput {
            id: "resolution".to_owned(),
            weight_bps: 10_000,
        }],
        pass_threshold_bps: 8_500,
        bad_case_threshold_bps: 6_000,
        mandatory_violation_codes: Vec::new(),
    });
    assert!(rubric_without_mandatory_violations.is_ok());
}

fn segment_input(generation: u64, text: &str) -> TranscriptSegmentInput {
    TranscriptSegmentInput {
        id: TranscriptSegmentId::parse("segment-001").unwrap(),
        context: context(generation),
        source_event_id: EventId::parse("event-transcript-001").unwrap(),
        sequence: 2,
        speaker: TranscriptSpeaker::Customer,
        language: "zh-CN".to_owned(),
        text: text.to_owned(),
        start_offset_ms: 100,
        end_offset_ms: 500,
        observed_at_ms: 1_000,
        retention_policy_ref: "retention:voice-default-v1".to_owned(),
    }
}

fn outcome_schema() -> OutcomeSchema {
    OutcomeSchema::try_new(OutcomeSchemaInput {
        id: OutcomeSchemaRevisionId::parse("outcome-schema-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
        intents: vec!["support".to_owned()],
        dispositions: vec!["completed".to_owned(), "follow_up".to_owned()],
        outcome_codes: vec!["resolved".to_owned(), "unresolved".to_owned()],
        attribute_keys: vec!["product".to_owned()],
    })
    .unwrap()
}

fn result_input() -> ConversationResultInput {
    ConversationResultInput {
        id: ConversationResultId::parse("result-001").unwrap(),
        context: context(2),
        revision: ResultRevision::new(1).unwrap(),
        outcome_schema_revision_id: OutcomeSchemaRevisionId::parse("outcome-schema-001").unwrap(),
        transcript_snapshot_digest: "a".repeat(64),
        summary_artifact_ref: "summary:interaction-001".to_owned(),
        intent: "support".to_owned(),
        disposition: "completed".to_owned(),
        outcome_code: "resolved".to_owned(),
        confidence_bps: 8_750,
        attributes: BTreeMap::from([("product".to_owned(), "voice".to_owned())]),
        created_at_ms: 2_000,
    }
}

fn rubric() -> EvaluationRubric {
    EvaluationRubric::try_new(EvaluationRubricInput {
        id: EvaluationRubricRevisionId::parse("rubric-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
        dimensions: vec![
            EvaluationDimensionInput {
                id: "compliance".to_owned(),
                weight_bps: 6_000,
            },
            EvaluationDimensionInput {
                id: "resolution".to_owned(),
                weight_bps: 4_000,
            },
        ],
        pass_threshold_bps: 8_500,
        bad_case_threshold_bps: 6_000,
        mandatory_violation_codes: vec!["privacy_breach".to_owned()],
    })
    .unwrap()
}

fn evaluation_input<const N: usize>(
    scores: [(&str, u16); N],
    violations: Vec<String>,
) -> EvaluationInput {
    EvaluationInput {
        id: EvaluationId::parse("evaluation-001").unwrap(),
        evaluator_release_id: AgentReleaseId::parse("evaluator-release-001").unwrap(),
        result_id: ConversationResultId::parse("result-001").unwrap(),
        result_revision: ResultRevision::new(1).unwrap(),
        rubric_revision_id: EvaluationRubricRevisionId::parse("rubric-001").unwrap(),
        dimension_scores_bps: scores
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
        evidence_segment_ids: vec![TranscriptSegmentId::parse("segment-001").unwrap()],
        violation_codes: violations,
        created_at_ms: 3_000,
    }
}

fn context(generation: u64) -> EnvelopeContext {
    EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version: VOICE_AGENT_SCHEMA_VERSION,
        tenant_id: "tenant-a".to_owned(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        campaign_id: CampaignId::parse("campaign-001").unwrap(),
        campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
        call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        call_id: Some(CallId::parse("call-001").unwrap()),
        agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
        channel_agent_session_id: Some(ChannelAgentSessionId::parse("agent-session-001").unwrap()),
        execution_generation: ExecutionGeneration::new(generation).unwrap(),
        trace_id: "trace-001".to_owned(),
    })
    .unwrap()
}
