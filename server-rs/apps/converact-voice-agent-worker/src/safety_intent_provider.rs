use std::{collections::BTreeMap, error::Error, fmt};

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

const MAX_RULES: usize = 64;
const MAX_PHRASES_PER_RULE: usize = 16;
const MAX_TOTAL_PHRASES: usize = 128;
const MAX_RULE_ID_BYTES: usize = 100;
const MAX_PHRASE_BYTES: usize = 256;
const PROVIDER_DOMAIN: &str = "converact_safety_intent_rules_v1";
const OBSERVATION_DOMAIN: &str = "converact_safety_intent_observation_v1";

/// Closed deterministic matching modes selected by one immutable Agent Release.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SafetyIntentMatchKind {
    Exact,
    Phrase,
}

impl SafetyIntentMatchKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::Phrase => "phrase",
        }
    }
}

/// One untrusted release-authored safety rule.
pub struct SafetyIntentRuleInput {
    pub rule_id: String,
    pub intent_code: String,
    pub priority: u16,
    pub confidence_bps: u16,
    pub match_kind: SafetyIntentMatchKind,
    pub phrases: Vec<String>,
}

/// Untrusted immutable safety-rule set bound to one Intent Catalog revision.
pub struct SafetyIntentRuleSetInput {
    pub agent_release_id: AgentReleaseId,
    pub intent_catalog_revision_id: IntentCatalogRevisionId,
    pub rules: Vec<SafetyIntentRuleInput>,
}

#[derive(Clone, Eq, PartialEq)]
struct SafetyIntentRule {
    rule_id: Box<str>,
    intent_code: Box<str>,
    priority: u16,
    confidence_bps: u16,
    match_kind: SafetyIntentMatchKind,
    phrases: Box<[Box<str>]>,
}

/// Stable fail-closed Provider error without transcript or configured phrase content.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SafetyIntentProviderError {
    CatalogMismatch,
    RuleSetInvalid,
    ObservationInvalid,
    StateTransitionInvalid,
}

impl SafetyIntentProviderError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::CatalogMismatch => "safety_intent_catalog_mismatch",
            Self::RuleSetInvalid => "safety_intent_rule_set_invalid",
            Self::ObservationInvalid => "safety_intent_observation_invalid",
            Self::StateTransitionInvalid => "safety_intent_state_transition_invalid",
        }
    }
}

impl fmt::Display for SafetyIntentProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for SafetyIntentProviderError {}

/// Bounded deterministic Layer-0 Provider. It produces evidence and owns no business action port.
#[derive(Clone)]
pub struct SafetyIntentProvider {
    catalog: IntentCatalog,
    rules: Box<[SafetyIntentRule]>,
    provider_revision: Box<str>,
}

impl SafetyIntentProvider {
    /// Validates and content-binds one release-authored rule set to the exact Intent Catalog.
    ///
    /// # Errors
    ///
    /// Rejects cross-Release/catalog input, non-safety targets, ambiguous priorities or phrases,
    /// and unbounded metadata.
    pub fn try_new(
        input: SafetyIntentRuleSetInput,
        catalog: &IntentCatalog,
    ) -> Result<Self, SafetyIntentProviderError> {
        if input.agent_release_id != *catalog.agent_release_id()
            || input.intent_catalog_revision_id != *catalog.id()
        {
            return Err(SafetyIntentProviderError::CatalogMismatch);
        }
        if input.rules.is_empty() || input.rules.len() > MAX_RULES {
            return Err(SafetyIntentProviderError::RuleSetInvalid);
        }

        let mut rules = Vec::with_capacity(input.rules.len());
        let mut rule_ids = std::collections::HashSet::with_capacity(input.rules.len());
        let mut priorities = std::collections::HashSet::with_capacity(input.rules.len());
        let mut phrases = std::collections::HashSet::new();
        let mut total_phrases = 0_usize;
        for input_rule in input.rules {
            if !bounded_identifier(&input_rule.rule_id, MAX_RULE_ID_BYTES)
                || !catalog.is_safety_critical(&input_rule.intent_code)
                || input_rule.priority == 0
                || input_rule.confidence_bps == 0
                || input_rule.confidence_bps > 10_000
                || input_rule.phrases.is_empty()
                || input_rule.phrases.len() > MAX_PHRASES_PER_RULE
                || !rule_ids.insert(input_rule.rule_id.clone())
                || !priorities.insert(input_rule.priority)
            {
                return Err(SafetyIntentProviderError::RuleSetInvalid);
            }
            total_phrases = total_phrases
                .checked_add(input_rule.phrases.len())
                .ok_or(SafetyIntentProviderError::RuleSetInvalid)?;
            if total_phrases > MAX_TOTAL_PHRASES {
                return Err(SafetyIntentProviderError::RuleSetInvalid);
            }
            let mut normalized_phrases = input_rule
                .phrases
                .into_iter()
                .map(|phrase| {
                    if phrase.len() > MAX_PHRASE_BYTES || phrase.chars().any(char::is_control) {
                        return Err(SafetyIntentProviderError::RuleSetInvalid);
                    }
                    let phrase = normalize_text(&phrase);
                    if phrase.is_empty()
                        || phrase.len() > MAX_PHRASE_BYTES
                        || !phrases.insert(phrase.clone())
                    {
                        return Err(SafetyIntentProviderError::RuleSetInvalid);
                    }
                    Ok(phrase.into_boxed_str())
                })
                .collect::<Result<Vec<_>, _>>()?;
            normalized_phrases.sort_unstable();
            rules.push(SafetyIntentRule {
                rule_id: input_rule.rule_id.into(),
                intent_code: input_rule.intent_code.into(),
                priority: input_rule.priority,
                confidence_bps: input_rule.confidence_bps,
                match_kind: input_rule.match_kind,
                phrases: normalized_phrases.into_boxed_slice(),
            });
        }
        rules.sort_unstable_by_key(|rule| rule.priority);
        let digest = canonical_sha256(&json!({
            "domain": PROVIDER_DOMAIN,
            "agent_release_id": input.agent_release_id.as_str(),
            "intent_catalog_revision_id": input.intent_catalog_revision_id.as_str(),
            "rules": rules.iter().map(|rule| json!({
                "rule_id": rule.rule_id,
                "intent_code": rule.intent_code,
                "priority": rule.priority,
                "confidence_bps": rule.confidence_bps,
                "match_kind": rule.match_kind.as_str(),
                "phrases": rule.phrases,
            })).collect::<Vec<_>>(),
        }))
        .map_err(|_| SafetyIntentProviderError::RuleSetInvalid)?;
        Ok(Self {
            catalog: catalog.clone(),
            rules: rules.into_boxed_slice(),
            provider_revision: format!("safety-rules.{digest}").into(),
        })
    }

