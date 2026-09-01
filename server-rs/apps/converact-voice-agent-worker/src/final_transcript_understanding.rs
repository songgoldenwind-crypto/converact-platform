use std::{error::Error, fmt};

use converact_conversation_result_core::{TranscriptSegment, TranscriptSpeaker};
use converact_conversation_understanding_core::{
    DialoguePolicy, EmotionCatalog, EmotionDecisionPolicy, EmotionState, IntentCatalog,
    IntentDecisionPolicy, IntentState,
};

use crate::{
    AcousticEmotionClassifierPort, AcousticEmotionClassifierProvider, AcousticEmotionFailurePolicy,
    AdaptiveEmotionTurnRuntime, AdaptiveEmotionTurnRuntimeError, AudioEvidenceWindow,
    CompleteUnderstandingTurnInput, ContextualFailurePolicy, ContextualIntentClassifierPort,
    ContextualIntentClassifierProvider, EmotionTurnResolution, FastIntentClassifierPort,
    FastIntentClassifierProvider, FinalTranscriptUnderstandingPort, LayeredIntentRuntime,
    MultimodalEmotionFusionPolicy, PreparedUnderstandingTurn, RecoveredUnderstanding,
    SafetyIntentProvider, TextEmotionClassifierPort, TextEmotionClassifierProvider,
    TextEmotionTurnRuntime, UnderstandingAppendDecision, UnderstandingDurabilityPort,
    UnderstandingRecoveryInputs, UnderstandingRuntime,
};

/// Durable transcript classification supplied by the append boundary before any model invocation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TranscriptUnderstandingDisposition {
    AppendedCurrent,
    ReplayedCurrent,
    Historical,
}

/// All immutable components needed to process one current final customer transcript.
pub struct FinalTranscriptUnderstandingInput<'a, D, F, C, E> {
    pub disposition: TranscriptUnderstandingDisposition,
    pub history: &'a [TranscriptSegment],
    pub durability: &'a D,
    pub safety: &'a SafetyIntentProvider,
    pub fast: &'a FastIntentClassifierProvider<F>,
    pub contextual: &'a ContextualIntentClassifierProvider<C>,
    pub text_emotion: &'a TextEmotionClassifierProvider<E>,
    pub intent_catalog: &'a IntentCatalog,
    pub emotion_catalog: &'a EmotionCatalog,
    pub intent_policy: IntentDecisionPolicy,
    pub emotion_policy: EmotionDecisionPolicy,
    pub contextual_failure_policy: ContextualFailurePolicy,
    pub dialogue_policy: &'a DialoguePolicy,
    pub retention_policy_ref: &'a str,
    pub retention_until_ms: u64,
}

/// Adds exact normalized audio evidence and release policy to one final-transcript turn.
pub struct MultimodalFinalTranscriptUnderstandingInput<'a, D, F, C, T, A> {
    pub base: FinalTranscriptUnderstandingInput<'a, D, F, C, T>,
    pub acoustic_emotion: &'a AcousticEmotionClassifierProvider<A>,
    pub audio_evidence_window: Option<&'a AudioEvidenceWindow>,
    pub fusion_policy: MultimodalEmotionFusionPolicy,
    pub acoustic_failure_policy: AcousticEmotionFailurePolicy,
}

/// Immutable dependencies for the text-emotion final-turn processor used by event coordinators.
pub struct TextFinalTranscriptUnderstandingProcessorInput<'a, D, F, C, E> {
    pub durability: &'a D,
    pub safety: &'a SafetyIntentProvider,
    pub fast: &'a FastIntentClassifierProvider<F>,
    pub contextual: &'a ContextualIntentClassifierProvider<C>,
    pub text_emotion: &'a TextEmotionClassifierProvider<E>,
    pub intent_catalog: &'a IntentCatalog,
    pub emotion_catalog: &'a EmotionCatalog,
    pub intent_policy: IntentDecisionPolicy,
    pub emotion_policy: EmotionDecisionPolicy,
    pub contextual_failure_policy: ContextualFailurePolicy,
    pub dialogue_policy: &'a DialoguePolicy,
    pub retention_policy_ref: &'a str,
    pub retention_until_ms: u64,
}

/// Concrete processor adapter from event-coordinator inputs to the complete text-emotion turn.
pub struct TextFinalTranscriptUnderstandingProcessor<'a, D, F, C, E> {
    input: TextFinalTranscriptUnderstandingProcessorInput<'a, D, F, C, E>,
}

