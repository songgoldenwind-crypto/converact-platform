//! Rust application boundary for bounded AI outbound voice work.

#![forbid(unsafe_code)]

mod http;
mod lifecycle;
mod model;
mod repository;
mod worker;

pub use http::router;
pub use lifecycle::{AdmissionReadiness, ShutdownToken, WorkerConfig, WorkerConfigError};
pub use model::{
    AgentReleaseResource, AttemptResource, AuthenticatedTenant, CampaignResource,
    ConversationEvidence, ModelError, Outcome, WorkerResource,
};
pub use repository::{ReconcileReceipt, RepositoryError, VoiceAgentRepository};
pub use worker::{ConversationEvidencePort, VoiceAgentWorker, WorkerError};
