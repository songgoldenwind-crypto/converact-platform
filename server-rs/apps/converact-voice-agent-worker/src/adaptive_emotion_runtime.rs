use std::{error::Error, fmt};

use converact_conversation_result_core::TranscriptSegment;
use converact_conversation_understanding_core::{
    EmotionCatalog, EmotionDecisionPolicy, EmotionObservation, EmotionState,
};

use crate::{
    AcousticEmotionClassifierPort, AcousticEmotionClassifierProvider,
    AcousticEmotionClassifierProviderError, AudioEvidenceWindow, EmotionTurnResolution,
    MultimodalEmotionFusionPolicy, MultimodalEmotionTurnRuntime, TextEmotionClassifierPort,
    TextEmotionClassifierProvider, TextEmotionTurnRuntime,
    text_emotion_runtime::TextEmotionFusionPath,
};

/// Release policy for turns where acoustic evidence cannot be produced transiently.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AcousticEmotionFailurePolicy {
    FallbackTextOnMissingOrTransient,
    RequireMultimodal,
}

/// Stable adaptive-emotion failure without transcript, PCM or Provider payload details.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdaptiveEmotionTurnRuntimeError {
    TranscriptInvalid,
    EvidenceMismatch,
    TextProviderFailed,
    AcousticEvidenceRequired,
    AcousticProviderFailed,
    ResolutionFailed,
}

impl AdaptiveEmotionTurnRuntimeError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::TranscriptInvalid => "adaptive_emotion_transcript_invalid",
            Self::EvidenceMismatch => "adaptive_emotion_evidence_mismatch",
            Self::TextProviderFailed => "adaptive_emotion_text_provider_failed",
            Self::AcousticEvidenceRequired => "adaptive_emotion_acoustic_evidence_required",
            Self::AcousticProviderFailed => "adaptive_emotion_acoustic_provider_failed",
            Self::ResolutionFailed => "adaptive_emotion_resolution_failed",
        }
    }
}

impl fmt::Display for AdaptiveEmotionTurnRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for AdaptiveEmotionTurnRuntimeError {}

/// Resolves text plus optional acoustic evidence without granting any call-control authority.
pub struct AdaptiveEmotionTurnRuntime<'a, T, A> {
    text: &'a TextEmotionClassifierProvider<T>,
    acoustic: &'a AcousticEmotionClassifierProvider<A>,
    catalog: &'a EmotionCatalog,
    decision_policy: EmotionDecisionPolicy,
    fusion_policy: MultimodalEmotionFusionPolicy,
    failure_policy: AcousticEmotionFailurePolicy,
}

impl<'a, T, A> AdaptiveEmotionTurnRuntime<'a, T, A> {
    #[must_use]
    pub const fn new(
        text: &'a TextEmotionClassifierProvider<T>,
        acoustic: &'a AcousticEmotionClassifierProvider<A>,
        catalog: &'a EmotionCatalog,
        decision_policy: EmotionDecisionPolicy,
        fusion_policy: MultimodalEmotionFusionPolicy,
        failure_policy: AcousticEmotionFailurePolicy,
    ) -> Self {
        Self {
            text,
            acoustic,
            catalog,
            decision_policy,
            fusion_policy,
            failure_policy,
        }
    }
}

impl<T, A> AdaptiveEmotionTurnRuntime<'_, T, A>
where
    T: TextEmotionClassifierPort,
    A: AcousticEmotionClassifierPort,
{
    /// Uses both modalities when exact audio evidence exists and an audited text-only fallback
    /// only for missing audio or transient acoustic serving failure.
    ///
    /// # Errors
    ///
    /// Fails closed on authority/evidence/artifact/output drift and when multimodal evidence is
    /// required by release policy. These errors never imply a telephony action.
    pub async fn resolve(
        &self,
        segment: &TranscriptSegment,
        window: Option<&AudioEvidenceWindow>,
        turn_index: u32,
        previous: &EmotionState,
    ) -> Result<EmotionTurnResolution, AdaptiveEmotionTurnRuntimeError> {
        if window.is_some_and(|window| {
            window.context() != segment.context() || window.transcript_segment_id() != segment.id()
        }) {
            return Err(AdaptiveEmotionTurnRuntimeError::EvidenceMismatch);
        }
        if window.is_none()
            && self.failure_policy == AcousticEmotionFailurePolicy::RequireMultimodal
        {
            return Err(AdaptiveEmotionTurnRuntimeError::AcousticEvidenceRequired);
        }
        let text = self
            .text
            .observe(segment, turn_index)
            .await
            .map_err(|_| AdaptiveEmotionTurnRuntimeError::TextProviderFailed)?
            .ok_or(AdaptiveEmotionTurnRuntimeError::TranscriptInvalid)?;
        let Some(window) = window else {
            return self.resolve_fallback(
                text,
                previous,
                TextEmotionFusionPath::AcousticEvidenceMissingFallback,
            );
        };
        match self.acoustic.observe(window, turn_index).await {
            Ok(acoustic) => MultimodalEmotionTurnRuntime::new(
                self.catalog,
                self.decision_policy,
                &self.fusion_policy,
            )
            .resolve(text, acoustic, previous)
            .map_err(|_| AdaptiveEmotionTurnRuntimeError::ResolutionFailed),
            Err(AcousticEmotionClassifierProviderError::ClassifierUnavailable) => self
                .resolve_fallback(
                    text,
                    previous,
                    TextEmotionFusionPath::AcousticUnavailableFallback,
                ),
            Err(AcousticEmotionClassifierProviderError::ClassifierTimedOut) => self
                .resolve_fallback(
                    text,
                    previous,
                    TextEmotionFusionPath::AcousticTimedOutFallback,
                ),
            Err(_) => Err(AdaptiveEmotionTurnRuntimeError::AcousticProviderFailed),
        }
    }

    fn resolve_fallback(
        &self,
        text: EmotionObservation,
        previous: &EmotionState,
        path: TextEmotionFusionPath,
    ) -> Result<EmotionTurnResolution, AdaptiveEmotionTurnRuntimeError> {
        if self.failure_policy == AcousticEmotionFailurePolicy::RequireMultimodal {
            return Err(AdaptiveEmotionTurnRuntimeError::AcousticEvidenceRequired);
        }
        TextEmotionTurnRuntime::new(self.catalog, self.decision_policy)
            .resolve_with_path(text, previous, path)
            .map_err(|_| AdaptiveEmotionTurnRuntimeError::ResolutionFailed)
    }
}

impl<T, A> fmt::Debug for AdaptiveEmotionTurnRuntime<'_, T, A> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AdaptiveEmotionTurnRuntime")
            .field("catalog_revision_id", self.catalog.id())
            .field("fusion_policy", &self.fusion_policy)
            .field("failure_policy", &self.failure_policy)
            .finish_non_exhaustive()
    }
}