impl<'a, D, F, C, E> TextFinalTranscriptUnderstandingProcessor<'a, D, F, C, E> {
    #[must_use]
    pub const fn new(
        input: TextFinalTranscriptUnderstandingProcessorInput<'a, D, F, C, E>,
    ) -> Self {
        Self { input }
    }
}

impl<D, F, C, E> fmt::Debug for TextFinalTranscriptUnderstandingProcessor<'_, D, F, C, E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TextFinalTranscriptUnderstandingProcessor")
            .field("intent_catalog_revision_id", self.input.intent_catalog.id())
            .field(
                "emotion_catalog_revision_id",
                self.input.emotion_catalog.id(),
            )
            .field("has_retention_policy", &true)
            .finish_non_exhaustive()
    }
}

impl<D, F, C, E> FinalTranscriptUnderstandingPort
    for TextFinalTranscriptUnderstandingProcessor<'_, D, F, C, E>
where
    D: UnderstandingDurabilityPort,
    F: FastIntentClassifierPort,
    C: ContextualIntentClassifierPort,
    E: TextEmotionClassifierPort,
{
    type Outcome = FinalTranscriptUnderstandingOutcome;

    async fn process(
        &self,
        disposition: TranscriptUnderstandingDisposition,
        history: &[TranscriptSegment],
    ) -> Result<Self::Outcome, FinalTranscriptUnderstandingError> {
        process_final_transcript_understanding(FinalTranscriptUnderstandingInput {
            disposition,
            history,
            durability: self.input.durability,
            safety: self.input.safety,
            fast: self.input.fast,
            contextual: self.input.contextual,
            text_emotion: self.input.text_emotion,
            intent_catalog: self.input.intent_catalog,
            emotion_catalog: self.input.emotion_catalog,
            intent_policy: self.input.intent_policy,
            emotion_policy: self.input.emotion_policy,
            contextual_failure_policy: self.input.contextual_failure_policy,
            dialogue_policy: self.input.dialogue_policy,
            retention_policy_ref: self.input.retention_policy_ref,
            retention_until_ms: self.input.retention_until_ms,
        })
        .await
    }
}

/// One complete prepared turn and its exact atomic persistence classification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersistedUnderstandingTurn {
    turn_index: u32,
    decision: UnderstandingAppendDecision,
    prepared: PreparedUnderstandingTurn,
}

impl PersistedUnderstandingTurn {
    #[must_use]
    pub const fn turn_index(&self) -> u32 {
        self.turn_index
    }

    #[must_use]
    pub const fn decision(&self) -> UnderstandingAppendDecision {
        self.decision
    }

    #[must_use]
    pub const fn prepared(&self) -> &PreparedUnderstandingTurn {
        &self.prepared
    }
}

/// Processing result that distinguishes deliberate replay/history skips from durable turns.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FinalTranscriptUnderstandingOutcome {
    SkippedReplay,
    SkippedHistorical,
    Persisted(Box<PersistedUnderstandingTurn>),
}

/// Stable end-to-end understanding failure without transcript, label or Provider payload details.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FinalTranscriptUnderstandingError {
    TranscriptInvalid,
    RecoveryFailed,
    TurnExhausted,
    IntentFailed,
    EmotionProviderFailed,
    EmotionResolutionFailed,
    TurnPreparationFailed,
    PersistenceFailed,
}

impl FinalTranscriptUnderstandingError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::TranscriptInvalid => "final_transcript_understanding_transcript_invalid",
            Self::RecoveryFailed => "final_transcript_understanding_recovery_failed",
            Self::TurnExhausted => "final_transcript_understanding_turn_exhausted",
            Self::IntentFailed => "final_transcript_understanding_intent_failed",
            Self::EmotionProviderFailed => "final_transcript_understanding_emotion_provider_failed",
            Self::EmotionResolutionFailed => {
                "final_transcript_understanding_emotion_resolution_failed"
            }
            Self::TurnPreparationFailed => "final_transcript_understanding_prepare_failed",
            Self::PersistenceFailed => "final_transcript_understanding_persistence_failed",
        }
    }
}

impl fmt::Display for FinalTranscriptUnderstandingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for FinalTranscriptUnderstandingError {}

fn next_turn_index(
    recovered: &RecoveredUnderstanding,
) -> Result<u32, FinalTranscriptUnderstandingError> {
    let intent = recovered.intent_checkpoint().map_or(
        0,
        converact_conversation_understanding_core::IntentCheckpoint::turn_index,
    );
    let emotion = recovered.emotion_checkpoint().map_or(
        0,
        converact_conversation_understanding_core::EmotionCheckpoint::turn_index,
    );
    intent
        .max(emotion)
        .checked_add(1)
        .ok_or(FinalTranscriptUnderstandingError::TurnExhausted)
}

