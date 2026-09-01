use std::{collections::BTreeMap, fmt};

use converact_contracts::canonical_sha256;
use converact_voice_agent_contracts::{
    AgentReleaseId, AudioEvidenceWindowId, EmotionCatalogRevisionId, EmotionFusionId,
    EmotionObservationId, EnvelopeContext, TranscriptSegmentId,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::UnderstandingError;

const MAX_DEFINITIONS: usize = 64;
const MAX_CODE_BYTES: usize = 100;
const MAX_CANDIDATES: usize = 5;
const MAX_EVIDENCE_ITEMS: usize = 32;
const MAX_CONTRIBUTORS: usize = 8;
const MAX_PROVIDER_REVISION_BYTES: usize = 255;
const MAX_INTENSITY: u8 = 4;
const MAX_DISTRESS_RANK: u8 = 4;

/// Stable polarity metadata for a Release-owned emotion label.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EmotionValence {
    Negative,
    Neutral,
    Positive,
}

/// One untrusted emotion definition supplied by an Agent Release.
pub struct EmotionDefinitionInput {
    pub code: String,
    pub valence: EmotionValence,
    pub distress_rank: u8,
}

/// Untrusted immutable emotion vocabulary.
pub struct EmotionCatalogInput {
    pub id: EmotionCatalogRevisionId,
    pub agent_release_id: AgentReleaseId,
    pub definitions: Vec<EmotionDefinitionInput>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct EmotionDefinition {
    valence: EmotionValence,
    distress_rank: u8,
}

/// Immutable emotion vocabulary and distress semantics for one exact Agent Release.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmotionCatalog {
    id: EmotionCatalogRevisionId,
    agent_release_id: AgentReleaseId,
    definitions: BTreeMap<Box<str>, EmotionDefinition>,
}

impl EmotionCatalog {
    /// Validates bounded labels and explicit distress semantics.
    ///
    /// # Errors
    ///
    /// Rejects empty, duplicate, unbounded or internally inconsistent catalogs.
    pub fn try_new(input: EmotionCatalogInput) -> Result<Self, UnderstandingError> {
        if input.definitions.is_empty() || input.definitions.len() > MAX_DEFINITIONS {
            return Err(UnderstandingError::InvalidEmotionCatalog);
        }
        let mut definitions = BTreeMap::new();
        for definition in input.definitions {
            let distress_valid = match definition.valence {
                EmotionValence::Negative => {
                    (1..=MAX_DISTRESS_RANK).contains(&definition.distress_rank)
                }
                EmotionValence::Neutral | EmotionValence::Positive => definition.distress_rank == 0,
            };
            if !bounded_identifier(&definition.code, MAX_CODE_BYTES) || !distress_valid {
                return Err(UnderstandingError::InvalidEmotionCatalog);
            }
            let value = EmotionDefinition {
                valence: definition.valence,
                distress_rank: definition.distress_rank,
            };
            if definitions.insert(definition.code.into(), value).is_some() {
                return Err(UnderstandingError::InvalidEmotionCatalog);
            }
        }
        Ok(Self {
            id: input.id,
            agent_release_id: input.agent_release_id,
            definitions,
        })
    }

    #[must_use]
    pub const fn id(&self) -> &EmotionCatalogRevisionId {
        &self.id
    }

    #[must_use]
    pub const fn agent_release_id(&self) -> &AgentReleaseId {
        &self.agent_release_id
    }

    #[must_use]
    pub fn valence(&self, emotion: &str) -> Option<EmotionValence> {
        self.definitions
            .get(emotion)
            .map(|definition| definition.valence)
    }

    #[must_use]
    pub fn distress_rank(&self, emotion: &str) -> Option<u8> {
        self.definitions
            .get(emotion)
            .map(|definition| definition.distress_rank)
    }

    fn contains(&self, emotion: &str) -> bool {
        self.definitions.contains_key(emotion)
    }
}

/// Provider class that produced one independently traceable emotion signal.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EmotionSource {
    AcousticModel,
    TextClassifier,
    ContextualLlm,
    ActiveCallPlaybook,
    HumanCorrection,
}

impl EmotionSource {
    const fn as_str(self) -> &'static str {
        match self {
            Self::AcousticModel => "acoustic_model",
            Self::TextClassifier => "text_classifier",
            Self::ContextualLlm => "contextual_llm",
            Self::ActiveCallPlaybook => "active_call_playbook",
            Self::HumanCorrection => "human_correction",
        }
    }

    const fn requires_audio(self) -> bool {
        matches!(self, Self::AcousticModel)
    }

    const fn requires_transcript(self) -> bool {
        matches!(
            self,
            Self::TextClassifier | Self::ContextualLlm | Self::ActiveCallPlaybook
        )
    }
}

/// Untrusted emotion hypothesis with calibrated confidence and ordinal intensity.
pub struct EmotionCandidateInput {
    pub code: String,
    pub confidence_bps: u16,
    pub intensity: u8,
}

