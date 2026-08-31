mod support;

use std::sync::{Arc, Mutex};

use converact_tool_broker_core::{
    ActionObservation, ActionReceipt, ActionReceiptId, ApprovalGrant, ApprovalPort,
    AuthorizedToolAction, BrokerResult, PolicyDecision, PolicyPort, PrepareDecision,
    ToolActionOutput, ToolActionPort, ToolActionStorePort, ToolBroker, ToolCatalogPort,
    ToolDefinition, ToolEffectClass, ToolPortError, ToolProposal, ToolRisk, ToolSchemaPort,
};
use converact_voice_agent_contracts::{AgentReleaseId, ToolRevisionId};
use serde_json::json;

use support::{NOW_MS, approval, proposal_with_generation};

#[tokio::test]
async fn unknown_outcome_queries_once_and_fences_old_generation_result() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let broker = ToolBroker::new(
        Catalog,
        Schema,
        Policy,
        Approvals,
        Store::new(Arc::clone(&calls)),
        Action::new(Arc::clone(&calls)),
    );

    let first = broker
        .execute(proposal_with_generation(2), NOW_MS)
        .await
        .unwrap();
    let recovered = broker
        .execute(proposal_with_generation(3), NOW_MS + 1)
        .await
        .unwrap();

    assert_eq!(first, BrokerResult::Pending);
    assert!(matches!(recovered, BrokerResult::Historical(_)));
    assert_eq!(
        *calls.lock().unwrap(),
        ["prepare", "execute", "prepare", "query", "finalize"]
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

enum StoreState {
    Empty,
    Accepted(AuthorizedToolAction),
    Final(ActionReceipt),
}

struct Store {
    calls: Arc<Mutex<Vec<&'static str>>>,
    state: Mutex<StoreState>,
}

impl Store {
    fn new(calls: Arc<Mutex<Vec<&'static str>>>) -> Self {
        Self {
            calls,
            state: Mutex::new(StoreState::Empty),
        }
    }
}

impl ToolActionStorePort for Store {
    async fn prepare(
        &self,
        action: &AuthorizedToolAction,
        _now_ms: u64,
    ) -> Result<PrepareDecision, ToolPortError> {
        self.calls.lock().unwrap().push("prepare");
        let mut state = self.state.lock().unwrap();
        match &*state {
            StoreState::Empty => {
                *state = StoreState::Accepted(action.clone());
                Ok(PrepareDecision::Prepared)
            }
            StoreState::Accepted(_) => Ok(PrepareDecision::ReconcileRequired),
            StoreState::Final(receipt) => Ok(PrepareDecision::Replay(Box::new(receipt.clone()))),
        }
    }

    async fn finalize(
        &self,
        _action: &AuthorizedToolAction,
        observation: ActionObservation,
        now_ms: u64,
    ) -> Result<ActionReceipt, ToolPortError> {
        self.calls.lock().unwrap().push("finalize");
        let mut state = self.state.lock().unwrap();
        let StoreState::Accepted(original) = &*state else {
            return Err(ToolPortError::new("tool_test_store_state_invalid"));
        };
        let receipt = ActionReceipt::state_observed(
            original,
            ActionReceiptId::parse("action-receipt-recovered").unwrap(),
            NOW_MS,
            now_ms,
            now_ms,
            observation.into_resolution().unwrap(),
        )
        .unwrap();
        *state = StoreState::Final(receipt.clone());
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
        _action: &AuthorizedToolAction,
    ) -> Result<ActionObservation, ToolPortError> {
        self.calls.lock().unwrap().push("execute");
        Ok(ActionObservation::OutcomeUnknown)
    }

    async fn query(
        &self,
        _action: &AuthorizedToolAction,
    ) -> Result<ActionObservation, ToolPortError> {
        self.calls.lock().unwrap().push("query");
        Ok(ActionObservation::Applied(
            ToolActionOutput::try_new(json!({"updated": true})).unwrap(),
        ))
    }
}
