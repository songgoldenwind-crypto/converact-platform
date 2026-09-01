//! Rust application boundary for bounded AI outbound voice work.

#![forbid(unsafe_code)]

mod acoustic_emotion_classifier;
mod active_call_channel_agent;
mod active_call_event_consumer;
mod active_call_event_postgres;
mod active_call_handoff;
mod active_call_intent;
mod active_call_playbook_artifact;
mod active_call_playbook_postgres;
mod active_call_playbook_resolver;
mod active_call_reservation;
mod active_call_transcript;
mod active_call_transcript_postgres;
mod active_call_understanding;
mod adaptive_emotion_runtime;
mod campaign_admin;
mod campaign_admin_http;
mod campaign_retry;
mod channel_agent_session;
mod claim_supervisor;
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
mod model_provider_pool;
mod multimodal_emotion_runtime;
mod platform_auth;
mod post_call_finalization;
mod post_call_finalization_postgres;
mod postgres_repository;
mod process;
mod repository;
mod result_generation;
mod safety_intent_provider;
mod structured_model_http_transport;
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
pub use active_call_event_consumer::{
    ActiveCallDurableEvent, ActiveCallEventAppendDecision, ActiveCallEventConsumerError,
    ActiveCallEventConsumerOutcome, ActiveCallEventInboxError, ActiveCallEventInboxPort,
    ActiveCallEventInboxSnapshot, ActiveCallEventInboxStatus, ActiveCallEventProcessingError,
    ActiveCallEventProcessorPort, ActiveCallEventReconcileReason,
    ActiveCallUnderstandingEventProcessor, consume_active_call_events_once,
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
    prepare_postgres_transcript_understanding_source, prepare_transcript_understanding_source,
};
pub use active_call_understanding::{
    ActiveCallUnderstandingEventError, ActiveCallUnderstandingEventOutcome,
    FinalTranscriptUnderstandingPort, TranscriptUnderstandingAppendReceipt,
    process_active_call_understanding_event,
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
pub use claim_supervisor::{
    AttemptClaimSource, ClaimBatchProgress, ClaimSupervisor, ClaimedAttemptExecutor,
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
    PersistedUnderstandingTurn, TextFinalTranscriptUnderstandingProcessor,
    TextFinalTranscriptUnderstandingProcessorInput, TranscriptUnderstandingDisposition,
    process_final_transcript_understanding, process_final_transcript_understanding_multimodal,
};
pub use handoff_runtime::{
    AiResumeCommandIds, AiResumeRequest, ChannelAgentHandoffPort, DurableCreateDecision,
    DurablePrepareDecision, EffectObservation, GenerationCommit, HandoffDurabilityPort,
    HandoffProgress, HandoffRuntime, HumanActivationCommandIds, HumanDialRequest,
    HumanLegObservation, TelephonyHandoffPort, VoiceHandoffPortError, VoiceHandoffRuntimeError,
};
pub use http::{router, router_with_platform_auth};
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
pub use model_provider_pool::{
    ModelProviderLease, ModelProviderPool, ModelProviderPoolConfig, ModelProviderPoolError,
    PooledModelProviderPort,
};
pub use multimodal_emotion_runtime::{
    MultimodalEmotionFusionPolicy, MultimodalEmotionTurnRuntime, MultimodalEmotionTurnRuntimeError,
};
pub use platform_auth::{FixedWallClock, PlatformTokenAuthenticator, SystemWallClock, WallClock};
pub use post_call_finalization::{
    ConversationFinalizationWorker, FinalizationBatchProgress, FinalizationProjectionPort,
    FinalizationProjectionProgress, FinalizationQueuePort, FinalizationWorkerError,
};
pub use postgres_repository::PostgresVoiceAgentRepository;
pub use process::{WorkerServeError, serve_worker_http};
pub use repository::{
    ReconcileReceipt, RepositoryError, RepositoryErrorKind, VoiceAgentRepository,
};
pub use result_generation::ResultGenerationEvidence;
pub use safety_intent_provider::{
    SafetyIntentMatchKind, SafetyIntentProvider, SafetyIntentProviderError, SafetyIntentRuleInput,
    SafetyIntentRuleSetInput,
};
pub use structured_model_http_transport::{
    ModelInferenceHttpConfig, ModelInferenceHttpConfigError, ModelInferenceHttpTransport,
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
