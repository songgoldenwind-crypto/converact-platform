#![allow(dead_code)]

use std::{
    future::ready,
    sync::{Arc, Mutex},
};

use converact_ai_outbound_core::{
    AgentDraft, AgentObservation, AgentReleaseBinding, AgentReservation, AttachCall,
    AttemptCommand, AttemptStorePort, CallAttempt, CallObservation, Campaign, CampaignCommand,
    ChannelAgentPort, ComplianceDecision, ComplianceInput, CompliancePort, ConsentBasis,
    EffectIntent, EvidenceStatus, GateStatus, OrchestrationError, OriginateCall,
    OutboundOrchestrator, PlayDisclosure, PortError, ReleaseComponentDigests, ReserveAgent,
    StartConversation, TelephonyPort, TerminateCall,
};
use converact_voice_agent_contracts::{
    AgentDefinitionId, AgentReleaseId, CallAttemptId, CallAttemptState, CallId, CampaignId,
    ChannelAgentSessionId, TenantId,
};

pub fn agent_draft() -> AgentDraft {
    AgentDraft::try_new(
        AgentDefinitionId::parse("agent-sales-assistant").unwrap(),
        AgentReleaseId::parse("agent-sales-assistant-r1").unwrap(),
        "Industry-neutral sales assistant",
        "zh-CN",
    )
    .unwrap()
}

pub fn release_digests() -> ReleaseComponentDigests {
    ReleaseComponentDigests {
        prompt_revision_hash: "1".repeat(64),
        conversation_flow_revision_hash: "2".repeat(64),
        knowledge_revision_hash: "3".repeat(64),
        tool_schema_hash: "4".repeat(64),
        speech_profile_hash: "5".repeat(64),
        compliance_policy_hash: "6".repeat(64),
        outcome_schema_hash: "7".repeat(64),
        evaluation_rubric_hash: "8".repeat(64),
    }
}

pub fn running_campaign() -> Campaign {
    Campaign::new(CampaignId::parse("campaign-001").unwrap())
        .apply(CampaignCommand::Schedule)
        .unwrap()
        .apply(CampaignCommand::Start)
        .unwrap()
        .observe_attempt_started()
        .unwrap()
}

pub fn completed_campaign() -> Campaign {
    running_campaign()
        .apply(CampaignCommand::Drain)
        .unwrap()
        .observe_attempt_finished()
        .unwrap()
        .apply(CampaignCommand::Complete)
        .unwrap()
}

pub fn planned_attempt() -> CallAttempt {
    CallAttempt::new(CallAttemptId::parse("attempt-001").unwrap())
}

pub fn no_answer_attempt() -> CallAttempt {
    dialling_attempt()
        .apply(AttemptCommand::MarkNoAnswer)
        .unwrap()
}

pub fn outcome_unknown_attempt() -> CallAttempt {
    dialling_attempt()
        .apply(AttemptCommand::MarkOutcomeUnknown)
        .unwrap()
}

fn dialling_attempt() -> CallAttempt {
    planned_attempt()
        .apply(AttemptCommand::Claim)
        .unwrap()
        .apply(AttemptCommand::ApproveCompliance)
        .unwrap()
        .apply(AttemptCommand::ReserveAgentCapacity)
        .unwrap()
        .apply(AttemptCommand::Dial)
        .unwrap()
}

pub fn disclosure_pending_attempt() -> CallAttempt {
    dialling_attempt()
        .apply(AttemptCommand::ObserveAnswered)
        .unwrap()
        .apply(AttemptCommand::AttachAgent)
        .unwrap()
        .apply(AttemptCommand::AwaitDisclosure)
        .unwrap()
}

pub const fn compliance_input() -> ComplianceInput {
    ComplianceInput {
        consent_basis: Some(ConsentBasis::Explicit),
        timezone: EvidenceStatus::Confirmed,
        dial_window: GateStatus::Allowed,
        do_not_call: GateStatus::Allowed,
        frequency: GateStatus::Allowed,
        release: GateStatus::Allowed,
    }
}

const MAX_OPERATIONS: usize = 32;

#[derive(Clone)]
pub struct Harness {
    state: Arc<Mutex<HarnessState>>,
    compliance: FakeCompliance,
    agent: FakeAgent,
    telephony: FakeTelephony,
    store: FakeStore,
    attempt_id: CallAttemptId,
}

impl Harness {
    pub fn new() -> Self {
        Self::configured(AgentReservationOutcome::Reserved, false, false)
    }

    pub fn with_agent_reservation_failure() -> Self {
        Self::configured(AgentReservationOutcome::Unavailable, false, false)
    }

    pub fn with_agent_reservation_timeout() -> Self {
        Self::configured(AgentReservationOutcome::OutcomeUnknown, false, false)
    }

