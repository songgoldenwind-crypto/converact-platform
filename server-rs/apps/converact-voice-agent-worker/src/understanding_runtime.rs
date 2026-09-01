use std::{error::Error, fmt, future::Future};

use converact_contracts::canonical_sha256;
use converact_conversation_understanding_core::{
    CustomerStateInput, CustomerStateSnapshot, DialoguePolicy, DialogueRecommendation,
    EmotionCatalog, EmotionCheckpoint, IntentCatalog, IntentCheckpoint,
};
use converact_conversation_understanding_store::{
    AppendUnderstandingRecord, StoredUnderstandingHead, UnderstandingDomain,
    UnderstandingHeadExpectation, UnderstandingHeadExpectationInput, UnderstandingTurnBatch,
    encode_customer_state_snapshot, encode_dialogue_recommendation, encode_emotion_checkpoint,
    encode_intent_checkpoint, restore_customer_state_snapshot, restore_dialogue_recommendation,
    restore_emotion_checkpoint, restore_intent_checkpoint,
};
use converact_voice_agent_contracts::{
    CustomerStateSnapshotId, DialogueRecommendationId, EnvelopeContext,
};
use serde_json::json;

use crate::{EmotionTurnResolution, intent_confidence_router::IntentTurnResolution};

const CUSTOMER_STATE_DOMAIN: &str = "converact_understanding_customer_state_v1";
const DIALOGUE_DOMAIN: &str = "converact_understanding_dialogue_recommendation_v1";

/// Bounded persistence or recovery failure without customer data or storage topology.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UnderstandingPortError {
    code: &'static str,
}

impl UnderstandingPortError {
    #[must_use]
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for UnderstandingPortError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for UnderstandingPortError {}

/// Durable boundary that returns all current domains from one consistent database snapshot.
pub trait UnderstandingDurabilityPort: Sync {
    fn load_consistent_heads(
        &self,
        context: &EnvelopeContext,
    ) -> impl Future<Output = Result<Vec<StoredUnderstandingHead>, UnderstandingPortError>> + Send;

    fn append_turn(
        &self,
        batch: &UnderstandingTurnBatch,
    ) -> impl Future<Output = Result<UnderstandingAppendDecision, UnderstandingPortError>> + Send;
}

/// Atomic persistence classification for the complete four-domain turn graph.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnderstandingAppendDecision {
    Applied,
    Replayed,
    Superseded,
}

/// Exact Release-owned inputs required to reconstruct the fixed dependency graph.
#[derive(Clone, Copy)]
pub struct UnderstandingRecoveryInputs<'a> {
    pub intent_catalog: &'a IntentCatalog,
    pub emotion_catalog: &'a EmotionCatalog,
    pub dialogue_policy: &'a DialoguePolicy,
}

/// Exact typed state and retention inputs for one atomic understanding turn commit.
#[derive(Clone, Copy)]
pub struct UnderstandingTurnWriteInput<'a> {
    pub intent_checkpoint: &'a IntentCheckpoint,
    pub emotion_checkpoint: &'a EmotionCheckpoint,
    pub customer_state: &'a CustomerStateSnapshot,
    pub dialogue: &'a DialogueRecommendation,
    pub dialogue_policy: &'a DialoguePolicy,
    pub retention_policy_ref: &'a str,
    pub retention_until_ms: u64,
}

/// Exact Router resolution and dependent domain inputs for one atomic understanding turn commit.
#[derive(Clone, Copy)]
pub struct ResolvedUnderstandingTurnWriteInput<'a> {
    pub intent_resolution: &'a IntentTurnResolution,
    pub emotion_resolution: &'a EmotionTurnResolution,
    pub customer_state: &'a CustomerStateSnapshot,
    pub dialogue: &'a DialogueRecommendation,
    pub dialogue_policy: &'a DialoguePolicy,
    pub retention_policy_ref: &'a str,
    pub retention_until_ms: u64,
}

