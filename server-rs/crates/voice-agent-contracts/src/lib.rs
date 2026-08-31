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
    ActionReceiptId, AgentDefinitionId, AgentReleaseId, ApprovalId, BadCaseId, CallAttemptId,
    CallId, CampaignContactId, CampaignId, ChannelAgentSessionId, ContextPacketId,
    ConversationFinalizationJobId, ConversationFinalizationReceiptId, ConversationResultId,
    EvaluationId, EvaluationRubricRevisionId, EventId, ExecutionGeneration, HandoffCommandId,
    HandoffId, HandoffReceiptId, HumanLegId, IdempotencyKey, IdentityError, InteractionId,
    OutcomeSchemaRevisionId, ResultProjectionCommandId, ResultProjectionReceiptId, TenantId,
    ToolCallId, ToolRevisionId, TranscriptSegmentId, TranscriptSnapshotId,
};
pub use state::{AgentReleaseState, CallAttemptState, CampaignState};
