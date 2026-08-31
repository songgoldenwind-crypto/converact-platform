#![allow(dead_code)]

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use converact_rustpbx_rwi_adapter::{
    ClientConfig, ClientError, OriginateRequest, RwiSecretResolver, SecretRef, SecretValue,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_tungstenite::{accept_async, tungstenite::Message};

pub struct FakeRwiServer {
    url: String,
    mode: ServerMode,
    actions: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}

#[derive(Clone, Copy)]
enum ServerMode {
    Success,
    WithoutReceipt,
}

impl FakeRwiServer {
    pub async fn success() -> Self {
        Self::start(ServerMode::Success).await
    }

    pub async fn without_receipt() -> Self {
        Self::start(ServerMode::WithoutReceipt).await
    }

    async fn start(mode: ServerMode) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let actions = Arc::new(AtomicUsize::new(0));
        let server_actions = Arc::clone(&actions);
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            while let Some(message) = socket.next().await {
                let message = message.unwrap();
                let Message::Text(text) = message else {
                    continue;
                };
                let envelope: Value = serde_json::from_str(&text).unwrap();
                let action_id = envelope["action_id"].as_str().unwrap();
                server_actions.fetch_add(1, Ordering::SeqCst);
                if matches!(mode, ServerMode::Success) {
                    socket
                        .send(Message::Text(
                            json!({
                                "type": "command_completed",
                                "action_id": action_id,
                                "data": { "call_id": "call-001" }
                            })
                            .to_string()
                            .into(),
                        ))
                        .await
                        .unwrap();
                }
            }
        });
        Self {
            url: format!("ws://{address}/rwi/v1"),
            mode,
            actions,
            task,
        }
    }

    pub fn config(&self) -> ClientConfig {
        client_config(&self.url).unwrap()
    }

    pub fn originate_request() -> OriginateRequest {
        OriginateRequest {
            action_id: "attempt-001:originate".to_owned(),
            to: "+8613800138000".to_owned(),
            from: Some("+8610000000000".to_owned()),
            timeout_seconds: 30,
            interaction_id: "interaction-001".to_owned(),
        }
    }

    pub fn action_count(&self) -> usize {
        self.actions.load(Ordering::SeqCst)
    }
}

impl Drop for FakeRwiServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct FixedSecretResolver;

impl RwiSecretResolver for FixedSecretResolver {
    fn resolve(&self, _reference: &SecretRef) -> Result<SecretValue, ClientError> {
        SecretValue::new("controlled-test-token")
    }
}

pub fn client_config(endpoint: &str) -> Result<ClientConfig, ClientError> {
    ClientConfig::new(
        endpoint,
        SecretRef::parse("test://rustpbx-rwi").unwrap(),
        Arc::new(FixedSecretResolver),
    )
}