    pub fn with_agent_identity_mismatch() -> Self {
        Self::configured(AgentReservationOutcome::IdentityMismatch, false, false)
    }

    pub fn crash_after_originate() -> Self {
        Self::configured(AgentReservationOutcome::Reserved, true, false)
    }

    pub fn with_disclosure_timeout() -> Self {
        Self::configured(AgentReservationOutcome::Reserved, false, true)
    }

    fn configured(
        agent_reservation_outcome: AgentReservationOutcome,
        crash_after_originate: bool,
        disclosure_times_out: bool,
    ) -> Self {
        let attempt = planned_attempt();
        let attempt_id = attempt.id().clone();
        let state = Arc::new(Mutex::new(HarnessState {
            operations: Vec::with_capacity(MAX_OPERATIONS),
            attempt,
            agent_reservation_outcome,
            crash_after_originate,
            disclosure_times_out,
            agent_query_count: 0,
            rustpbx_originate_count: 0,
            retry_count: 0,
            reserved_agent_release: None,
            reserved_agent_session_id: None,
            reserved_tenant_id: None,
            originated_agent_session_id: None,
        }));
        Self {
            compliance: FakeCompliance(state.clone()),
            agent: FakeAgent(state.clone()),
            telephony: FakeTelephony(state.clone()),
            store: FakeStore(state.clone()),
            state,
            attempt_id,
        }
    }

    pub async fn run_one_attempt(&self) -> Result<CallAttempt, OrchestrationError> {
        self.orchestrator()
            .run_one_attempt(
                &TenantId::parse("tenant-001").unwrap(),
                &self.attempt_id,
                &agent_release_binding(),
                &requested_agent_session_id(),
            )
            .await
    }

    pub async fn reconcile(&self) -> Result<CallObservation, OrchestrationError> {
        self.orchestrator().reconcile(&self.attempt_id).await
    }

    pub fn operations(&self) -> Vec<&'static str> {
        self.state.lock().unwrap().operations.clone()
    }

    pub fn rustpbx_originate_count(&self) -> usize {
        self.state.lock().unwrap().rustpbx_originate_count
    }

    pub fn retry_count(&self) -> usize {
        self.state.lock().unwrap().retry_count
    }

    pub fn attempt_state(&self) -> CallAttemptState {
        self.state.lock().unwrap().attempt.state()
    }

    pub fn reserved_agent_release(&self) -> Option<AgentReleaseBinding> {
        self.state.lock().unwrap().reserved_agent_release.clone()
    }

    pub fn reserved_agent_session_id(&self) -> Option<ChannelAgentSessionId> {
        self.state.lock().unwrap().reserved_agent_session_id.clone()
    }

    pub fn reserved_tenant_id(&self) -> Option<TenantId> {
        self.state.lock().unwrap().reserved_tenant_id.clone()
    }

    pub fn originated_agent_session_id(&self) -> Option<ChannelAgentSessionId> {
        self.state
            .lock()
            .unwrap()
            .originated_agent_session_id
            .clone()
    }

    fn orchestrator(
        &self,
    ) -> OutboundOrchestrator<'_, FakeCompliance, FakeAgent, FakeTelephony, FakeStore> {
        OutboundOrchestrator::new(&self.compliance, &self.agent, &self.telephony, &self.store)
    }
}

struct HarnessState {
    operations: Vec<&'static str>,
    attempt: CallAttempt,
    agent_reservation_outcome: AgentReservationOutcome,
    crash_after_originate: bool,
    disclosure_times_out: bool,
    agent_query_count: usize,
    rustpbx_originate_count: usize,
    retry_count: usize,
    reserved_agent_release: Option<AgentReleaseBinding>,
    reserved_agent_session_id: Option<ChannelAgentSessionId>,
    reserved_tenant_id: Option<TenantId>,
    originated_agent_session_id: Option<ChannelAgentSessionId>,
}

#[derive(Clone, Copy)]
enum AgentReservationOutcome {
    Reserved,
    Unavailable,
    OutcomeUnknown,
    IdentityMismatch,
}

impl HarnessState {
    fn record(&mut self, operation: &'static str) {
        assert!(self.operations.len() < MAX_OPERATIONS);
        self.operations.push(operation);
    }
}

#[derive(Clone)]
struct FakeCompliance(Arc<Mutex<HarnessState>>);

impl CompliancePort for FakeCompliance {
    fn evaluate(&self, _attempt: &CallAttempt) -> Result<ComplianceDecision, PortError> {
        self.0.lock().unwrap().record("compliance.check");
        Ok(ComplianceDecision::Approved)
    }
}

#[derive(Clone)]
struct FakeAgent(Arc<Mutex<HarnessState>>);

