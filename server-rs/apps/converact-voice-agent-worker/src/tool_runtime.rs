use std::{error::Error, fmt, future::Future};

use converact_active_call_adapter::NormalizedEvent;
use converact_contracts::canonical_sha256_with_max_bytes;
use converact_tool_broker_core::{
    ActionReceipt, ApprovalPort, BrokerResult, PolicyPort, ToolActionPort, ToolActionStorePort,
    ToolBroker, ToolCatalogPort, ToolPortError, ToolProposal, ToolProposalInput, ToolSchemaPort,
};
use converact_voice_agent_contracts::{EnvelopeContext, ToolCallId, ToolRevisionId};

const MAX_ARGUMENT_BYTES: usize = 65_536;
const MAX_TOOL_DEADLINE_MS: u64 = 120_000;

/// Exact Agent Release binding for one upstream Tool name.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolBinding {
    revision_id: ToolRevisionId,
    schema_hash: Box<str>,
    deadline_after_ms: u64,
}

impl ToolBinding {
    /// Creates a bounded immutable binding.
    ///
    /// # Errors
    ///
    /// Rejects malformed schema digests and zero or excessive deadlines.
    pub fn try_new(
        revision_id: ToolRevisionId,
        schema_hash: impl AsRef<str>,
        deadline_after_ms: u64,
    ) -> Result<Self, ToolRuntimeError> {
        let schema_hash = schema_hash.as_ref();
        if !lowercase_sha256(schema_hash) {
            return Err(ToolRuntimeError::BindingInvalid);
        }
        if deadline_after_ms == 0 || deadline_after_ms > MAX_TOOL_DEADLINE_MS {
            return Err(ToolRuntimeError::BindingInvalid);
        }
        Ok(Self {
            revision_id,
            schema_hash: schema_hash.into(),
            deadline_after_ms,
        })
    }
}

/// Resolves a friendly upstream name only within the exact Agent Release.
pub trait ToolBindingPort {
    fn resolve(
        &self,
        authority: &EnvelopeContext,
        tool_name: &str,
    ) -> impl Future<Output = Result<Option<ToolBinding>, ToolPortError>> + Send;
}

/// Narrow Worker boundary around the shared Tool Broker.
pub trait ToolBrokerPort {
    fn execute(
        &self,
        proposal: ToolProposal,
        now_ms: u64,
    ) -> impl Future<Output = Result<BrokerResult, ToolPortError>> + Send;
}

impl<C, S, P, A, D, X> ToolBrokerPort for ToolBroker<C, S, P, A, D, X>
where
    C: ToolCatalogPort + Sync,
    S: ToolSchemaPort + Sync,
    P: PolicyPort + Sync,
    A: ApprovalPort + Sync,
    D: ToolActionStorePort + Sync,
    X: ToolActionPort + Sync,
{
    async fn execute(
        &self,
        proposal: ToolProposal,
        now_ms: u64,
    ) -> Result<BrokerResult, ToolPortError> {
        ToolBroker::execute(self, proposal, now_ms)
            .await
            .map_err(|error| ToolPortError::new(error.code()))
    }
}

/// Sends one finalized result to the current channel-agent session.
pub trait ToolResultPort {
    fn deliver(
        &self,
        session_id: &converact_voice_agent_contracts::ChannelAgentSessionId,
        receipt: ActionReceipt,
    ) -> impl Future<Output = Result<(), ToolPortError>> + Send;
}

/// Result of consuming one normalized Active Call event.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolEventOutcome {
    Ignored,
    Pending,
    Historical,
    Delivered,
}

/// Proposal-only Active Call bridge into the shared Tool Broker.
pub struct ToolRuntime<B, K, R> {
    bindings: B,
    broker: K,
    results: R,
}

