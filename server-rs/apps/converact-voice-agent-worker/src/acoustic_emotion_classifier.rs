use std::{error::Error, fmt, future::Future, time::Duration};

use converact_contracts::{canonical_sha256, sha256_bytes};
use converact_conversation_result_core::{TranscriptSegment, TranscriptSpeaker};
use converact_conversation_understanding_core::{
    EmotionCandidateInput, EmotionCatalog, EmotionObservation, EmotionObservationInput,
    EmotionSource,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, AudioEvidenceWindowId, EmotionCatalogRevisionId, EmotionObservationId,
    EnvelopeContext, TranscriptSegmentId,
};
use serde_json::json;

const AUDIO_WINDOW_DOMAIN: &str = "converact_audio_evidence_window_v1";
const ARTIFACT_DOMAIN: &str = "converact_acoustic_emotion_classifier_artifact_v1";
const OBSERVATION_DOMAIN: &str = "converact_acoustic_emotion_classifier_observation_v1";
const PCM_SAMPLE_RATE_HZ: u32 = 16_000;
const PCM_SAMPLES_PER_MS: u64 = 16;
const MIN_WINDOW_MS: u64 = 200;
const MAX_WINDOW_MS: u64 = 15_000;
const MAX_TRACK_ID_BYTES: usize = 255;
const MAX_CANDIDATES: usize = 5;
const MAX_DEADLINE_MS: u64 = 30_000;

/// Untrusted normalized customer-audio slice associated with one final transcript segment.
pub struct AudioEvidenceWindowInput<'a> {
    pub segment: &'a TranscriptSegment,
    pub customer_track_id: String,
    pub start_offset_ms: u64,
    pub end_offset_ms: u64,
    pub pcm_s16_mono_16khz: Vec<i16>,
}

/// Stable audio-window construction failure without transcript or PCM details.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AudioEvidenceWindowError {
    AuthorityInvalid,
    TimingInvalid,
    PcmInvalid,
    IdentityInvalid,
}

impl AudioEvidenceWindowError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::AuthorityInvalid => "audio_evidence_window_authority_invalid",
            Self::TimingInvalid => "audio_evidence_window_timing_invalid",
            Self::PcmInvalid => "audio_evidence_window_pcm_invalid",
            Self::IdentityInvalid => "audio_evidence_window_identity_invalid",
        }
    }
}

impl fmt::Display for AudioEvidenceWindowError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for AudioEvidenceWindowError {}

/// Bounded normalized PCM evidence. Debug output never includes samples or transcript text.
#[derive(Clone, Eq, PartialEq)]
pub struct AudioEvidenceWindow {
    id: AudioEvidenceWindowId,
    context: EnvelopeContext,
    transcript_segment_id: TranscriptSegmentId,
    customer_track_id: Box<str>,
    start_offset_ms: u64,
    end_offset_ms: u64,
    observed_at_ms: u64,
    pcm_s16_mono_16khz: Box<[i16]>,
    pcm_sha256: Box<str>,
    payload_hash: Box<str>,
}

