use std::fmt;

use converact_contracts::canonical_sha256;
use converact_voice_agent_contracts::{
    AgentReleaseId, CustomerStateSnapshotId, DialoguePolicyRevisionId, DialogueRecommendationId,
    EmotionCatalogRevisionId, EnvelopeContext, IntentCatalogRevisionId,
};
use serde::Serialize;
use serde_json::json;

use crate::{
    CustomerDistressTrend, EmotionState, EmotionStatus, IntentState, IntentStatus,
    UnderstandingError,
};

/// Untrusted identity and clock evidence for one immutable Customer State snapshot.
pub struct CustomerStateInput {
    pub id: CustomerStateSnapshotId,
    pub observed_at_ms: u64,
}

/// Immutable intent-and-emotion projection for Dialogue Policy consumption.
///
/// It stores no transcript or audio payload and grants no business action authority.
#[derive(Clone, Eq, PartialEq)]
pub struct CustomerStateSnapshot {
    id: CustomerStateSnapshotId,
    context: EnvelopeContext,
    intent_catalog_revision_id: IntentCatalogRevisionId,
    emotion_catalog_revision_id: EmotionCatalogRevisionId,
    intent_status: IntentStatus,
    primary_intent: Option<Box<str>>,
    confirmed_intent: Option<Box<str>>,
    emotion_status: EmotionStatus,
    primary_emotion: Option<Box<str>>,
    confirmed_emotion: Option<Box<str>>,
    confirmed_emotion_intensity: Option<u8>,
    distress_trend: CustomerDistressTrend,
    consecutive_distress_turns: u16,
    last_intent_turn: u32,
    last_emotion_turn: u32,
    intent_evidence_hash: Option<Box<str>>,
    emotion_evidence_hash: Option<Box<str>>,
    observed_at_ms: u64,
    payload_hash: Box<str>,
}

impl CustomerStateSnapshot {
    /// Combines independently projected Intent and Emotion state from the same authority.
    ///
    /// # Errors
    ///
    /// Rejects authority drift and a snapshot clock older than either source state.
    pub fn try_new(
        input: CustomerStateInput,
        intent: &IntentState,
        emotion: &EmotionState,
    ) -> Result<Self, UnderstandingError> {
        if !same_authority(intent.context(), emotion.context()) {
            return Err(UnderstandingError::CustomerStateAuthorityMismatch);
        }
        if input.observed_at_ms == 0
            || input.observed_at_ms < intent.last_observed_at_ms()
            || input.observed_at_ms < emotion.last_observed_at_ms()
        {
            return Err(UnderstandingError::InvalidCustomerState);
        }
        let primary_intent = intent.primary_intent().map(Into::into);
        let confirmed_intent = intent.confirmed_intent().map(Into::into);
        let primary_emotion = emotion.primary_emotion().map(Into::into);
        let confirmed_emotion = emotion.confirmed_emotion().map(Into::into);
        let intent_evidence_hash = intent.last_observation_hash().map(Into::into);
        let emotion_evidence_hash = emotion.last_fusion_hash().map(Into::into);
        let payload_hash = canonical_sha256(&json!({
            "customer_state_snapshot_id": input.id.as_str(),
            "tenant_id": intent.context().tenant_id(),
            "interaction_id": intent.context().interaction_id().as_str(),
            "call_attempt_id": intent.context().call_attempt_id().as_str(),
            "call_id": intent.context().call_id().map(converact_voice_agent_contracts::CallId::as_str),
            "agent_release_id": intent.context().agent_release_id().as_str(),
            "channel_agent_session_id": intent.context().channel_agent_session_id().map(converact_voice_agent_contracts::ChannelAgentSessionId::as_str),
            "execution_generation": intent.context().execution_generation().get(),
            "intent_catalog_revision_id": intent.catalog_revision_id().as_str(),
            "emotion_catalog_revision_id": emotion.catalog_revision_id().as_str(),
            "intent_status": intent.status(),
            "primary_intent": primary_intent,
            "confirmed_intent": confirmed_intent,
            "emotion_status": emotion.status(),
            "primary_emotion": primary_emotion,
            "confirmed_emotion": confirmed_emotion,
            "confirmed_emotion_intensity": emotion.confirmed_intensity(),
            "distress_trend": emotion.distress_trend(),
            "consecutive_distress_turns": emotion.consecutive_distress_turns(),
            "last_intent_turn": intent.last_turn_index(),
            "last_emotion_turn": emotion.last_turn_index(),
            "intent_evidence_hash": intent_evidence_hash,
            "emotion_evidence_hash": emotion_evidence_hash,
            "observed_at_ms": input.observed_at_ms,
        }))
        .map_err(|_| UnderstandingError::CustomerStateCanonicalPayloadInvalid)?;
        Ok(Self {
            id: input.id,
            context: intent.context().clone(),
            intent_catalog_revision_id: intent.catalog_revision_id().clone(),
            emotion_catalog_revision_id: emotion.catalog_revision_id().clone(),
            intent_status: intent.status(),
            primary_intent,
            confirmed_intent,
            emotion_status: emotion.status(),
            primary_emotion,
            confirmed_emotion,
            confirmed_emotion_intensity: emotion.confirmed_intensity(),
            distress_trend: emotion.distress_trend(),
            consecutive_distress_turns: emotion.consecutive_distress_turns(),
            last_intent_turn: intent.last_turn_index(),
            last_emotion_turn: emotion.last_turn_index(),
            intent_evidence_hash,
            emotion_evidence_hash,
            observed_at_ms: input.observed_at_ms,
            payload_hash: payload_hash.into(),
        })
    }

