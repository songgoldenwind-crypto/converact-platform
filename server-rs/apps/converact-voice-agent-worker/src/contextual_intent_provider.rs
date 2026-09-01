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
    IntentCandidateInput, IntentCatalog, IntentObservation, IntentObservationInput, IntentSource,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, EnvelopeContext, IntentCatalogRevisionId, IntentObservationId,
};
use serde_json::json;

const ARTIFACT_DOMAIN: &str = "converact_contextual_intent_artifact_v1";
const OBSERVATION_DOMAIN: &str = "converact_contextual_intent_observation_v1";
const MAX_LANGUAGES: usize = 32;
const MAX_LANGUAGE_BYTES: usize = 35;
const MAX_CONTEXT_SEGMENTS: usize = 32;
const MAX_CONTEXT_BYTES: usize = 131_072;
const MAX_CANDIDATES: usize = 5;
const MAX_SLOTS: usize = 32;
const MAX_DEADLINE_MS: u64 = 30_000;

/// Untrusted immutable Layer-2 artifact binding selected by one exact Agent Release.
pub struct ContextualIntentArtifactInput {
    pub agent_release_id: AgentReleaseId,
    pub intent_catalog_revision_id: IntentCatalogRevisionId,
    pub model_profile_sha256: String,
    pub prompt_template_sha256: String,
    pub label_map_sha256: String,
    pub output_schema_sha256: String,
    pub calibration_sha256: String,
    pub supported_languages: Vec<String>,
    pub max_context_segments: usize,
    pub max_context_bytes: usize,
    pub max_candidates: usize,
    pub max_slots: usize,
    pub inference_deadline_ms: u64,
}

#[derive(Clone, Eq, PartialEq)]
struct ContextualIntentArtifact {
    agent_release_id: AgentReleaseId,
    intent_catalog_revision_id: IntentCatalogRevisionId,
    revision: Box<str>,
    supported_languages: BTreeSet<Box<str>>,
    max_context_segments: usize,
    max_context_bytes: usize,
    max_candidates: usize,
    max_slots: usize,
    inference_deadline_ms: u64,
}

struct PreparedContextualIntent<'a> {
    current: &'a TranscriptSegment,
    request: ContextualIntentClassifierRequest<'a>,
    evidence_ids: Vec<converact_voice_agent_contracts::TranscriptSegmentId>,
    evidence_hashes: Vec<&'a str>,
    turn_index: u32,
}

/// One minimal borrowed dialogue turn supplied to the Layer-2 model port.
#[derive(Clone, Copy)]
pub struct ContextualIntentTurn<'a> {
    speaker: TranscriptSpeaker,
    language: &'a str,
    text: &'a str,
}

impl ContextualIntentTurn<'_> {
    #[must_use]
    pub const fn speaker(&self) -> TranscriptSpeaker {
        self.speaker
    }

    #[must_use]
    pub const fn language(&self) -> &str {
        self.language
    }

    #[must_use]
    pub const fn text(&self) -> &str {
        self.text
    }
}

impl fmt::Debug for ContextualIntentTurn<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ContextualIntentTurn")
            .field("speaker", &self.speaker)
            .field("language", &self.language)
            .field("text_bytes", &self.text.len())
            .finish_non_exhaustive()
    }
}

/// Minimal multi-turn request. Debug output omits all transcript content.
pub struct ContextualIntentClassifierRequest<'a> {
    artifact_revision: &'a str,
    turns: Box<[ContextualIntentTurn<'a>]>,
    max_candidates: usize,
    max_slots: usize,
}

impl ContextualIntentClassifierRequest<'_> {
    #[must_use]
    pub const fn artifact_revision(&self) -> &str {
        self.artifact_revision
    }

    #[must_use]
    pub fn turns(&self) -> &[ContextualIntentTurn<'_>] {
        &self.turns
    }

    #[must_use]
    pub const fn max_candidates(&self) -> usize {
        self.max_candidates
    }

    #[must_use]
    pub const fn max_slots(&self) -> usize {
        self.max_slots
    }
}

impl fmt::Debug for ContextualIntentClassifierRequest<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text_bytes: usize = self.turns.iter().map(|turn| turn.text.len()).sum();
        formatter
            .debug_struct("ContextualIntentClassifierRequest")
            .field("artifact_revision", &self.artifact_revision)
            .field("turn_count", &self.turns.len())
            .field("text_bytes", &text_bytes)
            .field("max_candidates", &self.max_candidates)
            .field("max_slots", &self.max_slots)
            .finish_non_exhaustive()
    }
}

