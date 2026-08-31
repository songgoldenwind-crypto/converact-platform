use std::{error::Error, fmt};

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};

use crate::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    ExecutionGeneration, IdempotencyKey, InteractionId, id::is_valid_bounded_identifier,
};

/// The only schema version accepted by the first voice-agent boundary.
pub const VOICE_AGENT_SCHEMA_VERSION: u16 = 1;

/// A rejected command or event envelope.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnvelopeError {
    /// The sender and receiver do not share a frozen schema version.
    UnsupportedSchemaVersion,
    /// The tenant identifier is malformed or unbounded.
    InvalidTenantId,
    /// The distributed trace identifier is malformed or unbounded.
    InvalidTraceId,
    /// An event claims to have been received before it occurred.
    InvalidTimestampOrder,
}

impl fmt::Display for EnvelopeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::UnsupportedSchemaVersion => "voice_agent_schema_version_unsupported",
            Self::InvalidTenantId => "voice_agent_tenant_id_invalid",
            Self::InvalidTraceId => "voice_agent_trace_id_invalid",
            Self::InvalidTimestampOrder => "voice_agent_timestamp_order_invalid",
        })
    }
}

impl Error for EnvelopeError {}

/// Validated authority fields shared by every cross-process command and event.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct EnvelopeContext {
    schema_version: u16,
    tenant_id: Box<str>,
    interaction_id: InteractionId,
    campaign_id: CampaignId,
    campaign_contact_id: CampaignContactId,
    call_attempt_id: CallAttemptId,
    #[serde(skip_serializing_if = "Option::is_none")]
    call_id: Option<CallId>,
    agent_release_id: AgentReleaseId,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel_agent_session_id: Option<ChannelAgentSessionId>,
    execution_generation: ExecutionGeneration,
    trace_id: Box<str>,
}

/// Unvalidated values accepted by [`EnvelopeContext::try_new`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnvelopeContextInput {
    pub schema_version: u16,
    pub tenant_id: String,
    pub interaction_id: InteractionId,
    pub campaign_id: CampaignId,
    pub campaign_contact_id: CampaignContactId,
    pub call_attempt_id: CallAttemptId,
    pub call_id: Option<CallId>,
    pub agent_release_id: AgentReleaseId,
    pub channel_agent_session_id: Option<ChannelAgentSessionId>,
    pub execution_generation: ExecutionGeneration,
    pub trace_id: String,
}

#[derive(Deserialize)]
struct EnvelopeContextWire {
    schema_version: u16,
    tenant_id: String,
    interaction_id: InteractionId,
    campaign_id: CampaignId,
    campaign_contact_id: CampaignContactId,
    call_attempt_id: CallAttemptId,
    call_id: Option<CallId>,
    agent_release_id: AgentReleaseId,
    channel_agent_session_id: Option<ChannelAgentSessionId>,
    execution_generation: ExecutionGeneration,
    trace_id: String,
}

impl EnvelopeContext {
    /// Validates and creates cross-process authority metadata.
    ///
    /// # Errors
    ///
    /// Rejects unknown schema versions and malformed tenant or trace identifiers.
    pub fn try_new(input: EnvelopeContextInput) -> Result<Self, EnvelopeError> {
        if input.schema_version != VOICE_AGENT_SCHEMA_VERSION {
            return Err(EnvelopeError::UnsupportedSchemaVersion);
        }
        if !is_valid_bounded_identifier(&input.tenant_id) {
            return Err(EnvelopeError::InvalidTenantId);
        }
        if !is_valid_bounded_identifier(&input.trace_id) {
            return Err(EnvelopeError::InvalidTraceId);
        }
        Ok(Self {
            schema_version: input.schema_version,
            tenant_id: input.tenant_id.into(),
            interaction_id: input.interaction_id,
            campaign_id: input.campaign_id,
            campaign_contact_id: input.campaign_contact_id,
            call_attempt_id: input.call_attempt_id,
            call_id: input.call_id,
            agent_release_id: input.agent_release_id,
            channel_agent_session_id: input.channel_agent_session_id,
            execution_generation: input.execution_generation,
            trace_id: input.trace_id.into(),
        })
    }