impl AudioEvidenceWindow {
    /// Validates and content-addresses one normalized mono 16 kHz PCM window.
    ///
    /// # Errors
    ///
    /// Rejects non-customer authority, malformed track/timing, oversized windows, sample-count
    /// drift or identity construction failure.
    pub fn try_new(input: AudioEvidenceWindowInput<'_>) -> Result<Self, AudioEvidenceWindowError> {
        if input.segment.speaker() != TranscriptSpeaker::Customer
            || !bounded_identifier(&input.customer_track_id, MAX_TRACK_ID_BYTES)
        {
            return Err(AudioEvidenceWindowError::AuthorityInvalid);
        }
        let duration_ms = input
            .end_offset_ms
            .checked_sub(input.start_offset_ms)
            .ok_or(AudioEvidenceWindowError::TimingInvalid)?;
        if !(MIN_WINDOW_MS..=MAX_WINDOW_MS).contains(&duration_ms)
            || input.start_offset_ms > input.segment.start_offset_ms()
            || input.end_offset_ms < input.segment.end_offset_ms()
        {
            return Err(AudioEvidenceWindowError::TimingInvalid);
        }
        let expected_samples = duration_ms
            .checked_mul(PCM_SAMPLES_PER_MS)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or(AudioEvidenceWindowError::PcmInvalid)?;
        if input.pcm_s16_mono_16khz.len() != expected_samples {
            return Err(AudioEvidenceWindowError::PcmInvalid);
        }
        let pcm_sha256 = hash_pcm_s16le(&input.pcm_s16_mono_16khz)?;
        let payload_hash = canonical_sha256(&json!({
            "domain": AUDIO_WINDOW_DOMAIN,
            "tenant_id": input.segment.context().tenant_id(),
            "interaction_id": input.segment.context().interaction_id().as_str(),
            "call_attempt_id": input.segment.context().call_attempt_id().as_str(),
            "agent_release_id": input.segment.context().agent_release_id().as_str(),
            "execution_generation": input.segment.context().execution_generation().get(),
            "transcript_segment_id": input.segment.id().as_str(),
            "transcript_segment_payload_hash": input.segment.payload_hash(),
            "customer_track_id": input.customer_track_id,
            "start_offset_ms": input.start_offset_ms,
            "end_offset_ms": input.end_offset_ms,
            "sample_rate_hz": PCM_SAMPLE_RATE_HZ,
            "sample_count": input.pcm_s16_mono_16khz.len(),
            "pcm_sha256": pcm_sha256,
        }))
        .map_err(|_| AudioEvidenceWindowError::IdentityInvalid)?;
        let id = AudioEvidenceWindowId::parse(format!("audio-window.{payload_hash}"))
            .map_err(|_| AudioEvidenceWindowError::IdentityInvalid)?;
        Ok(Self {
            id,
            context: input.segment.context().clone(),
            transcript_segment_id: input.segment.id().clone(),
            customer_track_id: input.customer_track_id.into(),
            start_offset_ms: input.start_offset_ms,
            end_offset_ms: input.end_offset_ms,
            observed_at_ms: input.segment.observed_at_ms(),
            pcm_s16_mono_16khz: input.pcm_s16_mono_16khz.into(),
            pcm_sha256: pcm_sha256.into(),
            payload_hash: payload_hash.into(),
        })
    }

    #[must_use]
    pub const fn id(&self) -> &AudioEvidenceWindowId {
        &self.id
    }

    #[must_use]
    pub const fn context(&self) -> &EnvelopeContext {
        &self.context
    }

    #[must_use]
    pub const fn transcript_segment_id(&self) -> &TranscriptSegmentId {
        &self.transcript_segment_id
    }

    #[must_use]
    pub const fn samples(&self) -> &[i16] {
        &self.pcm_s16_mono_16khz
    }

    #[must_use]
    pub fn pcm_sha256(&self) -> &str {
        &self.pcm_sha256
    }

    #[must_use]
    pub const fn duration_ms(&self) -> u64 {
        self.end_offset_ms - self.start_offset_ms
    }

    #[must_use]
    pub const fn observed_at_ms(&self) -> u64 {
        self.observed_at_ms
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }
}

impl fmt::Debug for AudioEvidenceWindow {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AudioEvidenceWindow")
            .field("id", &self.id)
            .field("transcript_segment_id", &self.transcript_segment_id)
            .field("has_customer_track", &true)
            .field("start_offset_ms", &self.start_offset_ms)
            .field("end_offset_ms", &self.end_offset_ms)
            .field("sample_count", &self.pcm_s16_mono_16khz.len())
            .field("pcm_sha256", &self.pcm_sha256)
            .field("payload_hash", &self.payload_hash)
            .finish_non_exhaustive()
    }
}