impl<B, K, R> ToolRuntime<B, K, R>
where
    B: ToolBindingPort,
    K: ToolBrokerPort,
    R: ToolResultPort,
{
    #[must_use]
    pub const fn new(bindings: B, broker: K, results: R) -> Self {
        Self {
            bindings,
            broker,
            results,
        }
    }

    /// Converts a normalized proposal, runs the Broker and returns only current-generation data.
    ///
    /// # Errors
    ///
    /// Fails closed on unknown bindings, malformed proposals, Broker failures or stale receipts.
    pub async fn handle(
        &self,
        event: NormalizedEvent,
        now_ms: u64,
    ) -> Result<ToolEventOutcome, ToolRuntimeError> {
        let NormalizedEvent::ToolProposed {
            authority,
            proposal_id,
            tool_name,
            arguments,
            timestamp_ms,
            ..
        } = event
        else {
            return Ok(ToolEventOutcome::Ignored);
        };
        let binding = self
            .bindings
            .resolve(&authority, &tool_name)
            .await
            .map_err(|_| ToolRuntimeError::BindingUnavailable)?
            .ok_or(ToolRuntimeError::BindingUnavailable)?;
        let arguments_hash = canonical_sha256_with_max_bytes(&arguments, MAX_ARGUMENT_BYTES)
            .map_err(|_| ToolRuntimeError::ProposalInvalid)?;
        let deadline_ms = timestamp_ms
            .checked_add(binding.deadline_after_ms)
            .ok_or(ToolRuntimeError::ProposalInvalid)?;
        let proposal = ToolProposal::try_new(ToolProposalInput {
            context: authority.clone(),
            tool_revision_id: binding.revision_id,
            tool_call_id: ToolCallId::parse(proposal_id.as_ref())
                .map_err(|_| ToolRuntimeError::ProposalInvalid)?,
            tool_schema_hash: binding.schema_hash.into(),
            arguments_hash,
            arguments,
            requested_at_ms: timestamp_ms,
            deadline_ms,
        })
        .map_err(|_| ToolRuntimeError::ProposalInvalid)?;
        let expected_revision = proposal.tool_revision_id().clone();
        let expected_call = proposal.tool_call_id().clone();
        let expected_arguments_hash = proposal.arguments_hash().to_owned();
        match self
            .broker
            .execute(proposal, now_ms)
            .await
            .map_err(|_| ToolRuntimeError::BrokerUnavailable)?
        {
            BrokerResult::Pending => Ok(ToolEventOutcome::Pending),
            BrokerResult::Historical(_) => Ok(ToolEventOutcome::Historical),
            BrokerResult::Consumable(receipt) => {
                if !same_current_receipt(
                    &authority,
                    &expected_revision,
                    &expected_call,
                    &expected_arguments_hash,
                    &receipt,
                ) {
                    return Err(ToolRuntimeError::BrokerContractInvalid);
                }
                let session_id = authority
                    .channel_agent_session_id()
                    .ok_or(ToolRuntimeError::AgentSessionMissing)?;
                self.results
                    .deliver(session_id, *receipt)
                    .await
                    .map_err(|_| ToolRuntimeError::ResultDeliveryUnavailable)?;
                Ok(ToolEventOutcome::Delivered)
            }
        }
    }
}

/// Stable Worker error that excludes arguments, results, endpoints and credentials.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolRuntimeError {
    BindingInvalid,
    BindingUnavailable,
    ProposalInvalid,
    BrokerUnavailable,
    BrokerContractInvalid,
    AgentSessionMissing,
    ResultDeliveryUnavailable,
}

impl ToolRuntimeError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::BindingInvalid => "tool_binding_invalid",
            Self::BindingUnavailable => "tool_binding_unavailable",
            Self::ProposalInvalid => "tool_runtime_proposal_invalid",
            Self::BrokerUnavailable => "tool_broker_unavailable",
            Self::BrokerContractInvalid => "tool_broker_contract_invalid",
            Self::AgentSessionMissing => "tool_agent_session_missing",
            Self::ResultDeliveryUnavailable => "tool_result_delivery_unavailable",
        }
    }
}

impl fmt::Display for ToolRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ToolRuntimeError {}

fn same_current_receipt(
    authority: &EnvelopeContext,
    expected_revision: &ToolRevisionId,
    expected_call: &ToolCallId,
    expected_arguments_hash: &str,
    receipt: &ActionReceipt,
) -> bool {
    let receipt_authority = receipt.authority();
    let authority_matches = receipt_authority.tenant_id() == authority.tenant_id()
        && receipt_authority.interaction_id() == authority.interaction_id()
        && receipt_authority.call_attempt_id() == authority.call_attempt_id()
        && receipt_authority.agent_release_id() == authority.agent_release_id()
        && receipt_authority.execution_generation() == authority.execution_generation();
    authority_matches
        && receipt.tool_revision_id() == expected_revision
        && receipt.tool_call_id() == expected_call
        && receipt.arguments_hash() == expected_arguments_hash
}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}
