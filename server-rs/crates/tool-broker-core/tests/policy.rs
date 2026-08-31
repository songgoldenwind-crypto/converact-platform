mod support;

use std::{cell::Cell, future::ready};

use converact_tool_broker_core::{
    ApprovalGrant, ApprovalPort, PolicyDecision, PolicyPort, ToolAuthorizationError,
    ToolCatalogPort, ToolDefinition, ToolEffectClass, ToolGate, ToolRisk, ToolSchemaPort,
};
use converact_voice_agent_contracts::{AgentReleaseId, ToolRevisionId};

use support::{NOW_MS, proposal};

#[tokio::test]
async fn high_risk_mutation_without_exact_approval_never_reaches_action() {
    let action_calls = Cell::new(0_u32);
    let gate = ToolGate::new(Catalog, Schema, Policy, MissingApproval);

    let authorization = gate.authorize(proposal(), NOW_MS).await;
    if authorization.is_ok() {
        action_calls.set(action_calls.get() + 1);
    }

    assert_eq!(
        authorization.unwrap_err(),
        ToolAuthorizationError::ApprovalRequired
    );
    assert_eq!(action_calls.get(), 0);
}

struct Catalog;

impl ToolCatalogPort for Catalog {
    async fn resolve(
        &self,
        _proposal: &converact_tool_broker_core::ToolProposal,
    ) -> Result<Option<ToolDefinition>, converact_tool_broker_core::ToolPortError> {
        Ok(Some(
            ToolDefinition::try_new(
                ToolRevisionId::parse("crm.update-r1").unwrap(),
                AgentReleaseId::parse("agent-release-001").unwrap(),
                "a".repeat(64),
                ToolEffectClass::Mutation,
                ToolRisk::High,
                "crm.update",
            )
            .unwrap(),
        ))
    }
}

struct Schema;

impl ToolSchemaPort for Schema {
    fn validate(
        &self,
        _definition: &ToolDefinition,
        _proposal: &converact_tool_broker_core::ToolProposal,
    ) -> impl Future<Output = Result<(), converact_tool_broker_core::ToolPortError>> + Send {
        ready(Ok(()))
    }
}

struct Policy;

impl PolicyPort for Policy {
    fn evaluate(
        &self,
        _definition: &ToolDefinition,
        _proposal: &converact_tool_broker_core::ToolProposal,
    ) -> impl Future<Output = Result<PolicyDecision, converact_tool_broker_core::ToolPortError>> + Send
    {
        ready(Ok(PolicyDecision::Allowed))
    }
}

struct MissingApproval;

impl ApprovalPort for MissingApproval {
    fn exact_grant(
        &self,
        _proposal: &converact_tool_broker_core::ToolProposal,
    ) -> impl Future<
        Output = Result<Option<ApprovalGrant>, converact_tool_broker_core::ToolPortError>,
    > + Send {
        ready(Ok(None))
    }
}
