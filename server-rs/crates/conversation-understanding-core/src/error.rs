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
