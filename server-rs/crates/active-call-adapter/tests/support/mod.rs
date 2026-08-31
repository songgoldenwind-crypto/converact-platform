#![allow(dead_code)]

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use axum::{
    Json, Router,
    extract::Path,
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
    playbook_reservation_count: Arc<AtomicUsize>,
    playbook_start_count: Arc<AtomicUsize>,
    last_playbook_reservation: Arc<Mutex<Option<serde_json::Value>>>,
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
            playbook_reservation_count: Arc::new(AtomicUsize::new(0)),
            playbook_start_count: Arc::new(AtomicUsize::new(0)),
            last_playbook_reservation: Arc::new(Mutex::new(None)),
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
            playbook_reservation_count: Arc::new(AtomicUsize::new(0)),
            playbook_start_count: Arc::new(AtomicUsize::new(0)),
            last_playbook_reservation: Arc::new(Mutex::new(None)),
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
            playbook_reservation_count: Arc::new(AtomicUsize::new(0)),
            playbook_start_count: Arc::new(AtomicUsize::new(0)),
            last_playbook_reservation: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn accept_playbook_reservations() -> Self {
        let count = Arc::new(AtomicUsize::new(0));
        let handler_count = Arc::clone(&count);
        let last = Arc::new(Mutex::new(None));
        let handler_last = Arc::clone(&last);
        let start_count = Arc::new(AtomicUsize::new(0));
        let handler_start_count = Arc::clone(&start_count);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new()
            .route(
                "/api/playbook/run",
                post(move |Json(body): Json<serde_json::Value>| {
                    let count = Arc::clone(&handler_count);
                    let last = Arc::clone(&handler_last);
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        let session_id = body["session_id"].clone();
                        *last.lock().unwrap() = Some(body);
                        Json(json!({ "session_id": session_id }))
                    }
                }),
            )
            .route(
                "/api/playbook/reservations/{id}",
                get(|Path(id): Path<String>| async move {
                    match id.as_str() {
                        "agent-session-001" => Json(json!({
                            "session_id": id,
                            "state": "pending"
                        }))
                        .into_response(),
                        "agent-session-active" => Json(json!({
                            "session_id": id,
                            "state": "active"
                        }))
                        .into_response(),
                        "agent-session-attached" => Json(json!({
                            "session_id": id,
                            "state": "attached"
                        }))
                        .into_response(),
                        "agent-session-media-ready" => Json(json!({
                            "session_id": id,
                            "state": "media_ready"
                        }))
                        .into_response(),
                        "agent-session-disclosure-completed" => Json(json!({
                            "session_id": id,
                            "state": "disclosure_completed"
                        }))
                        .into_response(),
                        "agent-session-started" => Json(json!({
                            "session_id": id,
                            "state": "started"
                        }))
                        .into_response(),
                        "agent-session-terminal" => Json(json!({
                            "session_id": id,
                            "state": "terminal"
                        }))
                        .into_response(),
                        _ => StatusCode::NOT_FOUND.into_response(),
                    }
                }),
            )
            .route(
                "/api/playbook/reservations/{id}/start",
                post(move |Path(id): Path<String>| {
                    let count = Arc::clone(&handler_start_count);
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        if id == "agent-session-start-timeout" {
                            std::future::pending::<axum::response::Response>().await
                        } else {
                            Json(json!({ "session_id": id, "state": "started" })).into_response()
                        }
                    }
                }),
            );
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            endpoint: format!("http://{address}"),
            task,
            command_count: Arc::new(AtomicUsize::new(0)),
            status_count: Arc::new(AtomicUsize::new(0)),
            playbook_reservation_count: count,
            playbook_start_count: start_count,
            last_playbook_reservation: last,
        }
    }

    pub async fn mismatch_playbook_reservations() -> Self {
        let count = Arc::new(AtomicUsize::new(0));
        let handler_count = Arc::clone(&count);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new().route(
            "/api/playbook/run",
            post(move || {
                let count = Arc::clone(&handler_count);
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    Json(json!({ "session_id": "agent-session-drift" }))
                }
            }),
        );
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            endpoint: format!("http://{address}"),
            task,
            command_count: Arc::new(AtomicUsize::new(0)),
            status_count: Arc::new(AtomicUsize::new(0)),
            playbook_reservation_count: count,
            playbook_start_count: Arc::new(AtomicUsize::new(0)),
            last_playbook_reservation: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn timeout_playbook_reservations() -> Self {
        let count = Arc::new(AtomicUsize::new(0));
        let handler_count = Arc::clone(&count);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new().route(
            "/api/playbook/run",
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
            command_count: Arc::new(AtomicUsize::new(0)),
            status_count: Arc::new(AtomicUsize::new(0)),
            playbook_reservation_count: count,
            playbook_start_count: Arc::new(AtomicUsize::new(0)),
            last_playbook_reservation: Arc::new(Mutex::new(None)),
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

    pub fn playbook_reservation_count(&self) -> usize {
        self.playbook_reservation_count.load(Ordering::SeqCst)
    }

    pub fn playbook_start_count(&self) -> usize {
        self.playbook_start_count.load(Ordering::SeqCst)
    }

    pub fn last_playbook_reservation(&self) -> Option<serde_json::Value> {
        self.last_playbook_reservation.lock().unwrap().clone()
    }
}

impl Drop for FakeActiveCall {
    fn drop(&mut self) {
        self.task.abort();
    }
}
