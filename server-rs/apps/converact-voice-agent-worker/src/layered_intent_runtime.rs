use std::{error::Error, fmt};

use converact_conversation_result_core::TranscriptSegment;
use converact_conversation_understanding_core::{IntentDecisionPolicy, IntentState};

use crate::{
    ContextualIntentClassifierPort, ContextualIntentClassifierProvider,
    ContextualIntentClassifierProviderError, FastIntentClassifierPort,
    FastIntentClassifierProvider, IntentConfidenceRouter, IntentFallbackReason,
    IntentTurnResolution, IntentTurnRoute, SafetyIntentProvider,
};

/// Release-owned behavior when the Contextual classifier has a transient serving failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContextualFailurePolicy {
    FailClosed,
    FallbackFastOnTransient,
}

/// Stable layered-runtime failure without transcript, candidate or Provider details.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LayeredIntentRuntimeError {
    TranscriptHistoryInvalid,
    Router,
    ContextualProvider,
    ContextualResultMissing,
}

impl LayeredIntentRuntimeError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::TranscriptHistoryInvalid => "layered_intent_transcript_history_invalid",
            Self::Router => "layered_intent_router_failed",
            Self::ContextualProvider => "layered_intent_contextual_provider_failed",
            Self::ContextualResultMissing => "layered_intent_contextual_result_missing",
        }
    }
}

impl fmt::Display for LayeredIntentRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for LayeredIntentRuntimeError {}

/// Stateless coordinator over one already-durable, sequence-ordered transcript window.
///
/// The Runtime selects Intent evidence only. It owns no transcript sequence, durable head,
/// business action, Tool, Telephony or media authority.
pub struct LayeredIntentRuntime<'a, F, C> {
    router: IntentConfidenceRouter<'a, F>,
    contextual: &'a ContextualIntentClassifierProvider<C>,
    contextual_failure_policy: ContextualFailurePolicy,
}

impl<'a, F, C> LayeredIntentRuntime<'a, F, C> {
    #[must_use]
    pub const fn new(
        safety: &'a SafetyIntentProvider,
        fast: &'a FastIntentClassifierProvider<F>,
        contextual: &'a ContextualIntentClassifierProvider<C>,
        contextual_failure_policy: ContextualFailurePolicy,
    ) -> Self {
        Self {
            router: IntentConfidenceRouter::new(safety, fast),
            contextual,
            contextual_failure_policy,
        }
    }
}

impl<F, C> LayeredIntentRuntime<'_, F, C>
where
    F: FastIntentClassifierPort,
    C: ContextualIntentClassifierPort,
{
    /// Resolves the last final segment through Safety, Fast and, only when needed, Contextual.
    ///
    /// `history` must be the bounded durable-sequence window ending at the exact segment routed by
    /// Layer 0/1. Contextual evidence is applied to the original state exactly once.
    ///
    /// # Errors
    ///
    /// Rejects empty history, Router failure, missing Contextual evidence and every non-transient
    /// Contextual failure. Only timeout/unavailability may use the explicit Release fallback.
    pub async fn resolve(
        &self,
        history: &[TranscriptSegment],
        turn_index: u32,
        previous: &IntentState,
        decision_policy: IntentDecisionPolicy,
    ) -> Result<Option<IntentTurnResolution>, LayeredIntentRuntimeError> {
        let current = history
            .last()
            .ok_or(LayeredIntentRuntimeError::TranscriptHistoryInvalid)?;
        let Some(route) = self
            .router
            .route(current, turn_index, previous, decision_policy)
            .await
            .map_err(|_| LayeredIntentRuntimeError::Router)?
        else {
            return Ok(None);
        };
        let IntentTurnRoute::ContextualRequired(pending) = route else {
            let IntentTurnRoute::Resolved(resolution) = route else {
                unreachable!("closed Intent route")
            };
            return Ok(Some(resolution));
        };

        match self.contextual.observe(history, turn_index).await {
            Ok(Some(observation)) => pending
                .resolve_contextual(observation)
                .map(Some)
                .map_err(|_| LayeredIntentRuntimeError::Router),
            Ok(None) => Err(LayeredIntentRuntimeError::ContextualResultMissing),
            Err(error) => {
                let Some(reason) = self.fallback_reason(error) else {
                    return Err(LayeredIntentRuntimeError::ContextualProvider);
                };
                pending
                    .fallback_with_reason(reason)
                    .map(Some)
                    .map_err(|_| LayeredIntentRuntimeError::Router)
            }
        }
    }

    fn fallback_reason(
        &self,
        error: ContextualIntentClassifierProviderError,
    ) -> Option<IntentFallbackReason> {
        if self.contextual_failure_policy != ContextualFailurePolicy::FallbackFastOnTransient {
            return None;
        }
        match error {
            ContextualIntentClassifierProviderError::ClassifierUnavailable => {
                Some(IntentFallbackReason::ContextualUnavailable)
            }
            ContextualIntentClassifierProviderError::ClassifierTimedOut => {
                Some(IntentFallbackReason::ContextualTimedOut)
            }
            ContextualIntentClassifierProviderError::CatalogMismatch
            | ContextualIntentClassifierProviderError::ArtifactInvalid
            | ContextualIntentClassifierProviderError::InputInvalid
            | ContextualIntentClassifierProviderError::InputUnsupported
            | ContextualIntentClassifierProviderError::ArtifactDrift
            | ContextualIntentClassifierProviderError::ClassifierOutputInvalid
            | ContextualIntentClassifierProviderError::ObservationInvalid => None,
        }
    }
}

impl<F, C> fmt::Debug for LayeredIntentRuntime<'_, F, C> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LayeredIntentRuntime")
            .field("contextual_failure_policy", &self.contextual_failure_policy)
            .finish_non_exhaustive()
    }
}