/// One catalog-validated emotion hypothesis. Its containing types own redacted diagnostics.
#[derive(Clone, Eq, PartialEq, Serialize)]
pub struct EmotionCandidate {
    code: Box<str>,
    confidence_bps: u16,
    intensity: u8,
}

impl EmotionCandidate {
    #[must_use]
    pub fn code(&self) -> &str {
        &self.code
    }

    #[must_use]
    pub const fn confidence_bps(&self) -> u16 {
        self.confidence_bps
    }

    #[must_use]
    pub const fn intensity(&self) -> u8 {
        self.intensity
    }
}

/// Untrusted provider signal tied to exact transcript and/or audio evidence.
pub struct EmotionObservationInput {
    pub id: EmotionObservationId,
    pub context: EnvelopeContext,
    pub catalog_revision_id: EmotionCatalogRevisionId,
    pub source: EmotionSource,
    pub provider_revision: String,
    pub candidates: Vec<EmotionCandidateInput>,
    pub transcript_segment_ids: Vec<TranscriptSegmentId>,
    pub audio_evidence_window_ids: Vec<AudioEvidenceWindowId>,
    pub turn_index: u32,
    pub observed_at_ms: u64,
}

impl EmotionObservationInput {
    #[must_use]
    pub fn without_audio_evidence(mut self) -> Self {
        self.audio_evidence_window_ids.clear();
        self
    }

    #[must_use]
    pub fn without_transcript_evidence(mut self) -> Self {
        self.transcript_segment_ids.clear();
        self
    }
}

/// Immutable content-hashed emotion signal. Debug output omits labels and customer evidence.
#[derive(Clone, Eq, PartialEq)]
pub struct EmotionObservation {
    id: EmotionObservationId,
    context: EnvelopeContext,
    catalog_revision_id: EmotionCatalogRevisionId,
    source: EmotionSource,
    provider_revision: Box<str>,
    candidates: Box<[EmotionCandidate]>,
    transcript_segment_ids: Box<[TranscriptSegmentId]>,
    audio_evidence_window_ids: Box<[AudioEvidenceWindowId]>,
    turn_index: u32,
    observed_at_ms: u64,
    payload_hash: Box<str>,
}

impl EmotionObservation {
    /// Validates one provider signal against its exact Release-owned catalog and evidence mode.
    ///
    /// # Errors
    ///
    /// Rejects authority drift, malformed candidates, missing source evidence and unbounded input.
    pub fn try_new(
        input: EmotionObservationInput,
        catalog: &EmotionCatalog,
    ) -> Result<Self, UnderstandingError> {
        if input.catalog_revision_id != catalog.id
            || input.context.agent_release_id() != &catalog.agent_release_id
        {
            return Err(UnderstandingError::EmotionCatalogMismatch);
        }
        if input.candidates.len() > MAX_CANDIDATES
            || input.transcript_segment_ids.len() > MAX_EVIDENCE_ITEMS
            || input.audio_evidence_window_ids.len() > MAX_EVIDENCE_ITEMS
            || (input.transcript_segment_ids.is_empty()
                && input.audio_evidence_window_ids.is_empty())
            || input.turn_index == 0
            || input.observed_at_ms == 0
            || !bounded_identifier(&input.provider_revision, MAX_PROVIDER_REVISION_BYTES)
            || !candidate_inputs_valid(&input.candidates, catalog)
            || !unique_ids(&input.transcript_segment_ids, TranscriptSegmentId::as_str)
            || !unique_ids(
                &input.audio_evidence_window_ids,
                AudioEvidenceWindowId::as_str,
            )
        {
            return Err(UnderstandingError::InvalidEmotionObservation);
        }
        if (input.source.requires_audio() && input.audio_evidence_window_ids.is_empty())
            || (input.source.requires_transcript() && input.transcript_segment_ids.is_empty())
        {
            return Err(UnderstandingError::EmotionEvidenceMismatch);
        }
        let candidates: Box<[EmotionCandidate]> = input
            .candidates
            .into_iter()
            .map(|candidate| EmotionCandidate {
                code: candidate.code.into(),
                confidence_bps: candidate.confidence_bps,
                intensity: candidate.intensity,
            })
            .collect();
        let payload_hash = canonical_sha256(&json!({
            "schema_version": input.context.schema_version(),
            "tenant_id": input.context.tenant_id(),
            "interaction_id": input.context.interaction_id().as_str(),
            "campaign_id": input.context.campaign_id().as_str(),
            "campaign_contact_id": input.context.campaign_contact_id().as_str(),
            "call_attempt_id": input.context.call_attempt_id().as_str(),
            "call_id": input.context.call_id().map(converact_voice_agent_contracts::CallId::as_str),
            "agent_release_id": input.context.agent_release_id().as_str(),
            "channel_agent_session_id": input.context.channel_agent_session_id().map(converact_voice_agent_contracts::ChannelAgentSessionId::as_str),
            "execution_generation": input.context.execution_generation().get(),
            "emotion_observation_id": input.id.as_str(),
            "emotion_catalog_revision_id": input.catalog_revision_id.as_str(),
            "source": input.source.as_str(),
            "provider_revision": input.provider_revision,
            "candidates": candidates,
            "transcript_segment_ids": input.transcript_segment_ids.iter().map(TranscriptSegmentId::as_str).collect::<Vec<_>>(),
            "audio_evidence_window_ids": input.audio_evidence_window_ids.iter().map(AudioEvidenceWindowId::as_str).collect::<Vec<_>>(),
            "turn_index": input.turn_index,
            "observed_at_ms": input.observed_at_ms,
        }))
        .map_err(|_| UnderstandingError::EmotionCanonicalPayloadInvalid)?;
        Ok(Self {
            id: input.id,
            context: input.context,
            catalog_revision_id: input.catalog_revision_id,
            source: input.source,
            provider_revision: input.provider_revision.into(),
            candidates,
            transcript_segment_ids: input.transcript_segment_ids.into(),
            audio_evidence_window_ids: input.audio_evidence_window_ids.into(),
            turn_index: input.turn_index,
            observed_at_ms: input.observed_at_ms,
            payload_hash: payload_hash.into(),
        })
    }

