use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use converact_active_call_adapter::{ActiveCallClient, ClientConfig};
use converact_ai_outbound_core::{
    AgentLegBinding, AgentObservation, AgentReleaseBinding, ChannelAgentPort, PlayDisclosure,
    PortFailureKind, ReleaseComponentDigests, ReserveAgent, StartConversation,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, ChannelAgentSessionId, TenantId,
};
use converact_voice_agent_worker::{
    ActiveCallArtifactSource, ActiveCallArtifactSourcePort, ActiveCallChannelAgent,
    ActiveCallChannelAgentConfig, ActiveCallPlaybookResolver, ActiveCallPlaybookResolverError,
    AuthenticatedTenant,
};
use serde_json::{Value, json};
use tokio::sync::Notify;

const PLAYBOOK: &str = "---\nname: sales-r1\n---\n# Main\nHello";
const ARTIFACT_HASH: &str = "d166fc603bcf881b32a0ebfde04994f38f5aa655160834ee69b0dbce5b9052af";

#[tokio::test]
async fn complete_channel_agent_port_runs_reserve_attach_disclose_start_and_terminal() {
    let fake = FakeActiveCall::start().await;
    let release = release();
    let source = ArtifactSource {
        tenant: "tenant-001".to_owned(),
        release: release.clone(),
    };
    let resolver = ActiveCallPlaybookResolver::new(source, "compiler-r1").unwrap();
    let client = Arc::new(ActiveCallClient::connect(fake.config()).unwrap());
    let agent = ActiveCallChannelAgent::new(
        client,
        resolver,
        ActiveCallChannelAgentConfig::new("This is an AI assistant and this call is recorded.", 8)
            .unwrap(),
    );
    let attempt_id = CallAttemptId::parse("attempt-001").unwrap();
    let session_id = ChannelAgentSessionId::parse("agent-session-001").unwrap();

    let reservation = agent
        .reserve(ReserveAgent {
            tenant_id: TenantId::parse("tenant-001").unwrap(),
            attempt_id: attempt_id.clone(),
            release,
            session_id: session_id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(reservation.session_id, session_id);
    fake.set_state("media_ready");

    agent
        .confirm_attachment(AgentLegBinding {
            attempt_id: attempt_id.clone(),
            call_id: CallId::parse("call-001").unwrap(),
            session_id: session_id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(
        agent.query(&session_id).await.unwrap(),
        AgentObservation::MediaReady
    );

    agent
        .play_disclosure(PlayDisclosure {
            attempt_id: attempt_id.clone(),
            session_id: session_id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(
        agent.query(&session_id).await.unwrap(),
        AgentObservation::DisclosureCompleted
    );
    agent
        .start_conversation(StartConversation {
            attempt_id,
            session_id: session_id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(
        agent.query(&session_id).await.unwrap(),
        AgentObservation::Conversing
    );
    fake.set_state("terminal");
    assert_eq!(
        agent.query(&session_id).await.unwrap(),
        AgentObservation::Terminal
    );

    assert_eq!(fake.operations(), ["reserve", "disclosure", "start"]);
    let disclosure = fake.disclosure().unwrap();
    assert_eq!(disclosure["command"], "tts");
    assert_eq!(disclosure["playId"], "agent-session-001");
}

#[tokio::test]
async fn concurrent_reservation_replay_emits_only_one_external_mutation() {
    let fake = FakeActiveCall::start().await;
    let release = release();
    let resolver = ActiveCallPlaybookResolver::new(
        ArtifactSource {
            tenant: "tenant-001".to_owned(),
            release: release.clone(),
        },
        "compiler-r1",
    )
    .unwrap();
    let agent = ActiveCallChannelAgent::new(
        Arc::new(ActiveCallClient::connect(fake.config()).unwrap()),
        resolver,
        ActiveCallChannelAgentConfig::new("This is an AI assistant and this call is recorded.", 8)
            .unwrap(),
    );
    let request = ReserveAgent {
        tenant_id: TenantId::parse("tenant-001").unwrap(),
        attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        release,
        session_id: ChannelAgentSessionId::parse("agent-session-001").unwrap(),
    };

    let (left, right) = tokio::join!(agent.reserve(request.clone()), agent.reserve(request));

    assert!(left.is_ok() || right.is_ok());
    assert_eq!(fake.operations(), ["reserve"]);
}

#[tokio::test]
async fn not_found_after_reservation_freezes_replay_as_outcome_unknown() {
    let fake = FakeActiveCall::start().await;
    let release = release();
    let resolver = ActiveCallPlaybookResolver::new(
        ArtifactSource {
            tenant: "tenant-001".to_owned(),
            release: release.clone(),
        },
        "compiler-r1",
    )
    .unwrap();
    let agent = ActiveCallChannelAgent::new(
        Arc::new(ActiveCallClient::connect(fake.config()).unwrap()),
        resolver,
        ActiveCallChannelAgentConfig::new("This is an AI assistant and this call is recorded.", 8)
            .unwrap(),
    );
    let request = ReserveAgent {
        tenant_id: TenantId::parse("tenant-001").unwrap(),
        attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        release,
        session_id: ChannelAgentSessionId::parse("agent-session-001").unwrap(),
    };

    agent.reserve(request.clone()).await.unwrap();
    fake.set_state("not_found");
    assert_eq!(
        agent.query(&request.session_id).await.unwrap(),
        AgentObservation::NotFound
    );
    let replay = agent.reserve(request).await.unwrap_err();

    assert_eq!(replay.kind(), PortFailureKind::OutcomeUnknown);
    assert_eq!(fake.operations(), ["reserve"]);
}

#[tokio::test]
async fn disclosure_unknown_cannot_be_cleared_by_an_earlier_media_ready_observation() {
    let fake = FakeActiveCall::start().await;
    let release = release();
    let resolver = ActiveCallPlaybookResolver::new(
        ArtifactSource {
            tenant: "tenant-001".to_owned(),
            release: release.clone(),
        },
        "compiler-r1",
    )
    .unwrap();
    let agent = ActiveCallChannelAgent::new(
        Arc::new(ActiveCallClient::connect(fake.config()).unwrap()),
        resolver,
        ActiveCallChannelAgentConfig::new("This is an AI assistant and this call is recorded.", 8)
            .unwrap(),
    );
    let attempt_id = CallAttemptId::parse("attempt-001").unwrap();
    let session_id = ChannelAgentSessionId::parse("agent-session-001").unwrap();
    agent
        .reserve(ReserveAgent {
            tenant_id: TenantId::parse("tenant-001").unwrap(),
            attempt_id: attempt_id.clone(),
            release,
            session_id: session_id.clone(),
        })
        .await
        .unwrap();
    fake.set_state("media_ready");
    agent
        .confirm_attachment(AgentLegBinding {
            attempt_id: attempt_id.clone(),
            call_id: CallId::parse("call-001").unwrap(),
            session_id: session_id.clone(),
        })
        .await
        .unwrap();
    fake.set_disclosure_unknown();

    let first = agent
        .play_disclosure(PlayDisclosure {
            attempt_id: attempt_id.clone(),
            session_id: session_id.clone(),
        })
        .await
        .unwrap_err();
    let observation = agent.query(&session_id).await.unwrap_err();
    let replay = agent
        .play_disclosure(PlayDisclosure {
            attempt_id,
            session_id,
        })
        .await
        .unwrap_err();

    assert_eq!(first.kind(), PortFailureKind::OutcomeUnknown);
    assert_eq!(observation.kind(), PortFailureKind::OutcomeUnknown);
    assert_eq!(replay.kind(), PortFailureKind::OutcomeUnknown);
    assert_eq!(fake.operations(), ["reserve", "disclosure"]);
}

#[tokio::test]
async fn start_unknown_cannot_be_cleared_by_disclosure_completed_observation() {
    let fake = FakeActiveCall::start().await;
    let release = release();
    let resolver = ActiveCallPlaybookResolver::new(
        ArtifactSource {
            tenant: "tenant-001".to_owned(),
            release: release.clone(),
        },
        "compiler-r1",
    )
    .unwrap();
    let agent = ActiveCallChannelAgent::new(
        Arc::new(ActiveCallClient::connect(fake.config()).unwrap()),
        resolver,
        ActiveCallChannelAgentConfig::new("This is an AI assistant and this call is recorded.", 8)
            .unwrap(),
    );
    let attempt_id = CallAttemptId::parse("attempt-001").unwrap();
    let session_id = ChannelAgentSessionId::parse("agent-session-001").unwrap();
    agent
        .reserve(ReserveAgent {
            tenant_id: TenantId::parse("tenant-001").unwrap(),
            attempt_id: attempt_id.clone(),
            release,
            session_id: session_id.clone(),
        })
        .await
        .unwrap();
    fake.set_state("media_ready");
    agent
        .confirm_attachment(AgentLegBinding {
            attempt_id: attempt_id.clone(),
            call_id: CallId::parse("call-001").unwrap(),
            session_id: session_id.clone(),
        })
        .await
        .unwrap();
    agent
        .play_disclosure(PlayDisclosure {
            attempt_id: attempt_id.clone(),
            session_id: session_id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(
        agent.query(&session_id).await.unwrap(),
        AgentObservation::DisclosureCompleted
    );
    fake.set_start_unknown();

    let first = agent
        .start_conversation(StartConversation {
            attempt_id: attempt_id.clone(),
            session_id: session_id.clone(),
        })
        .await
        .unwrap_err();
    let observation = agent.query(&session_id).await.unwrap_err();
    let replay = agent
        .start_conversation(StartConversation {
            attempt_id,
            session_id,
        })
        .await
        .unwrap_err();

    assert_eq!(first.kind(), PortFailureKind::OutcomeUnknown);
    assert_eq!(observation.kind(), PortFailureKind::OutcomeUnknown);
    assert_eq!(replay.kind(), PortFailureKind::OutcomeUnknown);
    assert_eq!(fake.operations(), ["reserve", "disclosure", "start"]);
}

#[tokio::test]
async fn attach_not_found_freezes_reservation_as_outcome_unknown() {
    let fake = FakeActiveCall::start().await;
    let release = release();
    let resolver = ActiveCallPlaybookResolver::new(
        ArtifactSource {
            tenant: "tenant-001".to_owned(),
            release: release.clone(),
        },
        "compiler-r1",
    )
    .unwrap();
    let agent = ActiveCallChannelAgent::new(
        Arc::new(ActiveCallClient::connect(fake.config()).unwrap()),
        resolver,
        ActiveCallChannelAgentConfig::new("This is an AI assistant and this call is recorded.", 8)
            .unwrap(),
    );
    let attempt_id = CallAttemptId::parse("attempt-001").unwrap();
    let session_id = ChannelAgentSessionId::parse("agent-session-001").unwrap();
    let request = ReserveAgent {
        tenant_id: TenantId::parse("tenant-001").unwrap(),
        attempt_id: attempt_id.clone(),
        release,
        session_id: session_id.clone(),
    };
    agent.reserve(request.clone()).await.unwrap();
    fake.set_state("not_found");

    let attach = agent
        .confirm_attachment(AgentLegBinding {
            attempt_id,
            call_id: CallId::parse("call-001").unwrap(),
            session_id,
        })
        .await
        .unwrap_err();
    let replay = agent.reserve(request).await.unwrap_err();

    assert_eq!(attach.kind(), PortFailureKind::OutcomeUnknown);
    assert_eq!(replay.kind(), PortFailureKind::OutcomeUnknown);
    assert_eq!(fake.operations(), ["reserve"]);
}

#[tokio::test]
async fn concurrent_resolver_failure_cannot_orphan_the_successful_reservation() {
    let fake = FakeActiveCall::start().await;
    let release = release();
    let source = FlakyArtifactSource::new("tenant-001", release.clone());
    let resolver = ActiveCallPlaybookResolver::new(source.clone(), "compiler-r1").unwrap();
    let agent = Arc::new(ActiveCallChannelAgent::new(
        Arc::new(ActiveCallClient::connect(fake.config()).unwrap()),
        resolver,
        ActiveCallChannelAgentConfig::new("This is an AI assistant and this call is recorded.", 8)
            .unwrap(),
    ));
    let attempt_id = CallAttemptId::parse("attempt-001").unwrap();
    let session_id = ChannelAgentSessionId::parse("agent-session-001").unwrap();
    let request = ReserveAgent {
        tenant_id: TenantId::parse("tenant-001").unwrap(),
        attempt_id: attempt_id.clone(),
        release,
        session_id: session_id.clone(),
    };
    let first_agent = Arc::clone(&agent);
    let first_request = request.clone();
    let first = tokio::spawn(async move { first_agent.reserve(first_request).await });
    source.first_started.notified().await;
    let second_agent = Arc::clone(&agent);
    let second = tokio::spawn(async move { second_agent.reserve(request).await });
    source.release_first.notify_one();

    let first_error = first.await.unwrap().unwrap_err();
    second.await.unwrap().unwrap();
    fake.set_state("media_ready");
    agent
        .confirm_attachment(AgentLegBinding {
            attempt_id,
            call_id: CallId::parse("call-001").unwrap(),
            session_id,
        })
        .await
        .unwrap();

    assert_eq!(first_error.kind(), PortFailureKind::Unavailable);
    assert_eq!(fake.operations(), ["reserve"]);
}

#[tokio::test]
async fn media_ready_cannot_bypass_the_required_call_attachment() {
    let fake = FakeActiveCall::start().await;
    let release = release();
    let resolver = ActiveCallPlaybookResolver::new(
        ArtifactSource {
            tenant: "tenant-001".to_owned(),
            release: release.clone(),
        },
        "compiler-r1",
    )
    .unwrap();
    let agent = ActiveCallChannelAgent::new(
        Arc::new(ActiveCallClient::connect(fake.config()).unwrap()),
        resolver,
        ActiveCallChannelAgentConfig::new("This is an AI assistant and this call is recorded.", 8)
            .unwrap(),
    );
    let attempt_id = CallAttemptId::parse("attempt-001").unwrap();
    let session_id = ChannelAgentSessionId::parse("agent-session-001").unwrap();
    agent
        .reserve(ReserveAgent {
            tenant_id: TenantId::parse("tenant-001").unwrap(),
            attempt_id: attempt_id.clone(),
            release,
            session_id: session_id.clone(),
        })
        .await
        .unwrap();
    fake.set_state("media_ready");
    assert_eq!(
        agent.query(&session_id).await.unwrap(),
        AgentObservation::MediaReady
    );

    let disclosure = agent
        .play_disclosure(PlayDisclosure {
            attempt_id,
            session_id,
        })
        .await
        .unwrap_err();

    assert_eq!(disclosure.kind(), PortFailureKind::Rejected);
    assert_eq!(fake.operations(), ["reserve"]);
}

#[derive(Clone)]
struct ArtifactSource {
    tenant: String,
    release: AgentReleaseBinding,
}

impl ActiveCallArtifactSourcePort for ArtifactSource {
    async fn load(
        &self,
        tenant: &AuthenticatedTenant,
        release: &AgentReleaseBinding,
    ) -> Result<Option<ActiveCallArtifactSource>, ActiveCallPlaybookResolverError> {
        if tenant.as_str() != self.tenant || release != &self.release {
            return Ok(None);
        }
        Ok(Some(ActiveCallArtifactSource::new(
            self.release.clone(),
            "compiler-r1",
            PLAYBOOK,
            ARTIFACT_HASH,
        )))
    }
}

#[derive(Clone)]
struct FlakyArtifactSource {
    tenant: String,
    release: AgentReleaseBinding,
    calls: Arc<AtomicUsize>,
    first_started: Arc<Notify>,
    release_first: Arc<Notify>,
}

impl FlakyArtifactSource {
    fn new(tenant: &str, release: AgentReleaseBinding) -> Self {
        Self {
            tenant: tenant.to_owned(),
            release,
            calls: Arc::new(AtomicUsize::new(0)),
            first_started: Arc::new(Notify::new()),
            release_first: Arc::new(Notify::new()),
        }
    }
}

impl ActiveCallArtifactSourcePort for FlakyArtifactSource {
    async fn load(
        &self,
        tenant: &AuthenticatedTenant,
        release: &AgentReleaseBinding,
    ) -> Result<Option<ActiveCallArtifactSource>, ActiveCallPlaybookResolverError> {
        if tenant.as_str() != self.tenant || release != &self.release {
            return Ok(None);
        }
        if self.calls.fetch_add(1, Ordering::Relaxed) == 0 {
            self.first_started.notify_one();
            self.release_first.notified().await;
            return Err(ActiveCallPlaybookResolverError::Unavailable);
        }
        Ok(Some(ActiveCallArtifactSource::new(
            self.release.clone(),
            "compiler-r1",
            PLAYBOOK,
            ARTIFACT_HASH,
        )))
    }
}

#[derive(Clone)]
struct FakeState {
    state: Arc<Mutex<&'static str>>,
    operations: Arc<Mutex<Vec<&'static str>>>,
    disclosure: Arc<Mutex<Option<Value>>>,
    disclosure_unknown: Arc<AtomicBool>,
    start_unknown: Arc<AtomicBool>,
}

struct FakeActiveCall {
    endpoint: String,
    state: FakeState,
    task: tokio::task::JoinHandle<()>,
}

impl FakeActiveCall {
    async fn start() -> Self {
        let state = FakeState {
            state: Arc::new(Mutex::new("not_found")),
            operations: Arc::new(Mutex::new(Vec::new())),
            disclosure: Arc::new(Mutex::new(None)),
            disclosure_unknown: Arc::new(AtomicBool::new(false)),
            start_unknown: Arc::new(AtomicBool::new(false)),
        };
        let app = Router::new()
            .route("/api/playbook/run", post(reserve))
            .route("/api/playbook/reservations/{id}", get(query))
            .route("/api/playbook/reservations/{id}/start", post(start))
            .route("/command/{id}", post(command))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            endpoint,
            state,
            task,
        }
    }

    fn config(&self) -> ClientConfig {
        ClientConfig::new(&self.endpoint, 1_000, 4_096).unwrap()
    }

    fn set_state(&self, state: &'static str) {
        *self.state.state.lock().unwrap() = state;
    }

    fn operations(&self) -> Vec<&'static str> {
        self.state.operations.lock().unwrap().clone()
    }

    fn disclosure(&self) -> Option<Value> {
        self.state.disclosure.lock().unwrap().clone()
    }

    fn set_disclosure_unknown(&self) {
        self.state.disclosure_unknown.store(true, Ordering::Relaxed);
    }

    fn set_start_unknown(&self) {
        self.state.start_unknown.store(true, Ordering::Relaxed);
    }
}

impl Drop for FakeActiveCall {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn reserve(State(state): State<FakeState>, Json(body): Json<Value>) -> Json<Value> {
    state.operations.lock().unwrap().push("reserve");
    *state.state.lock().unwrap() = "pending";
    Json(json!({"session_id": body["session_id"]}))
}

async fn query(Path(id): Path<String>, State(state): State<FakeState>) -> impl IntoResponse {
    let current = *state.state.lock().unwrap();
    if current == "not_found" {
        return StatusCode::NOT_FOUND.into_response();
    }
    Json(json!({"session_id": id, "state": current})).into_response()
}

async fn command(
    Path(id): Path<String>,
    State(state): State<FakeState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    state.operations.lock().unwrap().push("disclosure");
    *state.disclosure.lock().unwrap() = Some(body);
    if state.disclosure_unknown.load(Ordering::Relaxed) {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    *state.state.lock().unwrap() = "disclosure_completed";
    Json(json!({"status": "sent", "id": id})).into_response()
}

async fn start(Path(id): Path<String>, State(state): State<FakeState>) -> impl IntoResponse {
    if *state.state.lock().unwrap() != "disclosure_completed" {
        return StatusCode::CONFLICT.into_response();
    }
    state.operations.lock().unwrap().push("start");
    if state.start_unknown.load(Ordering::Relaxed) {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    *state.state.lock().unwrap() = "started";
    Json(json!({"session_id": id, "state": "started"})).into_response()
}

fn release() -> AgentReleaseBinding {
    AgentReleaseBinding::try_new(
        AgentReleaseId::parse("release-001").unwrap(),
        "9".repeat(64),
        ReleaseComponentDigests {
            prompt_revision_hash: "1".repeat(64),
            conversation_flow_revision_hash: "2".repeat(64),
            knowledge_revision_hash: "3".repeat(64),
            tool_schema_hash: "4".repeat(64),
            speech_profile_hash: "5".repeat(64),
            compliance_policy_hash: "6".repeat(64),
            outcome_schema_hash: "7".repeat(64),
            evaluation_rubric_hash: "8".repeat(64),
        },
    )
    .unwrap()
}
