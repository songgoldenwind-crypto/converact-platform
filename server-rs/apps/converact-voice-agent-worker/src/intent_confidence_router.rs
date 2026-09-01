use std::{error::Error, fmt};

use converact_contracts::canonical_sha256;
use converact_conversation_result_core::TranscriptSegment;
use converact_conversation_understanding_core::{
    IntentCatalog, IntentCheckpoint, IntentDecisionPolicy, IntentObservation, IntentSource,
    IntentState, IntentStatus,
};
use serde_json::json;

use crate::{FastIntentClassifierPort, FastIntentClassifierProvider, SafetyIntentProvider};

const ROUTER_REVISION: &str = "intent-confidence-router-v1";
const MAX_CONTRIBUTORS: usize = 3;

/// Stable Router failure without transcript, candidate or Slot content.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IntentConfidenceRouterError {
    ProviderCatalogMismatch,
    SafetyProvider,
    FastProvider,
    StateTransitionInvalid,
    ContextualEvidenceMismatch,
    ResolutionInvalid,
}

impl IntentConfidenceRouterError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::ProviderCatalogMismatch => "intent_confidence_router_provider_catalog_mismatch",
            Self::SafetyProvider => "intent_confidence_router_safety_provider_failed",
            Self::FastProvider => "intent_confidence_router_fast_provider_failed",
            Self::StateTransitionInvalid => "intent_confidence_router_state_transition_invalid",
            Self::ContextualEvidenceMismatch => {
                "intent_confidence_router_contextual_evidence_mismatch"
            }
            Self::ResolutionInvalid => "intent_confidence_router_resolution_invalid",
        }
    }
}

impl fmt::Display for IntentConfidenceRouterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for IntentConfidenceRouterError {}

/// One selected Intent checkpoint plus every same-turn Provider contribution used to select it.
#[derive(Clone, Eq, PartialEq)]
pub struct IntentTurnResolution {
    checkpoint: IntentCheckpoint,
    contributors: Box<[IntentObservation]>,
    resolution_hash: Box<str>,
}

impl IntentTurnResolution {
    fn try_new(
        checkpoint: IntentCheckpoint,
        mut contributors: Vec<IntentObservation>,
        policy: IntentDecisionPolicy,
    ) -> Result<Self, IntentConfidenceRouterError> {
        if contributors.is_empty() || contributors.len() > MAX_CONTRIBUTORS {
            return Err(IntentConfidenceRouterError::ResolutionInvalid);
        }
        contributors.sort_unstable_by(|left, right| left.payload_hash().cmp(right.payload_hash()));
        if contributors
            .windows(2)
            .any(|pair| pair[0].payload_hash() == pair[1].payload_hash())
        {
            return Err(IntentConfidenceRouterError::ResolutionInvalid);
        }
        let selected = checkpoint.observation();
        if !contributors
            .iter()
            .any(|observation| observation.payload_hash() == selected.payload_hash())
            || contributors.iter().any(|observation| {
                observation.context() != selected.context()
                    || observation.catalog_revision_id() != selected.catalog_revision_id()
                    || observation.turn_index() != selected.turn_index()
                    || observation.evidence_segment_ids() != selected.evidence_segment_ids()
            })
        {
            return Err(IntentConfidenceRouterError::ResolutionInvalid);
        }
        let contributor_hashes: Vec<&str> = contributors
            .iter()
            .map(IntentObservation::payload_hash)
            .collect();
        let resolution_hash = canonical_sha256(&json!({
            "router_revision": ROUTER_REVISION,
            "selected_observation_hash": selected.payload_hash(),
            "contributor_hashes": contributor_hashes,
            "policy": {
                "provisional_min_bps": policy.provisional_min_bps(),
                "confirmed_min_bps": policy.confirmed_min_bps(),
                "minimum_margin_bps": policy.minimum_margin_bps(),
                "safety_rule_confirm_min_bps": policy.safety_rule_confirm_min_bps(),
            },
            "selected_checkpoint": checkpoint.to_value(),
        }))
        .map_err(|_| IntentConfidenceRouterError::ResolutionInvalid)?;
        Ok(Self {
            checkpoint,
            contributors: contributors.into(),
            resolution_hash: resolution_hash.into(),
        })
    }

    #[must_use]
    pub const fn checkpoint(&self) -> &IntentCheckpoint {
        &self.checkpoint
    }

    #[must_use]
    pub fn contributor_count(&self) -> usize {
        self.contributors.len()
    }

    #[must_use]
    pub fn contributors(&self) -> &[IntentObservation] {
        &self.contributors
    }

    #[must_use]
    pub const fn selected_source(&self) -> IntentSource {
        self.checkpoint.observation().source()
    }

    #[must_use]
    pub fn resolution_hash(&self) -> &str {
        &self.resolution_hash
    }
}

impl fmt::Debug for IntentTurnResolution {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IntentTurnResolution")
            .field("selected_source", &self.selected_source())
            .field("contributor_count", &self.contributors.len())
            .field("resolution_hash", &self.resolution_hash)
            .finish_non_exhaustive()
    }
}

/// Same-turn Fast evidence waiting for either Contextual resolution or explicit fallback.
#[derive(Clone, Eq, PartialEq)]
pub struct PendingIntentTurn {
    catalog: IntentCatalog,
    fast_observation: IntentObservation,
    previous: IntentState,
    policy: IntentDecisionPolicy,
}

impl PendingIntentTurn {
    #[must_use]
    pub const fn fast_observation(&self) -> &IntentObservation {
        &self.fast_observation
    }

