//! Durable, provider-neutral realtime conversation-understanding contracts.

#![forbid(unsafe_code)]

mod customer_state;
mod emotion;
mod error;
mod intent;

pub use customer_state::{
    CustomerStateInput, CustomerStateSnapshot, DialoguePolicy, DialogueRecommendation,
    DialogueRecommendationKind,
};
pub use emotion::{
    CustomerDistressTrend, EmotionCandidate, EmotionCandidateInput, EmotionCatalog,
    EmotionCatalogInput, EmotionDecisionPolicy, EmotionDefinitionInput, EmotionFusion,
    EmotionFusionInput, EmotionObservation, EmotionObservationInput, EmotionSource, EmotionState,
    EmotionStatus, EmotionValence,
};
pub use error::UnderstandingError;
pub use intent::{
    IntentCandidate, IntentCandidateInput, IntentCatalog, IntentCatalogInput, IntentDecisionPolicy,
    IntentDefinitionInput, IntentObservation, IntentObservationInput, IntentSource, IntentState,
    IntentStatus,
};