/// Exact resolved Provider inputs required to derive and persist one complete understanding turn.
#[derive(Clone, Copy)]
pub struct CompleteUnderstandingTurnInput<'a> {
    pub intent_resolution: &'a IntentTurnResolution,
    pub emotion_resolution: &'a EmotionTurnResolution,
    pub dialogue_policy: &'a DialoguePolicy,
    pub retention_policy_ref: &'a str,
    pub retention_until_ms: u64,
}

/// Derived Customer State/Dialogue projections and their atomic durable batch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedUnderstandingTurn {
    batch: UnderstandingTurnBatch,
    customer_state: CustomerStateSnapshot,
    dialogue: DialogueRecommendation,
}

impl PreparedUnderstandingTurn {
    #[must_use]
    pub const fn batch(&self) -> &UnderstandingTurnBatch {
        &self.batch
    }

    #[must_use]
    pub const fn customer_state(&self) -> &CustomerStateSnapshot {
        &self.customer_state
    }

    #[must_use]
    pub const fn dialogue(&self) -> &DialogueRecommendation {
        &self.dialogue
    }

    #[must_use]
    pub fn into_batch(self) -> UnderstandingTurnBatch {
        self.batch
    }
}

/// Complete recovered understanding state, or the valid all-empty initial state.
#[derive(Clone, Eq, PartialEq)]
pub struct RecoveredUnderstanding {
    context: EnvelopeContext,
    intent_head: Option<StoredUnderstandingHead>,
    emotion_head: Option<StoredUnderstandingHead>,
    customer_state_head: Option<StoredUnderstandingHead>,
    dialogue_head: Option<StoredUnderstandingHead>,
    intent_checkpoint: Option<IntentCheckpoint>,
    emotion_checkpoint: Option<EmotionCheckpoint>,
    customer_state: Option<CustomerStateSnapshot>,
    dialogue: Option<DialogueRecommendation>,
}

