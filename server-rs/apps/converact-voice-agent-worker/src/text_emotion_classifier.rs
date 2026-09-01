use std::{collections::BTreeSet, error::Error, fmt, future::Future, time::Duration};

use converact_contracts::canonical_sha256;
use converact_conversation_result_core::{TranscriptSegment, TranscriptSpeaker};
use converact_conversation_understanding_core::{
    EmotionCandidateInput, EmotionCatalog, EmotionObservation, EmotionObservationInput,
    EmotionSource,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, EmotionCatalogRevisionId, EmotionObservationId,
};
use serde_json::json;

const ARTIFACT_DOMAIN: &str = "converact_text_emotion_classifier_artifact_v1";
const OBSERVATION_DOMAIN: &str = "converact_text_emotion_classifier_observation_v1";
const MAX_LANGUAGES: usize = 32;
const MAX_LANGUAGE_BYTES: usize = 35;
const MAX_INPUT_BYTES: usize = 32_768;
const MAX_CANDIDATES: usize = 5;
const MAX_DEADLINE_MS: u64 = 30_000;

/// Untrusted immutable text-emotion artifact selected by one exact Agent Release.
pub struct TextEmotionClassifierArtifactInput {
    pub agent_release_id: AgentReleaseId,
    pub emotion_catalog_revision_id: EmotionCatalogRevisionId,
    pub model_sha256: String,
    pub tokenizer_sha256: String,
    pub label_map_sha256: String,
    pub calibration_sha256: String,
    pub supported_languages: Vec<String>,
    pub max_input_bytes: usize,
    pub max_candidates: usize,
    pub inference_deadline_ms: u64,
}

#[derive(Clone, Eq, PartialEq)]
struct TextEmotionClassifierArtifact {
    agent_release_id: AgentReleaseId,
    emotion_catalog_revision_id: EmotionCatalogRevisionId,
    revision: Box<str>,
    supported_languages: BTreeSet<Box<str>>,
    max_input_bytes: usize,
    max_candidates: usize,
    inference_deadline_ms: u64,
}

/// Minimal borrowed inference request. Debug output omits transcript text.
#[derive(Clone, Copy)]
pub struct TextEmotionClassifierRequest<'a> {
    artifact_revision: &'a str,
    language: &'a str,
    text: &'a str,
    max_candidates: usize,
}

impl TextEmotionClassifierRequest<'_> {
    #[must_use]
    pub const fn artifact_revision(&self) -> &str {
        self.artifact_revision
    }

    #[must_use]
    pub const fn language(&self) -> &str {
        self.language
    }

    #[must_use]
    pub const fn text(&self) -> &str {
        self.text
    }

    #[must_use]
    pub const fn max_candidates(&self) -> usize {
        self.max_candidates
    }
}

impl fmt::Debug for TextEmotionClassifierRequest<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TextEmotionClassifierRequest")
            .field("artifact_revision", &self.artifact_revision)
            .field("language", &self.language)
            .field("text_bytes", &self.text.len())
            .field("max_candidates", &self.max_candidates)
            .finish_non_exhaustive()
    }
}

/// One untrusted calibrated text-emotion candidate.
pub struct TextEmotionCandidateOutput {
    pub code: String,
    pub confidence_bps: u16,
    pub intensity: u8,
}

/// Untrusted classifier response. Serving must echo the selected artifact revision.
pub struct TextEmotionClassifierOutput {
    pub served_artifact_revision: String,
    pub candidates: Vec<TextEmotionCandidateOutput>,
}

impl fmt::Debug for TextEmotionClassifierOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TextEmotionClassifierOutput")
            .field("served_artifact_revision", &self.served_artifact_revision)
            .field("candidate_count", &self.candidates.len())
            .finish_non_exhaustive()
    }
}

/// Sanitized failure from a concrete local or remote classifier adapter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TextEmotionClassifierPortError {
    code: &'static str,
}

impl TextEmotionClassifierPortError {
    #[must_use]
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for TextEmotionClassifierPortError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for TextEmotionClassifierPortError {}

/// Provider-neutral text-emotion inference boundary.
pub trait TextEmotionClassifierPort: Sync {
    fn classify<'a>(
        &'a self,
        request: TextEmotionClassifierRequest<'a>,
    ) -> impl Future<Output = Result<TextEmotionClassifierOutput, TextEmotionClassifierPortError>>
    + Send
    + 'a;
}