/// Untrusted immutable acoustic-emotion artifact selected by one exact Agent Release.
pub struct AcousticEmotionClassifierArtifactInput {
    pub agent_release_id: AgentReleaseId,
    pub emotion_catalog_revision_id: EmotionCatalogRevisionId,
    pub model_sha256: String,
    pub feature_extractor_sha256: String,
    pub label_map_sha256: String,
    pub calibration_sha256: String,
    pub sample_rate_hz: u32,
    pub max_window_ms: u64,
    pub max_candidates: usize,
    pub inference_deadline_ms: u64,
}

#[derive(Clone, Eq, PartialEq)]
struct AcousticEmotionClassifierArtifact {
    agent_release_id: AgentReleaseId,
    emotion_catalog_revision_id: EmotionCatalogRevisionId,
    revision: Box<str>,
    sample_rate_hz: u32,
    max_window_ms: u64,
    max_candidates: usize,
    inference_deadline_ms: u64,
}

/// Borrowed normalized acoustic inference request.
#[derive(Clone, Copy)]
pub struct AcousticEmotionClassifierRequest<'a> {
    artifact_revision: &'a str,
    sample_rate_hz: u32,
    samples: &'a [i16],
    pcm_sha256: &'a str,
    max_candidates: usize,
}

impl AcousticEmotionClassifierRequest<'_> {
    #[must_use]
    pub const fn artifact_revision(&self) -> &str {
        self.artifact_revision
    }

    #[must_use]
    pub const fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    #[must_use]
    pub const fn samples(&self) -> &[i16] {
        self.samples
    }

    #[must_use]
    pub const fn pcm_sha256(&self) -> &str {
        self.pcm_sha256
    }

    #[must_use]
    pub const fn max_candidates(&self) -> usize {
        self.max_candidates
    }
}

impl fmt::Debug for AcousticEmotionClassifierRequest<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AcousticEmotionClassifierRequest")
            .field("artifact_revision", &self.artifact_revision)
            .field("sample_rate_hz", &self.sample_rate_hz)
            .field("sample_count", &self.samples.len())
            .field("pcm_sha256", &self.pcm_sha256)
            .field("max_candidates", &self.max_candidates)
            .finish_non_exhaustive()
    }
}

/// One untrusted calibrated acoustic-emotion candidate.
pub struct AcousticEmotionCandidateOutput {
    pub code: String,
    pub confidence_bps: u16,
    pub intensity: u8,
}

/// Untrusted acoustic classifier response with an artifact echo fence.
pub struct AcousticEmotionClassifierOutput {
    pub served_artifact_revision: String,
    pub candidates: Vec<AcousticEmotionCandidateOutput>,
}

impl fmt::Debug for AcousticEmotionClassifierOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AcousticEmotionClassifierOutput")
            .field("served_artifact_revision", &self.served_artifact_revision)
            .field("candidate_count", &self.candidates.len())
            .finish_non_exhaustive()
    }
}

/// Sanitized failure from a local or remote acoustic classifier adapter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AcousticEmotionClassifierPortError {
    code: &'static str,
}

impl AcousticEmotionClassifierPortError {
    #[must_use]
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for AcousticEmotionClassifierPortError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for AcousticEmotionClassifierPortError {}

/// Provider-neutral acoustic emotion inference boundary.
pub trait AcousticEmotionClassifierPort: Sync {
    fn classify<'a>(
        &'a self,
        request: AcousticEmotionClassifierRequest<'a>,
    ) -> impl Future<
        Output = Result<AcousticEmotionClassifierOutput, AcousticEmotionClassifierPortError>,
    > + Send
    + 'a;
}

/// Stable fail-closed acoustic Provider failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AcousticEmotionClassifierProviderError {
    CatalogMismatch,
    ArtifactInvalid,
    InputInvalid,
    ClassifierUnavailable,
    ClassifierTimedOut,
    ArtifactDrift,
    ClassifierOutputInvalid,
    ObservationInvalid,
}

