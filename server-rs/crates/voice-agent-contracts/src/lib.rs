//! Bounded wire contracts for Converact voice-agent runtimes.

mod command;
mod event;
mod id;
mod state;

pub use command::{
    AttemptCommand, CommandEnvelope, EnvelopeContext, EnvelopeContextInput, EnvelopeError,
    VOICE_AGENT_SCHEMA_VERSION,
};
pub use event::EventEnvelope;
pub use id::{
    ActionReceiptId, AgentDefinitionId, AgentReleaseId, ApprovalId, CallAttemptId, CallId,
    CampaignContactId, CampaignId, ChannelAgentSessionId, ContextPacketId, EventId,
    ExecutionGeneration, HandoffCommandId, HandoffId, HumanLegId, IdempotencyKey, IdentityError,
    InteractionId, ToolCallId, ToolRevisionId,
};
pub use state::{AgentReleaseState, CallAttemptState, CampaignState};