impl RecoveredUnderstanding {
    fn empty(context: EnvelopeContext) -> Self {
        Self {
            context,
            intent_head: None,
            emotion_head: None,
            customer_state_head: None,
            dialogue_head: None,
            intent_checkpoint: None,
            emotion_checkpoint: None,
            customer_state: None,
            dialogue: None,
        }
    }

    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.intent_head.is_none()
    }

    #[must_use]
    pub const fn context(&self) -> &EnvelopeContext {
        &self.context
    }

    #[must_use]
    pub const fn intent_head(&self) -> Option<&StoredUnderstandingHead> {
        self.intent_head.as_ref()
    }

    #[must_use]
    pub const fn emotion_head(&self) -> Option<&StoredUnderstandingHead> {
        self.emotion_head.as_ref()
    }

    #[must_use]
    pub const fn customer_state_head(&self) -> Option<&StoredUnderstandingHead> {
        self.customer_state_head.as_ref()
    }

    #[must_use]
    pub const fn dialogue_head(&self) -> Option<&StoredUnderstandingHead> {
        self.dialogue_head.as_ref()
    }

    #[must_use]
    pub const fn intent_checkpoint(&self) -> Option<&IntentCheckpoint> {
        self.intent_checkpoint.as_ref()
    }

    #[must_use]
    pub const fn emotion_checkpoint(&self) -> Option<&EmotionCheckpoint> {
        self.emotion_checkpoint.as_ref()
    }

    #[must_use]
    pub const fn customer_state(&self) -> Option<&CustomerStateSnapshot> {
        self.customer_state.as_ref()
    }

    #[must_use]
    pub const fn dialogue(&self) -> Option<&DialogueRecommendation> {
        self.dialogue.as_ref()
    }

    /// Builds one typed, exact-source and current-head-fenced four-domain write.
    ///
    /// # Errors
    ///
    /// Rejects authority, source-state, Policy, retention or head-expectation drift before SQL.
    pub fn prepare_turn(
        &self,
        input: UnderstandingTurnWriteInput<'_>,
    ) -> Result<UnderstandingTurnBatch, UnderstandingPortError> {
        self.prepare_turn_with_evidence(input, Vec::new())
    }

    /// Builds one atomic write containing raw Intent contributors, resolution and four heads.
    ///
    /// # Errors
    ///
    /// Rejects invalid Router evidence, retention, authority, dependency or head fencing before
    /// SQL. The selected Intent checkpoint remains the rolling-compatible Intent head.
    pub fn prepare_resolved_turn(
        &self,
        input: ResolvedUnderstandingTurnWriteInput<'_>,
    ) -> Result<UnderstandingTurnBatch, UnderstandingPortError> {
        let mut records = input
            .intent_resolution
            .encode_evidence_records(input.retention_policy_ref, input.retention_until_ms)
            .map_err(|_| append_input_invalid())?;
        records.extend(
            input
                .emotion_resolution
                .encode_evidence_records(input.retention_policy_ref, input.retention_until_ms)
                .map_err(|_| append_input_invalid())?,
        );
        let evidence = records
            .into_iter()
            .map(|record| {
                AppendUnderstandingRecord::try_new(record, None).map_err(|_| append_input_invalid())
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.prepare_turn_with_evidence(
            UnderstandingTurnWriteInput {
                intent_checkpoint: input.intent_resolution.checkpoint(),
                emotion_checkpoint: input.emotion_resolution.checkpoint(),
                customer_state: input.customer_state,
                dialogue: input.dialogue,
                dialogue_policy: input.dialogue_policy,
                retention_policy_ref: input.retention_policy_ref,
                retention_until_ms: input.retention_until_ms,
            },
            evidence,
        )
    }

    /// Derives Customer State and Dialogue from exact resolved sources, then freezes one batch.
    ///
    /// # Errors
    ///
    /// Rejects cross-authority/turn evidence, identity derivation, Policy, retention or current-head
    /// fence drift before any SQL is executed.
    pub fn prepare_complete_turn(
        &self,
        input: CompleteUnderstandingTurnInput<'_>,
    ) -> Result<PreparedUnderstandingTurn, UnderstandingPortError> {
        let intent = input.intent_resolution.checkpoint();
        let emotion = input.emotion_resolution.checkpoint();
        if intent.context() != &self.context
            || emotion.context() != &self.context
            || intent.turn_index() != emotion.turn_index()
        {
            return Err(append_input_invalid());
        }
        let observed_at_ms = intent.observed_at_ms().max(emotion.observed_at_ms());
        let customer_digest = canonical_sha256(&json!({
            "domain": CUSTOMER_STATE_DOMAIN,
            "intent_resolution_hash": input.intent_resolution.resolution_hash(),
            "emotion_fusion_hash": emotion.fusion().payload_hash(),
            "turn_index": intent.turn_index(),
        }))
        .map_err(|_| append_input_invalid())?;
        let customer_state = CustomerStateSnapshot::try_new(
            CustomerStateInput {
                id: CustomerStateSnapshotId::parse(format!("customer-state.{customer_digest}"))
                    .map_err(|_| append_input_invalid())?,
                observed_at_ms,
            },
            intent.state(),
            emotion.state(),
        )
        .map_err(|_| append_input_invalid())?;
        let dialogue_digest = canonical_sha256(&json!({
            "domain": DIALOGUE_DOMAIN,
            "dialogue_policy_revision_id": input.dialogue_policy.revision_id().as_str(),
            "customer_state_hash": customer_state.payload_hash(),
            "turn_index": intent.turn_index(),
        }))
        .map_err(|_| append_input_invalid())?;
        let dialogue = input
            .dialogue_policy
            .evaluate(
                DialogueRecommendationId::parse(format!(
                    "dialogue-recommendation.{dialogue_digest}"
                ))
                .map_err(|_| append_input_invalid())?,
                &customer_state,
                observed_at_ms,
            )
            .map_err(|_| append_input_invalid())?;
        let batch = self.prepare_resolved_turn(ResolvedUnderstandingTurnWriteInput {
            intent_resolution: input.intent_resolution,
            emotion_resolution: input.emotion_resolution,
            customer_state: &customer_state,
            dialogue: &dialogue,
            dialogue_policy: input.dialogue_policy,
            retention_policy_ref: input.retention_policy_ref,
            retention_until_ms: input.retention_until_ms,
        })?;
        Ok(PreparedUnderstandingTurn {
            batch,
            customer_state,
            dialogue,
        })
    }

    fn prepare_turn_with_evidence(
        &self,
        input: UnderstandingTurnWriteInput<'_>,
        evidence: Vec<AppendUnderstandingRecord>,
    ) -> Result<UnderstandingTurnBatch, UnderstandingPortError> {
        if input.intent_checkpoint.context() != &self.context
            || input.emotion_checkpoint.context() != &self.context
            || input.customer_state.context() != &self.context
            || input.dialogue.context() != &self.context
        {
            return Err(append_input_invalid());
        }
        CustomerStateSnapshot::from_value(
            input.customer_state.to_value(),
            input.intent_checkpoint.state(),
            input.emotion_checkpoint.state(),
        )
        .map_err(|_| append_input_invalid())?;
        DialogueRecommendation::from_value(
            input.dialogue.to_value(),
            input.dialogue_policy,
            input.customer_state,
        )
        .map_err(|_| append_input_invalid())?;
        let records = [
            encode_intent_checkpoint(
                input.intent_checkpoint,
                input.retention_policy_ref,
                input.retention_until_ms,
            ),
            encode_emotion_checkpoint(
                input.emotion_checkpoint,
                input.retention_policy_ref,
                input.retention_until_ms,
            ),
            encode_customer_state_snapshot(
                input.customer_state,
                input.retention_policy_ref,
                input.retention_until_ms,
            ),
            encode_dialogue_recommendation(
                input.dialogue,
                input.customer_state,
                input.retention_policy_ref,
                input.retention_until_ms,
            ),
        ];
        let [intent, emotion, customer_state, dialogue] =
            records.map(|record| record.map_err(|_| append_input_invalid()));
        UnderstandingTurnBatch::try_new_with_evidence(
            evidence,
            append_command(intent?, self.intent_head.as_ref())?,
            append_command(emotion?, self.emotion_head.as_ref())?,
            append_command(customer_state?, self.customer_state_head.as_ref())?,
            append_command(dialogue?, self.dialogue_head.as_ref())?,
        )
        .map_err(|_| append_input_invalid())
    }
}

impl fmt::Debug for RecoveredUnderstanding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RecoveredUnderstanding")
            .field("empty", &self.is_empty())
            .field("has_intent", &self.intent_checkpoint.is_some())
            .field("has_emotion", &self.emotion_checkpoint.is_some())
            .field("has_customer_state", &self.customer_state.is_some())
            .field("has_dialogue", &self.dialogue.is_some())
            .finish_non_exhaustive()
    }
}

