use std::{error::Error, fmt};

use converact_voice_agent_contracts::ApprovalId;

use crate::{
    ApprovalPort, PolicyDecision, PolicyPort, ToolCatalogPort, ToolDefinition, ToolProposal,
    ToolRisk, ToolSchemaPort,
};

/// Proof that all fail-closed pre-execution checks passed for one Proposal.
#[derive(Debug)]
pub struct AuthorizedToolAction {
    proposal: ToolProposal,
    definition: ToolDefinition,
    approval_id: Option<ApprovalId>,
}

impl AuthorizedToolAction {
    #[must_use]
    pub const fn proposal(&self) -> &ToolProposal {
        &self.proposal
    }

    #[must_use]
    pub const fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    #[must_use]
    pub const fn approval_id(&self) -> Option<&ApprovalId> {
        self.approval_id.as_ref()
    }
}

/// Pure pre-execution authority gate. It cannot execute an external Action.
pub struct ToolGate<C, S, P, A> {
    catalog: C,
    schema: S,
    policy: P,
    approval: A,
}

impl<C, S, P, A> ToolGate<C, S, P, A>
where
    C: ToolCatalogPort,
    S: ToolSchemaPort,
    P: PolicyPort,
    A: ApprovalPort,
{
    #[must_use]
    pub const fn new(catalog: C, schema: S, policy: P, approval: A) -> Self {
        Self {
            catalog,
            schema,
            policy,
            approval,
        }
    }

    /// Resolves the exact definition, schema, Policy and required Approval.
    ///
    /// # Errors
    ///
    /// Fails closed for unavailable dependencies, mismatched authority and missing Approval.
    pub async fn authorize(
        &self,
        proposal: ToolProposal,
        now_ms: u64,
    ) -> Result<AuthorizedToolAction, ToolAuthorizationError> {
        if now_ms >= proposal.deadline_ms() {
            return Err(ToolAuthorizationError::DeadlineElapsed);
        }
        let definition = self
            .catalog
            .resolve(&proposal)
            .await
            .map_err(|_| ToolAuthorizationError::CatalogUnavailable)?
            .ok_or(ToolAuthorizationError::ToolUnavailable)?;
        if definition.revision_id() != proposal.tool_revision_id()
            || definition.agent_release_id() != proposal.context().agent_release_id()
            || definition.schema_hash() != proposal.tool_schema_hash()
        {
            return Err(ToolAuthorizationError::AuthorityMismatch);
        }
        self.schema
            .validate(&definition, &proposal)
            .await
            .map_err(|_| ToolAuthorizationError::SchemaRejected)?;
        let policy = self
            .policy
            .evaluate(&definition, &proposal)
            .await
            .map_err(|_| ToolAuthorizationError::PolicyUnavailable)?;
        if policy == PolicyDecision::Denied {
            return Err(ToolAuthorizationError::Denied);
        }
        let approval_required =
            definition.risk() == ToolRisk::High || policy == PolicyDecision::ApprovalRequired;
        let approval_id = if approval_required {
            let grant = self
                .approval
                .exact_grant(&proposal)
                .await
                .ok()
                .flatten()
                .filter(|grant| grant.authorizes(&proposal, now_ms))
                .ok_or(ToolAuthorizationError::ApprovalRequired)?;
            Some(grant.approval_id().clone())
        } else {
            None
        };
        Ok(AuthorizedToolAction {
            proposal,
            definition,
            approval_id,
        })
    }
}

/// Stable pre-execution rejection safe for Agent feedback and logs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolAuthorizationError {
    DeadlineElapsed,
    CatalogUnavailable,
    ToolUnavailable,
    AuthorityMismatch,
    SchemaRejected,
    PolicyUnavailable,
    Denied,
    ApprovalRequired,
}

impl ToolAuthorizationError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::DeadlineElapsed => "tool_deadline_elapsed",
            Self::CatalogUnavailable => "tool_catalog_unavailable",
            Self::ToolUnavailable => "tool_unavailable",
            Self::AuthorityMismatch => "tool_authority_mismatch",
            Self::SchemaRejected => "tool_schema_rejected",
            Self::PolicyUnavailable => "tool_policy_unavailable",
            Self::Denied => "tool_denied",
            Self::ApprovalRequired => "approval_required",
        }
    }
}

impl fmt::Display for ToolAuthorizationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ToolAuthorizationError {}
