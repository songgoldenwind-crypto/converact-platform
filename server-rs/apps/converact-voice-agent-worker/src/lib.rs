//! Rust application boundary for bounded AI outbound voice work.

#![forbid(unsafe_code)]

mod active_call_channel_agent;
mod active_call_handoff;
mod active_call_intent;
mod active_call_playbook_artifact;
mod active_call_playbook_resolver;
mod active_call_reservation;
mod campaign_admin;
mod campaign_admin_http;
mod campaign_retry;
mod channel_agent_session;
mod conversation_finalization;
mod conversation_projection;
mod conversation_projection_postgres;
mod conversation_quality;
mod conversation_quality_http;
mod conversation_quality_postgres;
mod handoff_runtime;
mod http;
mod lifecycle;
mod model;
mod post_call_finalization;
mod post_call_finalization_postgres;
mod repository;
mod result_generation;
mod safety_intent_provider;
mod tool_runtime;
mod understanding_postgres;
mod understanding_runtime;
mod worker;

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
pub use campaign_admin::{
    AdminMutationResource, CampaignAdminAccess, CampaignAdminError, CampaignAdminPort,
};
pub use campaign_admin_http::campaign_admin_router;
pub use campaign_retry::{
    CampaignRetryRequest, CampaignRetryWorker, RetryDurabilityPort, RetryPersistenceRequest,
    RetryWorkerDecision, RetryWorkerError, RetryWriteDecision,
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
pub use handoff_runtime::{
    AiResumeCommandIds, AiResumeRequest, ChannelAgentHandoffPort, DurableCreateDecision,
    DurablePrepareDecision, EffectObservation, GenerationCommit, HandoffDurabilityPort,
    HandoffProgress, HandoffRuntime, HumanActivationCommandIds, HumanDialRequest,
    HumanLegObservation, TelephonyHandoffPort, VoiceHandoffPortError, VoiceHandoffRuntimeError,
};
pub use http::router;
pub use lifecycle::{AdmissionReadiness, ShutdownToken, WorkerConfig, WorkerConfigError};
pub use model::{
    AgentReleaseResource, AttemptResource, AuthenticatedTenant, CampaignResource, ModelError,
    Outcome, PostCallState, RetryInspectionState, WorkerResource,
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
pub use tool_runtime::{
    ToolBinding, ToolBindingPort, ToolBrokerPort, ToolEventOutcome, ToolResultPort, ToolRuntime,
    ToolRuntimeError,
};
pub use understanding_runtime::{
    RecoveredUnderstanding, UnderstandingAppendDecision, UnderstandingDurabilityPort,
    UnderstandingPortError, UnderstandingRecoveryInputs, UnderstandingRuntime,
    UnderstandingTurnWriteInput,
};
pub use worker::{VoiceAgentWorker, WorkerError};
