use std::sync::Arc;

use converact_active_call_adapter::{
    ActiveCallClient, ActiveCallCommand, ActiveCallSessionState, AdapterCommand,
};
use converact_agent_handoff_core::ControlOwner;

use crate::{
    AiResumeRequest, ChannelAgentHandoffPort, EffectObservation, GenerationCommit,
    VoiceHandoffPortError,
};

/// Concrete bounded Handoff boundary for the pinned private Active Call process.
///
/// Session presence is a readiness observation only. Playback control never becomes ownership or
/// media-routing authority; the `RustPBX` media switch remains a separate required effect.
#[derive(Clone)]
pub struct ActiveCallHandoffPort {
    client: Arc<ActiveCallClient>,
}

impl ActiveCallHandoffPort {
    #[must_use]
    pub const fn new(client: Arc<ActiveCallClient>) -> Self {
        Self { client }
    }

    async fn observe_replacement(
        &self,
        request: &AiResumeRequest,
    ) -> Result<EffectObservation, VoiceHandoffPortError> {
        match self.client.query_session(request.ai_session_id()).await {
            Ok(ActiveCallSessionState::Active) => Ok(EffectObservation::Applied),
            Ok(ActiveCallSessionState::NotFound) => Ok(EffectObservation::NotApplied(
                "active_call_session_not_found",
            )),
            Err(error) => Err(VoiceHandoffPortError::new(error.code())),
        }
    }
}

impl ChannelAgentHandoffPort for ActiveCallHandoffPort {
    async fn prepare_ai_resume(
        &self,
        request: AiResumeRequest,
    ) -> Result<EffectObservation, VoiceHandoffPortError> {
        self.observe_replacement(&request).await
    }

    async fn query_ai_resume(
        &self,
        request: AiResumeRequest,
    ) -> Result<EffectObservation, VoiceHandoffPortError> {
        self.observe_replacement(&request).await
    }

    async fn generation_committed(
        &self,
        commit: GenerationCommit,
    ) -> Result<(), VoiceHandoffPortError> {
        if commit.owner() == ControlOwner::Ai {
            return Ok(());
        }
        let command = ActiveCallCommand::try_new(
            commit.ai_session_id().clone(),
            AdapterCommand::InterruptOutput { fade_out_ms: None },
        )
        .map_err(|error| VoiceHandoffPortError::new(error.code()))?;
        self.client
            .send_command(command)
            .await
            .map(|_| ())
            .map_err(|error| VoiceHandoffPortError::new(error.code()))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{
        Json, Router,
        extract::{Path, State},
        routing::{get, post},
    };
    use converact_active_call_adapter::{ActiveCallClient, ClientConfig};
    use converact_agent_handoff_core::{
        ContextPacket, ContextPacketInput, ContextRevision, HandoffSession, HandoffTarget,
    };
    use converact_voice_agent_contracts::{
        AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId,
        ChannelAgentSessionId, ContextPacketId, EnvelopeContext, EnvelopeContextInput,
        ExecutionGeneration, HandoffCommandId, HandoffId, HumanLegId, InteractionId,
        VOICE_AGENT_SCHEMA_VERSION,
    };
    use serde_json::{Value, json};
    use tokio::{net::TcpListener, task::JoinHandle};

    use crate::{AiResumeRequest, ChannelAgentHandoffPort, EffectObservation, GenerationCommit};

    use super::ActiveCallHandoffPort;

    #[tokio::test]
    async fn replacement_session_must_exist_without_creating_or_resuming_it() {
        let fake = FakeActiveCall::start(["agent-session-002"]).await;
        let port =
            ActiveCallHandoffPort::new(Arc::new(ActiveCallClient::connect(fake.config()).unwrap()));
        let human_active = human_active();
        let request = AiResumeRequest::from_handoff(
            &human_active,
            ChannelAgentSessionId::parse("agent-session-002").unwrap(),
            command_id("prepare-ai-resume"),
        );

        assert_eq!(
            port.prepare_ai_resume(request.clone()).await.unwrap(),
            EffectObservation::Applied,
        );
        assert_eq!(
            port.query_ai_resume(request).await.unwrap(),
            EffectObservation::Applied,
        );
        assert!(fake.commands().is_empty());
    }

    #[tokio::test]
    async fn missing_replacement_session_is_deterministically_not_applied() {
        let fake = FakeActiveCall::start([]).await;
        let port =
            ActiveCallHandoffPort::new(Arc::new(ActiveCallClient::connect(fake.config()).unwrap()));
        let request = AiResumeRequest::from_handoff(
            &human_active(),
            ChannelAgentSessionId::parse("agent-session-002").unwrap(),
            command_id("prepare-ai-resume"),
        );

        assert_eq!(
            port.prepare_ai_resume(request).await.unwrap(),
            EffectObservation::NotApplied("active_call_session_not_found"),
        );
        assert!(fake.commands().is_empty());
    }

    #[tokio::test]
    async fn human_generation_interrupts_only_the_bound_previous_ai_session() {
        let fake = FakeActiveCall::start(["agent-session-001"]).await;
        let port =
            ActiveCallHandoffPort::new(Arc::new(ActiveCallClient::connect(fake.config()).unwrap()));
        let commit = GenerationCommit::from_handoff(&human_committed(), command_id("commit-human"));

        port.generation_committed(commit).await.unwrap();

        assert_eq!(
            fake.commands(),
            [(
                "agent-session-001".to_owned(),
                json!({ "command": "interrupt", "graceful": false }),
            )]
        );
    }

    #[tokio::test]
    async fn new_ai_generation_does_not_resume_an_unpaused_playback_track() {
        let fake = FakeActiveCall::start(["agent-session-002"]).await;
        let port =
            ActiveCallHandoffPort::new(Arc::new(ActiveCallClient::connect(fake.config()).unwrap()));
        let commit = GenerationCommit::from_handoff(&ai_resumed(), command_id("commit-ai-resume"));

        port.generation_committed(commit).await.unwrap();

        assert!(fake.commands().is_empty());
    }

    #[derive(Clone)]
    struct FakeState {
        active_sessions: Arc<Vec<String>>,
        commands: Arc<Mutex<Vec<(String, Value)>>>,
    }

    struct FakeActiveCall {
        endpoint: String,
        state: FakeState,
        task: JoinHandle<()>,
    }

    impl FakeActiveCall {
        async fn start<const N: usize>(sessions: [&str; N]) -> Self {
            let state = FakeState {
                active_sessions: Arc::new(sessions.into_iter().map(str::to_owned).collect()),
                commands: Arc::new(Mutex::new(Vec::new())),
            };
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let router = Router::new()
                .route("/list", get(list_sessions))
                .route("/command/{id}", post(accept_command))
                .with_state(state.clone());
            let task = tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            });
            Self {
                endpoint: format!("http://{address}"),
                state,
                task,
            }
        }

