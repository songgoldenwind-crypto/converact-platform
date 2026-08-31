mod support;

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use converact_ai_outbound_core::{
    AgentLegBinding, CallObservation, OriginateCall, OutboundDialBinding, OutboundDialBindingInput,
    PortFailureKind, TelephonyPort, TerminateCall,
};
use converact_rustpbx_rwi_adapter::{
    ClientConfig, RustPbxRwiClient, RustPbxTelephony, RustPbxTelephonyConfig,
};
use converact_voice_agent_contracts::{CallAttemptId, CallId, ChannelAgentSessionId};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_tungstenite::{accept_async, tungstenite::Message};

use support::{FakeRwiServer, client_config};

#[tokio::test]
async fn originate_observes_answer_then_rustpbx_adds_and_hangs_up_agent_leg() {
    let server = CallLifecycleServer::start().await;
    let telephony = connected_telephony(server.config()).await;
    let request = originate_request();

    let observation = telephony.originate(request.clone()).await.unwrap();
    assert_eq!(
        observation,
        CallObservation::Answered(request.call_id.clone())
    );

    let binding = agent_leg_binding();
    telephony.add_agent_leg(binding.clone()).await.unwrap();
    telephony
        .terminate(TerminateCall {
            attempt_id: binding.attempt_id.clone(),
            call_id: binding.call_id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(
        telephony.query(&binding.call_id).await.unwrap(),
        CallObservation::NotFound(binding.call_id.clone()),
    );

    let actions = server.actions();
    assert_eq!(
        actions,
        [
            "call.originate",
            "session.inspect_call",
            "session.inspect_call",
            "call.leg_add",
            "call.hangup",
            "session.inspect_call",
        ],
    );
    let requests = server.requests();
    assert_eq!(requests[0]["params"]["extra_headers"], json!({}));
    assert!(requests[0]["params"].get("agent_session_id").is_none());
    assert_eq!(
        requests[3]["params"]["agent_session_id"],
        binding.session_id.as_str()
    );
    assert_eq!(requests[3]["params"]["target"], "sip:agent@127.0.0.1:9080");
}

#[tokio::test]
async fn missing_mutation_receipt_is_outcome_unknown_and_is_not_replayed() {
    let server = FakeRwiServer::without_receipt().await;
    let client_config = server.config().with_command_timeout_ms(10).unwrap();
    let telephony = connected_telephony(client_config).await;

    let error = telephony.originate(originate_request()).await.unwrap_err();

    assert_eq!(error.kind(), PortFailureKind::OutcomeUnknown);
    assert_eq!(server.action_count(), 1);
}

async fn connected_telephony(config: ClientConfig) -> RustPbxTelephony {
    let client = Arc::new(RustPbxRwiClient::connect(config).await.unwrap());
    let config = RustPbxTelephonyConfig::new(
        "sip:agent@127.0.0.1:9080",
        Duration::from_millis(1),
        Duration::from_millis(100),
    )
    .unwrap();
    RustPbxTelephony::new(client, config)
}

fn originate_request() -> OriginateCall {
    OriginateCall {
        attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        call_id: CallId::parse("call-001").unwrap(),
        agent_session_id: ChannelAgentSessionId::parse("agent-session-001").unwrap(),
        dial: OutboundDialBinding::try_new(OutboundDialBindingInput {
            destination: "+8613800138000".to_owned(),
            caller_id: Some("+8610000000000".to_owned()),
            timeout_secs: 30,
            trunk: Some("carrier-a".to_owned()),
        })
        .unwrap(),
    }
}

fn agent_leg_binding() -> AgentLegBinding {
    AgentLegBinding {
        attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        call_id: CallId::parse("call-001").unwrap(),
        session_id: ChannelAgentSessionId::parse("agent-session-001").unwrap(),
    }
}

struct CallLifecycleServer {
    endpoint: String,
    requests: Arc<Mutex<Vec<Value>>>,
    task: JoinHandle<()>,
}

impl CallLifecycleServer {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/rwi/v1", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&requests);
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            let mut query_count = 0_u8;
            while let Some(Ok(Message::Text(text))) = socket.next().await {
                let request: Value = serde_json::from_str(&text).unwrap();
                captured.lock().unwrap().push(request.clone());
                let action = request["action"].as_str().unwrap();
                let action_id = request["action_id"].as_str().unwrap();
                let data = match action {
                    "call.originate" => json!({ "call_id": "call-001" }),
                    "session.inspect_call" => {
                        query_count += 1;
                        match query_count {
                            1 => wire_call("ringing", None),
                            2 => wire_call("talking", Some("2026-09-01T00:00:01Z")),
                            _ => Value::Null,
                        }
                    }
                    "call.leg_add" | "call.hangup" => Value::Null,
                    _ => panic!("unexpected test action: {action}"),
                };
                socket
                    .send(Message::Text(
                        json!({
                            "type": "command_completed",
                            "action_id": action_id,
                            "data": data,
                        })
                        .to_string()
                        .into(),
                    ))
                    .await
                    .unwrap();
            }
        });
        Self {
            endpoint,
            requests,
            task,
        }
    }

    fn config(&self) -> ClientConfig {
        client_config(&self.endpoint).unwrap()
    }

    fn requests(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }

    fn actions(&self) -> Vec<String> {
        self.requests()
            .iter()
            .map(|request| request["action"].as_str().unwrap().to_owned())
            .collect()
    }
}

impl Drop for CallLifecycleServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn wire_call(status: &str, answered_at: Option<&str>) -> Value {
    json!({
        "session_id": "call-001",
        "caller": "+8610000000000",
        "callee": "+8613800138000",
        "direction": "outbound",
        "status": status,
        "started_at": "2026-09-01T00:00:00Z",
        "answered_at": answered_at,
    })
}
