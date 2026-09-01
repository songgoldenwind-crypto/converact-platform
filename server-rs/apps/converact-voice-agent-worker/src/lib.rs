//! Rust application boundary for bounded AI outbound voice work.

#![forbid(unsafe_code)]

mod acoustic_emotion_classifier;
mod active_call_channel_agent;
mod active_call_handoff;
mod active_call_intent;
mod active_call_playbook_artifact;
mod active_call_playbook_resolver;
mod active_call_reservation;
mod active_call_transcript;
mod active_call_transcript_postgres;
mod adaptive_emotion_runtime;
mod campaign_admin;
mod campaign_admin_http;
mod campaign_retry;
mod channel_agent_session;
mod contextual_intent_provider;
mod conversation_finalization;
mod conversation_projection;
mod conversation_projection_postgres;
mod conversation_quality;
mod conversation_quality_http;
mod conversation_quality_postgres;
mod fast_intent_classifier;
mod final_transcript_understanding;
mod handoff_runtime;
mod http;
mod intent_confidence_router;
mod layered_intent_runtime;
mod lifecycle;
mod model;
mod multimodal_emotion_runtime;
mod post_call_finalization;
mod post_call_finalization_postgres;
mod repository;
mod result_generation;
mod safety_intent_provider;
mod text_emotion_classifier;
mod text_emotion_runtime;
mod tool_runtime;
mod understanding_postgres;
mod understanding_runtime;
mod worker;

