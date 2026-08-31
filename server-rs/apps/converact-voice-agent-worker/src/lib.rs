//! Rust application boundary for bounded AI outbound voice work.

#![forbid(unsafe_code)]

mod campaign_retry;
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
mod tool_runtime;
mod worker;

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
    Outcome, PostCallState, WorkerResource,
};
pub use post_call_finalization::{
    ConversationFinalizationWorker, FinalizationBatchProgress, FinalizationProjectionPort,
    FinalizationProjectionProgress, FinalizationQueuePort, FinalizationWorkerError,
};
pub use repository::{ReconcileReceipt, RepositoryError, VoiceAgentRepository};
pub use tool_runtime::{
    ToolBinding, ToolBindingPort, ToolBrokerPort, ToolEventOutcome, ToolResultPort, ToolRuntime,
    ToolRuntimeError,
};
pub use worker::{VoiceAgentWorker, WorkerError};
