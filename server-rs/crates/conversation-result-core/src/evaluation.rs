use std::{collections::BTreeMap, fmt};

use converact_contracts::canonical_sha256;
use converact_voice_agent_contracts::{
    AgentReleaseId, ConversationResultId, EvaluationId, EvaluationRubricRevisionId,
    TranscriptSegmentId,
};
use serde_json::json;

use crate::{ConversationResult, ResultError, ResultRevision, validation::bounded_unique};

const MAX_DIMENSIONS: usize = 32;
const MAX_VIOLATIONS: usize = 64;
const MAX_EVIDENCE_SEGMENTS: usize = 512;
const MAX_CODE_BYTES: usize = 100;

/// Unvalidated weighted quality dimension.
pub struct EvaluationDimensionInput {
    pub id: String,
    pub weight_bps: u16,
}

/// Unvalidated immutable rubric revision.
pub struct EvaluationRubricInput {
    pub id: EvaluationRubricRevisionId,
    pub agent_release_id: AgentReleaseId,
    pub dimensions: Vec<EvaluationDimensionInput>,
    pub pass_threshold_bps: u16,
    pub bad_case_threshold_bps: u16,
    pub mandatory_violation_codes: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct EvaluationDimension {
    id: Box<str>,
    weight_bps: u16,
}

/// Release-bound deterministic quality calculation contract.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvaluationRubric {
    id: EvaluationRubricRevisionId,
    agent_release_id: AgentReleaseId,
    dimensions: Box<[EvaluationDimension]>,
    pass_threshold_bps: u16,
    bad_case_threshold_bps: u16,
    mandatory_violation_codes: Box<[Box<str>]>,
}

impl EvaluationRubric {
    /// Validates bounded dimensions, exact 100% weights and ordered thresholds.
    ///
    /// # Errors
    ///
    /// Rejects duplicates, invalid weights/thresholds or unbounded violation codes.
    pub fn try_new(input: EvaluationRubricInput) -> Result<Self, ResultError> {
        let dimension_ids: Vec<String> = input
            .dimensions
            .iter()
            .map(|dimension| dimension.id.clone())
            .collect();
        let total_weight: u32 = input
            .dimensions
            .iter()
            .map(|dimension| u32::from(dimension.weight_bps))
            .sum();
        if dimension_ids.is_empty()
            || !bounded_unique(&dimension_ids, MAX_DIMENSIONS, MAX_CODE_BYTES)
            || input
                .dimensions
                .iter()
                .any(|dimension| dimension.weight_bps == 0 || dimension.weight_bps > 10_000)
            || total_weight != 10_000
            || input.pass_threshold_bps > 10_000
            || input.bad_case_threshold_bps > input.pass_threshold_bps
            || !bounded_unique(
                &input.mandatory_violation_codes,
                MAX_VIOLATIONS,
                MAX_CODE_BYTES,
            )
        {
            return Err(ResultError::InvalidRubric);
        }
        Ok(Self {
            id: input.id,
            agent_release_id: input.agent_release_id,
            dimensions: input
                .dimensions
                .into_iter()
                .map(|dimension| EvaluationDimension {
                    id: dimension.id.into(),
                    weight_bps: dimension.weight_bps,
                })
                .collect(),
            pass_threshold_bps: input.pass_threshold_bps,
            bad_case_threshold_bps: input.bad_case_threshold_bps,
            mandatory_violation_codes: input
                .mandatory_violation_codes
                .into_iter()
                .map(Into::into)
                .collect(),
        })
    }

    #[must_use]
    pub const fn id(&self) -> &EvaluationRubricRevisionId {
        &self.id
    }
}

/// Closed deterministic overall quality grade.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QualityGrade {
    Pass,
    Warn,
    Fail,
}

/// Deterministic reasons for entering the Bad Case queue.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BadCaseReason {
    ScoreBelowThreshold,
    MandatoryViolation,
}