/// Recovers, resolves and atomically persists one new current final customer transcript turn.
///
/// Replay and historical dispositions return before Store recovery or model invocation. The caller
/// must supply the bounded durable-sequence history ending at the exact newly appended segment.
///
/// # Errors
///
/// Rejects invalid transcript windows, recovery/model/state drift and durable write failures.
pub async fn process_final_transcript_understanding<D, F, C, E>(
    input: FinalTranscriptUnderstandingInput<'_, D, F, C, E>,
) -> Result<FinalTranscriptUnderstandingOutcome, FinalTranscriptUnderstandingError>
where
    D: UnderstandingDurabilityPort,
    F: FastIntentClassifierPort,
    C: ContextualIntentClassifierPort,
    E: TextEmotionClassifierPort,
{
    let emotion = TextOnlyFinalEmotionResolver {
        provider: input.text_emotion,
        catalog: input.emotion_catalog,
        policy: input.emotion_policy,
    };
    process_with_emotion(&input, &emotion).await
}

/// Processes one final transcript with exact text/acoustic evidence and conservative fallback.
///
/// Replay and historical dispositions return before Store recovery or either model invocation.
/// Acoustic serving faults can never perform or authorize a telephony action.
///
/// # Errors
///
/// Rejects transcript, recovery, model, evidence, state or persistence drift.
pub async fn process_final_transcript_understanding_multimodal<D, F, C, T, A>(
    input: MultimodalFinalTranscriptUnderstandingInput<'_, D, F, C, T, A>,
) -> Result<FinalTranscriptUnderstandingOutcome, FinalTranscriptUnderstandingError>
where
    D: UnderstandingDurabilityPort,
    F: FastIntentClassifierPort,
    C: ContextualIntentClassifierPort,
    T: TextEmotionClassifierPort,
    A: AcousticEmotionClassifierPort,
{
    let emotion = BoundAdaptiveEmotionResolver {
        runtime: AdaptiveEmotionTurnRuntime::new(
            input.base.text_emotion,
            input.acoustic_emotion,
            input.base.emotion_catalog,
            input.base.emotion_policy,
            input.fusion_policy,
            input.acoustic_failure_policy,
        ),
        window: input.audio_evidence_window,
    };
    process_with_emotion(&input.base, &emotion).await
}

trait FinalEmotionResolver {
    async fn resolve(
        &self,
        current: &TranscriptSegment,
        turn_index: u32,
        previous: &EmotionState,
    ) -> Result<EmotionTurnResolution, FinalTranscriptUnderstandingError>;
}

struct TextOnlyFinalEmotionResolver<'a, E> {
    provider: &'a TextEmotionClassifierProvider<E>,
    catalog: &'a EmotionCatalog,
    policy: EmotionDecisionPolicy,
}

impl<E> FinalEmotionResolver for TextOnlyFinalEmotionResolver<'_, E>
where
    E: TextEmotionClassifierPort,
{
    async fn resolve(
        &self,
        current: &TranscriptSegment,
        turn_index: u32,
        previous: &EmotionState,
    ) -> Result<EmotionTurnResolution, FinalTranscriptUnderstandingError> {
        let observation = self
            .provider
            .observe(current, turn_index)
            .await
            .map_err(|_| FinalTranscriptUnderstandingError::EmotionProviderFailed)?
            .ok_or(FinalTranscriptUnderstandingError::TranscriptInvalid)?;
        TextEmotionTurnRuntime::new(self.catalog, self.policy)
            .resolve(observation, previous)
            .map_err(|_| FinalTranscriptUnderstandingError::EmotionResolutionFailed)
    }
}

struct BoundAdaptiveEmotionResolver<'a, T, A> {
    runtime: AdaptiveEmotionTurnRuntime<'a, T, A>,
    window: Option<&'a AudioEvidenceWindow>,
}

impl<T, A> FinalEmotionResolver for BoundAdaptiveEmotionResolver<'_, T, A>
where
    T: TextEmotionClassifierPort,
    A: AcousticEmotionClassifierPort,
{
    async fn resolve(
        &self,
        current: &TranscriptSegment,
        turn_index: u32,
        previous: &EmotionState,
    ) -> Result<EmotionTurnResolution, FinalTranscriptUnderstandingError> {
        self.runtime
            .resolve(current, self.window, turn_index, previous)
            .await
            .map_err(map_adaptive_emotion_error)
    }
}