/// Stable fail-closed Provider error without transcript or emotion labels.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextEmotionClassifierProviderError {
    CatalogMismatch,
    ArtifactInvalid,
    InputUnsupported,
    ClassifierUnavailable,
    ClassifierTimedOut,
    ArtifactDrift,
    ClassifierOutputInvalid,
    ObservationInvalid,
}

impl TextEmotionClassifierProviderError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::CatalogMismatch => "text_emotion_classifier_catalog_mismatch",
            Self::ArtifactInvalid => "text_emotion_classifier_artifact_invalid",
            Self::InputUnsupported => "text_emotion_classifier_input_unsupported",
            Self::ClassifierUnavailable => "text_emotion_classifier_unavailable",
            Self::ClassifierTimedOut => "text_emotion_classifier_timed_out",
            Self::ArtifactDrift => "text_emotion_classifier_artifact_drift",
            Self::ClassifierOutputInvalid => "text_emotion_classifier_output_invalid",
            Self::ObservationInvalid => "text_emotion_classifier_observation_invalid",
        }
    }
}

impl fmt::Display for TextEmotionClassifierProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for TextEmotionClassifierProviderError {}

/// Bounded Release-bound Provider that creates text emotion evidence only.
pub struct TextEmotionClassifierProvider<P> {
    catalog: EmotionCatalog,
    artifact: TextEmotionClassifierArtifact,
    port: P,
}

impl<P> TextEmotionClassifierProvider<P> {
    /// Validates immutable serving artifacts and hard request bounds.
    ///
    /// # Errors
    ///
    /// Rejects Release/Catalog mismatch, malformed digests and unbounded configuration.
    pub fn try_new(
        input: TextEmotionClassifierArtifactInput,
        catalog: &EmotionCatalog,
        port: P,
    ) -> Result<Self, TextEmotionClassifierProviderError> {
        if input.agent_release_id != *catalog.agent_release_id()
            || input.emotion_catalog_revision_id != *catalog.id()
        {
            return Err(TextEmotionClassifierProviderError::CatalogMismatch);
        }
        if !lowercase_sha256(&input.model_sha256)
            || !lowercase_sha256(&input.tokenizer_sha256)
            || !lowercase_sha256(&input.label_map_sha256)
            || !lowercase_sha256(&input.calibration_sha256)
            || input.supported_languages.is_empty()
            || input.supported_languages.len() > MAX_LANGUAGES
            || input.max_input_bytes == 0
            || input.max_input_bytes > MAX_INPUT_BYTES
            || input.max_candidates == 0
            || input.max_candidates > MAX_CANDIDATES
            || input.inference_deadline_ms == 0
            || input.inference_deadline_ms > MAX_DEADLINE_MS
        {
            return Err(TextEmotionClassifierProviderError::ArtifactInvalid);
        }
        let supported_languages: BTreeSet<Box<str>> = input
            .supported_languages
            .iter()
            .map(|language| language.as_str().into())
            .collect();
        if supported_languages.len() != input.supported_languages.len()
            || supported_languages
                .iter()
                .any(|language| !language_valid(language))
        {
            return Err(TextEmotionClassifierProviderError::ArtifactInvalid);
        }
        let revision = canonical_sha256(&json!({
            "domain": ARTIFACT_DOMAIN,
            "agent_release_id": input.agent_release_id.as_str(),
            "emotion_catalog_revision_id": input.emotion_catalog_revision_id.as_str(),
            "model_sha256": input.model_sha256,
            "tokenizer_sha256": input.tokenizer_sha256,
            "label_map_sha256": input.label_map_sha256,
            "calibration_sha256": input.calibration_sha256,
            "supported_languages": supported_languages,
            "max_input_bytes": input.max_input_bytes,
            "max_candidates": input.max_candidates,
            "inference_deadline_ms": input.inference_deadline_ms,
        }))
        .map_err(|_| TextEmotionClassifierProviderError::ArtifactInvalid)?;
        Ok(Self {
            catalog: catalog.clone(),
            artifact: TextEmotionClassifierArtifact {
                agent_release_id: input.agent_release_id,
                emotion_catalog_revision_id: input.emotion_catalog_revision_id,
                revision: format!("text-emotion.{revision}").into(),
                supported_languages,
                max_input_bytes: input.max_input_bytes,
                max_candidates: input.max_candidates,
                inference_deadline_ms: input.inference_deadline_ms,
            },
            port,
        })
    }