pub use acoustic_emotion_classifier::{
    AcousticEmotionCandidateOutput, AcousticEmotionClassifierArtifactInput,
    AcousticEmotionClassifierOutput, AcousticEmotionClassifierPort,
    AcousticEmotionClassifierPortError, AcousticEmotionClassifierProvider,
    AcousticEmotionClassifierProviderError, AcousticEmotionClassifierRequest, AudioEvidenceWindow,
    AudioEvidenceWindowError, AudioEvidenceWindowInput,
};
pub use active_call_channel_agent::{
    ActiveCallChannelAgent, ActiveCallChannelAgentConfig, ActiveCallChannelAgentConfigError,
};
pub use active_call_handoff::ActiveCallHandoffPort;
pub use active_call_intent::{
    ActiveCallIntentProjectionError, resolve_active_call_intent_evidence,
};
pub use active_call_playbook_artifact::{
    ActiveCallPlaybookArtifact, ActiveCallPlaybookArtifactError,
};
pub use active_call_playbook_resolver::{
    ActiveCallArtifactSource, ActiveCallArtifactSourcePort, ActiveCallPlaybookResolver,
    ActiveCallPlaybookResolverError,
};
pub use active_call_reservation::{ActiveCallReservationAdapter, ActiveCallReservationObservation};
pub use active_call_transcript::{
    ActiveCallTranscriptBinding, ActiveCallTranscriptBindingInput,
    ActiveCallTranscriptDurabilityPort, ActiveCallTranscriptIngestError,
    append_active_call_final_transcript,
};
pub use active_call_transcript_postgres::{
    PostgresTranscriptUnderstandingSource, TranscriptUnderstandingHistoryPort,
    TranscriptUnderstandingSourceError, map_postgres_transcript_understanding_disposition,
    prepare_postgres_transcript_understanding_source,
};
pub use adaptive_emotion_runtime::{
    AcousticEmotionFailurePolicy, AdaptiveEmotionTurnRuntime, AdaptiveEmotionTurnRuntimeError,
};
pub use campaign_admin::{
    AdminMutationResource, CampaignAdminAccess, CampaignAdminError, CampaignAdminPort,
};
pub use campaign_admin_http::campaign_admin_router;
pub use campaign_retry::{
    CampaignRetryRequest, CampaignRetryWorker, RetryDurabilityPort, RetryPersistenceRequest,
    RetryWorkerDecision, RetryWorkerError, RetryWriteDecision,
};
pub use contextual_intent_provider::{
    ContextualIntentArtifactInput, ContextualIntentCandidateOutput,
    ContextualIntentClassifierOutput, ContextualIntentClassifierPort,
    ContextualIntentClassifierPortError, ContextualIntentClassifierProvider,
    ContextualIntentClassifierProviderError, ContextualIntentClassifierRequest,
    ContextualIntentTurn,
};
pub use conversation_finalization::{
    ConversationFinalizationEvidence, ConversationFinalizationProjector,
    FinalizationEvidenceObservation, FinalizationEvidenceSourcePort,
};
pub use conversation_projection::{
    ConversationEvaluationDurabilityPort, ConversationEvaluationProviderPort,
    ConversationEvidenceDurabilityPort, ConversationProjectionDurabilityPort,
    ConversationProjectionPortError, ConversationProjectionProviderPort,
    ConversationProjectionRuntime, DurableProjectionPrepareDecision,
    DurableProjectionWriteDecision, DurableTranscriptAppendDecision, EvaluationProjectionProgress,
    ProjectionObservation, ResultProjectionProgress, TerminalEvidenceProgress,
};
pub use conversation_quality::{
    ConversationQualityAccess, ConversationQualityQueryError, ConversationQualityQueryPort,
};
pub use conversation_quality_http::conversation_quality_router;
pub use fast_intent_classifier::{
    FastIntentCandidateOutput, FastIntentClassifierArtifactInput, FastIntentClassifierOutput,
    FastIntentClassifierPort, FastIntentClassifierPortError, FastIntentClassifierProvider,
    FastIntentClassifierProviderError, FastIntentClassifierRequest,
};
pub use final_transcript_understanding::{
    FinalTranscriptUnderstandingError, FinalTranscriptUnderstandingInput,
    FinalTranscriptUnderstandingOutcome, MultimodalFinalTranscriptUnderstandingInput,
    PersistedUnderstandingTurn, TranscriptUnderstandingDisposition,
    process_final_transcript_understanding, process_final_transcript_understanding_multimodal,
};
pub use handoff_runtime::{
    AiResumeCommandIds, AiResumeRequest, ChannelAgentHandoffPort, DurableCreateDecision,
    DurablePrepareDecision, EffectObservation, GenerationCommit, HandoffDurabilityPort,
    HandoffProgress, HandoffRuntime, HumanActivationCommandIds, HumanDialRequest,
    HumanLegObservation, TelephonyHandoffPort, VoiceHandoffPortError, VoiceHandoffRuntimeError,
};
pub use http::router;
pub use intent_confidence_router::{
    IntentConfidenceRouter, IntentConfidenceRouterError, IntentFallbackReason,
    IntentResolutionPath, IntentTurnResolution, IntentTurnRoute, PendingIntentTurn,
};
pub use layered_intent_runtime::{
    ContextualFailurePolicy, LayeredIntentRuntime, LayeredIntentRuntimeError,
};
pub use lifecycle::{AdmissionReadiness, ShutdownToken, WorkerConfig, WorkerConfigError};
pub use model::{
    AgentReleaseResource, AttemptResource, AuthenticatedTenant, CampaignResource, ModelError,
    Outcome, PostCallState, RetryInspectionState, WorkerResource,
};
pub use multimodal_emotion_runtime::{
    MultimodalEmotionFusionPolicy, MultimodalEmotionTurnRuntime, MultimodalEmotionTurnRuntimeError,
};
pub use post_call_finalization::{
    ConversationFinalizationWorker, FinalizationBatchProgress, FinalizationProjectionPort,
    FinalizationProjectionProgress, FinalizationQueuePort, FinalizationWorkerError,
};
pub use repository::{ReconcileReceipt, RepositoryError, VoiceAgentRepository};
pub use result_generation::ResultGenerationEvidence;
pub use safety_intent_provider::{
    SafetyIntentMatchKind, SafetyIntentProvider, SafetyIntentProviderError, SafetyIntentRuleInput,
    SafetyIntentRuleSetInput,
};
pub use text_emotion_classifier::{
    TextEmotionCandidateOutput, TextEmotionClassifierArtifactInput, TextEmotionClassifierOutput,
    TextEmotionClassifierPort, TextEmotionClassifierPortError, TextEmotionClassifierProvider,
    TextEmotionClassifierProviderError, TextEmotionClassifierRequest,
};
pub use text_emotion_runtime::{
    EmotionTurnResolution, TextEmotionTurnRuntime, TextEmotionTurnRuntimeError,
};
pub use tool_runtime::{
    ToolBinding, ToolBindingPort, ToolBrokerPort, ToolEventOutcome, ToolResultPort, ToolRuntime,
    ToolRuntimeError,
};
pub use understanding_runtime::{
    CompleteUnderstandingTurnInput, PreparedUnderstandingTurn, RecoveredUnderstanding,
    ResolvedUnderstandingTurnWriteInput, UnderstandingAppendDecision, UnderstandingDurabilityPort,
    UnderstandingPortError, UnderstandingRecoveryInputs, UnderstandingRuntime,
    UnderstandingTurnWriteInput,
};
pub use worker::{VoiceAgentWorker, WorkerError};