/// Unvalidated evaluator proposal. The platform recomputes all derived fields.
pub struct EvaluationInput {
    pub id: EvaluationId,
    pub evaluator_release_id: AgentReleaseId,
    pub result_id: ConversationResultId,
    pub result_revision: ResultRevision,
    pub rubric_revision_id: EvaluationRubricRevisionId,
    pub dimension_scores_bps: BTreeMap<String, u16>,
    pub evidence_segment_ids: Vec<TranscriptSegmentId>,
    pub violation_codes: Vec<String>,
    pub created_at_ms: u64,
}

/// Immutable evaluation with platform-derived score, grade and Bad Case reasons.
#[derive(Clone, Eq, PartialEq)]
pub struct Evaluation {
    id: EvaluationId,
    evaluator_release_id: AgentReleaseId,
    result_id: ConversationResultId,
    result_revision: ResultRevision,
    rubric_revision_id: EvaluationRubricRevisionId,
    dimension_scores_bps: BTreeMap<Box<str>, u16>,
    evidence_segment_ids: Box<[TranscriptSegmentId]>,
    violation_codes: Box<[Box<str>]>,
    overall_score_bps: u16,
    grade: QualityGrade,
    bad_case_reasons: Box<[BadCaseReason]>,
    created_at_ms: u64,
    payload_hash: Box<str>,
}

impl Evaluation {
    /// Validates an evaluator proposal and deterministically recomputes all derived values.
    ///
    /// # Errors
    ///
    /// Rejects result/rubric mismatch, missing dimensions, invalid scores/evidence or hash failure.
    pub fn try_new(
        input: EvaluationInput,
        result: &ConversationResult,
        rubric: &EvaluationRubric,
    ) -> Result<Self, ResultError> {
        if input.result_id != *result.id()
            || input.result_revision != result.revision()
            || input.rubric_revision_id != rubric.id
            || result.context().agent_release_id() != &rubric.agent_release_id
        {
            return Err(ResultError::RubricMismatch);
        }
        if input.created_at_ms == 0
            || input.evidence_segment_ids.is_empty()
            || input.evidence_segment_ids.len() > MAX_EVIDENCE_SEGMENTS
            || !unique_segment_ids(&input.evidence_segment_ids)
            || !bounded_unique(&input.violation_codes, MAX_VIOLATIONS, MAX_CODE_BYTES)
            || input
                .dimension_scores_bps
                .values()
                .any(|score| *score > 10_000)
        {
            return Err(ResultError::InvalidEvaluation);
        }
        if input.dimension_scores_bps.len() != rubric.dimensions.len()
            || rubric.dimensions.iter().any(|dimension| {
                !input
                    .dimension_scores_bps
                    .contains_key(dimension.id.as_ref())
            })
        {
            return Err(ResultError::RubricMismatch);
        }
        let weighted: u64 = rubric
            .dimensions
            .iter()
            .map(|dimension| {
                u64::from(input.dimension_scores_bps[dimension.id.as_ref()])
                    * u64::from(dimension.weight_bps)
            })
            .sum();
        let overall_score_bps =
            u16::try_from(weighted / 10_000).map_err(|_| ResultError::InvalidEvaluation)?;
        let grade = if overall_score_bps >= rubric.pass_threshold_bps {
            QualityGrade::Pass
        } else if overall_score_bps < rubric.bad_case_threshold_bps {
            QualityGrade::Fail
        } else {
            QualityGrade::Warn
        };
        let mandatory_violation = input.violation_codes.iter().any(|candidate| {
            rubric
                .mandatory_violation_codes
                .iter()
                .any(|required| required.as_ref() == candidate)
        });
        let mut bad_case_reasons = Vec::with_capacity(2);
        if overall_score_bps < rubric.bad_case_threshold_bps {
            bad_case_reasons.push(BadCaseReason::ScoreBelowThreshold);
        }
        if mandatory_violation {
            bad_case_reasons.push(BadCaseReason::MandatoryViolation);
        }
        let payload_hash = canonical_sha256(&json!({
            "evaluation_id": input.id.as_str(),
            "evaluator_release_id": input.evaluator_release_id.as_str(),
            "result_id": input.result_id.as_str(),
            "result_revision": input.result_revision.get(),
            "rubric_revision_id": input.rubric_revision_id.as_str(),
            "dimension_scores_bps": input.dimension_scores_bps,
            "evidence_segment_ids": input.evidence_segment_ids.iter().map(TranscriptSegmentId::as_str).collect::<Vec<_>>(),
            "violation_codes": input.violation_codes,
            "overall_score_bps": overall_score_bps,
            "grade": grade.as_str(),
            "bad_case_reasons": bad_case_reasons.iter().map(|reason| reason.as_str()).collect::<Vec<_>>(),
            "created_at_ms": input.created_at_ms
        }))
        .map_err(|_| ResultError::CanonicalPayloadInvalid)?;
        Ok(Self {
            id: input.id,
            evaluator_release_id: input.evaluator_release_id,
            result_id: input.result_id,
            result_revision: input.result_revision,
            rubric_revision_id: input.rubric_revision_id,
            dimension_scores_bps: input
                .dimension_scores_bps
                .into_iter()
                .map(|(key, value)| (key.into(), value))
                .collect(),
            evidence_segment_ids: input.evidence_segment_ids.into_boxed_slice(),
            violation_codes: input.violation_codes.into_iter().map(Into::into).collect(),
            overall_score_bps,
            grade,
            bad_case_reasons: bad_case_reasons.into_boxed_slice(),
            created_at_ms: input.created_at_ms,
            payload_hash: payload_hash.into(),
        })
    }

