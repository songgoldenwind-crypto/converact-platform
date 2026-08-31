use std::{collections::HashMap, sync::Mutex};

use converact_agent_handoff_core::{
    ContextPacket, ContextPacketInput, ContextRevision, ControlOwner, HandoffSession, HandoffTarget,
};
use converact_agent_handoff_store::{HandoffStoreCommand, HandoffTransitionWrite};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    ContextPacketId, EnvelopeContext, EnvelopeContextInput, ExecutionGeneration, HandoffCommandId,
    HandoffId, HumanLegId, InteractionId, VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    AiResumeCommandIds, AiResumeRequest, ChannelAgentHandoffPort, DurableCreateDecision,
    DurablePrepareDecision, EffectObservation, GenerationCommit, HandoffDurabilityPort,
    HandoffProgress, HandoffRuntime, HumanActivationCommandIds, HumanDialRequest,
    HumanLegObservation, TelephonyHandoffPort, VoiceHandoffPortError,
};

#[tokio::test]
async fn durable_handoff_reaches_human_then_ai_without_repeating_effects_on_replay() {
    let durability = MemoryDurability::default();
    let telephony = FakeTelephony::default();
    let channel = FakeChannelAgent::default();
    let runtime = HandoffRuntime::new(&durability, &telephony, &channel);
    let requested = requested();
    let human_ids = human_ids();

    let first = runtime
        .activate_human(
            &requested,
            HumanLegId::parse("human-leg-001").unwrap(),
            &human_ids,
        )
        .await
        .unwrap();
    let HandoffProgress::HumanActive(human_active) = first else {
        panic!("answered human must become active")
    };
    assert_eq!(human_active.owner(), ControlOwner::Human);
    assert_eq!(human_active.execution_generation().get(), 2);

    let replay = runtime
        .activate_human(
            &requested,
            HumanLegId::parse("human-leg-001").unwrap(),
            &human_ids,
        )
        .await
        .unwrap();
    assert!(matches!(replay, HandoffProgress::HumanActive(_)));

    let resumed = runtime
        .resume_ai(
            &human_active,
            ChannelAgentSessionId::parse("agent-session-002").unwrap(),
            &ai_ids(),
        )
        .await
        .unwrap();
    let HandoffProgress::AiResumed(ai_resumed) = resumed else {
        panic!("ready AI must regain ownership")
    };
    assert_eq!(ai_resumed.owner(), ControlOwner::Ai);
    assert_eq!(ai_resumed.execution_generation().get(), 3);
    assert_eq!(telephony.dial_count(), 1);
    assert_eq!(channel.prepare_count(), 1);
    assert_eq!(
        channel.commits(),
        ["human:2:commit-human", "ai:3:commit-ai-resume"]
    );
}

#[tokio::test]
async fn unknown_dial_outcome_is_queried_before_human_activation_without_redialing() {
    let durability = MemoryDurability::default();
    let telephony = FakeTelephony::with_first_dial_outcome(EffectObservation::OutcomeUnknown);
    let channel = FakeChannelAgent::default();
    let runtime = HandoffRuntime::new(&durability, &telephony, &channel);
    let requested = requested();
    let ids = human_ids();

    let first = runtime
        .activate_human(
            &requested,
            HumanLegId::parse("human-leg-001").unwrap(),
            &ids,
        )
        .await
        .unwrap();
    assert!(matches!(first, HandoffProgress::Pending(_)));

    let reconciled = runtime
        .activate_human(
            &requested,
            HumanLegId::parse("human-leg-001").unwrap(),
            &ids,
        )
        .await
        .unwrap();
    assert!(matches!(reconciled, HandoffProgress::HumanActive(_)));
    assert_eq!(telephony.dial_count(), 1);
}

