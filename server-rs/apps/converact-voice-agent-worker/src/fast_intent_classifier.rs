use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt,
    future::Future,
    time::Duration,
};

use converact_contracts::canonical_sha256;
use converact_conversation_result_core::{TranscriptSegment, TranscriptSpeaker};
use converact_conversation_understanding_core::{
    IntentCandidateInput, IntentCatalog, IntentCheckpoint, IntentDecisionPolicy, IntentObservation,
    IntentObservationInput, IntentSource, IntentState,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, IntentCatalogRevisionId, IntentObservationId,
};
use serde_json::json;

const ARTIFACT_DOMAIN: &str = "converact_fast_intent_classifier_artifact_v1";
const OBSERVATION_DOMAIN: &str = "converact_fast_intent_classifier_observation_v1";
const MAX_LANGUAGES: usize = 32;
const MAX_LANGUAGE_BYTES: usize = 35;
const MAX_INPUT_BYTES: usize = 32_768;
const MAX_CANDIDATES: usize = 5;
const MAX_DEADLINE_MS: u64 = 30_000;

/// Untrusted immutable classifier-artifact binding selected by one exact Agent Release.
pub struct FastIntentClassifierArtifactInput {
    pub agent_release_id: AgentReleaseId,
    pub intent_catalog_revision_id: IntentCatalogRevisionId,
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
struct FastIntentClassifierArtifact {
    agent_release_id: AgentReleaseId,
    intent_catalog_revision_id: IntentCatalogRevisionId,
    revision: Box<str>,
    supported_languages: BTreeSet<Box<str>>,
    max_input_bytes: usize,
    max_candidates: usize,
    inference_deadline_ms: u64,
}

/// Minimal semantic inference request. Debug output intentionally omits transcript text.
#[derive(Clone, Copy)]
pub struct FastIntentClassifierRequest<'a> {
    artifact_revision: &'a str,
    language: &'a str,
    text: &'a str,
    max_candidates: usize,
}

impl FastIntentClassifierRequest<'_> {
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

impl fmt::Debug for FastIntentClassifierRequest<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FastIntentClassifierRequest")
            .field("artifact_revision", &self.artifact_revision)
            .field("language", &self.language)
            .field("text_bytes", &self.text.len())
            .field("max_candidates", &self.max_candidates)
            .finish_non_exhaustive()
    }
}

/// One untrusted calibrated candidate returned by a classifier runtime.
pub struct FastIntentCandidateOutput {
    pub code: String,
    pub confidence_bps: u16,
}

/// Untrusted classifier response. The serving runtime must echo the selected artifact revision.
pub struct FastIntentClassifierOutput {
    pub served_artifact_revision: String,
    pub candidates: Vec<FastIntentCandidateOutput>,
}

impl fmt::Debug for FastIntentClassifierOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FastIntentClassifierOutput")
            .field("served_artifact_revision", &self.served_artifact_revision)
            .field("candidate_count", &self.candidates.len())
            .finish_non_exhaustive()
    }
}

/// Sanitized failure from a concrete local or remote classifier adapter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FastIntentClassifierPortError {
    code: &'static str,
    contract_invalid: bool,
}

impl FastIntentClassifierPortError {
    #[must_use]
    pub const fn new(code: &'static str) -> Self {
        Self {
            code,
            contract_invalid: false,
        }
    }

    /// Creates a non-transient request/response contract failure.
    #[must_use]
    pub const fn contract_invalid(code: &'static str) -> Self {
        Self {
            code,
            contract_invalid: true,
        }
    }

    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }

    const fn is_contract_invalid(self) -> bool {
        self.contract_invalid
    }
}

impl fmt::Display for FastIntentClassifierPortError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for FastIntentClassifierPortError {}

/// Provider-neutral fast semantic-classifier boundary.
pub trait FastIntentClassifierPort: Sync {
    fn classify<'a>(
        &'a self,
        request: FastIntentClassifierRequest<'a>,
    ) -> impl Future<Output = Result<FastIntentClassifierOutput, FastIntentClassifierPortError>>
    + Send
    + 'a;
}

