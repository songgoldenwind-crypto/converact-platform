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
    AgentDefinitionId, AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId,
    ChannelAgentSessionId, EventId, ExecutionGeneration, IdempotencyKey, IdentityError,
    InteractionId,
};
pub use state::{AgentReleaseState, CallAttemptState, CampaignState};
