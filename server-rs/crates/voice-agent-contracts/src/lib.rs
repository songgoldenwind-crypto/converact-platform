//! Bounded wire contracts for Converact voice-agent runtimes.

mod command;
mod event;
mod id;
mod speech;
mod state;

pub use command::{
    AttemptCommand, CommandEnvelope, EnvelopeContext, EnvelopeContextInput, EnvelopeError,
    VOICE_AGENT_SCHEMA_VERSION,
};
pub use event::EventEnvelope;
pub use id::{
    ActionReceiptId, AgentDefinitionId, AgentReleaseId, ApprovalId, AudioEvidenceWindowId,
    AgentRunId, BadCaseId, CallAttemptId, CallId, CampaignContactId, CampaignId,
    ChannelAgentSessionId, ChannelBindingId, ContextPacketId, ConversationFinalizationJobId,
    ConversationFinalizationReceiptId, ConversationResultId, CustomerStateSnapshotId,
    DialoguePolicyRevisionId,
    DialogueRecommendationId, EmotionCatalogRevisionId, EmotionFusionId, EmotionObservationId,
    EvaluationId, EvaluationRubricRevisionId, EventId, ExecutionGeneration, HandoffCommandId,
    HandoffId, HandoffReceiptId, HumanLegId, IdempotencyKey, IdentityError,
    IntentCatalogRevisionId, IntentObservationId, InteractionId, OutcomeSchemaRevisionId,
    ResultProjectionCommandId, ResultProjectionReceiptId, SpeechResponseId, SpeechSessionId,
    TenantId, ToolCallId, ToolRevisionId, TranscriptSegmentId, TranscriptSnapshotId,
};
pub use speech::{
    AudioEncoding, AudioWriteOutcome, ContextRevision, PcmAudioFrame, ResponseFence,
    ResponseGeneration, ResponseLease, ResponseLeaseGeneration, SpeechContractError,
    SpeechControlFence, SpeechRuntimeEventKind, SpeechSessionBinding, SpeechSessionState,
};
pub use state::{AgentReleaseState, CallAttemptState, CampaignState};