/// One untrusted calibrated Intent candidate from the Layer-2 model.
pub struct ContextualIntentCandidateOutput {
    pub code: String,
    pub confidence_bps: u16,
}

/// Untrusted structured Layer-2 response.
pub struct ContextualIntentClassifierOutput {
    pub served_artifact_revision: String,
    pub candidates: Vec<ContextualIntentCandidateOutput>,
    pub slots: BTreeMap<String, String>,
}

impl fmt::Debug for ContextualIntentClassifierOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ContextualIntentClassifierOutput")
            .field("served_artifact_revision", &self.served_artifact_revision)
            .field("candidate_count", &self.candidates.len())
            .field("slot_count", &self.slots.len())
            .finish_non_exhaustive()
    }
}

/// Sanitized failure from a concrete model-provider adapter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ContextualIntentClassifierPortError {
    code: &'static str,
    contract_invalid: bool,
}

impl ContextualIntentClassifierPortError {
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

impl fmt::Display for ContextualIntentClassifierPortError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for ContextualIntentClassifierPortError {}

/// Provider-neutral structured Contextual Intent inference boundary.
pub trait ContextualIntentClassifierPort: Sync {
    fn classify<'a>(
        &'a self,
        request: ContextualIntentClassifierRequest<'a>,
    ) -> impl Future<
        Output = Result<ContextualIntentClassifierOutput, ContextualIntentClassifierPortError>,
    > + Send
    + 'a;
}

/// Stable fail-closed Layer-2 Provider error without customer content.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContextualIntentClassifierProviderError {
    CatalogMismatch,
    ArtifactInvalid,
    InputInvalid,
    InputUnsupported,
    ClassifierUnavailable,
    ClassifierTimedOut,
    ArtifactDrift,
    ClassifierOutputInvalid,
    ObservationInvalid,
}

impl ContextualIntentClassifierProviderError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::CatalogMismatch => "contextual_intent_catalog_mismatch",
            Self::ArtifactInvalid => "contextual_intent_artifact_invalid",
            Self::InputInvalid => "contextual_intent_input_invalid",
            Self::InputUnsupported => "contextual_intent_input_unsupported",
            Self::ClassifierUnavailable => "contextual_intent_classifier_unavailable",
            Self::ClassifierTimedOut => "contextual_intent_classifier_timed_out",
            Self::ArtifactDrift => "contextual_intent_artifact_drift",
            Self::ClassifierOutputInvalid => "contextual_intent_classifier_output_invalid",
            Self::ObservationInvalid => "contextual_intent_observation_invalid",
        }
    }
}

impl fmt::Display for ContextualIntentClassifierProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ContextualIntentClassifierProviderError {}

/// Bounded Layer-2 Provider. It creates evidence and owns no business-action port.
pub struct ContextualIntentClassifierProvider<P> {
    catalog: IntentCatalog,
    artifact: ContextualIntentArtifact,
    port: P,
}

