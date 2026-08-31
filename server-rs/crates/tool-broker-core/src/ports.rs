use std::future::Future;

use crate::{ApprovalGrant, ToolDefinition, ToolProposal};

/// Closed Policy result. Callers cannot invent a weaker interpretation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PolicyDecision {
    Denied,
    Allowed,
    ApprovalRequired,
}

/// Bounded dependency error safe for logs and retry policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ToolPortError {
    code: &'static str,
}

impl ToolPortError {
    #[must_use]
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

/// Resolves one immutable Tool definition; it does not return URLs or Secrets.
pub trait ToolCatalogPort {
    fn resolve(
        &self,
        proposal: &ToolProposal,
    ) -> impl Future<Output = Result<Option<ToolDefinition>, ToolPortError>> + Send;
}

/// Validates bounded arguments against the exact frozen schema.
pub trait ToolSchemaPort {
    fn validate(
        &self,
        definition: &ToolDefinition,
        proposal: &ToolProposal,
    ) -> impl Future<Output = Result<(), ToolPortError>> + Send;
}

/// Resolves tenant and current-generation Policy without performing an Action.
pub trait PolicyPort {
    fn evaluate(
        &self,
        definition: &ToolDefinition,
        proposal: &ToolProposal,
    ) -> impl Future<Output = Result<PolicyDecision, ToolPortError>> + Send;
}

/// Finds only a durable Approval candidate for the exact Proposal lookup tuple.
pub trait ApprovalPort {
    fn exact_grant(
        &self,
        proposal: &ToolProposal,
    ) -> impl Future<Output = Result<Option<ApprovalGrant>, ToolPortError>> + Send;
}
