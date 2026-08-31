use std::future::Future;

use crate::{
    ActionObservation, ActionReceipt, ApprovalGrant, AuthorizedToolAction, PrepareDecision,
    ToolDefinition, ToolProposal,
};

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

/// Durable Action authority. Its atomic `prepare` result is the only execute permission.
pub trait ToolActionStorePort {
    fn prepare(
        &self,
        action: &AuthorizedToolAction,
        now_ms: u64,
    ) -> impl Future<Output = Result<PrepareDecision, ToolPortError>> + Send;

    /// Atomically persists completed + state-observed evidence and its result projection.
    fn finalize(
        &self,
        action: &AuthorizedToolAction,
        observation: ActionObservation,
        now_ms: u64,
    ) -> impl Future<Output = Result<ActionReceipt, ToolPortError>> + Send;
}

/// Deployment-registered Rust Adapter. No method accepts an arbitrary URL or Secret.
pub trait ToolActionPort {
    fn execute(
        &self,
        action: &AuthorizedToolAction,
    ) -> impl Future<Output = Result<ActionObservation, ToolPortError>> + Send;

    fn query(
        &self,
        action: &AuthorizedToolAction,
    ) -> impl Future<Output = Result<ActionObservation, ToolPortError>> + Send;
}