    #[must_use]
    pub const fn id(&self) -> &EvaluationId {
        &self.id
    }

    #[must_use]
    pub const fn evaluator_release_id(&self) -> &AgentReleaseId {
        &self.evaluator_release_id
    }

    #[must_use]
    pub const fn result_id(&self) -> &ConversationResultId {
        &self.result_id
    }

    #[must_use]
    pub const fn result_revision(&self) -> ResultRevision {
        self.result_revision
    }

    #[must_use]
    pub const fn rubric_revision_id(&self) -> &EvaluationRubricRevisionId {
        &self.rubric_revision_id
    }

    #[must_use]
    pub const fn dimension_scores_bps(&self) -> &BTreeMap<Box<str>, u16> {
        &self.dimension_scores_bps
    }

    #[must_use]
    pub const fn evidence_segment_ids(&self) -> &[TranscriptSegmentId] {
        &self.evidence_segment_ids
    }

    #[must_use]
    pub const fn violation_codes(&self) -> &[Box<str>] {
        &self.violation_codes
    }

    #[must_use]
    pub const fn overall_score_bps(&self) -> u16 {
        self.overall_score_bps
    }

    #[must_use]
    pub const fn grade(&self) -> QualityGrade {
        self.grade
    }

    #[must_use]
    pub fn is_bad_case(&self) -> bool {
        !self.bad_case_reasons.is_empty()
    }

    #[must_use]
    pub fn bad_case_reasons(&self) -> &[BadCaseReason] {
        &self.bad_case_reasons
    }

    #[must_use]
    pub const fn created_at_ms(&self) -> u64 {
        self.created_at_ms
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }
}

impl QualityGrade {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Warn => "warn",
            Self::Fail => "fail",
        }
    }
}

impl BadCaseReason {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ScoreBelowThreshold => "score_below_threshold",
            Self::MandatoryViolation => "mandatory_violation",
        }
    }
}

impl fmt::Debug for Evaluation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Evaluation")
            .field("id", &self.id)
            .field("result_id", &self.result_id)
            .field("result_revision", &self.result_revision)
            .field("rubric_revision_id", &self.rubric_revision_id)
            .field("overall_score_bps", &self.overall_score_bps)
            .field("grade", &self.grade)
            .field("payload_hash", &self.payload_hash)
            .finish_non_exhaustive()
    }
}

fn unique_segment_ids(values: &[TranscriptSegmentId]) -> bool {
    let mut ids: Vec<&str> = values.iter().map(TranscriptSegmentId::as_str).collect();
    ids.sort_unstable();
    !ids.windows(2).any(|pair| pair[0] == pair[1])
}