    #[must_use]
    pub fn primary(&self) -> Option<&EmotionCandidate> {
        self.candidates.first()
    }

    #[must_use]
    pub const fn id(&self) -> &EmotionObservationId {
        &self.id
    }

    #[must_use]
    pub const fn context(&self) -> &EnvelopeContext {
        &self.context
    }

    #[must_use]
    pub const fn catalog_revision_id(&self) -> &EmotionCatalogRevisionId {
        &self.catalog_revision_id
    }

    #[must_use]
    pub const fn source(&self) -> EmotionSource {
        self.source
    }

    #[must_use]
    pub fn provider_revision(&self) -> &str {
        &self.provider_revision
    }

    #[must_use]
    pub fn transcript_segment_ids(&self) -> &[TranscriptSegmentId] {
        &self.transcript_segment_ids
    }

    #[must_use]
    pub fn audio_evidence_window_ids(&self) -> &[AudioEvidenceWindowId] {
        &self.audio_evidence_window_ids
    }

    #[must_use]
    pub const fn turn_index(&self) -> u32 {
        self.turn_index
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

impl fmt::Debug for EmotionObservation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EmotionObservation")
            .field("id", &self.id)
            .field("catalog_revision_id", &self.catalog_revision_id)
            .field("source", &self.source)
            .field("provider_revision", &self.provider_revision)
            .field("candidate_count", &self.candidates.len())
            .field(
                "transcript_evidence_count",
                &self.transcript_segment_ids.len(),
            )
            .field(
                "audio_evidence_count",
                &self.audio_evidence_window_ids.len(),
            )
            .field("turn_index", &self.turn_index)
            .field("observed_at_ms", &self.observed_at_ms)
            .field("payload_hash", &self.payload_hash)
            .finish_non_exhaustive()
    }
}

/// Untrusted fused result over one or more independently validated signals.
pub struct EmotionFusionInput {
    pub id: EmotionFusionId,
    pub context: EnvelopeContext,
    pub catalog_revision_id: EmotionCatalogRevisionId,
    pub fusion_revision: String,
    pub candidates: Vec<EmotionCandidateInput>,
    pub turn_index: u32,
    pub observed_at_ms: u64,
}

/// Immutable fused emotion evidence. It is an observation, never an action permission.
#[derive(Clone, Eq, PartialEq)]
pub struct EmotionFusion {
    id: EmotionFusionId,
    context: EnvelopeContext,
    catalog_revision_id: EmotionCatalogRevisionId,
    fusion_revision: Box<str>,
    candidates: Box<[EmotionCandidate]>,
    contributor_hashes: Box<[Box<str>]>,
    turn_index: u32,
    observed_at_ms: u64,
    payload_hash: Box<str>,
}

