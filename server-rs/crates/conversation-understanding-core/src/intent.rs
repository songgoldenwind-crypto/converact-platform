use std::{collections::BTreeMap, fmt};

use converact_contracts::canonical_sha256;
use converact_voice_agent_contracts::{
    AgentReleaseId, EnvelopeContext, IntentCatalogRevisionId, IntentObservationId,
    TranscriptSegmentId,
};
use serde::Serialize;
use serde_json::json;

use crate::UnderstandingError;

const MAX_DEFINITIONS: usize = 128;
const MAX_CODE_BYTES: usize = 100;
const MAX_SLOTS_PER_INTENT: usize = 32;
const MAX_SLOT_VALUE_BYTES: usize = 512;
const MAX_CANDIDATES: usize = 5;
const MAX_EVIDENCE_SEGMENTS: usize = 32;
const MAX_PROVIDER_REVISION_BYTES: usize = 255;

/// One untrusted hierarchical Intent definition inside a Release-bound catalog.
pub struct IntentDefinitionInput {
    pub code: String,
    pub parent_code: Option<String>,
    pub slot_keys: Vec<String>,
    pub safety_critical: bool,
}

/// Untrusted immutable catalog revision.
pub struct IntentCatalogInput {
    pub id: IntentCatalogRevisionId,
    pub agent_release_id: AgentReleaseId,
    pub definitions: Vec<IntentDefinitionInput>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct IntentDefinition {
    parent_code: Option<Box<str>>,
    slot_keys: Box<[Box<str>]>,
    safety_critical: bool,
}

/// Immutable hierarchical Intent and Slot vocabulary for one exact Agent Release.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IntentCatalog {
    id: IntentCatalogRevisionId,
    agent_release_id: AgentReleaseId,
    definitions: BTreeMap<Box<str>, IntentDefinition>,
}

impl IntentCatalog {
    /// Validates parent references, cycles, bounded codes and per-Intent Slot allow-lists.
    ///
    /// # Errors
    ///
    /// Rejects empty, duplicate, cyclic or unbounded catalogs.
    pub fn try_new(input: IntentCatalogInput) -> Result<Self, UnderstandingError> {
        if input.definitions.is_empty() || input.definitions.len() > MAX_DEFINITIONS {
            return Err(UnderstandingError::InvalidIntentCatalog);
        }
        let mut definitions = BTreeMap::new();
        for definition in input.definitions {
            if !bounded_identifier(&definition.code, MAX_CODE_BYTES)
                || definition
                    .parent_code
                    .as_deref()
                    .is_some_and(|parent| !bounded_identifier(parent, MAX_CODE_BYTES))
                || !bounded_unique(&definition.slot_keys, MAX_SLOTS_PER_INTENT, MAX_CODE_BYTES)
            {
                return Err(UnderstandingError::InvalidIntentCatalog);
            }
            let value = IntentDefinition {
                parent_code: definition.parent_code.map(Into::into),
                slot_keys: definition.slot_keys.into_iter().map(Into::into).collect(),
                safety_critical: definition.safety_critical,
            };
            if definitions.insert(definition.code.into(), value).is_some() {
                return Err(UnderstandingError::InvalidIntentCatalog);
            }
        }
        if definitions.values().any(|definition| {
            definition
                .parent_code
                .as_ref()
                .is_some_and(|parent| !definitions.contains_key(parent))
        }) || has_parent_cycle(&definitions)
        {
            return Err(UnderstandingError::InvalidIntentCatalog);
        }
        Ok(Self {
            id: input.id,
            agent_release_id: input.agent_release_id,
            definitions,
        })
    }

    #[must_use]
    pub const fn id(&self) -> &IntentCatalogRevisionId {
        &self.id
    }

    #[must_use]
    pub const fn agent_release_id(&self) -> &AgentReleaseId {
        &self.agent_release_id
    }

    #[must_use]
    pub fn is_safety_critical(&self, intent: &str) -> bool {
        self.definitions
            .get(intent)
            .is_some_and(|definition| definition.safety_critical)
    }

