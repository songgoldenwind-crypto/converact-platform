use std::sync::{Arc, Mutex};

use converact_agent_tool_adapters::{
    AgentToolAdapter, CustomerDirectoryPort, CustomerLookup, CustomerLookupResult,
    CustomerSnapshot, FollowUpExecuteResult, FollowUpQuery, FollowUpRequest, FollowUpTaskId,
    FollowUpTaskPort,
};
use converact_contracts::canonical_sha256_with_max_bytes;
use converact_tool_broker_core::{
    ActionObservation, ApprovalGrant, ApprovalPort, AuthorizedToolAction, PolicyDecision,
    PolicyPort, ToolActionPort, ToolCatalogPort, ToolDefinition, ToolEffectClass, ToolGate,
    ToolPortError, ToolProposal, ToolProposalInput, ToolRisk, ToolSchemaPort,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId, EnvelopeContext,
    EnvelopeContextInput, ExecutionGeneration, InteractionId, ToolCallId, ToolRevisionId,
    VOICE_AGENT_SCHEMA_VERSION,
};
use serde_json::{Value, json};

#[tokio::test]
async fn query_and_idempotent_mutation_dispatch_through_typed_provider_ports() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let adapter =
        AgentToolAdapter::new(Directory(Arc::clone(&calls)), FollowUps(Arc::clone(&calls)));
    let lookup = authorized(
        "customer.lookup",
        ToolEffectClass::Query,
        "tool-call-lookup",
        json!({"customer_id": "customer-001"}),
    )
    .await;
    let follow_up = authorized(
        "task.create_follow_up",
        ToolEffectClass::Mutation,
        "tool-call-follow-up",
        json!({
            "customer_id": "customer-001",
            "reason": "Send requested proposal",
            "due_at_ms": 10_000
        }),
    )
    .await;

    let lookup_result = adapter.execute(&lookup).await.unwrap();
    let uncertain = adapter.execute(&follow_up).await.unwrap();
    let reconciled = adapter.query(&follow_up).await.unwrap();

    let ActionObservation::Applied(lookup_output) = lookup_result else {
        panic!("lookup must return a definitive result")
    };
    assert_eq!(lookup_output.value()["found"], true);
    assert_eq!(uncertain, ActionObservation::OutcomeUnknown);
    let ActionObservation::Applied(task_output) = reconciled else {
        panic!("follow-up query must observe the created task")
    };
    assert_eq!(task_output.value()["task_id"], "follow-up-001");
    assert_eq!(
        *calls.lock().unwrap(),
        [
            "lookup:customer-001",
            "create:tool-call-follow-up",
            "query:tool-call-follow-up"
        ]
    );
}

#[tokio::test]
async fn unknown_capability_effect_mismatch_and_invalid_arguments_fail_closed() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let adapter =
        AgentToolAdapter::new(Directory(Arc::clone(&calls)), FollowUps(Arc::clone(&calls)));
    let unknown = authorized(
        "customer.export",
        ToolEffectClass::Query,
        "tool-call-unknown",
        json!({}),
    )
    .await;
    let mismatched = authorized(
        "customer.lookup",
        ToolEffectClass::Mutation,
        "tool-call-mismatched",
        json!({"customer_id": "customer-001"}),
    )
    .await;
    let invalid = authorized(
        "customer.lookup",
        ToolEffectClass::Query,
        "tool-call-invalid",
        json!({"customer_id": " "}),
    )
    .await;

    assert_eq!(
        adapter.execute(&unknown).await.unwrap_err().code(),
        "agent_tool_capability_rejected"
    );
    assert_eq!(
        adapter.execute(&mismatched).await.unwrap_err().code(),
        "agent_tool_capability_rejected"
    );
    assert_eq!(
        adapter.execute(&invalid).await.unwrap_err().code(),
        "agent_tool_arguments_invalid"
    );
    assert!(calls.lock().unwrap().is_empty());
}