#[tokio::test]
async fn rejected_human_dial_aborts_without_redialing_on_replay() {
    let durability = MemoryDurability::default();
    let telephony =
        FakeTelephony::with_first_dial_outcome(EffectObservation::NotApplied("seat_unavailable"));
    let channel = FakeChannelAgent::default();
    let runtime = HandoffRuntime::new(&durability, &telephony, &channel);
    let requested = requested();
    let ids = human_ids();

    let first = runtime
        .activate_human(
            &requested,
            HumanLegId::parse("human-leg-001").unwrap(),
            &ids,
        )
        .await
        .unwrap();
    assert!(matches!(first, HandoffProgress::Aborted(_)));

    let replay = runtime
        .activate_human(
            &requested,
            HumanLegId::parse("human-leg-001").unwrap(),
            &ids,
        )
        .await
        .unwrap();
    assert!(matches!(replay, HandoffProgress::Aborted(_)));
    assert_eq!(telephony.dial_count(), 1);
}

#[tokio::test]
async fn unknown_ai_resume_is_queried_without_starting_a_second_session() {
    let durability = MemoryDurability::default();
    let telephony = FakeTelephony::default();
    let channel = FakeChannelAgent::with_first_prepare_outcome(EffectObservation::OutcomeUnknown);
    let runtime = HandoffRuntime::new(&durability, &telephony, &channel);
    let requested = requested();
    let HandoffProgress::HumanActive(human_active) = runtime
        .activate_human(
            &requested,
            HumanLegId::parse("human-leg-001").unwrap(),
            &human_ids(),
        )
        .await
        .unwrap()
    else {
        panic!("answered human must become active")
    };
    let ai_session_id = ChannelAgentSessionId::parse("agent-session-002").unwrap();
    let ids = ai_ids();

    let first = runtime
        .resume_ai(&human_active, ai_session_id.clone(), &ids)
        .await
        .unwrap();
    assert!(matches!(first, HandoffProgress::Pending(_)));

    let reconciled = runtime
        .resume_ai(&human_active, ai_session_id, &ids)
        .await
        .unwrap();
    assert!(matches!(reconciled, HandoffProgress::AiResumed(_)));
    assert_eq!(channel.prepare_count(), 1);
}

#[derive(Default)]
struct MemoryDurability {
    commands: Mutex<HashMap<String, DurableState>>,
}

#[derive(Clone, Copy)]
enum DurableState {
    Prepared,
    Applied,
    NotApplied,
}

impl HandoffDurabilityPort for MemoryDurability {
    async fn create_requested(
        &self,
        _requested: &HandoffSession,
        command: &HandoffStoreCommand,
    ) -> Result<DurableCreateDecision, VoiceHandoffPortError> {
        let mut commands = self.commands.lock().unwrap();
        if commands
            .insert(command.id().as_str().to_owned(), DurableState::Applied)
            .is_some()
        {
            Ok(DurableCreateDecision::Replayed)
        } else {
            Ok(DurableCreateDecision::Created)
        }
    }

    async fn prepare_transition(
        &self,
        write: &HandoffTransitionWrite<'_>,
    ) -> Result<DurablePrepareDecision, VoiceHandoffPortError> {
        let mut commands = self.commands.lock().unwrap();
        match commands.get(write.command().id().as_str()).copied() {
            None => {
                commands.insert(
                    write.command().id().as_str().to_owned(),
                    DurableState::Prepared,
                );
                Ok(DurablePrepareDecision::Execute)
            }
            Some(DurableState::Prepared) => Ok(DurablePrepareDecision::Query),
            Some(DurableState::Applied) => Ok(DurablePrepareDecision::ReplayApplied),
            Some(DurableState::NotApplied) => Ok(DurablePrepareDecision::ReplayNotApplied),
        }
    }

    async fn finalize_applied(
        &self,
        write: &HandoffTransitionWrite<'_>,
    ) -> Result<(), VoiceHandoffPortError> {
        self.commands.lock().unwrap().insert(
            write.command().id().as_str().to_owned(),
            DurableState::Applied,
        );
        Ok(())
    }

    async fn finalize_not_applied(
        &self,
        _current: &HandoffSession,
        command: &HandoffStoreCommand,
        _failure_code: &'static str,
    ) -> Result<(), VoiceHandoffPortError> {
        self.commands
            .lock()
            .unwrap()
            .insert(command.id().as_str().to_owned(), DurableState::NotApplied);
        Ok(())
    }
}

