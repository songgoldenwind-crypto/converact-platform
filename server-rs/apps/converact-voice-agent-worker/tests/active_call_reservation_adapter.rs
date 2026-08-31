use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
use converact_active_call_adapter::{ActiveCallClient, ClientConfig};
use converact_ai_outbound_core::{AgentReleaseBinding, ReleaseComponentDigests, ReserveAgent};
use converact_voice_agent_contracts::{AgentReleaseId, CallAttemptId, ChannelAgentSessionId};
use converact_voice_agent_worker::{
    ActiveCallPlaybookArtifact, ActiveCallReservationAdapter, ActiveCallReservationObservation,
};
use serde_json::{Value, json};

const PLAYBOOK: &str = "---\nname: sales-r1\n---\n# Main\nHello";
const ARTIFACT_HASH: &str = "d166fc603bcf881b32a0ebfde04994f38f5aa655160834ee69b0dbce5b9052af";

#[tokio::test]
async fn exact_artifact_is_reserved_under_the_platform_session_identity() {
    let fake = FakeActiveCall::start().await;
    let adapter = ActiveCallReservationAdapter::new(Arc::new(
        ActiveCallClient::connect(fake.config()).unwrap(),
    ));
    let release = release("release-001", '9');
    let session_id = ChannelAgentSessionId::parse("ac.session-001").unwrap();

    let reservation = adapter
        .reserve(
            ReserveAgent {
                attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
                release: release.clone(),
                session_id: session_id.clone(),
            },
            ActiveCallPlaybookArtifact::try_new(release, PLAYBOOK, ARTIFACT_HASH).unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(reservation.session_id, session_id);
    assert_eq!(fake.request_count(), 1);
    let request = fake.last_request().unwrap();
    assert_eq!(request["session_id"], "ac.session-001");
    assert_eq!(request["content"], PLAYBOOK);
    assert_eq!(
        adapter.query(&reservation.session_id).await.unwrap(),
        ActiveCallReservationObservation::Pending
    );
}

#[tokio::test]
async fn cross_release_artifact_is_rejected_before_network_mutation() {
    let fake = FakeActiveCall::start().await;
    let adapter = ActiveCallReservationAdapter::new(Arc::new(
        ActiveCallClient::connect(fake.config()).unwrap(),
    ));
    let requested = release("release-001", '9');
    let artifact =
        ActiveCallPlaybookArtifact::try_new(release("release-002", '8'), PLAYBOOK, ARTIFACT_HASH)
            .unwrap();

    let error = adapter
        .reserve(
            ReserveAgent {
                attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
                release: requested,
                session_id: ChannelAgentSessionId::parse("ac.session-001").unwrap(),
            },
            artifact,
        )
        .await
        .unwrap_err();

    assert_eq!(error.code(), "active_call_artifact_release_mismatch");
    assert_eq!(fake.request_count(), 0);
}

#[derive(Clone, Default)]
struct FakeState {
    requests: Arc<Mutex<Vec<Value>>>,
}

struct FakeActiveCall {
    endpoint: String,
    state: FakeState,
    task: tokio::task::JoinHandle<()>,
}

impl FakeActiveCall {
    async fn start() -> Self {
        let state = FakeState::default();
        let app = Router::new()
            .route("/api/playbook/run", post(reserve_playbook))
            .route(
                "/api/playbook/reservations/{session_id}",
                get(query_reservation),
            )
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            endpoint,
            state,
            task,
        }
    }

    fn config(&self) -> ClientConfig {
        ClientConfig::new(&self.endpoint, 1_000, 4_096).unwrap()
    }

    fn request_count(&self) -> usize {
        self.state.requests.lock().unwrap().len()
    }

    fn last_request(&self) -> Option<Value> {
        self.state.requests.lock().unwrap().last().cloned()
    }
}

impl Drop for FakeActiveCall {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn reserve_playbook(
    State(state): State<FakeState>,
    Json(request): Json<Value>,
) -> Json<Value> {
    state.requests.lock().unwrap().push(request.clone());
    Json(json!({"session_id": request["session_id"]}))
}

async fn query_reservation(Path(session_id): Path<String>) -> Json<Value> {
    Json(json!({"session_id": session_id, "state": "pending"}))
}

fn release(id: &str, digest_character: char) -> AgentReleaseBinding {
    AgentReleaseBinding::try_new(
        AgentReleaseId::parse(id).unwrap(),
        digest_character.to_string().repeat(64),
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