impl EmotionFusion {
    /// Binds a fused result to same-authority, same-turn source observations.
    ///
    /// # Errors
    ///
    /// Rejects unbounded results, mismatched evidence, authority drift and stale fusion time.
    pub fn try_new(
        input: EmotionFusionInput,
        observations: &[EmotionObservation],
        catalog: &EmotionCatalog,
    ) -> Result<Self, UnderstandingError> {
        if input.catalog_revision_id != catalog.id
            || input.context.agent_release_id() != &catalog.agent_release_id
        {
            return Err(UnderstandingError::EmotionCatalogMismatch);
        }
        if observations.is_empty()
            || observations.len() > MAX_CONTRIBUTORS
            || input.candidates.len() > MAX_CANDIDATES
            || input.turn_index == 0
            || input.observed_at_ms == 0
            || !bounded_identifier(&input.fusion_revision, MAX_PROVIDER_REVISION_BYTES)
            || !candidate_inputs_valid(&input.candidates, catalog)
        {
            return Err(UnderstandingError::InvalidEmotionFusion);
        }
        if observations
            .iter()
            .any(|observation| !same_authority(&input.context, &observation.context))
        {
            return Err(UnderstandingError::EmotionAuthorityMismatch);
        }
        if observations.iter().any(|observation| {
            observation.catalog_revision_id != catalog.id
                || observation.turn_index != input.turn_index
                || observation.observed_at_ms > input.observed_at_ms
        }) {
            return Err(UnderstandingError::EmotionEvidenceMismatch);
        }
        let mut contributor_hashes: Vec<Box<str>> = observations
            .iter()
            .map(|observation| Box::<str>::from(observation.payload_hash()))
            .collect();
        contributor_hashes.sort_unstable();
        if contributor_hashes.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(UnderstandingError::EmotionEvidenceMismatch);
        }
        let candidates: Box<[EmotionCandidate]> = input
            .candidates
            .into_iter()
            .map(|candidate| EmotionCandidate {
                code: candidate.code.into(),
                confidence_bps: candidate.confidence_bps,
                intensity: candidate.intensity,
            })
            .collect();
        let payload_hash = canonical_sha256(&json!({
            "schema_version": input.context.schema_version(),
            "tenant_id": input.context.tenant_id(),
            "interaction_id": input.context.interaction_id().as_str(),
            "campaign_id": input.context.campaign_id().as_str(),
            "campaign_contact_id": input.context.campaign_contact_id().as_str(),
            "call_attempt_id": input.context.call_attempt_id().as_str(),
            "call_id": input.context.call_id().map(converact_voice_agent_contracts::CallId::as_str),
            "agent_release_id": input.context.agent_release_id().as_str(),
            "channel_agent_session_id": input.context.channel_agent_session_id().map(converact_voice_agent_contracts::ChannelAgentSessionId::as_str),
            "execution_generation": input.context.execution_generation().get(),
            "emotion_fusion_id": input.id.as_str(),
            "emotion_catalog_revision_id": input.catalog_revision_id.as_str(),
            "fusion_revision": input.fusion_revision,
            "candidates": candidates,
            "contributor_hashes": contributor_hashes,
            "turn_index": input.turn_index,
            "observed_at_ms": input.observed_at_ms,
        }))
        .map_err(|_| UnderstandingError::EmotionCanonicalPayloadInvalid)?;
        Ok(Self {
            id: input.id,
            context: input.context,
            catalog_revision_id: input.catalog_revision_id,
            fusion_revision: input.fusion_revision.into(),
            candidates,
            contributor_hashes: contributor_hashes.into(),
            turn_index: input.turn_index,
            observed_at_ms: input.observed_at_ms,
            payload_hash: payload_hash.into(),
        })
    }

    #[must_use]
    pub fn primary(&self) -> Option<&EmotionCandidate> {
        self.candidates.first()
    }

    #[must_use]
    pub fn contributor_count(&self) -> usize {
        self.contributor_hashes.len()
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }
}

impl fmt::Debug for EmotionFusion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EmotionFusion")
            .field("id", &self.id)
            .field("catalog_revision_id", &self.catalog_revision_id)
            .field("fusion_revision", &self.fusion_revision)
            .field("candidate_count", &self.candidates.len())
            .field("contributor_count", &self.contributor_hashes.len())
            .field("turn_index", &self.turn_index)
            .field("observed_at_ms", &self.observed_at_ms)
            .field("payload_hash", &self.payload_hash)
            .finish_non_exhaustive()
    }
}

/// Release-tuned confidence thresholds in basis points.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EmotionDecisionPolicy {
    provisional_min: u16,
    confirmed_min: u16,
}

impl EmotionDecisionPolicy {
    /// Creates one validated confidence policy.
    ///
    /// # Errors
    ///
    /// Rejects zero, inverted and out-of-range thresholds.
    pub const fn try_new(
        provisional_min_bps: u16,
        confirmed_min_bps: u16,
    ) -> Result<Self, UnderstandingError> {
        if provisional_min_bps == 0
            || provisional_min_bps > confirmed_min_bps
            || confirmed_min_bps > 10_000
        {
            return Err(UnderstandingError::InvalidEmotionPolicy);
        }
        Ok(Self {
            provisional_min: provisional_min_bps,
            confirmed_min: confirmed_min_bps,
        })
    }
}

/// Confidence state of the latest fused observation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EmotionStatus {
    Unknown,
    Provisional,
    Confirmed,
}

/// Trend of confirmed customer distress, not a generic positive/negative business judgment.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomerDistressTrend {
    Unknown,
    Stable,
    Improving,
    Worsening,
}

/// Monotonic per-generation projection over fused emotion evidence.
#[derive(Clone, Eq, PartialEq)]
pub struct EmotionState {
    context: EnvelopeContext,
    catalog_revision_id: EmotionCatalogRevisionId,
    status: EmotionStatus,
    primary_emotion: Option<Box<str>>,
    confirmed_emotion: Option<Box<str>>,
    confirmed_intensity: Option<u8>,
    confirmed_distress_score: Option<u8>,
    distress_trend: CustomerDistressTrend,
    consecutive_distress_turns: u16,
    last_turn_index: u32,
    last_observed_at_ms: u64,
    revision: u64,
    last_fusion_hash: Option<Box<str>>,
}

