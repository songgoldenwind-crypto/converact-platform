use std::{error::Error, fmt};

use converact_contracts::canonical_sha256;
use converact_conversation_understanding_core::{
    EmotionCandidateInput, EmotionCatalog, EmotionCheckpoint, EmotionDecisionPolicy, EmotionFusion,
    EmotionFusionInput, EmotionObservation, EmotionSource, EmotionState,
};
use converact_conversation_understanding_store::{
    UnderstandingRecord, UnderstandingRecordInput, UnderstandingRecordKind,
};
use converact_voice_agent_contracts::EmotionFusionId;
use serde_json::json;

const FUSION_REVISION: &str = "text-only-emotion-fusion-v1";
const FUSION_DOMAIN: &str = "converact_text_only_emotion_fusion_v1";

/// Stable text-emotion turn failure without transcript or label content.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextEmotionTurnRuntimeError {
    EvidenceMismatch,
    FusionInvalid,
    StateTransitionInvalid,
    EvidenceRecordInvalid,
}

impl TextEmotionTurnRuntimeError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::EvidenceMismatch => "text_emotion_turn_evidence_mismatch",
            Self::FusionInvalid => "text_emotion_turn_fusion_invalid",
            Self::StateTransitionInvalid => "text_emotion_turn_state_transition_invalid",
            Self::EvidenceRecordInvalid => "text_emotion_turn_evidence_record_invalid",
        }
    }
}

impl fmt::Display for TextEmotionTurnRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for TextEmotionTurnRuntimeError {}

/// One text-only Emotion checkpoint and the raw Provider evidence that produced it.
#[derive(Clone, Eq, PartialEq)]
pub struct EmotionTurnResolution {
    checkpoint: EmotionCheckpoint,
    contributors: Box<[EmotionObservation]>,
}

impl EmotionTurnResolution {
    pub(crate) fn from_checkpoint(
        checkpoint: EmotionCheckpoint,
        contributors: Vec<EmotionObservation>,
    ) -> Self {
        Self {
            checkpoint,
            contributors: contributors.into(),
        }
    }

    #[must_use]
    pub const fn checkpoint(&self) -> &EmotionCheckpoint {
        &self.checkpoint
    }

    #[must_use]
    pub fn contributors(&self) -> &[EmotionObservation] {
        &self.contributors
    }

    #[must_use]
    pub fn contributor_count(&self) -> usize {
        self.contributors.len()
    }

    /// Encodes raw Emotion Provider contributions as record-only durable evidence.
    ///
    /// # Errors
    ///
    /// Rejects invalid retention or canonical record construction.
    pub fn encode_evidence_records(
        &self,
        retention_policy_ref: &str,
        retention_until_ms: u64,
    ) -> Result<Vec<UnderstandingRecord>, TextEmotionTurnRuntimeError> {
        self.contributors
            .iter()
            .map(|observation| {
                let payload = observation.to_value();
                let payload_hash = canonical_sha256(&payload)
                    .map_err(|_| TextEmotionTurnRuntimeError::EvidenceRecordInvalid)?;
                UnderstandingRecord::try_new(UnderstandingRecordInput {
                    record_id: format!("emotion-provider.{}", observation.payload_hash()),
                    context: observation.context().clone(),
                    kind: UnderstandingRecordKind::EmotionObservation,
                    turn_index: observation.turn_index(),
                    observed_at_ms: observation.observed_at_ms(),
                    retention_policy_ref: retention_policy_ref.to_owned(),
                    retention_until_ms,
                    payload,
                    payload_hash,
                })
                .map_err(|_| TextEmotionTurnRuntimeError::EvidenceRecordInvalid)
            })
            .collect()
    }
}

impl fmt::Debug for EmotionTurnResolution {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EmotionTurnResolution")
            .field("checkpoint", &self.checkpoint)
            .field("contributor_count", &self.contributors.len())
            .finish()
    }
}

/// Conservative text-only bridge from raw Provider evidence to the shared Emotion state machine.
///
/// Acoustic evidence is deliberately not inferred or synthesized here. A future multimodal fusion
/// runtime can produce the same `EmotionTurnResolution` without changing downstream persistence.
pub struct TextEmotionTurnRuntime<'a> {
    catalog: &'a EmotionCatalog,
    decision_policy: EmotionDecisionPolicy,
}

impl<'a> TextEmotionTurnRuntime<'a> {
    #[must_use]
    pub const fn new(catalog: &'a EmotionCatalog, decision_policy: EmotionDecisionPolicy) -> Self {
        Self {
            catalog,
            decision_policy,
        }
    }

    /// Wraps one text observation as an explicitly text-only fusion and advances state once.
    ///
    /// # Errors
    ///
    /// Rejects non-text evidence, catalog/authority drift or stale state.
    pub fn resolve(
        &self,
        observation: EmotionObservation,
        previous: &EmotionState,
    ) -> Result<EmotionTurnResolution, TextEmotionTurnRuntimeError> {
        if observation.source() != EmotionSource::TextClassifier
            || observation.catalog_revision_id() != self.catalog.id()
        {
            return Err(TextEmotionTurnRuntimeError::EvidenceMismatch);
        }
        let digest = canonical_sha256(&json!({
            "domain": FUSION_DOMAIN,
            "fusion_revision": FUSION_REVISION,
            "observation_hash": observation.payload_hash(),
            "turn_index": observation.turn_index(),
        }))
        .map_err(|_| TextEmotionTurnRuntimeError::FusionInvalid)?;
        let fusion = EmotionFusion::try_new(
            EmotionFusionInput {
                id: EmotionFusionId::parse(format!("emotion-fusion.text.{digest}"))
                    .map_err(|_| TextEmotionTurnRuntimeError::FusionInvalid)?,
                context: observation.context().clone(),
                catalog_revision_id: observation.catalog_revision_id().clone(),
                fusion_revision: FUSION_REVISION.to_owned(),
                candidates: observation
                    .candidates()
                    .iter()
                    .map(|candidate| EmotionCandidateInput {
                        code: candidate.code().to_owned(),
                        confidence_bps: candidate.confidence_bps(),
                        intensity: candidate.intensity(),
                    })
                    .collect(),
                turn_index: observation.turn_index(),
                observed_at_ms: observation.observed_at_ms(),
            },
            std::slice::from_ref(&observation),
            self.catalog,
        )
        .map_err(|_| TextEmotionTurnRuntimeError::FusionInvalid)?;
        let state = previous
            .observe(&fusion, self.catalog, self.decision_policy)
            .map_err(|_| TextEmotionTurnRuntimeError::StateTransitionInvalid)?;
        let checkpoint = EmotionCheckpoint::try_new(fusion, state)
            .map_err(|_| TextEmotionTurnRuntimeError::StateTransitionInvalid)?;
        Ok(EmotionTurnResolution::from_checkpoint(
            checkpoint,
            vec![observation],
        ))
    }
}

impl fmt::Debug for TextEmotionTurnRuntime<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TextEmotionTurnRuntime")
            .field("catalog_revision_id", self.catalog.id())
            .field("fusion_revision", &FUSION_REVISION)
            .finish_non_exhaustive()
    }
}