    #[must_use]
    pub fn confirmed_intent(&self) -> Option<&str> {
        self.confirmed_intent.as_deref()
    }

    #[must_use]
    pub fn confirmed_emotion(&self) -> Option<&str> {
        self.confirmed_emotion.as_deref()
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }
}

impl fmt::Debug for CustomerStateSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CustomerStateSnapshot")
            .field("id", &self.id)
            .field(
                "intent_catalog_revision_id",
                &self.intent_catalog_revision_id,
            )
            .field(
                "emotion_catalog_revision_id",
                &self.emotion_catalog_revision_id,
            )
            .field("intent_status", &self.intent_status)
            .field("has_primary_intent", &self.primary_intent.is_some())
            .field("has_confirmed_intent", &self.confirmed_intent.is_some())
            .field("emotion_status", &self.emotion_status)
            .field("has_primary_emotion", &self.primary_emotion.is_some())
            .field("has_confirmed_emotion", &self.confirmed_emotion.is_some())
            .field(
                "confirmed_emotion_intensity",
                &self.confirmed_emotion_intensity,
            )
            .field("distress_trend", &self.distress_trend)
            .field(
                "consecutive_distress_turns",
                &self.consecutive_distress_turns,
            )
            .field("last_intent_turn", &self.last_intent_turn)
            .field("last_emotion_turn", &self.last_emotion_turn)
            .field("has_intent_evidence", &self.intent_evidence_hash.is_some())
            .field(
                "has_emotion_evidence",
                &self.emotion_evidence_hash.is_some(),
            )
            .field("observed_at_ms", &self.observed_at_ms)
            .field("payload_hash", &self.payload_hash)
            .finish_non_exhaustive()
    }
}

/// A bounded, non-executable recommendation from Dialogue Policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DialogueRecommendationKind {
    ContinueDiscovery,
    ContinueWorkflow,
    ClarifyIntent,
    AcknowledgeEmotion,
    AcknowledgeThenClarify,
    ProposeHumanHandoff,
}

impl DialogueRecommendationKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::ContinueDiscovery => "continue_discovery",
            Self::ContinueWorkflow => "continue_workflow",
            Self::ClarifyIntent => "clarify_intent",
            Self::AcknowledgeEmotion => "acknowledge_emotion",
            Self::AcknowledgeThenClarify => "acknowledge_then_clarify",
            Self::ProposeHumanHandoff => "propose_human_handoff",
        }
    }
}

/// Versioned, Release-selected thresholds for deterministic Dialogue recommendations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DialoguePolicy {
    revision_id: DialoguePolicyRevisionId,
    agent_release_id: AgentReleaseId,
    acknowledge_distress_after_turns: u16,
    propose_handoff_after_turns: u16,
}

impl DialoguePolicy {
    /// Creates a policy whose handoff threshold cannot precede acknowledgement.
    ///
    /// # Errors
    ///
    /// Rejects zero or inverted turn thresholds.
    pub fn try_new(
        revision_id: DialoguePolicyRevisionId,
        agent_release_id: AgentReleaseId,
        acknowledge_distress_after_turns: u16,
        propose_handoff_after_turns: u16,
    ) -> Result<Self, UnderstandingError> {
        if acknowledge_distress_after_turns == 0
            || acknowledge_distress_after_turns > propose_handoff_after_turns
        {
            return Err(UnderstandingError::InvalidDialoguePolicy);
        }
        Ok(Self {
            revision_id,
            agent_release_id,
            acknowledge_distress_after_turns,
            propose_handoff_after_turns,
        })
    }