impl EmotionState {
    #[must_use]
    pub const fn new(
        context: EnvelopeContext,
        catalog_revision_id: EmotionCatalogRevisionId,
    ) -> Self {
        Self {
            context,
            catalog_revision_id,
            status: EmotionStatus::Unknown,
            primary_emotion: None,
            confirmed_emotion: None,
            confirmed_intensity: None,
            confirmed_distress_score: None,
            distress_trend: CustomerDistressTrend::Unknown,
            consecutive_distress_turns: 0,
            last_turn_index: 0,
            last_observed_at_ms: 0,
            revision: 1,
            last_fusion_hash: None,
        }
    }

    /// Applies one newer same-authority fused result. Raw signals cannot mutate this state.
    ///
    /// # Errors
    ///
    /// Rejects catalog/authority drift, stale fusion and revision/counter overflow.
    pub fn observe(
        &self,
        fusion: &EmotionFusion,
        catalog: &EmotionCatalog,
        policy: EmotionDecisionPolicy,
    ) -> Result<Self, UnderstandingError> {
        if self.catalog_revision_id != catalog.id || fusion.catalog_revision_id != catalog.id {
            return Err(UnderstandingError::EmotionCatalogMismatch);
        }
        if catalog.agent_release_id != *self.context.agent_release_id()
            || !same_authority(&self.context, &fusion.context)
        {
            return Err(UnderstandingError::EmotionAuthorityMismatch);
        }
        if fusion.turn_index <= self.last_turn_index
            || fusion.observed_at_ms <= self.last_observed_at_ms
        {
            return Err(UnderstandingError::StaleEmotionFusion);
        }
        let revision = self
            .revision
            .checked_add(1)
            .ok_or(UnderstandingError::EmotionRevisionExhausted)?;
        let primary = fusion.primary();
        let status = match primary.map(EmotionCandidate::confidence_bps) {
            None => EmotionStatus::Unknown,
            Some(confidence) if confidence < policy.provisional_min => EmotionStatus::Unknown,
            Some(confidence) if confidence < policy.confirmed_min => EmotionStatus::Provisional,
            Some(_) => EmotionStatus::Confirmed,
        };
        let primary_emotion = primary.map(|candidate| candidate.code.clone());
        let mut confirmed_emotion = self.confirmed_emotion.clone();
        let mut confirmed_intensity = self.confirmed_intensity;
        let mut confirmed_distress_score = self.confirmed_distress_score;
        let mut distress_trend = self.distress_trend;
        let mut consecutive_distress_turns = self.consecutive_distress_turns;
        if status == EmotionStatus::Confirmed {
            let candidate = primary.ok_or(UnderstandingError::InvalidEmotionFusion)?;
            let definition = catalog
                .definitions
                .get(candidate.code())
                .ok_or(UnderstandingError::InvalidEmotionFusion)?;
            let next_distress_score = if definition.valence == EmotionValence::Negative {
                definition
                    .distress_rank
                    .saturating_mul(MAX_INTENSITY.saturating_add(1))
                    .saturating_add(candidate.intensity)
            } else {
                0
            };
            distress_trend = match confirmed_distress_score {
                None => CustomerDistressTrend::Unknown,
                Some(previous) if next_distress_score > previous => {
                    CustomerDistressTrend::Worsening
                }
                Some(previous) if next_distress_score < previous => {
                    CustomerDistressTrend::Improving
                }
                Some(_) => CustomerDistressTrend::Stable,
            };
            consecutive_distress_turns = if next_distress_score == 0 {
                0
            } else {
                consecutive_distress_turns
                    .checked_add(1)
                    .ok_or(UnderstandingError::EmotionRevisionExhausted)?
            };
            confirmed_emotion = Some(candidate.code.clone());
            confirmed_intensity = Some(candidate.intensity);
            confirmed_distress_score = Some(next_distress_score);
        }
        Ok(Self {
            context: self.context.clone(),
            catalog_revision_id: self.catalog_revision_id.clone(),
            status,
            primary_emotion,
            confirmed_emotion,
            confirmed_intensity,
            confirmed_distress_score,
            distress_trend,
            consecutive_distress_turns,
            last_turn_index: fusion.turn_index,
            last_observed_at_ms: fusion.observed_at_ms,
            revision,
            last_fusion_hash: Some(fusion.payload_hash.clone()),
        })
    }

    #[must_use]
    pub const fn status(&self) -> EmotionStatus {
        self.status
    }

    #[must_use]
    pub fn primary_emotion(&self) -> Option<&str> {
        self.primary_emotion.as_deref()
    }

    #[must_use]
    pub fn confirmed_emotion(&self) -> Option<&str> {
        self.confirmed_emotion.as_deref()
    }

    #[must_use]
    pub const fn confirmed_intensity(&self) -> Option<u8> {
        self.confirmed_intensity
    }

    #[must_use]
    pub const fn distress_trend(&self) -> CustomerDistressTrend {
        self.distress_trend
    }

    #[must_use]
    pub const fn consecutive_distress_turns(&self) -> u16 {
        self.consecutive_distress_turns
    }

    pub(crate) const fn context(&self) -> &EnvelopeContext {
        &self.context
    }

