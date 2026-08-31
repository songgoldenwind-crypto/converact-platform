mod support;

use std::sync::{Arc, Mutex};

use converact_tool_broker_core::{
    ActionObservation, ActionReceipt, ActionReceiptId, ApprovalGrant, ApprovalPort, BrokerResult,
    PolicyDecision, PolicyPort, PrepareDecision, ToolActionOutput, ToolActionPort,
    ToolActionStorePort, ToolBroker, ToolCatalogPort, ToolDefinition, ToolEffectClass,
    ToolPortError, ToolProposal, ToolRisk, ToolSchemaPort,
};
use converact_voice_agent_contracts::{AgentReleaseId, ToolRevisionId};
use serde_json::json;

use support::{NOW_MS, approval, proposal};

#[tokio::test]
async fn approved_action_prepares_executes_finalizes_once_and_replays_receipt() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let store = Store::new(Arc::clone(&calls));
    let action = Action::new(Arc::clone(&calls));
    let broker = ToolBroker::new(Catalog, Schema, Policy, Approvals, store, action);

    let first = broker.execute(proposal(), NOW_MS).await.unwrap();
    let second = broker.execute(proposal(), NOW_MS + 1).await.unwrap();

    assert!(matches!(first, BrokerResult::Consumable(_)));
    assert_eq!(first, second);
    assert_eq!(
        *calls.lock().unwrap(),
        ["prepare", "execute", "finalize", "prepare"]
    );
}

struct Catalog;

impl ToolCatalogPort for Catalog {
    async fn resolve(
        &self,
        _proposal: &ToolProposal,
    ) -> Result<Option<ToolDefinition>, ToolPortError> {
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
    async fn validate(
        &self,
        _definition: &ToolDefinition,
        _proposal: &ToolProposal,
    ) -> Result<(), ToolPortError> {
        Ok(())
    }
}

struct Policy;

impl PolicyPort for Policy {
    async fn evaluate(
        &self,
        _definition: &ToolDefinition,
        _proposal: &ToolProposal,
    ) -> Result<PolicyDecision, ToolPortError> {
        Ok(PolicyDecision::ApprovalRequired)
    }
}

struct Approvals;

impl ApprovalPort for Approvals {
    async fn exact_grant(
        &self,
        proposal: &ToolProposal,
    ) -> Result<Option<ApprovalGrant>, ToolPortError> {
        Ok(Some(approval(proposal)))
    }
}

struct Store {
    calls: Arc<Mutex<Vec<&'static str>>>,
    receipt: Mutex<Option<ActionReceipt>>,
}

impl Store {
    fn new(calls: Arc<Mutex<Vec<&'static str>>>) -> Self {
        Self {
            calls,
            receipt: Mutex::new(None),
        }
    }
}

impl ToolActionStorePort for Store {
    async fn prepare(
        &self,
        _action: &converact_tool_broker_core::AuthorizedToolAction,
        _now_ms: u64,
    ) -> Result<PrepareDecision, ToolPortError> {
        self.calls.lock().unwrap().push("prepare");
        Ok(self
            .receipt
            .lock()
            .unwrap()
            .clone()
            .map_or(PrepareDecision::Prepared, |receipt| {
                PrepareDecision::Replay(Box::new(receipt))
            }))
    }

    async fn finalize(
        &self,
        action: &converact_tool_broker_core::AuthorizedToolAction,
        observation: ActionObservation,
        now_ms: u64,
    ) -> Result<ActionReceipt, ToolPortError> {
        self.calls.lock().unwrap().push("finalize");
        let receipt = ActionReceipt::state_observed(
            action,
            ActionReceiptId::parse("action-receipt-001").unwrap(),
            NOW_MS,
            now_ms,
            now_ms,
            observation.into_resolution().unwrap(),
        )
        .unwrap();
        *self.receipt.lock().unwrap() = Some(receipt.clone());
        Ok(receipt)
    }
}

struct Action {
    calls: Arc<Mutex<Vec<&'static str>>>,
}

impl Action {
    fn new(calls: Arc<Mutex<Vec<&'static str>>>) -> Self {
        Self { calls }
    }
}

impl ToolActionPort for Action {
    async fn execute(
        &self,
        _action: &converact_tool_broker_core::AuthorizedToolAction,
    ) -> Result<ActionObservation, ToolPortError> {
        self.calls.lock().unwrap().push("execute");
        Ok(ActionObservation::Applied(
            ToolActionOutput::try_new(json!({"updated": true})).unwrap(),
        ))
    }

    async fn query(
        &self,
        _action: &converact_tool_broker_core::AuthorizedToolAction,
    ) -> Result<ActionObservation, ToolPortError> {
        panic!("replay must not query")
    }
}