    /// Classifies one already-validated final customer transcript segment.
    ///
    /// A match returns only release-bound evidence. This type has no Tool, DNC, Handoff,
    /// Telephony or media authority and therefore cannot execute the inferred intent.
    ///
    /// # Errors
    ///
    /// Rejects cross-Release input, zero turns or evidence that fails the shared Intent Core.
    pub fn observe(
        &self,
        segment: &TranscriptSegment,
        turn_index: u32,
    ) -> Result<Option<IntentObservation>, SafetyIntentProviderError> {
        if segment.context().agent_release_id() != self.catalog.agent_release_id() {
            return Err(SafetyIntentProviderError::CatalogMismatch);
        }
        if segment.speaker() != TranscriptSpeaker::Customer {
            return Ok(None);
        }
        let normalized = normalize_text(segment.text());
        let Some(rule) = self.rules.iter().find(|rule| {
            rule.phrases
                .iter()
                .any(|phrase| matches_phrase(&normalized, phrase, rule.match_kind))
        }) else {
            return Ok(None);
        };
        let observation_digest = canonical_sha256(&json!({
            "domain": OBSERVATION_DOMAIN,
            "provider_revision": self.provider_revision,
            "segment_payload_hash": segment.payload_hash(),
            "turn_index": turn_index,
        }))
        .map_err(|_| SafetyIntentProviderError::ObservationInvalid)?;
        let id =
            IntentObservationId::parse(format!("intent-observation.safety.{observation_digest}"))
                .map_err(|_| SafetyIntentProviderError::ObservationInvalid)?;
        IntentObservation::try_new(
            IntentObservationInput {
                id,
                context: segment.context().clone(),
                catalog_revision_id: self.catalog.id().clone(),
                source: IntentSource::SafetyRule,
                provider_revision: self.provider_revision.to_string(),
                candidates: vec![IntentCandidateInput {
                    code: rule.intent_code.to_string(),
                    confidence_bps: rule.confidence_bps,
                }],
                slots: BTreeMap::new(),
                evidence_segment_ids: vec![segment.id().clone()],
                turn_index,
                observed_at_ms: segment.observed_at_ms(),
            },
            &self.catalog,
        )
        .map(Some)
        .map_err(|_| SafetyIntentProviderError::ObservationInvalid)
    }

    /// Applies a matching observation to one exact previous Intent state and closes a checkpoint.
    ///
    /// # Errors
    ///
    /// Rejects mismatched/stale state or a checkpoint that cannot be reconstructed exactly.
    pub fn advance(
        &self,
        segment: &TranscriptSegment,
        turn_index: u32,
        previous: &IntentState,
        policy: IntentDecisionPolicy,
    ) -> Result<Option<IntentCheckpoint>, SafetyIntentProviderError> {
        let Some(observation) = self.observe(segment, turn_index)? else {
            return Ok(None);
        };
        let state = previous
            .observe(&observation, &self.catalog, policy)
            .map_err(|_| SafetyIntentProviderError::StateTransitionInvalid)?;
        IntentCheckpoint::try_new(observation, state)
            .map(Some)
            .map_err(|_| SafetyIntentProviderError::StateTransitionInvalid)
    }

    #[must_use]
    pub fn provider_revision(&self) -> &str {
        &self.provider_revision
    }
}

impl fmt::Debug for SafetyIntentProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SafetyIntentProvider")
            .field("catalog_revision_id", self.catalog.id())
            .field("rule_count", &self.rules.len())
            .field("provider_revision", &self.provider_revision)
            .finish_non_exhaustive()
    }
}

fn normalize_text(input: &str) -> String {
    let mut normalized = String::with_capacity(input.len());
    let mut pending_space = false;
    for character in input.trim().chars() {
        if character.is_whitespace() {
            pending_space = !normalized.is_empty();
            continue;
        }
        if pending_space {
            normalized.push(' ');
            pending_space = false;
        }
        normalized.extend(character.to_lowercase());
    }
    normalized
}

fn matches_phrase(text: &str, phrase: &str, kind: SafetyIntentMatchKind) -> bool {
    if kind == SafetyIntentMatchKind::Exact {
        return text == phrase;
    }
    if !phrase.is_ascii()
        || !phrase
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !phrase
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
    {
        return text.contains(phrase);
    }
    text.match_indices(phrase).any(|(start, _)| {
        let before = text[..start].chars().next_back();
        let after = text[start + phrase.len()..].chars().next();
        before.is_none_or(|character| !character.is_alphanumeric())
            && after.is_none_or(|character| !character.is_alphanumeric())
    })
}

fn bounded_identifier(value: &str, max_bytes: usize) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= max_bytes
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