    pub(crate) const fn catalog_revision_id(&self) -> &EmotionCatalogRevisionId {
        &self.catalog_revision_id
    }

    pub(crate) const fn last_turn_index(&self) -> u32 {
        self.last_turn_index
    }

    pub(crate) const fn last_observed_at_ms(&self) -> u64 {
        self.last_observed_at_ms
    }

    pub(crate) fn last_fusion_hash(&self) -> Option<&str> {
        self.last_fusion_hash.as_deref()
    }

    pub(crate) fn canonical_fingerprint(&self) -> Result<Box<str>, UnderstandingError> {
        canonical_sha256(&json!({
            "context": self.context,
            "catalog_revision_id": self.catalog_revision_id,
            "status": self.status,
            "primary_emotion": self.primary_emotion,
            "confirmed_emotion": self.confirmed_emotion,
            "confirmed_intensity": self.confirmed_intensity,
            "confirmed_distress_score": self.confirmed_distress_score,
            "distress_trend": self.distress_trend,
            "consecutive_distress_turns": self.consecutive_distress_turns,
            "last_turn_index": self.last_turn_index,
            "last_observed_at_ms": self.last_observed_at_ms,
            "revision": self.revision,
            "last_fusion_hash": self.last_fusion_hash,
        }))
        .map(Into::into)
        .map_err(|_| UnderstandingError::EmotionCanonicalPayloadInvalid)
    }
}

impl fmt::Debug for EmotionState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EmotionState")
            .field("catalog_revision_id", &self.catalog_revision_id)
            .field("status", &self.status)
            .field("has_primary", &self.primary_emotion.is_some())
            .field("has_confirmed", &self.confirmed_emotion.is_some())
            .field("confirmed_intensity", &self.confirmed_intensity)
            .field("distress_trend", &self.distress_trend)
            .field(
                "consecutive_distress_turns",
                &self.consecutive_distress_turns,
            )
            .field("last_turn_index", &self.last_turn_index)
            .field("revision", &self.revision)
            .field("last_fusion_hash", &self.last_fusion_hash)
            .finish_non_exhaustive()
    }
}

/// Versioned O(1) recovery checkpoint containing fused evidence and its resulting state.
#[derive(Clone, Eq, PartialEq)]
pub struct EmotionCheckpoint {
    fusion: EmotionFusion,
    state: EmotionState,
}

impl EmotionCheckpoint {
    /// Binds one fused result to the exact state projection it produced.
    ///
    /// # Errors
    ///
    /// Rejects context, catalog, turn, clock, primary candidate or evidence-hash drift.
    pub fn try_new(fusion: EmotionFusion, state: EmotionState) -> Result<Self, UnderstandingError> {
        let primary = fusion.primary();
        let confirmed_matches = state.status != EmotionStatus::Confirmed
            || (state.confirmed_emotion.as_deref() == primary.map(EmotionCandidate::code)
                && state.confirmed_intensity == primary.map(EmotionCandidate::intensity));
        if fusion.context != state.context
            || fusion.catalog_revision_id != state.catalog_revision_id
            || fusion.turn_index != state.last_turn_index
            || fusion.observed_at_ms != state.last_observed_at_ms
            || state.last_fusion_hash.as_deref() != Some(fusion.payload_hash())
            || state.primary_emotion.as_deref() != primary.map(EmotionCandidate::code)
            || state.revision < 2
            || !confirmed_matches
        {
            return Err(UnderstandingError::InvalidEmotionCheckpoint);
        }
        Ok(Self { fusion, state })
    }

    /// Restores and revalidates one untrusted versioned checkpoint payload.
    ///
    /// # Errors
    ///
    /// Rejects unknown fields/versions, invalid fusion evidence, catalog drift and inconsistent
    /// state.
    pub fn from_value(
        payload: Value,
        catalog: &EmotionCatalog,
    ) -> Result<Self, UnderstandingError> {
        let wire: EmotionCheckpointWire = serde_json::from_value(payload)
            .map_err(|_| UnderstandingError::InvalidEmotionCheckpoint)?;
        if wire.checkpoint_schema_version != 1 {
            return Err(UnderstandingError::InvalidEmotionCheckpoint);
        }
        let fusion = restore_emotion_fusion(wire.fusion, catalog)?;
        let state = restore_emotion_state(wire.state, catalog)?;
        Self::try_new(fusion, state)
    }

    /// Serializes the validated checkpoint without exposing customer labels through `Debug`.
    #[must_use]
    pub fn to_value(&self) -> Value {
        json!({
            "checkpoint_schema_version": 1,
            "fusion": {
                "id": self.fusion.id,
                "context": self.fusion.context,
                "catalog_revision_id": self.fusion.catalog_revision_id,
                "fusion_revision": self.fusion.fusion_revision,
                "candidates": self.fusion.candidates,
                "contributor_hashes": self.fusion.contributor_hashes,
                "turn_index": self.fusion.turn_index,
                "observed_at_ms": self.fusion.observed_at_ms,
                "payload_hash": self.fusion.payload_hash,
            },
            "state": {
                "context": self.state.context,
                "catalog_revision_id": self.state.catalog_revision_id,
                "status": self.state.status,
                "primary_emotion": self.state.primary_emotion,
                "confirmed_emotion": self.state.confirmed_emotion,
                "confirmed_intensity": self.state.confirmed_intensity,
                "confirmed_distress_score": self.state.confirmed_distress_score,
                "distress_trend": self.state.distress_trend,
                "consecutive_distress_turns": self.state.consecutive_distress_turns,
                "last_turn_index": self.state.last_turn_index,
                "last_observed_at_ms": self.state.last_observed_at_ms,
                "revision": self.state.revision,
                "last_fusion_hash": self.state.last_fusion_hash,
            }
        })
    }

