use std::{error::Error, fmt};

use converact_active_call_adapter::NormalizedEvent;
use converact_conversation_result_core::{OutcomeSchema, ResultError, ValidatedIntentEvidence};

/// Stable intent-projection rejection without exposing customer or model text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActiveCallIntentProjectionError {
    code: &'static str,
}

impl ActiveCallIntentProjectionError {
    const fn new(code: &'static str) -> Self {
        Self { code }
    }

    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for ActiveCallIntentProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for ActiveCallIntentProjectionError {}

/// Resolves terminal Active Call intent evidence against the exact release schema.
///
/// # Errors
///
/// Rejects non-terminal events, cross-release evidence and candidates outside the closed schema.
pub fn resolve_active_call_intent_evidence(
    event: &NormalizedEvent,
    schema: &OutcomeSchema,
) -> Result<Option<ValidatedIntentEvidence>, ActiveCallIntentProjectionError> {
    let NormalizedEvent::ConversationCompleted {
        authority,
        intent_candidate,
        ..
    } = event
    else {
        return Err(ActiveCallIntentProjectionError::new(
            "active_call_intent_terminal_event_required",
        ));
    };
    if authority.agent_release_id() != schema.agent_release_id() {
        return Err(ActiveCallIntentProjectionError::new(
            "active_call_intent_release_mismatch",
        ));
    }
    intent_candidate
        .as_ref()
        .map(|candidate| schema.validate_intent_candidate(candidate.as_str()))
        .transpose()
        .map_err(|error| match error {
            ResultError::OutcomeSchemaMismatch => {
                ActiveCallIntentProjectionError::new("active_call_intent_outcome_schema_mismatch")
            }
            _ => ActiveCallIntentProjectionError::new("active_call_intent_evidence_invalid"),
        })
}