    #[must_use]
    pub fn slot_allowed(&self, intent: &str, slot: &str) -> bool {
        self.definitions.get(intent).is_some_and(|definition| {
            definition
                .slot_keys
                .iter()
                .any(|candidate| candidate.as_ref() == slot)
        })
    }

    fn contains(&self, intent: &str) -> bool {
        self.definitions.contains_key(intent)
    }
}

/// Provider class that produced one independently traceable Intent observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentSource {
    SafetyRule,
    FastClassifier,
    ContextualLlm,
    ActiveCallPlaybook,
    HumanCorrection,
}

impl IntentSource {
    const fn as_str(self) -> &'static str {
        match self {
            Self::SafetyRule => "safety_rule",
            Self::FastClassifier => "fast_classifier",
            Self::ContextualLlm => "contextual_llm",
            Self::ActiveCallPlaybook => "active_call_playbook",
            Self::HumanCorrection => "human_correction",
        }
    }
}

/// Untrusted candidate and calibrated confidence in basis points.
pub struct IntentCandidateInput {
    pub code: String,
    pub confidence_bps: u16,
}

/// One catalog-validated Intent hypothesis. Debug output is owned by its redacted container.
#[derive(Clone, Eq, PartialEq, Serialize)]
pub struct IntentCandidate {
    code: Box<str>,
    confidence_bps: u16,
}

impl IntentCandidate {
    #[must_use]
    pub fn code(&self) -> &str {
        &self.code
    }

    #[must_use]
    pub const fn confidence_bps(&self) -> u16 {
        self.confidence_bps
    }
}

/// Untrusted provider observation tied to one conversation turn and transcript evidence.
pub struct IntentObservationInput {
    pub id: IntentObservationId,
    pub context: EnvelopeContext,
    pub catalog_revision_id: IntentCatalogRevisionId,
    pub source: IntentSource,
    pub provider_revision: String,
    pub candidates: Vec<IntentCandidateInput>,
    pub slots: BTreeMap<String, String>,
    pub evidence_segment_ids: Vec<TranscriptSegmentId>,
    pub turn_index: u32,
    pub observed_at_ms: u64,
}

/// Immutable, content-hashed observation. Debug output omits candidates and Slot values.
#[derive(Clone, Eq, PartialEq)]
pub struct IntentObservation {
    id: IntentObservationId,
    context: EnvelopeContext,
    catalog_revision_id: IntentCatalogRevisionId,
    source: IntentSource,
    provider_revision: Box<str>,
    candidates: Box<[IntentCandidate]>,
    slots: BTreeMap<Box<str>, Box<str>>,
    evidence_segment_ids: Box<[TranscriptSegmentId]>,
    turn_index: u32,
    observed_at_ms: u64,
    payload_hash: Box<str>,
}

