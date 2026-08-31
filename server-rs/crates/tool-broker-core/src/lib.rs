//! Converact authority boundary for Agent tool proposals and actions.

#![forbid(unsafe_code)]

mod approval;
mod definition;
mod gate;
mod ports;
mod proposal;

pub use approval::{ApprovalGrant, ApprovalGrantError, ApprovalGrantInput};
pub use definition::{ToolDefinition, ToolDefinitionError, ToolEffectClass, ToolRisk};
pub use gate::{AuthorizedToolAction, ToolAuthorizationError, ToolGate};
pub use ports::{
    ApprovalPort, PolicyDecision, PolicyPort, ToolCatalogPort, ToolPortError, ToolSchemaPort,
};
pub use proposal::{ProposalError, ToolProposal, ToolProposalInput};