impl ChannelAgentPort for FakeAgent {
    async fn reserve(&self, request: ReserveAgent) -> Result<AgentReservation, PortError> {
        let mut state = self.0.lock().unwrap();
        state.record("agent.reserve");
        state.reserved_tenant_id = Some(request.tenant_id);
        state.reserved_agent_release = Some(request.release);
        state.reserved_agent_session_id = Some(request.session_id.clone());
        match state.agent_reservation_outcome {
            AgentReservationOutcome::Reserved => Ok(AgentReservation {
                session_id: request.session_id,
            }),
            AgentReservationOutcome::Unavailable => {
                Err(PortError::unavailable("agent_capacity_unavailable"))
            }
            AgentReservationOutcome::OutcomeUnknown => {
                Err(PortError::outcome_unknown("agent_reservation_timeout"))
            }
            AgentReservationOutcome::IdentityMismatch => Ok(AgentReservation {
                session_id: ChannelAgentSessionId::parse("agent-session-unexpected").unwrap(),
            }),
        }
    }

    async fn attach(&self, _request: AttachCall) -> Result<(), PortError> {
        self.0.lock().unwrap().record("agent.attach");
        Ok(())
    }

    async fn play_disclosure(&self, _request: PlayDisclosure) -> Result<(), PortError> {
        let mut state = self.0.lock().unwrap();
        state.record("agent.disclosure");
        if state.disclosure_times_out {
            Err(PortError::outcome_unknown("agent_disclosure_timeout"))
        } else {
            Ok(())
        }
    }

    async fn start_conversation(&self, _request: StartConversation) -> Result<(), PortError> {
        self.0.lock().unwrap().record("agent.start_conversation");
        Ok(())
    }

    fn query(
        &self,
        _session: &ChannelAgentSessionId,
    ) -> impl Future<Output = Result<AgentObservation, PortError>> + Send {
        let mut state = self.0.lock().unwrap();
        let observation = match state.agent_query_count {
            0 => {
                state.record("agent.media_ready");
                AgentObservation::MediaReady
            }
            1 => {
                state.record("agent.disclosure_completed");
                AgentObservation::DisclosureCompleted
            }
            _ => AgentObservation::Terminal,
        };
        state.agent_query_count += 1;
        ready(Ok(observation))
    }
}

fn agent_release_binding() -> AgentReleaseBinding {
    AgentReleaseBinding::try_new(
        AgentReleaseId::parse("agent-sales-assistant-r1").unwrap(),
        "9".repeat(64),
        release_digests(),
    )
    .unwrap()
}

fn requested_agent_session_id() -> ChannelAgentSessionId {
    ChannelAgentSessionId::parse("agent-session-platform-selected").unwrap()
}

#[derive(Clone)]
struct FakeTelephony(Arc<Mutex<HarnessState>>);

impl TelephonyPort for FakeTelephony {
    fn originate(
        &self,
        request: OriginateCall,
    ) -> impl Future<Output = Result<CallObservation, PortError>> + Send {
        let mut state = self.0.lock().unwrap();
        state.rustpbx_originate_count += 1;
        state.originated_agent_session_id = Some(request.agent_session_id.clone());
        state.record("rustpbx.originate");
        if state.crash_after_originate {
            ready(Err(PortError::outcome_unknown("rustpbx_timeout")))
        } else {
            state.record("rustpbx.answered");
            ready(Ok(CallObservation::Answered(request.call_id)))
        }
    }

    fn query(
        &self,
        call_id: &CallId,
    ) -> impl Future<Output = Result<CallObservation, PortError>> + Send {
        self.0.lock().unwrap().record("rustpbx.terminal");
        ready(Ok(CallObservation::Terminal(call_id.clone())))
    }

    fn terminate(
        &self,
        _request: TerminateCall,
    ) -> impl Future<Output = Result<(), PortError>> + Send {
        ready(Ok(()))
    }
}

#[derive(Clone)]
struct FakeStore(Arc<Mutex<HarnessState>>);

impl AttemptStorePort for FakeStore {
    fn load(
        &self,
        _attempt_id: &CallAttemptId,
    ) -> impl Future<Output = Result<CallAttempt, PortError>> + Send {
        ready(Ok(self.0.lock().unwrap().attempt.clone()))
    }

    fn persist_intent(
        &self,
        attempt: &CallAttempt,
        _intent: EffectIntent,
    ) -> impl Future<Output = Result<(), PortError>> + Send {
        self.0.lock().unwrap().attempt = attempt.clone();
        ready(Ok(()))
    }

    fn persist_observation(
        &self,
        attempt: &CallAttempt,
    ) -> impl Future<Output = Result<(), PortError>> + Send {
        let mut state = self.0.lock().unwrap();
        if attempt.state().as_str() == "completed" {
            state.record("outcome.finalize");
        }
        state.attempt = attempt.clone();
        ready(Ok(()))
    }
}
