//! Durable `PostgreSQL` boundary for Converact AI outbound Attempts.

mod authoring;
mod postgres;

pub use authoring::{
    AdminCommandKind, AdminWriteReceipt, AgentReleaseWrite, CampaignCreateWrite,
    CampaignTransitionWrite, ContactAttemptWrite, ContactImportWrite, StoredCampaign,
};

pub use postgres::{
    AdvanceAttempt, AiOutboundStore, AppendEffectIntent, AppendEvent, AppendEventStatus,
    AttemptLease, AttemptLeaseInput, ClaimedAttempt, PlanRetryAttempt, PlanRetryAttemptInput,
    PlanRetryStatus, StoreConfig, StoreError,
};