impl<P> ContextualIntentClassifierProvider<P> {
    /// Binds exact structured-LLM artifacts and bounds to one immutable Release and Catalog.
    ///
    /// # Errors
    ///
    /// Rejects authority mismatch, malformed artifact digests or unbounded configuration.
    pub fn try_new(
        input: ContextualIntentArtifactInput,
        catalog: &IntentCatalog,
        port: P,
    ) -> Result<Self, ContextualIntentClassifierProviderError> {
        if input.agent_release_id != *catalog.agent_release_id()
            || input.intent_catalog_revision_id != *catalog.id()
        {
            return Err(ContextualIntentClassifierProviderError::CatalogMismatch);
        }
        if !lowercase_sha256(&input.model_profile_sha256)
            || !lowercase_sha256(&input.prompt_template_sha256)
            || !lowercase_sha256(&input.label_map_sha256)
            || !lowercase_sha256(&input.output_schema_sha256)
            || !lowercase_sha256(&input.calibration_sha256)
            || input.supported_languages.is_empty()
            || input.supported_languages.len() > MAX_LANGUAGES
            || input.max_context_segments == 0
            || input.max_context_segments > MAX_CONTEXT_SEGMENTS
            || input.max_context_bytes == 0
            || input.max_context_bytes > MAX_CONTEXT_BYTES
            || input.max_candidates == 0
            || input.max_candidates > MAX_CANDIDATES
            || input.max_slots > MAX_SLOTS
            || input.inference_deadline_ms == 0
            || input.inference_deadline_ms > MAX_DEADLINE_MS
        {
            return Err(ContextualIntentClassifierProviderError::ArtifactInvalid);
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
            return Err(ContextualIntentClassifierProviderError::ArtifactInvalid);
        }
        let revision = canonical_sha256(&json!({
            "domain": ARTIFACT_DOMAIN,
            "agent_release_id": input.agent_release_id.as_str(),
            "intent_catalog_revision_id": input.intent_catalog_revision_id.as_str(),
            "model_profile_sha256": input.model_profile_sha256,
            "prompt_template_sha256": input.prompt_template_sha256,
            "label_map_sha256": input.label_map_sha256,
            "output_schema_sha256": input.output_schema_sha256,
            "calibration_sha256": input.calibration_sha256,
            "supported_languages": supported_languages,
            "max_context_segments": input.max_context_segments,
            "max_context_bytes": input.max_context_bytes,
            "max_candidates": input.max_candidates,
            "max_slots": input.max_slots,
            "inference_deadline_ms": input.inference_deadline_ms,
        }))
        .map_err(|_| ContextualIntentClassifierProviderError::ArtifactInvalid)?;
        Ok(Self {
            catalog: catalog.clone(),
            artifact: ContextualIntentArtifact {
                agent_release_id: input.agent_release_id,
                intent_catalog_revision_id: input.intent_catalog_revision_id,
                revision: format!("contextual-intent.{revision}").into(),
                supported_languages,
                max_context_segments: input.max_context_segments,
                max_context_bytes: input.max_context_bytes,
                max_candidates: input.max_candidates,
                max_slots: input.max_slots,
                inference_deadline_ms: input.inference_deadline_ms,
            },
            port,
        })
    }

    #[must_use]
    pub fn artifact_revision(&self) -> &str {
        &self.artifact.revision
    }

    fn prepare<'a>(
        &'a self,
        history: &'a [TranscriptSegment],
        turn_index: u32,
    ) -> Result<Option<PreparedContextualIntent<'a>>, ContextualIntentClassifierProviderError> {
        if history.is_empty()
            || history.len() > self.artifact.max_context_segments
            || turn_index == 0
        {
            return Err(ContextualIntentClassifierProviderError::InputInvalid);
        }
        let current = history
            .last()
            .ok_or(ContextualIntentClassifierProviderError::InputInvalid)?;
        if current.speaker() != TranscriptSpeaker::Customer {
            return Ok(None);
        }
        if current.context().agent_release_id() != &self.artifact.agent_release_id {
            return Err(ContextualIntentClassifierProviderError::CatalogMismatch);
        }
        let mut context_bytes = 0_usize;
        let mut previous_sequence = 0_u64;
        let mut turns = Vec::with_capacity(history.len());
        let mut evidence_ids = Vec::with_capacity(history.len());
        let mut evidence_hashes = Vec::with_capacity(history.len());
        for segment in history {
            if !same_authority(segment.context(), current.context())
                || segment.sequence() <= previous_sequence
                || segment.speaker() == TranscriptSpeaker::System
            {
                return Err(ContextualIntentClassifierProviderError::InputInvalid);
            }
            if !self
                .artifact
                .supported_languages
                .contains(segment.language())
            {
                return Err(ContextualIntentClassifierProviderError::InputUnsupported);
            }
            context_bytes = context_bytes
                .checked_add(segment.text().len())
                .ok_or(ContextualIntentClassifierProviderError::InputInvalid)?;
            if context_bytes > self.artifact.max_context_bytes {
                return Err(ContextualIntentClassifierProviderError::InputUnsupported);
            }
            previous_sequence = segment.sequence();
            turns.push(ContextualIntentTurn {
                speaker: segment.speaker(),
                language: segment.language(),
                text: segment.text(),
            });
            evidence_ids.push(segment.id().clone());
            evidence_hashes.push(segment.payload_hash());
        }
        Ok(Some(PreparedContextualIntent {
            current,
            request: ContextualIntentClassifierRequest {
                artifact_revision: &self.artifact.revision,
                turns: turns.into(),
                max_candidates: self.artifact.max_candidates,
                max_slots: self.artifact.max_slots,
            },
            evidence_ids,
            evidence_hashes,
            turn_index,
        }))
    }
}

