use std::{collections::BTreeMap, error::Error, fmt};

use converact_contracts::canonical_sha256;
use converact_conversation_understanding_core::{
    EmotionCandidateInput, EmotionCatalog, EmotionCheckpoint, EmotionDecisionPolicy, EmotionFusion,
    EmotionFusionInput, EmotionObservation, EmotionSource, EmotionState,
};
use converact_voice_agent_contracts::EmotionFusionId;
use serde_json::json;

use crate::EmotionTurnResolution;

const FUSION_DOMAIN: &str = "converact_multimodal_emotion_fusion_v1";
const TOTAL_WEIGHT_BPS: u16 = 10_000;
const MAX_CANDIDATES: usize = 5;

/// Stable multimodal fusion failure without customer labels or evidence payloads.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MultimodalEmotionTurnRuntimeError {
    PolicyInvalid,
    EvidenceMismatch,
    FusionInvalid,
    StateTransitionInvalid,
}

impl MultimodalEmotionTurnRuntimeError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::PolicyInvalid => "multimodal_emotion_policy_invalid",
            Self::EvidenceMismatch => "multimodal_emotion_evidence_mismatch",
            Self::FusionInvalid => "multimodal_emotion_fusion_invalid",
            Self::StateTransitionInvalid => "multimodal_emotion_state_transition_invalid",
        }
    }
}

impl fmt::Display for MultimodalEmotionTurnRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for MultimodalEmotionTurnRuntimeError {}

/// Release-selected conservative weights over independently calibrated modalities.
#[derive(Clone, Eq, PartialEq)]
pub struct MultimodalEmotionFusionPolicy {
    text_weight_bps: u16,
    acoustic_weight_bps: u16,
    minimum_candidate_bps: u16,
    max_candidates: usize,
    revision: Box<str>,
}

impl MultimodalEmotionFusionPolicy {
    /// Builds a closed two-modality policy whose weights total exactly 10,000 basis points.
    ///
    /// # Errors
    ///
    /// Rejects missing/inexact weights, invalid confidence floor or unbounded top-k.
    pub fn try_new(
        text_weight_bps: u16,
        acoustic_weight_bps: u16,
        minimum_candidate_bps: u16,
        max_candidates: usize,
    ) -> Result<Self, MultimodalEmotionTurnRuntimeError> {
        if text_weight_bps == 0
            || acoustic_weight_bps == 0
            || text_weight_bps.checked_add(acoustic_weight_bps) != Some(TOTAL_WEIGHT_BPS)
            || minimum_candidate_bps == 0
            || minimum_candidate_bps > TOTAL_WEIGHT_BPS
            || max_candidates == 0
            || max_candidates > MAX_CANDIDATES
        {
            return Err(MultimodalEmotionTurnRuntimeError::PolicyInvalid);
        }
        let revision = canonical_sha256(&json!({
            "domain": FUSION_DOMAIN,
            "text_weight_bps": text_weight_bps,
            "acoustic_weight_bps": acoustic_weight_bps,
            "minimum_candidate_bps": minimum_candidate_bps,
            "max_candidates": max_candidates,
        }))
        .map_err(|_| MultimodalEmotionTurnRuntimeError::PolicyInvalid)?;
        Ok(Self {
            text_weight_bps,
            acoustic_weight_bps,
            minimum_candidate_bps,
            max_candidates,
            revision: format!("multimodal-emotion.{revision}").into(),
        })
    }

    #[must_use]
    pub fn revision(&self) -> &str {
        &self.revision
    }
}

impl fmt::Debug for MultimodalEmotionFusionPolicy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MultimodalEmotionFusionPolicy")
            .field("text_weight_bps", &self.text_weight_bps)
            .field("acoustic_weight_bps", &self.acoustic_weight_bps)
            .field("minimum_candidate_bps", &self.minimum_candidate_bps)
            .field("max_candidates", &self.max_candidates)
            .field("revision", &self.revision)
            .finish()
    }
}

/// Deterministic conservative fusion over one text and one acoustic observation.
pub struct MultimodalEmotionTurnRuntime<'a> {
    catalog: &'a EmotionCatalog,
    decision_policy: EmotionDecisionPolicy,
    fusion_policy: MultimodalEmotionFusionPolicy,
}

impl<'a> MultimodalEmotionTurnRuntime<'a> {
    #[must_use]
    pub const fn new(
        catalog: &'a EmotionCatalog,
        decision_policy: EmotionDecisionPolicy,
        fusion_policy: MultimodalEmotionFusionPolicy,
    ) -> Self {
        Self {
            catalog,
            decision_policy,
            fusion_policy,
        }
    }