        fn config(&self) -> ClientConfig {
            ClientConfig::new(&self.endpoint, 200, 1_024).unwrap()
        }

        fn commands(&self) -> Vec<(String, Value)> {
            self.state.commands.lock().unwrap().clone()
        }
    }

    impl Drop for FakeActiveCall {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn list_sessions(State(state): State<FakeState>) -> Json<Value> {
        Json(json!({
            "active_calls": state
                .active_sessions
                .iter()
                .map(|id| json!({ "id": id }))
                .collect::<Vec<_>>()
        }))
    }

    async fn accept_command(
        Path(id): Path<String>,
        State(state): State<FakeState>,
        Json(payload): Json<Value>,
    ) -> Json<Value> {
        state.commands.lock().unwrap().push((id.clone(), payload));
        Json(json!({ "status": "sent", "id": id }))
    }

    fn ai_resumed() -> HandoffSession {
        let human = human_active();
        let preparing = human
            .prepare_ai_resume(
                human.revision(),
                human.execution_generation(),
                ChannelAgentSessionId::parse("agent-session-002").unwrap(),
            )
            .unwrap();
        preparing
            .commit_ai_resume(preparing.revision(), preparing.execution_generation())
            .unwrap()
    }

    fn human_active() -> HandoffSession {
        let committed = human_committed();
        committed
            .mark_human_active(committed.revision(), committed.execution_generation())
            .unwrap()
    }

    fn human_committed() -> HandoffSession {
        let requested = requested();
        let prepared = requested
            .prepare(requested.revision(), requested.execution_generation())
            .unwrap();
        let dialing = prepared
            .observe_human_leg_dialing(
                prepared.revision(),
                prepared.execution_generation(),
                HumanLegId::parse("human-leg-001").unwrap(),
            )
            .unwrap();
        let answered = dialing
            .observe_human_leg_answered(dialing.revision(), dialing.execution_generation())
            .unwrap();
        answered
            .commit_human(answered.revision(), answered.execution_generation())
            .unwrap()
    }

    fn requested() -> HandoffSession {
        HandoffSession::request(
            HandoffId::parse("handoff-001").unwrap(),
            EnvelopeContext::try_new(EnvelopeContextInput {
                schema_version: VOICE_AGENT_SCHEMA_VERSION,
                tenant_id: "tenant-a".to_owned(),
                interaction_id: InteractionId::parse("interaction-001").unwrap(),
                campaign_id: CampaignId::parse("campaign-001").unwrap(),
                campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
                call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
                call_id: Some(CallId::parse("call-001").unwrap()),
                agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
                channel_agent_session_id: Some(
                    ChannelAgentSessionId::parse("agent-session-001").unwrap(),
                ),
                execution_generation: ExecutionGeneration::new(1).unwrap(),
                trace_id: "trace-001".to_owned(),
            })
            .unwrap(),
            ContextPacket::try_new(ContextPacketInput {
                id: ContextPacketId::parse("packet-001").unwrap(),
                revision: ContextRevision::new(1).unwrap(),
                digest: "a".repeat(64),
                summary_artifact_ref: "summary:001".to_owned(),
                transcript_artifact_ref: None,
                unresolved_item_refs: Vec::new(),
                action_receipt_refs: Vec::new(),
                disclosure_completed: true,
                recording_active: true,
                data_region_policy_ref: "region:cn-mainland".to_owned(),
                created_at_ms: 1_000,
            })
            .unwrap(),
            HandoffTarget::try_new("support", ["billing"], Some("seat-001")).unwrap(),
        )
        .unwrap()
    }

    fn command_id(value: &str) -> HandoffCommandId {
        HandoffCommandId::parse(value).unwrap()
    }
}