    #[must_use]
    pub const fn fusion(&self) -> &EmotionFusion {
        &self.fusion
    }

    #[must_use]
    pub const fn state(&self) -> &EmotionState {
        &self.state
    }

    #[must_use]
    pub fn record_id(&self) -> &str {
        self.fusion.id.as_str()
    }

    #[must_use]
    pub const fn context(&self) -> &EnvelopeContext {
        &self.fusion.context
    }

    #[must_use]
    pub const fn turn_index(&self) -> u32 {
        self.fusion.turn_index
    }

    #[must_use]
    pub const fn observed_at_ms(&self) -> u64 {
        self.fusion.observed_at_ms
    }
}

impl fmt::Debug for EmotionCheckpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EmotionCheckpoint")
            .field("fusion", &self.fusion)
            .field("state", &self.state)
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmotionCheckpointWire {
    checkpoint_schema_version: u16,
    fusion: EmotionFusionWire,
    state: EmotionStateWire,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmotionFusionWire {
    id: EmotionFusionId,
    context: EnvelopeContext,
    catalog_revision_id: EmotionCatalogRevisionId,
    fusion_revision: String,
    candidates: Vec<EmotionCandidateWire>,
    contributor_hashes: Vec<String>,
    turn_index: u32,
    observed_at_ms: u64,
    payload_hash: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmotionCandidateWire {
    code: String,
    confidence_bps: u16,
    intensity: u8,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmotionStateWire {
    context: EnvelopeContext,
    catalog_revision_id: EmotionCatalogRevisionId,
    status: EmotionStatus,
    primary_emotion: Option<String>,
    confirmed_emotion: Option<String>,
    confirmed_intensity: Option<u8>,
    confirmed_distress_score: Option<u8>,
    distress_trend: CustomerDistressTrend,
    consecutive_distress_turns: u16,
    last_turn_index: u32,
    last_observed_at_ms: u64,
    revision: u64,
    last_fusion_hash: Option<String>,
}

fn restore_emotion_fusion(
    wire: EmotionFusionWire,
    catalog: &EmotionCatalog,
) -> Result<EmotionFusion, UnderstandingError> {
    let candidate_inputs: Vec<EmotionCandidateInput> = wire
        .candidates
        .iter()
        .map(|candidate| EmotionCandidateInput {
            code: candidate.code.clone(),
            confidence_bps: candidate.confidence_bps,
            intensity: candidate.intensity,
        })
        .collect();
    let mut contributor_hashes = wire.contributor_hashes;
    contributor_hashes.sort_unstable();
    if wire.catalog_revision_id != catalog.id
        || wire.context.agent_release_id() != &catalog.agent_release_id
        || wire.candidates.len() > MAX_CANDIDATES
        || contributor_hashes.is_empty()
        || contributor_hashes.len() > MAX_CONTRIBUTORS
        || contributor_hashes.windows(2).any(|pair| pair[0] == pair[1])
        || contributor_hashes
            .iter()
            .any(|hash| !lowercase_sha256(hash))
        || wire.turn_index == 0
        || wire.observed_at_ms == 0
        || !bounded_identifier(&wire.fusion_revision, MAX_PROVIDER_REVISION_BYTES)
        || !candidate_inputs_valid(&candidate_inputs, catalog)
    {
        return Err(UnderstandingError::InvalidEmotionCheckpoint);
    }
    let candidates: Box<[EmotionCandidate]> = candidate_inputs
        .into_iter()
        .map(|candidate| EmotionCandidate {
            code: candidate.code.into(),
            confidence_bps: candidate.confidence_bps,
            intensity: candidate.intensity,
        })
        .collect();
    let contributor_hashes: Box<[Box<str>]> =
        contributor_hashes.into_iter().map(Into::into).collect();
    let payload_hash = canonical_sha256(&json!({
        "schema_version": wire.context.schema_version(),
        "tenant_id": wire.context.tenant_id(),
        "interaction_id": wire.context.interaction_id().as_str(),
        "campaign_id": wire.context.campaign_id().as_str(),
        "campaign_contact_id": wire.context.campaign_contact_id().as_str(),
        "call_attempt_id": wire.context.call_attempt_id().as_str(),
        "call_id": wire.context.call_id().map(converact_voice_agent_contracts::CallId::as_str),
        "agent_release_id": wire.context.agent_release_id().as_str(),
        "channel_agent_session_id": wire.context.channel_agent_session_id().map(converact_voice_agent_contracts::ChannelAgentSessionId::as_str),
        "execution_generation": wire.context.execution_generation().get(),
        "emotion_fusion_id": wire.id.as_str(),
        "emotion_catalog_revision_id": wire.catalog_revision_id.as_str(),
        "fusion_revision": wire.fusion_revision,
        "candidates": candidates,
        "contributor_hashes": contributor_hashes,
        "turn_index": wire.turn_index,
        "observed_at_ms": wire.observed_at_ms,
    }))
    .map_err(|_| UnderstandingError::InvalidEmotionCheckpoint)?;
    if payload_hash != wire.payload_hash {
        return Err(UnderstandingError::InvalidEmotionCheckpoint);
    }
    Ok(EmotionFusion {
        id: wire.id,
        context: wire.context,
        catalog_revision_id: wire.catalog_revision_id,
        fusion_revision: wire.fusion_revision.into(),
        candidates,
        contributor_hashes,
        turn_index: wire.turn_index,
        observed_at_ms: wire.observed_at_ms,
        payload_hash: payload_hash.into(),
    })
}

fn restore_emotion_state(
    wire: EmotionStateWire,
    catalog: &EmotionCatalog,
) -> Result<EmotionState, UnderstandingError> {
    let primary_valid = wire
        .primary_emotion
        .as_deref()
        .is_none_or(|emotion| catalog.contains(emotion));
    let confirmed_valid = wire
        .confirmed_emotion
        .as_deref()
        .is_none_or(|emotion| catalog.contains(emotion));
    let confirmed_shape_valid = match (
        wire.confirmed_emotion.as_deref(),
        wire.confirmed_intensity,
        wire.confirmed_distress_score,
    ) {
        (None, None, None) => wire.consecutive_distress_turns == 0,
        (Some(emotion), Some(intensity), Some(score)) if intensity <= MAX_INTENSITY => {
            let Some(definition) = catalog.definitions.get(emotion) else {
                return Err(UnderstandingError::InvalidEmotionCheckpoint);
            };
            let expected = if definition.valence == EmotionValence::Negative {
                definition
                    .distress_rank
                    .saturating_mul(MAX_INTENSITY.saturating_add(1))
                    .saturating_add(intensity)
            } else {
                0
            };
            score == expected && (expected != 0 || wire.consecutive_distress_turns == 0)
        }
        _ => false,
    };
    let status_valid = match wire.status {
        EmotionStatus::Unknown => true,
        EmotionStatus::Provisional => wire.primary_emotion.is_some(),
        EmotionStatus::Confirmed => {
            wire.primary_emotion.is_some()
                && wire.primary_emotion == wire.confirmed_emotion
                && wire.confirmed_intensity.is_some()
        }
    };
    let Some(last_fusion_hash) = wire.last_fusion_hash else {
        return Err(UnderstandingError::InvalidEmotionCheckpoint);
    };
    if wire.catalog_revision_id != catalog.id
        || wire.context.agent_release_id() != &catalog.agent_release_id
        || wire.last_turn_index == 0
        || wire.last_observed_at_ms == 0
        || wire.revision < 2
        || !lowercase_sha256(&last_fusion_hash)
        || !primary_valid
        || !confirmed_valid
        || !confirmed_shape_valid
        || !status_valid
    {
        return Err(UnderstandingError::InvalidEmotionCheckpoint);
    }
    Ok(EmotionState {
        context: wire.context,
        catalog_revision_id: wire.catalog_revision_id,
        status: wire.status,
        primary_emotion: wire.primary_emotion.map(Into::into),
        confirmed_emotion: wire.confirmed_emotion.map(Into::into),
        confirmed_intensity: wire.confirmed_intensity,
        confirmed_distress_score: wire.confirmed_distress_score,
        distress_trend: wire.distress_trend,
        consecutive_distress_turns: wire.consecutive_distress_turns,
        last_turn_index: wire.last_turn_index,
        last_observed_at_ms: wire.last_observed_at_ms,
        revision: wire.revision,
        last_fusion_hash: Some(last_fusion_hash.into()),
    })
}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value.as_bytes().iter().all(u8::is_ascii_hexdigit)
        && !value.as_bytes().iter().any(u8::is_ascii_uppercase)
}

fn candidate_inputs_valid(inputs: &[EmotionCandidateInput], catalog: &EmotionCatalog) -> bool {
    let mut previous_score = u16::MAX;
    let mut seen = std::collections::HashSet::with_capacity(inputs.len());
    inputs.iter().all(|candidate| {
        let valid = candidate.confidence_bps <= 10_000
            && candidate.confidence_bps <= previous_score
            && candidate.intensity <= MAX_INTENSITY
            && catalog.contains(&candidate.code)
            && seen.insert(candidate.code.as_str());
        previous_score = candidate.confidence_bps;
        valid
    })
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

fn unique_ids<T, F>(values: &[T], value: F) -> bool
where
    F: Fn(&T) -> &str,
{
    let mut seen = std::collections::HashSet::with_capacity(values.len());
    values.iter().all(|item| seen.insert(value(item)))
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
