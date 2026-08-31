//! Durable, provider-neutral realtime conversation-understanding contracts.

#![forbid(unsafe_code)]

mod error;
mod intent;

pub use error::UnderstandingError;
pub use intent::{
    IntentCandidate, IntentCandidateInput, IntentCatalog, IntentCatalogInput, IntentDecisionPolicy,
    IntentDefinitionInput, IntentObservation, IntentObservationInput, IntentSource, IntentState,
    IntentStatus,
};