    /// Selects a Contextual LLM observation over the same exact customer-turn evidence.
    ///
    /// # Errors
    ///
    /// Rejects source, authority, Catalog, turn, evidence or clock drift.
    pub fn resolve_contextual(
        self,
        contextual: IntentObservation,
    ) -> Result<IntentTurnResolution, IntentConfidenceRouterError> {
        if contextual.source() != IntentSource::ContextualLlm
            || contextual.context() != self.fast_observation.context()
            || contextual.catalog_revision_id() != self.fast_observation.catalog_revision_id()
            || contextual.turn_index() != self.fast_observation.turn_index()
            || contextual.evidence_segment_ids() != self.fast_observation.evidence_segment_ids()
            || contextual.observed_at_ms() < self.fast_observation.observed_at_ms()
        {
            return Err(IntentConfidenceRouterError::ContextualEvidenceMismatch);
        }
        let state = self
            .previous
            .observe(&contextual, &self.catalog, self.policy)
            .map_err(|_| IntentConfidenceRouterError::StateTransitionInvalid)?;
        let checkpoint = IntentCheckpoint::try_new(contextual.clone(), state)
            .map_err(|_| IntentConfidenceRouterError::StateTransitionInvalid)?;
        IntentTurnResolution::try_new(
            checkpoint,
            vec![self.fast_observation, contextual],
            self.policy,
        )
    }

    /// Explicitly closes the Fast evidence when Layer 2 is unavailable.
    ///
    /// # Errors
    ///
    /// Rejects a stale or mismatched original state.
    pub fn fallback(self) -> Result<IntentTurnResolution, IntentConfidenceRouterError> {
        let state = self
            .previous
            .observe(&self.fast_observation, &self.catalog, self.policy)
            .map_err(|_| IntentConfidenceRouterError::StateTransitionInvalid)?;
        let checkpoint = IntentCheckpoint::try_new(self.fast_observation.clone(), state)
            .map_err(|_| IntentConfidenceRouterError::StateTransitionInvalid)?;
        IntentTurnResolution::try_new(checkpoint, vec![self.fast_observation], self.policy)
    }
}

impl fmt::Debug for PendingIntentTurn {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingIntentTurn")
            .field("turn_index", &self.fast_observation.turn_index())
            .field(
                "fast_observation_hash",
                &self.fast_observation.payload_hash(),
            )
            .finish_non_exhaustive()
    }
}

/// In-memory route result. Pending output has not advanced authoritative Intent state.
#[derive(Clone, Eq, PartialEq)]
pub enum IntentTurnRoute {
    Resolved(IntentTurnResolution),
    ContextualRequired(PendingIntentTurn),
}

impl fmt::Debug for IntentTurnRoute {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Resolved(resolution) => {
                formatter.debug_tuple("Resolved").field(resolution).finish()
            }
            Self::ContextualRequired(pending) => formatter
                .debug_tuple("ContextualRequired")
                .field(pending)
                .finish(),
        }
    }
}

/// Safety-first, confidence-gated same-turn Intent Router.
pub struct IntentConfidenceRouter<'a, P> {
    safety: &'a SafetyIntentProvider,
    fast: &'a FastIntentClassifierProvider<P>,
}

impl<'a, P> IntentConfidenceRouter<'a, P> {
    #[must_use]
    pub const fn new(
        safety: &'a SafetyIntentProvider,
        fast: &'a FastIntentClassifierProvider<P>,
    ) -> Self {
        Self { safety, fast }
    }
}

impl<P> IntentConfidenceRouter<'_, P>
where
    P: FastIntentClassifierPort,
{
    /// Routes one final segment through Safety and Fast layers without double-advancing a turn.
    ///
    /// # Errors
    ///
    /// Returns sanitized Provider or state validation failures.
    pub async fn route(
        &self,
        segment: &TranscriptSegment,
        turn_index: u32,
        previous: &IntentState,
        policy: IntentDecisionPolicy,
    ) -> Result<Option<IntentTurnRoute>, IntentConfidenceRouterError> {
        if self.safety.catalog() != self.fast.catalog() {
            return Err(IntentConfidenceRouterError::ProviderCatalogMismatch);
        }
        if let Some(observation) = self
            .safety
            .observe(segment, turn_index)
            .map_err(|_| IntentConfidenceRouterError::SafetyProvider)?
        {
            let state = previous
                .observe(&observation, self.fast.catalog(), policy)
                .map_err(|_| IntentConfidenceRouterError::StateTransitionInvalid)?;
            let checkpoint = IntentCheckpoint::try_new(observation.clone(), state)
                .map_err(|_| IntentConfidenceRouterError::StateTransitionInvalid)?;
            return IntentTurnResolution::try_new(checkpoint, vec![observation], policy)
                .map(IntentTurnRoute::Resolved)
                .map(Some);
        }
        let Some(observation) = self
            .fast
            .observe(segment, turn_index)
            .await
            .map_err(|_| IntentConfidenceRouterError::FastProvider)?
        else {
            return Ok(None);
        };
        let preview = previous
            .observe(&observation, self.fast.catalog(), policy)
            .map_err(|_| IntentConfidenceRouterError::StateTransitionInvalid)?;
        if matches!(
            preview.status(),
            IntentStatus::Confirmed | IntentStatus::Changed
        ) {
            let checkpoint = IntentCheckpoint::try_new(observation.clone(), preview)
                .map_err(|_| IntentConfidenceRouterError::StateTransitionInvalid)?;
            IntentTurnResolution::try_new(checkpoint, vec![observation], policy)
                .map(IntentTurnRoute::Resolved)
                .map(Some)
        } else {
            Ok(Some(IntentTurnRoute::ContextualRequired(
                PendingIntentTurn {
                    catalog: self.fast.catalog().clone(),
                    fast_observation: observation,
                    previous: previous.clone(),
                    policy,
                },
            )))
        }
    }
}