    #[must_use]
    pub fn artifact_revision(&self) -> &str {
        &self.artifact.revision
    }
}

impl<P> TextEmotionClassifierProvider<P>
where
    P: TextEmotionClassifierPort,
{
    /// Classifies one already-validated final customer transcript into text emotion evidence.
    ///
    /// # Errors
    ///
    /// Rejects unsupported input, serving drift, timeout and invalid calibrated output.
    pub async fn observe(
        &self,
        segment: &TranscriptSegment,
        turn_index: u32,
    ) -> Result<Option<EmotionObservation>, TextEmotionClassifierProviderError> {
        if segment.context().agent_release_id() != &self.artifact.agent_release_id
            || self.catalog.id() != &self.artifact.emotion_catalog_revision_id
        {
            return Err(TextEmotionClassifierProviderError::CatalogMismatch);
        }
        if segment.speaker() != TranscriptSpeaker::Customer {
            return Ok(None);
        }
        if turn_index == 0 {
            return Err(TextEmotionClassifierProviderError::ObservationInvalid);
        }
        if segment.text().len() > self.artifact.max_input_bytes
            || !self
                .artifact
                .supported_languages
                .contains(segment.language())
        {
            return Err(TextEmotionClassifierProviderError::InputUnsupported);
        }
        let output = tokio::time::timeout(
            Duration::from_millis(self.artifact.inference_deadline_ms),
            self.port.classify(TextEmotionClassifierRequest {
                artifact_revision: &self.artifact.revision,
                language: segment.language(),
                text: segment.text(),
                max_candidates: self.artifact.max_candidates,
            }),
        )
        .await
        .map_err(|_| TextEmotionClassifierProviderError::ClassifierTimedOut)?
        .map_err(|_| TextEmotionClassifierProviderError::ClassifierUnavailable)?;
        if output.served_artifact_revision != self.artifact.revision.as_ref() {
            return Err(TextEmotionClassifierProviderError::ArtifactDrift);
        }
        if output.candidates.len() > self.artifact.max_candidates {
            return Err(TextEmotionClassifierProviderError::ClassifierOutputInvalid);
        }
        let observation_digest = canonical_sha256(&json!({
            "domain": OBSERVATION_DOMAIN,
            "artifact_revision": self.artifact.revision,
            "segment_payload_hash": segment.payload_hash(),
            "turn_index": turn_index,
        }))
        .map_err(|_| TextEmotionClassifierProviderError::ObservationInvalid)?;
        let id =
            EmotionObservationId::parse(format!("emotion-observation.text.{observation_digest}"))
                .map_err(|_| TextEmotionClassifierProviderError::ObservationInvalid)?;
        EmotionObservation::try_new(
            EmotionObservationInput {
                id,
                context: segment.context().clone(),
                catalog_revision_id: self.artifact.emotion_catalog_revision_id.clone(),
                source: EmotionSource::TextClassifier,
                provider_revision: self.artifact.revision.to_string(),
                candidates: output
                    .candidates
                    .into_iter()
                    .map(|candidate| EmotionCandidateInput {
                        code: candidate.code,
                        confidence_bps: candidate.confidence_bps,
                        intensity: candidate.intensity,
                    })
                    .collect(),
                transcript_segment_ids: vec![segment.id().clone()],
                audio_evidence_window_ids: Vec::new(),
                turn_index,
                observed_at_ms: segment.observed_at_ms(),
            },
            &self.catalog,
        )
        .map(Some)
        .map_err(|_| TextEmotionClassifierProviderError::ClassifierOutputInvalid)
    }
}

impl<P> fmt::Debug for TextEmotionClassifierProvider<P> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TextEmotionClassifierProvider")
            .field("artifact_revision", &self.artifact.revision)
            .field("language_count", &self.artifact.supported_languages.len())
            .field("max_input_bytes", &self.artifact.max_input_bytes)
            .field("max_candidates", &self.artifact.max_candidates)
            .field(
                "inference_deadline_ms",
                &self.artifact.inference_deadline_ms,
            )
            .finish_non_exhaustive()
    }
}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn language_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_LANGUAGE_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}