impl AcousticEmotionClassifierProviderError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::CatalogMismatch => "acoustic_emotion_classifier_catalog_mismatch",
            Self::ArtifactInvalid => "acoustic_emotion_classifier_artifact_invalid",
            Self::InputInvalid => "acoustic_emotion_classifier_input_invalid",
            Self::ClassifierUnavailable => "acoustic_emotion_classifier_unavailable",
            Self::ClassifierTimedOut => "acoustic_emotion_classifier_timed_out",
            Self::ArtifactDrift => "acoustic_emotion_classifier_artifact_drift",
            Self::ClassifierOutputInvalid => "acoustic_emotion_classifier_output_invalid",
            Self::ObservationInvalid => "acoustic_emotion_classifier_observation_invalid",
        }
    }
}

impl fmt::Display for AcousticEmotionClassifierProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for AcousticEmotionClassifierProviderError {}

/// Release-bound Provider that converts normalized PCM windows into acoustic evidence only.
pub struct AcousticEmotionClassifierProvider<P> {
    catalog: EmotionCatalog,
    artifact: AcousticEmotionClassifierArtifact,
    port: P,
}

impl<P> AcousticEmotionClassifierProvider<P> {
    /// Validates immutable serving artifacts and hard request bounds.
    ///
    /// # Errors
    ///
    /// Rejects Release/Catalog mismatch, malformed digests or unsupported PCM configuration.
    pub fn try_new(
        input: AcousticEmotionClassifierArtifactInput,
        catalog: &EmotionCatalog,
        port: P,
    ) -> Result<Self, AcousticEmotionClassifierProviderError> {
        if input.agent_release_id != *catalog.agent_release_id()
            || input.emotion_catalog_revision_id != *catalog.id()
        {
            return Err(AcousticEmotionClassifierProviderError::CatalogMismatch);
        }
        if !lowercase_sha256(&input.model_sha256)
            || !lowercase_sha256(&input.feature_extractor_sha256)
            || !lowercase_sha256(&input.label_map_sha256)
            || !lowercase_sha256(&input.calibration_sha256)
            || input.sample_rate_hz != PCM_SAMPLE_RATE_HZ
            || !(MIN_WINDOW_MS..=MAX_WINDOW_MS).contains(&input.max_window_ms)
            || input.max_candidates == 0
            || input.max_candidates > MAX_CANDIDATES
            || input.inference_deadline_ms == 0
            || input.inference_deadline_ms > MAX_DEADLINE_MS
        {
            return Err(AcousticEmotionClassifierProviderError::ArtifactInvalid);
        }
        let revision = canonical_sha256(&json!({
            "domain": ARTIFACT_DOMAIN,
            "agent_release_id": input.agent_release_id.as_str(),
            "emotion_catalog_revision_id": input.emotion_catalog_revision_id.as_str(),
            "model_sha256": input.model_sha256,
            "feature_extractor_sha256": input.feature_extractor_sha256,
            "label_map_sha256": input.label_map_sha256,
            "calibration_sha256": input.calibration_sha256,
            "sample_rate_hz": input.sample_rate_hz,
            "max_window_ms": input.max_window_ms,
            "max_candidates": input.max_candidates,
            "inference_deadline_ms": input.inference_deadline_ms,
        }))
        .map_err(|_| AcousticEmotionClassifierProviderError::ArtifactInvalid)?;
        Ok(Self {
            catalog: catalog.clone(),
            artifact: AcousticEmotionClassifierArtifact {
                agent_release_id: input.agent_release_id,
                emotion_catalog_revision_id: input.emotion_catalog_revision_id,
                revision: format!("acoustic-emotion.{revision}").into(),
                sample_rate_hz: input.sample_rate_hz,
                max_window_ms: input.max_window_ms,
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

impl<P> AcousticEmotionClassifierProvider<P>
where
    P: AcousticEmotionClassifierPort,
{
    /// Classifies one normalized customer PCM window into acoustic emotion evidence.
    ///
    /// # Errors
    ///
    /// Rejects authority/configuration drift, timeout and invalid calibrated output.
    pub async fn observe(
        &self,
        window: &AudioEvidenceWindow,
        turn_index: u32,
    ) -> Result<EmotionObservation, AcousticEmotionClassifierProviderError> {
        if window.context().agent_release_id() != &self.artifact.agent_release_id
            || self.catalog.id() != &self.artifact.emotion_catalog_revision_id
        {
            return Err(AcousticEmotionClassifierProviderError::CatalogMismatch);
        }
        if turn_index == 0 || window.duration_ms() > self.artifact.max_window_ms {
            return Err(AcousticEmotionClassifierProviderError::InputInvalid);
        }
        let output = tokio::time::timeout(
            Duration::from_millis(self.artifact.inference_deadline_ms),
            self.port.classify(AcousticEmotionClassifierRequest {
                artifact_revision: &self.artifact.revision,
                sample_rate_hz: self.artifact.sample_rate_hz,
                samples: window.samples(),
                pcm_sha256: window.pcm_sha256(),
                max_candidates: self.artifact.max_candidates,
            }),
        )
        .await
        .map_err(|_| AcousticEmotionClassifierProviderError::ClassifierTimedOut)?
        .map_err(|_| AcousticEmotionClassifierProviderError::ClassifierUnavailable)?;
        if output.served_artifact_revision != self.artifact.revision.as_ref() {
            return Err(AcousticEmotionClassifierProviderError::ArtifactDrift);
        }
        if output.candidates.len() > self.artifact.max_candidates {
            return Err(AcousticEmotionClassifierProviderError::ClassifierOutputInvalid);
        }
        let observation_digest = canonical_sha256(&json!({
            "domain": OBSERVATION_DOMAIN,
            "artifact_revision": self.artifact.revision,
            "audio_window_payload_hash": window.payload_hash(),
            "turn_index": turn_index,
        }))
        .map_err(|_| AcousticEmotionClassifierProviderError::ObservationInvalid)?;
        EmotionObservation::try_new(
            EmotionObservationInput {
                id: EmotionObservationId::parse(format!(
                    "emotion-observation.acoustic.{observation_digest}"
                ))
                .map_err(|_| AcousticEmotionClassifierProviderError::ObservationInvalid)?,
                context: window.context().clone(),
                catalog_revision_id: self.artifact.emotion_catalog_revision_id.clone(),
                source: EmotionSource::AcousticModel,
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
                transcript_segment_ids: vec![window.transcript_segment_id().clone()],
                audio_evidence_window_ids: vec![window.id().clone()],
                turn_index,
                observed_at_ms: window.observed_at_ms(),
            },
            &self.catalog,
        )
        .map_err(|_| AcousticEmotionClassifierProviderError::ClassifierOutputInvalid)
    }
}

impl<P> fmt::Debug for AcousticEmotionClassifierProvider<P> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AcousticEmotionClassifierProvider")
            .field("artifact_revision", &self.artifact.revision)
            .field("sample_rate_hz", &self.artifact.sample_rate_hz)
            .field("max_window_ms", &self.artifact.max_window_ms)
            .field("max_candidates", &self.artifact.max_candidates)
            .field(
                "inference_deadline_ms",
                &self.artifact.inference_deadline_ms,
            )
            .finish_non_exhaustive()
    }
}

fn hash_pcm_s16le(samples: &[i16]) -> Result<String, AudioEvidenceWindowError> {
    let capacity = samples
        .len()
        .checked_mul(2)
        .ok_or(AudioEvidenceWindowError::PcmInvalid)?;
    let mut bytes = Vec::with_capacity(capacity);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    Ok(sha256_bytes(&bytes))
}

fn bounded_identifier(value: &str, maximum: usize) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= maximum
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