impl IntentObservation {
    /// Validates one provider result against the exact immutable Intent catalog.
    ///
    /// # Errors
    ///
    /// Rejects cross-Release catalogs, uncalibrated/unsorted candidates, forbidden Slots,
    /// unbounded provider metadata or missing turn evidence.
    pub fn try_new(
        input: IntentObservationInput,
        catalog: &IntentCatalog,
    ) -> Result<Self, UnderstandingError> {
        if input.catalog_revision_id != catalog.id
            || input.context.agent_release_id() != &catalog.agent_release_id
        {
            return Err(UnderstandingError::IntentCatalogMismatch);
        }
        if input.candidates.len() > MAX_CANDIDATES
            || input.slots.len() > MAX_SLOTS_PER_INTENT
            || input.evidence_segment_ids.is_empty()
            || input.evidence_segment_ids.len() > MAX_EVIDENCE_SEGMENTS
            || input.turn_index == 0
            || input.observed_at_ms == 0
            || !bounded_identifier(&input.provider_revision, MAX_PROVIDER_REVISION_BYTES)
            || !candidate_inputs_valid(&input.candidates, catalog)
            || !unique_segments(&input.evidence_segment_ids)
        {
            return Err(UnderstandingError::InvalidIntentObservation);
        }
        if input.candidates.is_empty() && !input.slots.is_empty() {
            return Err(UnderstandingError::IntentSlotNotAllowed);
        }
        if let Some(primary) = input.candidates.first()
            && input.slots.iter().any(|(key, value)| {
                !bounded_identifier(key, MAX_CODE_BYTES)
                    || !bounded_text(value, MAX_SLOT_VALUE_BYTES)
                    || !catalog.slot_allowed(&primary.code, key)
            })
        {
            return Err(UnderstandingError::IntentSlotNotAllowed);
        }
        let candidates: Box<[IntentCandidate]> = input
            .candidates
            .into_iter()
            .map(|candidate| IntentCandidate {
                code: candidate.code.into(),
                confidence_bps: candidate.confidence_bps,
            })
            .collect();
        let slots: BTreeMap<Box<str>, Box<str>> = input
            .slots
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect();
        let payload_hash = canonical_sha256(&json!({
            "tenant_id": input.context.tenant_id(),
            "interaction_id": input.context.interaction_id().as_str(),
            "call_attempt_id": input.context.call_attempt_id().as_str(),
            "call_id": input.context.call_id().map(converact_voice_agent_contracts::CallId::as_str),
            "agent_release_id": input.context.agent_release_id().as_str(),
            "channel_agent_session_id": input.context.channel_agent_session_id().map(converact_voice_agent_contracts::ChannelAgentSessionId::as_str),
            "execution_generation": input.context.execution_generation().get(),
            "intent_observation_id": input.id.as_str(),
            "intent_catalog_revision_id": input.catalog_revision_id.as_str(),
            "source": input.source.as_str(),
            "provider_revision": input.provider_revision,
            "candidates": candidates,
            "slots": slots,
            "evidence_segment_ids": input.evidence_segment_ids.iter().map(TranscriptSegmentId::as_str).collect::<Vec<_>>(),
            "turn_index": input.turn_index,
            "observed_at_ms": input.observed_at_ms,
        }))
        .map_err(|_| UnderstandingError::CanonicalPayloadInvalid)?;
        Ok(Self {
            id: input.id,
            context: input.context,
            catalog_revision_id: input.catalog_revision_id,
            source: input.source,
            provider_revision: input.provider_revision.into(),
            candidates,
            slots,
            evidence_segment_ids: input.evidence_segment_ids.into(),
            turn_index: input.turn_index,
            observed_at_ms: input.observed_at_ms,
            payload_hash: payload_hash.into(),
        })
    }

    #[must_use]
    pub fn primary(&self) -> Option<&IntentCandidate> {
        self.candidates.first()
    }

    #[must_use]
    pub const fn turn_index(&self) -> u32 {
        self.turn_index
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }
}

impl fmt::Debug for IntentObservation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IntentObservation")
            .field("id", &self.id)
            .field("catalog_revision_id", &self.catalog_revision_id)
            .field("source", &self.source)
            .field("provider_revision", &self.provider_revision)
            .field("candidate_count", &self.candidates.len())
            .field("slot_count", &self.slots.len())
            .field("evidence_count", &self.evidence_segment_ids.len())
            .field("turn_index", &self.turn_index)
            .field("observed_at_ms", &self.observed_at_ms)
            .field("payload_hash", &self.payload_hash)
            .finish_non_exhaustive()
    }
}

/// Release-tuned confidence thresholds. Values are basis points, not floating point.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct IntentDecisionPolicy {
    provisional_min: u16,
    confirmed_min: u16,
    minimum_margin: u16,
    safety_rule_confirm_min: u16,
}

