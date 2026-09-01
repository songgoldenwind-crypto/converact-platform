use std::sync::{Arc, Mutex};

use axum::{Json, Router, extract::Path, routing::post};
use converact_active_call_adapter::{
    ActiveCallClient, AdapterContext, ClientConfig, normalize_event,
};
use converact_contracts::canonical_sha256_with_max_bytes;
use converact_tool_broker_core::{
    ActionAuthority, ActionReceipt, ActionReceiptInput, ActionResolution, BrokerResult,
    ToolActionOutput, ToolPortError, ToolProposal,
};
use converact_voice_agent_contracts::{
    ActionReceiptId, AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId,
    ChannelAgentSessionId, EnvelopeContext, EnvelopeContextInput, ExecutionGeneration,
    InteractionId, ToolCallId, ToolRevisionId, VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    ActiveCallToolEventProcessor, ActiveCallToolProjectionPort, ActiveCallToolResultPort,
    FixedWallClock, ToolBinding, ToolBindingPort, ToolBrokerPort, ToolEventOutcome, ToolResultPort,
    ToolRuntime,
};
use serde_json::json;

#[tokio::test]
async fn normalized_proposal_enters_broker_and_only_consumable_result_returns_to_agent() {
    let receipts = Arc::new(Mutex::new(vec![
        receipt(2, "historical-receipt"),
        receipt(3, "consumable-receipt"),
    ]));
    let delivered = Arc::new(Mutex::new(Vec::new()));
    let broker_calls = Arc::new(Mutex::new(Vec::new()));
    let runtime = ToolRuntime::new(
        Binding,
        Broker {
            receipts,
            calls: Arc::clone(&broker_calls),
        },
        Results(Arc::clone(&delivered)),
    );
    let wire = r#"{"event":"functionCall","trackId":"track-001","callId":"tool-call-001","name":"lookup_customer","arguments":"{\"customer_id\":\"c-1\"}","timestamp":1200}"#;

    let historical = runtime
        .handle(
            normalize_event(&AdapterContext::new(context()), wire).unwrap(),
            1_300,
        )
        .await
        .unwrap();
    let consumable = runtime
        .handle(
            normalize_event(&AdapterContext::new(context()), wire).unwrap(),
            1_301,
        )
        .await
        .unwrap();

    assert_eq!(historical, ToolEventOutcome::Historical);
    assert_eq!(consumable, ToolEventOutcome::Delivered);
    let proposals = broker_calls.lock().unwrap();
    assert_eq!(proposals.len(), 2);
    assert_eq!(proposals[0].tool_revision_id().as_str(), "crm.lookup-r1");
    assert_eq!(
        proposals[0].tool_schema_hash(),
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    assert_eq!(proposals[0].arguments(), &json!({"customer_id": "c-1"}));
    assert_eq!(delivered.lock().unwrap().as_slice(), ["consumable-receipt"]);
}

#[tokio::test]
async fn event_projection_routes_the_current_tool_receipt_back_to_the_active_session() {
    let receipts = Arc::new(Mutex::new(vec![receipt(3, "consumable-receipt")]));
    let delivered = Arc::new(Mutex::new(Vec::new()));
    let runtime = ToolRuntime::new(
        Binding,
        Broker {
            receipts,
            calls: Arc::new(Mutex::new(Vec::new())),
        },
        Results(Arc::clone(&delivered)),
    );
    let projection =
        ActiveCallToolEventProcessor::new(Arc::new(runtime), FixedWallClock::new(1_300));
    let authority = context();
    let event = normalize_event(
        &AdapterContext::new(authority.clone()),
        r#"{"event":"functionCall","trackId":"track-001","callId":"tool-call-001","name":"lookup_customer","arguments":"{\"customer_id\":\"c-1\"}","timestamp":1200}"#,
    )
    .unwrap();

    projection
        .project_tool_event(&authority, &event)
        .await
        .unwrap();

    assert_eq!(delivered.lock().unwrap().as_slice(), ["consumable-receipt"]);
}

#[tokio::test]
async fn active_call_result_port_delivers_one_bounded_result_to_the_exact_session() {
    let commands = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&commands);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/command/{id}",
        post(
            move |Path(id): Path<String>, Json(body): Json<serde_json::Value>| {
                let captured = Arc::clone(&captured);
                async move {
                    captured.lock().unwrap().push((id.clone(), body));
                    Json(json!({"status": "sent", "id": id}))
                }
            },
        ),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = Arc::new(
        ActiveCallClient::connect(
            ClientConfig::new(format!("http://{address}"), 1_000, 131_072).unwrap(),
        )
        .unwrap(),
    );
    let results = ActiveCallToolResultPort::new(client);

    results
        .deliver(
            &ChannelAgentSessionId::parse("session-001").unwrap(),
            receipt(3, "consumable-receipt"),
        )
        .await
        .unwrap();

    assert_eq!(
        commands.lock().unwrap().as_slice(),
        [(
            "session-001".to_owned(),
            json!({
                "command": "toolResult",
                "callId": "tool-call-001",
                "output": "{\"ok\":true,\"receipt_id\":\"consumable-receipt\",\"result\":{\"name\":\"Customer\"}}",
            }),
        )]
    );
    server.abort();
}