/// Bounded coordinator for restoring the one authoritative understanding graph.
pub struct UnderstandingRuntime<'a, D> {
    durability: &'a D,
}

impl<'a, D> UnderstandingRuntime<'a, D> {
    #[must_use]
    pub const fn new(durability: &'a D) -> Self {
        Self { durability }
    }
}

impl<D> UnderstandingRuntime<'_, D>
where
    D: UnderstandingDurabilityPort,
{
    /// Atomically persists one validated four-domain turn graph.
    ///
    /// # Errors
    ///
    /// Returns a bounded durable-adapter failure; no Provider or channel action is performed.
    pub async fn persist_turn(
        &self,
        batch: &UnderstandingTurnBatch,
    ) -> Result<UnderstandingAppendDecision, UnderstandingPortError> {
        self.durability.append_turn(batch).await
    }

    /// Restores Intent, Emotion, Customer State and Dialogue from one consistent head snapshot.
    ///
    /// # Errors
    ///
    /// Rejects duplicate/mixed-authority heads, a partial dependency graph, or any checkpoint,
    /// Catalog, source-state or Policy drift.
    pub async fn recover(
        &self,
        context: &EnvelopeContext,
        inputs: UnderstandingRecoveryInputs<'_>,
    ) -> Result<RecoveredUnderstanding, UnderstandingPortError> {
        let heads = self.durability.load_consistent_heads(context).await?;
        if heads.len() > 4 {
            return Err(snapshot_invalid());
        }
        let mut intent_head = None;
        let mut emotion_head = None;
        let mut customer_state_head = None;
        let mut dialogue_head = None;
        for head in heads {
            if head.record().context() != context || head.head().context() != context {
                return Err(snapshot_invalid());
            }
            let slot = match head.head().domain() {
                UnderstandingDomain::Intent => &mut intent_head,
                UnderstandingDomain::Emotion => &mut emotion_head,
                UnderstandingDomain::CustomerState => &mut customer_state_head,
                UnderstandingDomain::Dialogue => &mut dialogue_head,
            };
            if slot.replace(head).is_some() {
                return Err(snapshot_invalid());
            }
        }
        let present = usize::from(intent_head.is_some())
            + usize::from(emotion_head.is_some())
            + usize::from(customer_state_head.is_some())
            + usize::from(dialogue_head.is_some());
        if present == 0 {
            return Ok(RecoveredUnderstanding::empty(context.clone()));
        }
        let (Some(intent_head), Some(emotion_head), Some(customer_state_head), Some(dialogue_head)) = (
            intent_head,
            emotion_head,
            customer_state_head,
            dialogue_head,
        ) else {
            return Err(UnderstandingPortError::new(
                "understanding_recovery_dependency_incomplete",
            ));
        };
        let intent_checkpoint =
            restore_intent_checkpoint(intent_head.record(), inputs.intent_catalog)
                .map_err(|_| checkpoint_invalid())?;
        let emotion_checkpoint =
            restore_emotion_checkpoint(emotion_head.record(), inputs.emotion_catalog)
                .map_err(|_| checkpoint_invalid())?;
        let customer_state = restore_customer_state_snapshot(
            customer_state_head.record(),
            intent_checkpoint.state(),
            emotion_checkpoint.state(),
        )
        .map_err(|_| checkpoint_invalid())?;
        let dialogue = restore_dialogue_recommendation(
            dialogue_head.record(),
            inputs.dialogue_policy,
            &customer_state,
        )
        .map_err(|_| checkpoint_invalid())?;
        Ok(RecoveredUnderstanding {
            context: context.clone(),
            intent_head: Some(intent_head),
            emotion_head: Some(emotion_head),
            customer_state_head: Some(customer_state_head),
            dialogue_head: Some(dialogue_head),
            intent_checkpoint: Some(intent_checkpoint),
            emotion_checkpoint: Some(emotion_checkpoint),
            customer_state: Some(customer_state),
            dialogue: Some(dialogue),
        })
    }
}

