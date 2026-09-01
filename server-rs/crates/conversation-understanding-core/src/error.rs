use std::{error::Error, fmt};

/// Stable fail-closed conversation-understanding rejection categories.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnderstandingError {
    InvalidIntentCatalog,
    InvalidIntentPolicy,
    InvalidIntentObservation,
    IntentCatalogMismatch,
    IntentSlotNotAllowed,
    IntentAuthorityMismatch,
    StaleIntentObservation,
    IntentRevisionExhausted,
    InvalidIntentCheckpoint,
    InvalidEmotionCatalog,
    InvalidEmotionPolicy,
    InvalidEmotionObservation,
    InvalidEmotionFusion,
    EmotionCatalogMismatch,
    EmotionEvidenceMismatch,
    EmotionAuthorityMismatch,
    StaleEmotionFusion,
    EmotionRevisionExhausted,
    EmotionCanonicalPayloadInvalid,
    InvalidEmotionCheckpoint,
    InvalidCustomerState,
    CustomerStateAuthorityMismatch,
    CustomerStateCanonicalPayloadInvalid,
    InvalidDialoguePolicy,
    DialoguePolicyReleaseMismatch,
    StaleDialogueEvaluation,
    InvalidDialogueRecommendation,
    DialogueRecommendationCanonicalPayloadInvalid,
    CanonicalPayloadInvalid,
}

impl UnderstandingError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidIntentCatalog => "conversation_intent_catalog_invalid",
            Self::InvalidIntentPolicy => "conversation_intent_policy_invalid",
            Self::InvalidIntentObservation => "conversation_intent_observation_invalid",
            Self::IntentCatalogMismatch => "conversation_intent_catalog_mismatch",
            Self::IntentSlotNotAllowed => "conversation_intent_slot_not_allowed",
            Self::IntentAuthorityMismatch => "conversation_intent_authority_mismatch",
            Self::StaleIntentObservation => "conversation_intent_observation_stale",
            Self::IntentRevisionExhausted => "conversation_intent_revision_exhausted",
            Self::InvalidIntentCheckpoint => "conversation_intent_checkpoint_invalid",
            Self::InvalidEmotionCatalog => "conversation_emotion_catalog_invalid",
            Self::InvalidEmotionPolicy => "conversation_emotion_policy_invalid",
            Self::InvalidEmotionObservation => "conversation_emotion_observation_invalid",
            Self::InvalidEmotionFusion => "conversation_emotion_fusion_invalid",
            Self::EmotionCatalogMismatch => "conversation_emotion_catalog_mismatch",
            Self::EmotionEvidenceMismatch => "conversation_emotion_evidence_mismatch",
            Self::EmotionAuthorityMismatch => "conversation_emotion_authority_mismatch",
            Self::StaleEmotionFusion => "conversation_emotion_fusion_stale",
            Self::EmotionRevisionExhausted => "conversation_emotion_revision_exhausted",
            Self::EmotionCanonicalPayloadInvalid => {
                "conversation_emotion_canonical_payload_invalid"
            }
            Self::InvalidEmotionCheckpoint => "conversation_emotion_checkpoint_invalid",
            Self::InvalidCustomerState => "conversation_customer_state_invalid",
            Self::CustomerStateAuthorityMismatch => {
                "conversation_customer_state_authority_mismatch"
            }
            Self::CustomerStateCanonicalPayloadInvalid => {
                "conversation_customer_state_canonical_payload_invalid"
            }
            Self::InvalidDialoguePolicy => "conversation_dialogue_policy_invalid",
            Self::DialoguePolicyReleaseMismatch => "conversation_dialogue_policy_release_mismatch",
            Self::StaleDialogueEvaluation => "conversation_dialogue_evaluation_stale",
            Self::InvalidDialogueRecommendation => "conversation_dialogue_recommendation_invalid",
            Self::DialogueRecommendationCanonicalPayloadInvalid => {
                "conversation_dialogue_recommendation_canonical_payload_invalid"
            }
            Self::CanonicalPayloadInvalid => "conversation_intent_canonical_payload_invalid",
        }
    }
}

impl fmt::Display for UnderstandingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for UnderstandingError {}