    /// Evaluates a Customer State snapshot into a non-executable recommendation.
    ///
    /// A human handoff recommendation still requires the separate Handoff authority to select,
    /// prepare and commit a real handoff.
    ///
    /// # Errors
    ///
    /// Rejects an evaluation clock older than the immutable Customer State snapshot.
    pub fn evaluate(
        &self,
        id: DialogueRecommendationId,
        state: &CustomerStateSnapshot,
        evaluated_at_ms: u64,
    ) -> Result<DialogueRecommendation, UnderstandingError> {
        if state.context.agent_release_id() != &self.agent_release_id {
            return Err(UnderstandingError::DialoguePolicyReleaseMismatch);
        }
        if evaluated_at_ms == 0 || evaluated_at_ms < state.observed_at_ms {
            return Err(UnderstandingError::StaleDialogueEvaluation);
        }
        let needs_clarification = state.intent_status == IntentStatus::ClarificationRequired;
        let needs_acknowledgement =
            state.consecutive_distress_turns >= self.acknowledge_distress_after_turns;
        let kind = if state.consecutive_distress_turns >= self.propose_handoff_after_turns
            && state.distress_trend == CustomerDistressTrend::Worsening
        {
            DialogueRecommendationKind::ProposeHumanHandoff
        } else if needs_clarification && needs_acknowledgement {
            DialogueRecommendationKind::AcknowledgeThenClarify
        } else if needs_clarification {
            DialogueRecommendationKind::ClarifyIntent
        } else if needs_acknowledgement {
            DialogueRecommendationKind::AcknowledgeEmotion
        } else if matches!(
            state.intent_status,
            IntentStatus::Confirmed | IntentStatus::Changed
        ) {
            DialogueRecommendationKind::ContinueWorkflow
        } else {
            DialogueRecommendationKind::ContinueDiscovery
        };
        let payload_hash = canonical_sha256(&json!({
            "dialogue_recommendation_id": id.as_str(),
            "dialogue_policy_revision_id": self.revision_id.as_str(),
            "dialogue_policy_agent_release_id": self.agent_release_id.as_str(),
            "customer_state_snapshot_id": state.id.as_str(),
            "customer_state_payload_hash": state.payload_hash,
            "tenant_id": state.context.tenant_id(),
            "interaction_id": state.context.interaction_id().as_str(),
            "call_attempt_id": state.context.call_attempt_id().as_str(),
            "agent_release_id": state.context.agent_release_id().as_str(),
            "execution_generation": state.context.execution_generation().get(),
            "kind": kind.as_str(),
            "evaluated_at_ms": evaluated_at_ms,
        }))
        .map_err(|_| UnderstandingError::DialogueRecommendationCanonicalPayloadInvalid)?;
        Ok(DialogueRecommendation {
            id,
            policy_revision_id: self.revision_id.clone(),
            customer_state_snapshot_id: state.id.clone(),
            customer_state_payload_hash: state.payload_hash.clone(),
            context: state.context.clone(),
            kind,
            evaluated_at_ms,
            payload_hash: payload_hash.into(),
        })
    }
}

/// Auditable recommendation evidence with no direct channel or Tool capability.
#[derive(Clone, Eq, PartialEq)]
pub struct DialogueRecommendation {
    id: DialogueRecommendationId,
    policy_revision_id: DialoguePolicyRevisionId,
    customer_state_snapshot_id: CustomerStateSnapshotId,
    customer_state_payload_hash: Box<str>,
    context: EnvelopeContext,
    kind: DialogueRecommendationKind,
    evaluated_at_ms: u64,
    payload_hash: Box<str>,
}

impl DialogueRecommendation {
    #[must_use]
    pub const fn kind(&self) -> DialogueRecommendationKind {
        self.kind
    }

    #[must_use]
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }
}

impl fmt::Debug for DialogueRecommendation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DialogueRecommendation")
            .field("id", &self.id)
            .field("policy_revision_id", &self.policy_revision_id)
            .field(
                "customer_state_snapshot_id",
                &self.customer_state_snapshot_id,
            )
            .field(
                "customer_state_payload_hash",
                &self.customer_state_payload_hash,
            )
            .field("context", &self.context)
            .field("kind", &self.kind)
            .field("evaluated_at_ms", &self.evaluated_at_ms)
            .field("payload_hash", &self.payload_hash)
            .finish_non_exhaustive()
    }
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