const fn map_adaptive_emotion_error(
    error: AdaptiveEmotionTurnRuntimeError,
) -> FinalTranscriptUnderstandingError {
    match error {
        AdaptiveEmotionTurnRuntimeError::TranscriptInvalid => {
            FinalTranscriptUnderstandingError::TranscriptInvalid
        }
        AdaptiveEmotionTurnRuntimeError::TextProviderFailed
        | AdaptiveEmotionTurnRuntimeError::AcousticProviderFailed => {
            FinalTranscriptUnderstandingError::EmotionProviderFailed
        }
        AdaptiveEmotionTurnRuntimeError::EvidenceMismatch
        | AdaptiveEmotionTurnRuntimeError::AcousticEvidenceRequired
        | AdaptiveEmotionTurnRuntimeError::ResolutionFailed => {
            FinalTranscriptUnderstandingError::EmotionResolutionFailed
        }
    }
}

async fn process_with_emotion<D, F, C, E, R>(
    input: &FinalTranscriptUnderstandingInput<'_, D, F, C, E>,
    emotion: &R,
) -> Result<FinalTranscriptUnderstandingOutcome, FinalTranscriptUnderstandingError>
where
    D: UnderstandingDurabilityPort,
    F: FastIntentClassifierPort,
    C: ContextualIntentClassifierPort,
    E: TextEmotionClassifierPort,
    R: FinalEmotionResolver,
{
    match input.disposition {
        TranscriptUnderstandingDisposition::ReplayedCurrent => {
            return Ok(FinalTranscriptUnderstandingOutcome::SkippedReplay);
        }
        TranscriptUnderstandingDisposition::Historical => {
            return Ok(FinalTranscriptUnderstandingOutcome::SkippedHistorical);
        }
        TranscriptUnderstandingDisposition::AppendedCurrent => {}
    }
    let current = input
        .history
        .last()
        .ok_or(FinalTranscriptUnderstandingError::TranscriptInvalid)?;
    if current.speaker() != TranscriptSpeaker::Customer {
        return Err(FinalTranscriptUnderstandingError::TranscriptInvalid);
    }
    let runtime = UnderstandingRuntime::new(input.durability);
    let recovered = runtime
        .recover(
            current.context(),
            UnderstandingRecoveryInputs {
                intent_catalog: input.intent_catalog,
                emotion_catalog: input.emotion_catalog,
                dialogue_policy: input.dialogue_policy,
            },
        )
        .await
        .map_err(|_| FinalTranscriptUnderstandingError::RecoveryFailed)?;
    let turn_index = next_turn_index(&recovered)?;
    let previous_intent = recovered.intent_checkpoint().map_or_else(
        || IntentState::new(current.context().clone(), input.intent_catalog.id().clone()),
        |checkpoint| checkpoint.state().clone(),
    );
    let previous_emotion = recovered.emotion_checkpoint().map_or_else(
        || {
            EmotionState::new(
                current.context().clone(),
                input.emotion_catalog.id().clone(),
            )
        },
        |checkpoint| checkpoint.state().clone(),
    );

    let intent_resolution = LayeredIntentRuntime::new(
        input.safety,
        input.fast,
        input.contextual,
        input.contextual_failure_policy,
    )
    .resolve(
        input.history,
        turn_index,
        &previous_intent,
        input.intent_policy,
    )
    .await
    .map_err(|_| FinalTranscriptUnderstandingError::IntentFailed)?
    .ok_or(FinalTranscriptUnderstandingError::TranscriptInvalid)?;
    let emotion_resolution = emotion
        .resolve(current, turn_index, &previous_emotion)
        .await?;
    let prepared = recovered
        .prepare_complete_turn(CompleteUnderstandingTurnInput {
            intent_resolution: &intent_resolution,
            emotion_resolution: &emotion_resolution,
            dialogue_policy: input.dialogue_policy,
            retention_policy_ref: input.retention_policy_ref,
            retention_until_ms: input.retention_until_ms,
        })
        .map_err(|_| FinalTranscriptUnderstandingError::TurnPreparationFailed)?;
    let decision = runtime
        .persist_turn(prepared.batch())
        .await
        .map_err(|_| FinalTranscriptUnderstandingError::PersistenceFailed)?;
    Ok(FinalTranscriptUnderstandingOutcome::Persisted(Box::new(
        PersistedUnderstandingTurn {
            turn_index,
            decision,
            prepared,
        },
    )))
}