struct Directory(Arc<Mutex<Vec<String>>>);

impl CustomerDirectoryPort for Directory {
    async fn lookup(&self, request: CustomerLookup) -> Result<CustomerLookupResult, ToolPortError> {
        self.0
            .lock()
            .unwrap()
            .push(format!("lookup:{}", request.customer_id()));
        Ok(CustomerLookupResult::Found(
            CustomerSnapshot::try_new("customer-001", "active", Some("enterprise"), Some("zh-CN"))
                .unwrap(),
        ))
    }
}

struct FollowUps(Arc<Mutex<Vec<String>>>);

impl FollowUpTaskPort for FollowUps {
    async fn create(
        &self,
        request: FollowUpRequest,
    ) -> Result<FollowUpExecuteResult, ToolPortError> {
        self.0
            .lock()
            .unwrap()
            .push(format!("create:{}", request.idempotency_key().as_str()));
        Ok(FollowUpExecuteResult::OutcomeUnknown)
    }

    async fn query(&self, request: FollowUpQuery) -> Result<FollowUpExecuteResult, ToolPortError> {
        self.0
            .lock()
            .unwrap()
            .push(format!("query:{}", request.idempotency_key().as_str()));
        Ok(FollowUpExecuteResult::Created(
            FollowUpTaskId::parse("follow-up-001").unwrap(),
        ))
    }
}

async fn authorized(
    capability: &str,
    effect_class: ToolEffectClass,
    tool_call_id: &str,
    arguments: Value,
) -> AuthorizedToolAction {
    let proposal = proposal(capability, tool_call_id, arguments);
    ToolGate::new(
        Catalog(
            ToolDefinition::try_new(
                ToolRevisionId::parse(format!("{capability}-r1")).unwrap(),
                AgentReleaseId::parse("agent-release-001").unwrap(),
                "a".repeat(64),
                effect_class,
                ToolRisk::Low,
                capability,
            )
            .unwrap(),
        ),
        Schema,
        Policy,
        Approvals,
    )
    .authorize(proposal, 2_000)
    .await
    .unwrap()
}

struct Catalog(ToolDefinition);

impl ToolCatalogPort for Catalog {
    async fn resolve(
        &self,
        _proposal: &ToolProposal,
    ) -> Result<Option<ToolDefinition>, ToolPortError> {
        Ok(Some(self.0.clone()))
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
        Ok(PolicyDecision::Allowed)
    }
}

struct Approvals;

impl ApprovalPort for Approvals {
    async fn exact_grant(
        &self,
        _proposal: &ToolProposal,
    ) -> Result<Option<ApprovalGrant>, ToolPortError> {
        Ok(None)
    }
}

fn proposal(capability: &str, tool_call_id: &str, arguments: Value) -> ToolProposal {
    ToolProposal::try_new(ToolProposalInput {
        context: EnvelopeContext::try_new(EnvelopeContextInput {
            schema_version: VOICE_AGENT_SCHEMA_VERSION,
            tenant_id: "tenant-a".to_owned(),
            interaction_id: InteractionId::parse("interaction-001").unwrap(),
            campaign_id: CampaignId::parse("campaign-001").unwrap(),
            campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
            call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
            call_id: None,
            agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
            channel_agent_session_id: None,
            execution_generation: ExecutionGeneration::new(1).unwrap(),
            trace_id: "trace-001".to_owned(),
        })
        .unwrap(),
        tool_revision_id: ToolRevisionId::parse(format!("{capability}-r1")).unwrap(),
        tool_call_id: ToolCallId::parse(tool_call_id).unwrap(),
        tool_schema_hash: "a".repeat(64),
        arguments_hash: canonical_sha256_with_max_bytes(&arguments, 65_536).unwrap(),
        arguments,
        requested_at_ms: 1_000,
        deadline_ms: 5_000,
    })
    .unwrap()
}
