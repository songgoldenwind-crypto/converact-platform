//! Rust application boundary for bounded AI outbound voice work.

#![forbid(unsafe_code)]

mod handoff_runtime;
mod http;
mod lifecycle;
mod model;
mod repository;
mod tool_runtime;
mod worker;

pub use handoff_runtime::{
    AiResumeCommandIds, AiResumeRequest, ChannelAgentHandoffPort, DurableCreateDecision,
    DurablePrepareDecision, EffectObservation, GenerationCommit, HandoffDurabilityPort,
    HandoffProgress, HandoffRuntime, HumanActivationCommandIds, HumanDialRequest,
    HumanLegObservation, TelephonyHandoffPort, VoiceHandoffPortError, VoiceHandoffRuntimeError,
};
pub use http::router;
pub use lifecycle::{AdmissionReadiness, ShutdownToken, WorkerConfig, WorkerConfigError};
pub use model::{
    AgentReleaseResource, AttemptResource, AuthenticatedTenant, CampaignResource,
    ConversationEvidence, ModelError, Outcome, WorkerResource,
};
pub use repository::{ReconcileReceipt, RepositoryError, VoiceAgentRepository};
pub use tool_runtime::{
    ToolBinding, ToolBindingPort, ToolBrokerPort, ToolEventOutcome, ToolResultPort, ToolRuntime,
    ToolRuntimeError,
};
pub use worker::{ConversationEvidencePort, VoiceAgentWorker, WorkerError};