/// Stable fail-closed Provider failure without transcript text or candidate labels.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FastIntentClassifierProviderError {
    CatalogMismatch,
    ArtifactInvalid,
    InputUnsupported,
    ClassifierUnavailable,
    ClassifierTimedOut,
    ArtifactDrift,
    ClassifierOutputInvalid,
    ObservationInvalid,
    StateTransitionInvalid,
}

impl FastIntentClassifierProviderError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::CatalogMismatch => "fast_intent_classifier_catalog_mismatch",
            Self::ArtifactInvalid => "fast_intent_classifier_artifact_invalid",
            Self::InputUnsupported => "fast_intent_classifier_input_unsupported",
            Self::ClassifierUnavailable => "fast_intent_classifier_unavailable",
            Self::ClassifierTimedOut => "fast_intent_classifier_timed_out",
            Self::ArtifactDrift => "fast_intent_classifier_artifact_drift",
            Self::ClassifierOutputInvalid => "fast_intent_classifier_output_invalid",
            Self::ObservationInvalid => "fast_intent_classifier_observation_invalid",
            Self::StateTransitionInvalid => "fast_intent_classifier_state_transition_invalid",
        }
    }
}

impl fmt::Display for FastIntentClassifierProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for FastIntentClassifierProviderError {}

/// Bounded Layer-1 Provider. It produces Intent evidence and owns no business-action port.
pub struct FastIntentClassifierProvider<P> {
    catalog: IntentCatalog,
    artifact: FastIntentClassifierArtifact,
    port: P,
}