impl IntentDecisionPolicy {
    /// Creates one calibrated routing policy without embedding global thresholds in the engine.
    ///
    /// # Errors
    ///
    /// Rejects zero, inverted or out-of-range thresholds.
    pub const fn try_new(
        provisional_min_bps: u16,
        confirmed_min_bps: u16,
        minimum_margin_bps: u16,
        safety_rule_confirm_min_bps: u16,
    ) -> Result<Self, UnderstandingError> {
        if provisional_min_bps == 0
            || provisional_min_bps > confirmed_min_bps
            || confirmed_min_bps > 10_000
            || minimum_margin_bps > 10_000
            || safety_rule_confirm_min_bps < confirmed_min_bps
            || safety_rule_confirm_min_bps > 10_000
        {
            return Err(UnderstandingError::InvalidIntentPolicy);
        }
        Ok(Self {
            provisional_min: provisional_min_bps,
            confirmed_min: confirmed_min_bps,
            minimum_margin: minimum_margin_bps,
            safety_rule_confirm_min: safety_rule_confirm_min_bps,
        })
    }
}

/// Realtime interpretation status. It is evidence, never an action authorization.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentStatus {
    Unknown,
    Provisional,
    ClarificationRequired,
    Confirmed,
    Changed,
}

/// Monotonic per-generation Intent projection over independently durable observations.
#[derive(Clone, Eq, PartialEq)]
pub struct IntentState {
    context: EnvelopeContext,
    catalog_revision_id: IntentCatalogRevisionId,
    status: IntentStatus,
    primary_intent: Option<Box<str>>,
    confirmed_intent: Option<Box<str>>,
    previous_confirmed_intent: Option<Box<str>>,
    last_turn_index: u32,
    last_observed_at_ms: u64,
    revision: u64,
    last_observation_hash: Option<Box<str>>,
}

impl IntentState {
    #[must_use]
    pub const fn new(
        context: EnvelopeContext,
        catalog_revision_id: IntentCatalogRevisionId,
    ) -> Self {
        Self {
            context,
            catalog_revision_id,
            status: IntentStatus::Unknown,
            primary_intent: None,
            confirmed_intent: None,
            previous_confirmed_intent: None,
            last_turn_index: 0,
            last_observed_at_ms: 0,
            revision: 1,
            last_observation_hash: None,
        }
    }

    /// Applies one newer same-authority observation through the release-tuned confidence policy.
    ///
    /// # Errors
    ///
    /// Rejects catalog/authority drift, stale turns and revision overflow.
    pub fn observe(
        &self,
        observation: &IntentObservation,
        catalog: &IntentCatalog,
        policy: IntentDecisionPolicy,
    ) -> Result<Self, UnderstandingError> {
        if self.catalog_revision_id != catalog.id || observation.catalog_revision_id != catalog.id {
            return Err(UnderstandingError::IntentCatalogMismatch);
        }
        if catalog.agent_release_id != *self.context.agent_release_id()
            || !same_authority(&self.context, &observation.context)
        {
            return Err(UnderstandingError::IntentAuthorityMismatch);
        }
        if observation.turn_index <= self.last_turn_index
            || observation.observed_at_ms <= self.last_observed_at_ms
        {
            return Err(UnderstandingError::StaleIntentObservation);
        }
        let revision = self
            .revision
            .checked_add(1)
            .ok_or(UnderstandingError::IntentRevisionExhausted)?;
        let primary = observation.primary();
        let status = classify(primary, observation, catalog, policy);
        let primary_intent = primary.map(|candidate| candidate.code.clone());
        let mut confirmed_intent = self.confirmed_intent.clone();
        let mut previous_confirmed_intent = None;
        let status = if matches!(status, IntentStatus::Confirmed) {
            match (&self.confirmed_intent, &primary_intent) {
                (Some(previous), Some(current)) if previous != current => {
                    previous_confirmed_intent = Some(previous.clone());
                    confirmed_intent = Some(current.clone());
                    IntentStatus::Changed
                }
                (_, Some(current)) => {
                    confirmed_intent = Some(current.clone());
                    IntentStatus::Confirmed
                }
                _ => IntentStatus::Unknown,
            }
        } else {
            status
        };
        Ok(Self {
            context: self.context.clone(),
            catalog_revision_id: self.catalog_revision_id.clone(),
            status,
            primary_intent,
            confirmed_intent,
            previous_confirmed_intent,
            last_turn_index: observation.turn_index,
            last_observed_at_ms: observation.observed_at_ms,
            revision,
            last_observation_hash: Some(observation.payload_hash.clone()),
        })
    }

