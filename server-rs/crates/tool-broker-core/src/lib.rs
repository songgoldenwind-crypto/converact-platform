//! Converact authority boundary for Agent tool proposals and actions.

#![forbid(unsafe_code)]

mod proposal;

pub use proposal::{ProposalError, ToolProposal, ToolProposalInput};