    /// Returns the accepted schema version.
    #[must_use]
    pub const fn schema_version(&self) -> u16 {
        self.schema_version
    }

    /// Returns the tenant authority binding.
    #[must_use]
    pub fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    /// Returns the interaction authority binding.
    #[must_use]
    pub const fn interaction_id(&self) -> &InteractionId {
        &self.interaction_id
    }

    /// Returns the physical call Attempt authority binding.
    #[must_use]
    pub const fn call_attempt_id(&self) -> &CallAttemptId {
        &self.call_attempt_id
    }

    /// Returns the established `RustPBX` Call binding when one exists.
    #[must_use]
    pub const fn call_id(&self) -> Option<&CallId> {
        self.call_id.as_ref()
    }

    /// Returns the immutable Agent Release authority binding.
    #[must_use]
    pub const fn agent_release_id(&self) -> &AgentReleaseId {
        &self.agent_release_id
    }

    /// Returns the current channel-agent session when one is attached.
    #[must_use]
    pub const fn channel_agent_session_id(&self) -> Option<&ChannelAgentSessionId> {
        self.channel_agent_session_id.as_ref()
    }

    /// Returns the execution generation used to fence stale work.
    #[must_use]
    pub const fn execution_generation(&self) -> ExecutionGeneration {
        self.execution_generation
    }
}

impl<'de> Deserialize<'de> for EnvelopeContext {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = EnvelopeContextWire::deserialize(deserializer)?;
        Self::try_new(EnvelopeContextInput {
            schema_version: wire.schema_version,
            tenant_id: wire.tenant_id,
            interaction_id: wire.interaction_id,
            campaign_id: wire.campaign_id,
            campaign_contact_id: wire.campaign_contact_id,
            call_attempt_id: wire.call_attempt_id,
            call_id: wire.call_id,
            agent_release_id: wire.agent_release_id,
            channel_agent_session_id: wire.channel_agent_session_id,
            execution_generation: wire.execution_generation,
            trace_id: wire.trace_id,
        })
        .map_err(D::Error::custom)
    }
}

/// Commands accepted by the durable call-attempt state machine.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptCommand {
    Claim,
    ApproveCompliance,
    BlockCompliance,
    ReserveAgentCapacity,
    Dial,
    ObserveRinging,
    ObserveAnswered,
    AttachAgent,
    AwaitDisclosure,
    CompleteDisclosure,
    StartConversation,
    RequestHandoff,
    CommitHumanHandoff,
    ResumeAi,
    Finalize,
    Complete,
    Cancel,
    MarkBusy,
    MarkNoAnswer,
    MarkRejected,
    MarkFailedBeforeAnswer,
    MarkFailedAfterAnswer,
    MarkOutcomeUnknown,
    RequireReconcile,
    Retry,
}

/// A versioned, tenant-bound, idempotent cross-process command.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CommandEnvelope<T> {
    #[serde(flatten)]
    context: EnvelopeContext,
    idempotency_key: IdempotencyKey,
    command: T,
}

impl<T> CommandEnvelope<T> {
    /// Creates a command from validated authority metadata.
    #[must_use]
    pub const fn new(
        context: EnvelopeContext,
        idempotency_key: IdempotencyKey,
        command: T,
    ) -> Self {
        Self {
            context,
            idempotency_key,
            command,
        }
    }

    /// Returns the validated authority metadata.
    #[must_use]
    pub const fn context(&self) -> &EnvelopeContext {
        &self.context
    }

    /// Returns the idempotency key for the directed effect.
    #[must_use]
    pub const fn idempotency_key(&self) -> &IdempotencyKey {
        &self.idempotency_key
    }

    /// Returns the command payload.
    #[must_use]
    pub const fn command(&self) -> &T {
        &self.command
    }
}