const fn snapshot_invalid() -> UnderstandingPortError {
    UnderstandingPortError::new("understanding_recovery_snapshot_invalid")
}

const fn checkpoint_invalid() -> UnderstandingPortError {
    UnderstandingPortError::new("understanding_recovery_checkpoint_invalid")
}

fn append_command(
    record: converact_conversation_understanding_store::UnderstandingRecord,
    current: Option<&StoredUnderstandingHead>,
) -> Result<AppendUnderstandingRecord, UnderstandingPortError> {
    let expectation = match current {
        Some(current) => UnderstandingHeadExpectation::try_new(UnderstandingHeadExpectationInput {
            expected_revision: current.head().revision(),
            expected_record_id: Some(current.head().record_id().to_owned()),
            expected_payload_hash: Some(current.head().payload_hash().to_owned()),
        }),
        None => UnderstandingHeadExpectation::try_new(UnderstandingHeadExpectationInput {
            expected_revision: 0,
            expected_record_id: None,
            expected_payload_hash: None,
        }),
    }
    .map_err(|_| append_input_invalid())?;
    AppendUnderstandingRecord::try_new(record, Some(expectation))
        .map_err(|_| append_input_invalid())
}

const fn append_input_invalid() -> UnderstandingPortError {
    UnderstandingPortError::new("understanding_append_input_invalid")
}