#[derive(Default)]
struct FakeTelephony {
    dial_count: Mutex<u32>,
    next_dial_outcome: Mutex<Option<EffectObservation>>,
}

impl FakeTelephony {
    fn with_first_dial_outcome(outcome: EffectObservation) -> Self {
        Self {
            dial_count: Mutex::new(0),
            next_dial_outcome: Mutex::new(Some(outcome)),
        }
    }

    fn dial_count(&self) -> u32 {
        *self.dial_count.lock().unwrap()
    }
}

impl TelephonyHandoffPort for FakeTelephony {
    async fn dial_human(
        &self,
        _request: HumanDialRequest,
    ) -> Result<EffectObservation, VoiceHandoffPortError> {
        *self.dial_count.lock().unwrap() += 1;
        Ok(self
            .next_dial_outcome
            .lock()
            .unwrap()
            .take()
            .unwrap_or(EffectObservation::Applied))
    }

    async fn query_human_leg(
        &self,
        _request: HumanDialRequest,
    ) -> Result<HumanLegObservation, VoiceHandoffPortError> {
        Ok(HumanLegObservation::Answered)
    }
}

#[derive(Default)]
struct FakeChannelAgent {
    prepare_count: Mutex<u32>,
    next_prepare_outcome: Mutex<Option<EffectObservation>>,
    commits: Mutex<Vec<String>>,
}

impl FakeChannelAgent {
    fn with_first_prepare_outcome(outcome: EffectObservation) -> Self {
        Self {
            prepare_count: Mutex::new(0),
            next_prepare_outcome: Mutex::new(Some(outcome)),
            commits: Mutex::new(Vec::new()),
        }
    }

    fn prepare_count(&self) -> u32 {
        *self.prepare_count.lock().unwrap()
    }

    fn commits(&self) -> Vec<String> {
        self.commits.lock().unwrap().clone()
    }
}

impl ChannelAgentHandoffPort for FakeChannelAgent {
    async fn prepare_ai_resume(
        &self,
        _request: AiResumeRequest,
    ) -> Result<EffectObservation, VoiceHandoffPortError> {
        *self.prepare_count.lock().unwrap() += 1;
        Ok(self
            .next_prepare_outcome
            .lock()
            .unwrap()
            .take()
            .unwrap_or(EffectObservation::Applied))
    }

    async fn query_ai_resume(
        &self,
        _request: AiResumeRequest,
    ) -> Result<EffectObservation, VoiceHandoffPortError> {
        Ok(EffectObservation::Applied)
    }

    async fn generation_committed(
        &self,
        commit: GenerationCommit,
    ) -> Result<(), VoiceHandoffPortError> {
        let value = format!(
            "{}:{}:{}",
            commit.owner().as_str(),
            commit.generation().get(),
            commit.idempotency_key().as_str()
        );
        let mut commits = self.commits.lock().unwrap();
        if !commits.contains(&value) {
            commits.push(value);
        }
        Ok(())
    }
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
            transcript_artifact_ref: Some("transcript:001".to_owned()),
            unresolved_item_refs: vec!["issue:001".to_owned()],
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

fn human_ids() -> HumanActivationCommandIds {
    HumanActivationCommandIds {
        request: command_id("request-handoff"),
        prepare: command_id("prepare-handoff"),
        dial: command_id("dial-human"),
        observe_answered: command_id("observe-human-answered"),
        commit: command_id("commit-human"),
        mark_active: command_id("mark-human-active"),
        abort_before_dial: command_id("abort-before-dial"),
        abort_after_dial: command_id("abort-after-dial"),
    }
}

fn ai_ids() -> AiResumeCommandIds {
    AiResumeCommandIds {
        prepare: command_id("prepare-ai-resume"),
        commit: command_id("commit-ai-resume"),
    }
}

fn command_id(value: &str) -> HandoffCommandId {
    HandoffCommandId::parse(value).unwrap()
}
