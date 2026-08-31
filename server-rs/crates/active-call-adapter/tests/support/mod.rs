#![allow(dead_code)]

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use axum::{
    Json, Router,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use converact_active_call_adapter::AdapterContext;
use converact_active_call_adapter::{ActiveCallCommand, AdapterCommand, ClientConfig};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    EnvelopeContext, EnvelopeContextInput, ExecutionGeneration, InteractionId,
};
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

pub fn adapter_context(generation: u64) -> AdapterContext {
    AdapterContext::new(
        EnvelopeContext::try_new(EnvelopeContextInput {
            schema_version: 1,
            tenant_id: "tenant-001".to_owned(),
            interaction_id: InteractionId::parse("interaction-001").unwrap(),
            campaign_id: CampaignId::parse("campaign-001").unwrap(),
            campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
            call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
            call_id: None,
            agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
            channel_agent_session_id: Some(
                ChannelAgentSessionId::parse("agent-session-001").unwrap(),
            ),
            execution_generation: ExecutionGeneration::new(generation).unwrap(),
            trace_id: "trace-001".to_owned(),
        })
        .unwrap(),
    )
}

pub struct CommandFixture;

impl CommandFixture {
    pub fn disclosure() -> ActiveCallCommand {
        ActiveCallCommand::try_new(
            ChannelAgentSessionId::parse("agent-session-001").unwrap(),
            AdapterCommand::PlayDisclosure {
                text: "This is an AI assistant and this call is recorded.".to_owned(),
                play_id: "disclosure-001".to_owned(),
            },
        )
        .unwrap()
    }
}

pub struct FakeActiveCall {
    endpoint: String,
    task: JoinHandle<()>,
    command_count: Arc<AtomicUsize>,
    status_count: Arc<AtomicUsize>,
}

impl FakeActiveCall {
    pub async fn timeout_commands() -> Self {
        let command_count = Arc::new(AtomicUsize::new(0));
        let handler_count = Arc::clone(&command_count);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new().route(
            "/command/{id}",
            post(move || {
                let count = Arc::clone(&handler_count);
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    std::future::pending::<String>().await
                }
            }),
        );
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            endpoint: format!("http://{address}"),
            task,
            command_count,
            status_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub async fn status_retry_with_event() -> Self {
        let status_count = Arc::new(AtomicUsize::new(0));
        let handler_count = Arc::clone(&status_count);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new()
            .route(
                "/list",
                get(move || {
                    let count = Arc::clone(&handler_count);
                    async move {
                        if count.fetch_add(1, Ordering::SeqCst) == 0 {
                            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({}))).into_response()
                        } else {
                            Json(json!({
                                "active_calls": [{ "id": "agent-session-001" }]
                            }))
                            .into_response()
                        }
                    }
                }),
            )
            .route(
                "/events/{id}",
                get(|| async {
                    (
                        [("content-type", "text/event-stream")],
                        "event: event\ndata: {\"event\":\"mediaReady\"}\n\n",
                    )
                }),
            );
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            endpoint: format!("http://{address}"),
            task,
            command_count: Arc::new(AtomicUsize::new(0)),
            status_count,
        }
    }

    pub async fn stall_command_body() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let command_count = Arc::new(AtomicUsize::new(0));
        let server_count = Arc::clone(&command_count);
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4_096];
            let _ = stream.read(&mut request).await.unwrap();
            server_count.fetch_add(1, Ordering::SeqCst);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 50\r\n\r\n{\"status\":\"sent\"",
                )
                .await
                .unwrap();
            std::future::pending::<()>().await;
        });
        Self {
            endpoint: format!("http://{address}"),
            task,
            command_count,
            status_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn config(&self) -> ClientConfig {
        ClientConfig::new(&self.endpoint, 20, 1_024).unwrap()
    }

    pub fn command_count(&self) -> usize {
        self.command_count.load(Ordering::SeqCst)
    }

    pub fn status_count(&self) -> usize {
        self.status_count.load(Ordering::SeqCst)
    }
}

impl Drop for FakeActiveCall {
    fn drop(&mut self) {
        self.task.abort();
    }
}
