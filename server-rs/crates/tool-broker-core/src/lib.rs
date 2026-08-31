//! Converact authority boundary for Agent tool proposals and actions.

#![forbid(unsafe_code)]

mod approval;
mod broker;
mod definition;
mod gate;
mod ports;
mod proposal;
mod receipt;

pub use approval::{ApprovalGrant, ApprovalGrantError, ApprovalGrantInput};
pub use broker::{BrokerError, BrokerResult, PrepareDecision, ToolBroker};
pub use converact_voice_agent_contracts::ActionReceiptId;
pub use definition::{ToolDefinition, ToolDefinitionError, ToolEffectClass, ToolRisk};
pub use gate::{AuthorizedToolAction, ToolAuthorizationError, ToolGate};
pub use ports::{
    ApprovalPort, PolicyDecision, PolicyPort, ToolActionPort, ToolActionStorePort, ToolCatalogPort,
    ToolPortError, ToolSchemaPort,
};
pub use proposal::{ProposalError, ToolProposal, ToolProposalInput};
pub use receipt::{
    ActionFailureCode, ActionObservation, ActionReceipt, ActionReceiptError, ActionResolution,
    ToolActionOutput,
};