    #[must_use]
    pub const fn status(&self) -> IntentStatus {
        self.status
    }

    #[must_use]
    pub fn primary_intent(&self) -> Option<&str> {
        self.primary_intent.as_deref()
    }

    #[must_use]
    pub fn previous_confirmed_intent(&self) -> Option<&str> {
        self.previous_confirmed_intent.as_deref()
    }
}

impl fmt::Debug for IntentState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IntentState")
            .field("catalog_revision_id", &self.catalog_revision_id)
            .field("status", &self.status)
            .field("has_primary", &self.primary_intent.is_some())
            .field("has_confirmed", &self.confirmed_intent.is_some())
            .field(
                "has_previous_confirmed",
                &self.previous_confirmed_intent.is_some(),
            )
            .field("last_turn_index", &self.last_turn_index)
            .field("revision", &self.revision)
            .field("last_observation_hash", &self.last_observation_hash)
            .finish_non_exhaustive()
    }
}

fn classify(
    primary: Option<&IntentCandidate>,
    observation: &IntentObservation,
    catalog: &IntentCatalog,
    policy: IntentDecisionPolicy,
) -> IntentStatus {
    let Some(primary) = primary else {
        return IntentStatus::Unknown;
    };
    if observation.source == IntentSource::SafetyRule
        && catalog.is_safety_critical(primary.code())
        && primary.confidence_bps >= policy.safety_rule_confirm_min
    {
        return IntentStatus::Confirmed;
    }
    if primary.confidence_bps < policy.provisional_min {
        return IntentStatus::ClarificationRequired;
    }
    if primary.confidence_bps < policy.confirmed_min {
        return IntentStatus::Provisional;
    }
    let second = observation
        .candidates
        .get(1)
        .map_or(0, |candidate| candidate.confidence_bps);
    if primary.confidence_bps.saturating_sub(second) < policy.minimum_margin {
        IntentStatus::ClarificationRequired
    } else {
        IntentStatus::Confirmed
    }
}

fn candidate_inputs_valid(inputs: &[IntentCandidateInput], catalog: &IntentCatalog) -> bool {
    let mut previous_score = u16::MAX;
    let mut seen = std::collections::HashSet::with_capacity(inputs.len());
    inputs.iter().all(|candidate| {
        let valid = candidate.confidence_bps <= 10_000
            && candidate.confidence_bps <= previous_score
            && catalog.contains(&candidate.code)
            && seen.insert(candidate.code.as_str());
        previous_score = candidate.confidence_bps;
        valid
    })
}

fn same_authority(left: &EnvelopeContext, right: &EnvelopeContext) -> bool {
    left.tenant_id() == right.tenant_id()
        && left.interaction_id() == right.interaction_id()
        && left.call_attempt_id() == right.call_attempt_id()
        && left.call_id() == right.call_id()
        && left.agent_release_id() == right.agent_release_id()
        && left.channel_agent_session_id() == right.channel_agent_session_id()
        && left.execution_generation() == right.execution_generation()
}

fn has_parent_cycle(definitions: &BTreeMap<Box<str>, IntentDefinition>) -> bool {
    definitions.keys().any(|start| {
        let mut current = Some(start.as_ref());
        for _ in 0..=definitions.len() {
            let Some(code) = current else {
                return false;
            };
            current = definitions
                .get(code)
                .and_then(|definition| definition.parent_code.as_deref());
        }
        true
    })
}

fn unique_segments(values: &[TranscriptSegmentId]) -> bool {
    let mut seen = std::collections::HashSet::with_capacity(values.len());
    values.iter().all(|value| seen.insert(value.as_str()))
}

fn bounded_unique(values: &[String], maximum_items: usize, maximum_bytes: usize) -> bool {
    if values.len() > maximum_items {
        return false;
    }
    let mut seen = std::collections::HashSet::with_capacity(values.len());
    values
        .iter()
        .all(|value| bounded_identifier(value, maximum_bytes) && seen.insert(value.as_str()))
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

fn bounded_text(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}