    /// Fuses two independently calibrated observations and advances shared Emotion State once.
    ///
    /// Missing labels receive zero contribution from that modality. This deliberately dilutes
    /// disagreement instead of turning one noisy signal into false high confidence.
    ///
    /// # Errors
    ///
    /// Rejects source/catalog/turn/evidence drift, invalid fusion output or stale state.
    pub fn resolve(
        &self,
        text: EmotionObservation,
        acoustic: EmotionObservation,
        previous: &EmotionState,
    ) -> Result<EmotionTurnResolution, MultimodalEmotionTurnRuntimeError> {
        validate_evidence(&text, &acoustic, self.catalog)?;
        let candidates = fuse_candidates(&text, &acoustic, &self.fusion_policy)?;
        let observed_at_ms = text.observed_at_ms().max(acoustic.observed_at_ms());
        let digest = canonical_sha256(&json!({
            "domain": FUSION_DOMAIN,
            "fusion_revision": self.fusion_policy.revision,
            "text_observation_hash": text.payload_hash(),
            "acoustic_observation_hash": acoustic.payload_hash(),
            "turn_index": text.turn_index(),
        }))
        .map_err(|_| MultimodalEmotionTurnRuntimeError::FusionInvalid)?;
        let contributors = vec![text, acoustic];
        let fusion = EmotionFusion::try_new(
            EmotionFusionInput {
                id: EmotionFusionId::parse(format!("emotion-fusion.multimodal.{digest}"))
                    .map_err(|_| MultimodalEmotionTurnRuntimeError::FusionInvalid)?,
                context: contributors[0].context().clone(),
                catalog_revision_id: self.catalog.id().clone(),
                fusion_revision: self.fusion_policy.revision.to_string(),
                candidates,
                turn_index: contributors[0].turn_index(),
                observed_at_ms,
            },
            &contributors,
            self.catalog,
        )
        .map_err(|_| MultimodalEmotionTurnRuntimeError::FusionInvalid)?;
        let state = previous
            .observe(&fusion, self.catalog, self.decision_policy)
            .map_err(|_| MultimodalEmotionTurnRuntimeError::StateTransitionInvalid)?;
        let checkpoint = EmotionCheckpoint::try_new(fusion, state)
            .map_err(|_| MultimodalEmotionTurnRuntimeError::StateTransitionInvalid)?;
        Ok(EmotionTurnResolution::from_checkpoint(
            checkpoint,
            contributors,
        ))
    }
}

impl fmt::Debug for MultimodalEmotionTurnRuntime<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MultimodalEmotionTurnRuntime")
            .field("catalog_revision_id", self.catalog.id())
            .field("fusion_policy", &self.fusion_policy)
            .finish_non_exhaustive()
    }
}

fn validate_evidence(
    text: &EmotionObservation,
    acoustic: &EmotionObservation,
    catalog: &EmotionCatalog,
) -> Result<(), MultimodalEmotionTurnRuntimeError> {
    if text.source() != EmotionSource::TextClassifier
        || acoustic.source() != EmotionSource::AcousticModel
        || !text.audio_evidence_window_ids().is_empty()
        || acoustic.audio_evidence_window_ids().is_empty()
        || text.transcript_segment_ids().is_empty()
        || acoustic.transcript_segment_ids().is_empty()
        || text.catalog_revision_id() != catalog.id()
        || acoustic.catalog_revision_id() != catalog.id()
        || text.turn_index() != acoustic.turn_index()
    {
        return Err(MultimodalEmotionTurnRuntimeError::EvidenceMismatch);
    }
    Ok(())
}

#[derive(Default)]
struct WeightedCandidate {
    confidence_numerator: u64,
    intensity_numerator: u64,
}

fn fuse_candidates(
    text: &EmotionObservation,
    acoustic: &EmotionObservation,
    policy: &MultimodalEmotionFusionPolicy,
) -> Result<Vec<EmotionCandidateInput>, MultimodalEmotionTurnRuntimeError> {
    let mut weighted = BTreeMap::<String, WeightedCandidate>::new();
    contribute(&mut weighted, text, policy.text_weight_bps)?;
    contribute(&mut weighted, acoustic, policy.acoustic_weight_bps)?;
    let denominator = u64::from(TOTAL_WEIGHT_BPS);
    let mut candidates: Vec<_> = weighted
        .into_iter()
        .filter_map(|(code, weighted)| {
            let confidence = u16::try_from(weighted.confidence_numerator / denominator).ok()?;
            if confidence < policy.minimum_candidate_bps {
                return None;
            }
            let intensity =
                u8::try_from((weighted.intensity_numerator + denominator / 2) / denominator)
                    .ok()?;
            Some(EmotionCandidateInput {
                code,
                confidence_bps: confidence,
                intensity,
            })
        })
        .collect();
    candidates.sort_unstable_by(|left, right| {
        right
            .confidence_bps
            .cmp(&left.confidence_bps)
            .then_with(|| right.intensity.cmp(&left.intensity))
            .then_with(|| left.code.cmp(&right.code))
    });
    candidates.truncate(policy.max_candidates);
    Ok(candidates)
}

fn contribute(
    weighted: &mut BTreeMap<String, WeightedCandidate>,
    observation: &EmotionObservation,
    weight_bps: u16,
) -> Result<(), MultimodalEmotionTurnRuntimeError> {
    for candidate in observation.candidates() {
        let aggregate = weighted.entry(candidate.code().to_owned()).or_default();
        aggregate.confidence_numerator = aggregate
            .confidence_numerator
            .checked_add(u64::from(candidate.confidence_bps()) * u64::from(weight_bps))
            .ok_or(MultimodalEmotionTurnRuntimeError::FusionInvalid)?;
        aggregate.intensity_numerator = aggregate
            .intensity_numerator
            .checked_add(u64::from(candidate.intensity()) * u64::from(weight_bps))
            .ok_or(MultimodalEmotionTurnRuntimeError::FusionInvalid)?;
    }
    Ok(())
}