struct Binding;

impl ToolBindingPort for Binding {
    async fn resolve(
        &self,
        _authority: &EnvelopeContext,
        _tool_name: &str,
    ) -> Result<Option<ToolBinding>, ToolPortError> {
        Ok(Some(
            ToolBinding::try_new(
                ToolRevisionId::parse("crm.lookup-r1").unwrap(),
                "a".repeat(64),
                5_000,
            )
            .unwrap(),
        ))
    }
}

struct Broker {
    receipts: Arc<Mutex<Vec<ActionReceipt>>>,
    calls: Arc<Mutex<Vec<ToolProposal>>>,
}

impl ToolBrokerPort for Broker {
    async fn execute(
        &self,
        proposal: ToolProposal,
        _now_ms: u64,
    ) -> Result<BrokerResult, ToolPortError> {
        self.calls.lock().unwrap().push(proposal);
        let receipt = self.receipts.lock().unwrap().remove(0);
        if receipt.generation().get() == 3 && self.receipts.lock().unwrap().is_empty() {
            Ok(BrokerResult::Consumable(Box::new(receipt)))
        } else {
            Ok(BrokerResult::Historical(Box::new(receipt)))
        }
    }
}

struct Results(Arc<Mutex<Vec<String>>>);

impl ToolResultPort for Results {
    async fn deliver(
        &self,
        _session_id: &ChannelAgentSessionId,
        receipt: ActionReceipt,
    ) -> Result<(), ToolPortError> {
        self.0
            .lock()
            .unwrap()
            .push(receipt.receipt_id().as_str().to_owned());
        Ok(())
    }
}

fn context() -> EnvelopeContext {
    EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version: VOICE_AGENT_SCHEMA_VERSION,
        tenant_id: "tenant-a".to_owned(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        campaign_id: CampaignId::parse("campaign-001").unwrap(),
        campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
        call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        call_id: None,
        agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
        channel_agent_session_id: Some(ChannelAgentSessionId::parse("session-001").unwrap()),
        execution_generation: ExecutionGeneration::new(3).unwrap(),
        trace_id: "trace-001".to_owned(),
    })
    .unwrap()
}

fn receipt(generation: u64, id: &str) -> ActionReceipt {
    ActionReceipt::try_new(ActionReceiptInput {
        receipt_id: ActionReceiptId::parse(id).unwrap(),
        authority: ActionAuthority::try_new(
            "tenant-a",
            InteractionId::parse("interaction-001").unwrap(),
            CallAttemptId::parse("attempt-001").unwrap(),
            AgentReleaseId::parse("agent-release-001").unwrap(),
            ExecutionGeneration::new(generation).unwrap(),
        )
        .unwrap(),
        tool_revision_id: ToolRevisionId::parse("crm.lookup-r1").unwrap(),
        tool_call_id: ToolCallId::parse("tool-call-001").unwrap(),
        approval_id: None,
        arguments_hash: canonical_sha256_with_max_bytes(&json!({"customer_id": "c-1"}), 65_536)
            .unwrap(),
        accepted_at_ms: 1_200,
        completed_at_ms: 1_250,
        state_observed_at_ms: 1_260,
        resolution: ActionResolution::Applied(
            ToolActionOutput::try_new(json!({"name": "Customer"})).unwrap(),
        ),
    })
    .unwrap()
}
