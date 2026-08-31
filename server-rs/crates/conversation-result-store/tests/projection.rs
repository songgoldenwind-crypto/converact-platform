use std::collections::BTreeMap;

use converact_conversation_result_core::{
    ConversationResult, ConversationResultInput, Evaluation, EvaluationDimensionInput,
    EvaluationInput, EvaluationRubric, EvaluationRubricInput, OutcomeSchema, OutcomeSchemaInput,
    ResultRevision,
};
use converact_conversation_result_store::{
    ConversationResultStoreError, EvaluationProjectionWrite, canonical_bad_case_payload_hash,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, BadCaseId, CallAttemptId, CampaignContactId, CampaignId, ConversationResultId,
    EnvelopeContext, EnvelopeContextInput, EvaluationId, EvaluationRubricRevisionId,
    ExecutionGeneration, InteractionId, OutcomeSchemaRevisionId, TranscriptSegmentId,
    VOICE_AGENT_SCHEMA_VERSION,
};

#[test]
fn evaluation_projection_requires_exact_derived_bad_case_identity() {
    let result = result();
    let ordinary = evaluation(&result, Vec::new());
    let bad_case_id = BadCaseId::parse("bad-case-001").unwrap();
    assert_eq!(
        EvaluationProjectionWrite::try_new(&result, &ordinary, Some(bad_case_id)).unwrap_err(),
        ConversationResultStoreError::InvalidEvaluationProjection
    );

    let bad = evaluation(&result, vec!["privacy_breach".to_owned()]);
    assert_eq!(
        EvaluationProjectionWrite::try_new(&result, &bad, None).unwrap_err(),
        ConversationResultStoreError::InvalidEvaluationProjection
    );
    let write = EvaluationProjectionWrite::try_new(
        &result,
        &bad,
        Some(BadCaseId::parse("bad-case-001").unwrap()),
    )
    .unwrap();

    assert_eq!(write.interaction_id().as_str(), "interaction-001");
    assert_eq!(write.bad_case_id().unwrap().as_str(), "bad-case-001");
    assert_eq!(canonical_bad_case_payload_hash(&write).unwrap().len(), 64);
}

fn result() -> ConversationResult {
    let schema = OutcomeSchema::try_new(OutcomeSchemaInput {
        id: OutcomeSchemaRevisionId::parse("outcome-schema-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
        intents: vec!["support".to_owned()],
        dispositions: vec!["completed".to_owned()],
        outcome_codes: vec!["resolved".to_owned()],
        attribute_keys: Vec::new(),
    })
    .unwrap();
    ConversationResult::try_new(
        ConversationResultInput {
            id: ConversationResultId::parse("result-001").unwrap(),
            context: context(),
            revision: ResultRevision::new(1).unwrap(),
            outcome_schema_revision_id: OutcomeSchemaRevisionId::parse("outcome-schema-001")
                .unwrap(),
            transcript_snapshot_digest: "a".repeat(64),
            summary_artifact_ref: "artifact:summary-001".to_owned(),
            intent: "support".to_owned(),
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

fn evaluation(result: &ConversationResult, violations: Vec<String>) -> Evaluation {
    let rubric = EvaluationRubric::try_new(EvaluationRubricInput {
        id: EvaluationRubricRevisionId::parse("rubric-001").unwrap(),
        agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
        dimensions: vec![EvaluationDimensionInput {
            id: "resolution".to_owned(),
            weight_bps: 10_000,
        }],
        pass_threshold_bps: 8_000,
        bad_case_threshold_bps: 6_000,
        mandatory_violation_codes: vec!["privacy_breach".to_owned()],
    })
    .unwrap();
    Evaluation::try_new(
        EvaluationInput {
            id: EvaluationId::parse(if violations.is_empty() {
                "evaluation-ordinary"
            } else {
                "evaluation-bad"
            })
            .unwrap(),
            evaluator_release_id: AgentReleaseId::parse("evaluator-release-001").unwrap(),
            result_id: result.id().clone(),
            result_revision: result.revision(),
            rubric_revision_id: EvaluationRubricRevisionId::parse("rubric-001").unwrap(),
            dimension_scores_bps: BTreeMap::from([("resolution".to_owned(), 9_000)]),
            evidence_segment_ids: vec![TranscriptSegmentId::parse("segment-001").unwrap()],
            violation_codes: violations,
            created_at_ms: 3_000,
        },
        result,
        &rubric,
    )
    .unwrap()
}

fn context() -> EnvelopeContext {
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
        execution_generation: ExecutionGeneration::new(1).unwrap(),
        trace_id: "trace-001".to_owned(),
    })
    .unwrap()
}