impl<P> ContextualIntentClassifierProvider<P>
where
    P: ContextualIntentClassifierPort,
{
    /// Classifies one ordered same-authority transcript window into Layer-2 Intent/Slot evidence.
    ///
    /// # Errors
    ///
    /// Rejects history drift, unsupported input, timeouts and invalid structured output.
    pub async fn observe(
        &self,
        history: &[TranscriptSegment],
        turn_index: u32,
    ) -> Result<Option<IntentObservation>, ContextualIntentClassifierProviderError> {
        let Some(prepared) = self.prepare(history, turn_index)? else {
            return Ok(None);
        };
        let PreparedContextualIntent {
            current,
            request,
            evidence_ids,
            evidence_hashes,
            turn_index,
        } = prepared;
        let output = tokio::time::timeout(
            Duration::from_millis(self.artifact.inference_deadline_ms),
            self.port.classify(request),
        )
        .await
        .map_err(|_| ContextualIntentClassifierProviderError::ClassifierTimedOut)?
        .map_err(|error| {
            if error.is_contract_invalid() {
                ContextualIntentClassifierProviderError::ClassifierOutputInvalid
            } else {
                ContextualIntentClassifierProviderError::ClassifierUnavailable
            }
        })?;
        if output.served_artifact_revision != self.artifact.revision.as_ref() {
            return Err(ContextualIntentClassifierProviderError::ArtifactDrift);
        }
        if output.candidates.len() > self.artifact.max_candidates
            || output.slots.len() > self.artifact.max_slots
        {
            return Err(ContextualIntentClassifierProviderError::ClassifierOutputInvalid);
        }
        let observation_digest = canonical_sha256(&json!({
            "domain": OBSERVATION_DOMAIN,
            "artifact_revision": self.artifact.revision,
            "evidence_payload_hashes": evidence_hashes,
            "turn_index": turn_index,
        }))
        .map_err(|_| ContextualIntentClassifierProviderError::ObservationInvalid)?;
        let id = IntentObservationId::parse(format!(
            "intent-observation.contextual.{observation_digest}"
        ))
        .map_err(|_| ContextualIntentClassifierProviderError::ObservationInvalid)?;
        IntentObservation::try_new(
            IntentObservationInput {
                id,
                context: current.context().clone(),
                catalog_revision_id: self.artifact.intent_catalog_revision_id.clone(),
                source: IntentSource::ContextualLlm,
                provider_revision: self.artifact.revision.to_string(),
                candidates: output
                    .candidates
                    .into_iter()
                    .map(|candidate| IntentCandidateInput {
                        code: candidate.code,
                        confidence_bps: candidate.confidence_bps,
                    })
                    .collect(),
                slots: output.slots,
                evidence_segment_ids: evidence_ids,
                turn_index,
                observed_at_ms: current.observed_at_ms(),
            },
            &self.catalog,
        )
        .map(Some)
        .map_err(|_| ContextualIntentClassifierProviderError::ClassifierOutputInvalid)
    }
}

impl<P> fmt::Debug for ContextualIntentClassifierProvider<P> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ContextualIntentClassifierProvider")
            .field("artifact_revision", &self.artifact.revision)
            .field("language_count", &self.artifact.supported_languages.len())
            .field("max_context_segments", &self.artifact.max_context_segments)
            .field("max_context_bytes", &self.artifact.max_context_bytes)
            .field("max_candidates", &self.artifact.max_candidates)
            .field("max_slots", &self.artifact.max_slots)
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

fn same_authority(left: &EnvelopeContext, right: &EnvelopeContext) -> bool {
    left.schema_version() == right.schema_version()
        && left.tenant_id() == right.tenant_id()
        && left.interaction_id() == right.interaction_id()
        && left.campaign_id() == right.campaign_id()
        && left.campaign_contact_id() == right.campaign_contact_id()
        && left.call_attempt_id() == right.call_attempt_id()
        && left.call_id() == right.call_id()
        && left.agent_release_id() == right.agent_release_id()
        && left.channel_agent_session_id() == right.channel_agent_session_id()
        && left.execution_generation() == right.execution_generation()
}