impl<P> FastIntentClassifierProvider<P> {
    /// Binds exact model artifacts and runtime limits to one immutable Release and Catalog.
    ///
    /// # Errors
    ///
    /// Rejects mismatched authority, malformed digests, duplicate languages or unbounded limits.
    pub fn try_new(
        input: FastIntentClassifierArtifactInput,
        catalog: &IntentCatalog,
        port: P,
    ) -> Result<Self, FastIntentClassifierProviderError> {
        if input.agent_release_id != *catalog.agent_release_id()
            || input.intent_catalog_revision_id != *catalog.id()
        {
            return Err(FastIntentClassifierProviderError::CatalogMismatch);
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
            return Err(FastIntentClassifierProviderError::ArtifactInvalid);
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
            return Err(FastIntentClassifierProviderError::ArtifactInvalid);
        }
        let revision = canonical_sha256(&json!({
            "domain": ARTIFACT_DOMAIN,
            "agent_release_id": input.agent_release_id.as_str(),
            "intent_catalog_revision_id": input.intent_catalog_revision_id.as_str(),
            "model_sha256": input.model_sha256,
            "tokenizer_sha256": input.tokenizer_sha256,
            "label_map_sha256": input.label_map_sha256,
            "calibration_sha256": input.calibration_sha256,
            "supported_languages": supported_languages,
            "max_input_bytes": input.max_input_bytes,
            "max_candidates": input.max_candidates,
            "inference_deadline_ms": input.inference_deadline_ms,
        }))
        .map_err(|_| FastIntentClassifierProviderError::ArtifactInvalid)?;
        Ok(Self {
            catalog: catalog.clone(),
            artifact: FastIntentClassifierArtifact {
                agent_release_id: input.agent_release_id,
                intent_catalog_revision_id: input.intent_catalog_revision_id,
                revision: format!("fast-intent.{revision}").into(),
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

    pub(crate) const fn catalog(&self) -> &IntentCatalog {
        &self.catalog
    }
}

impl<P> FastIntentClassifierProvider<P>
where
    P: FastIntentClassifierPort,
{
    /// Classifies one already-validated final customer transcript into closed-Catalog evidence.
    ///
    /// # Errors
    ///
    /// Rejects unsupported input, serving drift, timeouts and invalid calibrated output.
    pub async fn observe(
        &self,
        segment: &TranscriptSegment,
        turn_index: u32,
    ) -> Result<Option<IntentObservation>, FastIntentClassifierProviderError> {
        if segment.context().agent_release_id() != &self.artifact.agent_release_id
            || self.catalog.id() != &self.artifact.intent_catalog_revision_id
        {
            return Err(FastIntentClassifierProviderError::CatalogMismatch);
        }
        if segment.speaker() != TranscriptSpeaker::Customer {
            return Ok(None);
        }
        if turn_index == 0 {
            return Err(FastIntentClassifierProviderError::ObservationInvalid);
        }
        if segment.text().len() > self.artifact.max_input_bytes
            || !self
                .artifact
                .supported_languages
                .contains(segment.language())
        {
            return Err(FastIntentClassifierProviderError::InputUnsupported);
        }
        let request = FastIntentClassifierRequest {
            artifact_revision: &self.artifact.revision,
            language: segment.language(),
            text: segment.text(),
            max_candidates: self.artifact.max_candidates,
        };
        let output = tokio::time::timeout(
            Duration::from_millis(self.artifact.inference_deadline_ms),
            self.port.classify(request),
        )
        .await
        .map_err(|_| FastIntentClassifierProviderError::ClassifierTimedOut)?
        .map_err(|error| {
            if error.is_contract_invalid() {
                FastIntentClassifierProviderError::ClassifierOutputInvalid
            } else {
                FastIntentClassifierProviderError::ClassifierUnavailable
            }
        })?;
        if output.served_artifact_revision != self.artifact.revision.as_ref() {
            return Err(FastIntentClassifierProviderError::ArtifactDrift);
        }
        if output.candidates.len() > self.artifact.max_candidates {
            return Err(FastIntentClassifierProviderError::ClassifierOutputInvalid);
        }
        let observation_digest = canonical_sha256(&json!({
            "domain": OBSERVATION_DOMAIN,
            "artifact_revision": self.artifact.revision,
            "segment_payload_hash": segment.payload_hash(),
            "turn_index": turn_index,
        }))
        .map_err(|_| FastIntentClassifierProviderError::ObservationInvalid)?;
        let id =
            IntentObservationId::parse(format!("intent-observation.fast.{observation_digest}"))
                .map_err(|_| FastIntentClassifierProviderError::ObservationInvalid)?;
        IntentObservation::try_new(
            IntentObservationInput {
                id,
                context: segment.context().clone(),
                catalog_revision_id: self.artifact.intent_catalog_revision_id.clone(),
                source: IntentSource::FastClassifier,
                provider_revision: self.artifact.revision.to_string(),
                candidates: output
                    .candidates
                    .into_iter()
                    .map(|candidate| IntentCandidateInput {
                        code: candidate.code,
                        confidence_bps: candidate.confidence_bps,
                    })
                    .collect(),
                slots: BTreeMap::default(),
                evidence_segment_ids: vec![segment.id().clone()],
                turn_index,
                observed_at_ms: segment.observed_at_ms(),
            },
            &self.catalog,
        )
        .map(Some)
        .map_err(|_| FastIntentClassifierProviderError::ClassifierOutputInvalid)
    }

    /// Applies Layer-1 evidence to one exact previous Intent state and closes a checkpoint.
    ///
    /// # Errors
    ///
    /// Rejects model, observation or stale state failures without executing any business action.
    pub async fn advance(
        &self,
        segment: &TranscriptSegment,
        turn_index: u32,
        previous: &IntentState,
        policy: IntentDecisionPolicy,
    ) -> Result<Option<IntentCheckpoint>, FastIntentClassifierProviderError> {
        let Some(observation) = self.observe(segment, turn_index).await? else {
            return Ok(None);
        };
        let state = previous
            .observe(&observation, &self.catalog, policy)
            .map_err(|_| FastIntentClassifierProviderError::StateTransitionInvalid)?;
        IntentCheckpoint::try_new(observation, state)
            .map(Some)
            .map_err(|_| FastIntentClassifierProviderError::StateTransitionInvalid)
    }
}

impl<P> fmt::Debug for FastIntentClassifierProvider<P> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FastIntentClassifierProvider")
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
