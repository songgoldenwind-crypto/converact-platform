#![allow(dead_code)]

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    body::Body,
    http::{Method, Request, Response},
};
use converact_ai_outbound_core::{
    AgentDraft, AgentObservation, AgentReleaseBinding, AgentReservation, AttachCall,
    AttemptStorePort, CallAttempt, CallObservation, Campaign, CampaignCommand, ChannelAgentPort,
    ComplianceDecision, CompliancePort, EffectIntent, OriginateCall, PlayDisclosure, PortError,
    ReleaseComponentDigests, ReserveAgent, StartConversation, TelephonyPort, TerminateCall,
    publish_agent,
};
use converact_contracts::health::{
    ConfigurationCheck, ConfigurationStatus, DatabaseCheck, DatabaseStatus, MigrationCheck,
    MigrationStatus, NotificationProviderCheck, NotificationProviderStatus, PlacementSnapshotCheck,
    PlacementSnapshotStatus, ReadinessChecks, RuntimeHeartbeatCheck, RuntimeHeartbeatStatus,
};
use converact_runtime_health::RuntimeHealth;
use converact_voice_agent_contracts::{
    AgentDefinitionId, AgentReleaseId, CallAttemptId, CallAttemptState, CallId, CampaignId,
    ChannelAgentSessionId, IdempotencyKey,
};
use converact_voice_agent_worker::{
    AdmissionReadiness, AgentReleaseResource, AttemptResource, AuthenticatedTenant,
    CampaignResource, ReconcileReceipt, RepositoryError, ShutdownToken, VoiceAgentRepository,
    VoiceAgentWorker, WorkerConfig, WorkerError, router,
};
use tower::ServiceExt;

type ControlledWorker = VoiceAgentWorker<
    FakeCompliance,
    FakeAgent,
    FakeTelephony,
    FakeAttemptStore,
    InMemoryRepository,
>;

pub struct TestWorker {
    worker: ControlledWorker,
    repository: InMemoryRepository,
    state: Arc<Mutex<ControlledState>>,
    app: Router,
    readiness: AdmissionReadiness,
    shutdown: ShutdownToken,
}

impl TestWorker {
    pub fn controlled() -> Self {
        let state = Arc::new(Mutex::new(ControlledState::new()));
        let repository = InMemoryRepository::default();
        let health = RuntimeHealth::new();
        health.publish(ready_checks()).unwrap();
        let readiness = AdmissionReadiness::new(health);
        readiness.set_durable_store(true);
        readiness.set_agent_reservation(true);
        let config = WorkerConfig::new(4, 16).unwrap();
        let shutdown = ShutdownToken::default();
        let worker = VoiceAgentWorker::new(
            FakeCompliance,
            FakeAgent(Arc::clone(&state)),
            FakeTelephony(Arc::clone(&state)),
            FakeAttemptStore(Arc::clone(&state)),
            repository.clone(),
            config,
            readiness.clone(),
            shutdown.clone(),
        );
        let app = router(
            repository.shared(),
            readiness.clone(),
            config,
            shutdown.clone(),
        );
        Self {
            worker,
            repository,
            state,
            app,
            readiness,
            shutdown,
        }
    }

    pub fn publish_fixture_agent(&self) -> AgentReleaseResource {
        let draft = AgentDraft::try_new(
            AgentDefinitionId::parse("agent-sales-assistant").unwrap(),
            AgentReleaseId::parse("agent-sales-assistant-r1").unwrap(),
            "Industry-neutral sales assistant",
            "zh-CN",
        )
        .unwrap();
        let release = publish_agent(draft, release_digests()).unwrap();
        let resource = AgentReleaseResource::from_release(&release);
        self.repository.insert_release("tenant-a", resource.clone());
        resource
    }

    pub fn create_fixture_campaign(&self, release_id: &str) -> CampaignResource {
        let campaign = Campaign::new(CampaignId::parse("campaign-001").unwrap())
            .apply(CampaignCommand::Schedule)
            .unwrap()
            .apply(CampaignCommand::Start)
            .unwrap();
        let resource = CampaignResource::from_campaign(&campaign, release_id);
        self.repository
            .insert_campaign("tenant-a", resource.clone());
        resource
    }

    pub async fn run_one_contact(&self, campaign_id: &str) -> Result<AttemptResource, WorkerError> {
        let tenant = AuthenticatedTenant::try_from_verified_tenant_id("tenant-a").unwrap();
        let attempt_id = CallAttemptId::parse("attempt-001").unwrap();
        self.state.lock().unwrap().attempt = CallAttempt::new(attempt_id.clone());
        self.worker
            .run_attempt(&tenant, campaign_id, &attempt_id)
            .await
    }

    pub async fn seed_completed_attempt(&self) {
        let release = self.publish_fixture_agent();
        let campaign = self.create_fixture_campaign(release.id());
        self.run_one_contact(campaign.id()).await.unwrap();
    }

    pub fn telephony(&self) -> TelephonyProbe {
        TelephonyProbe(Arc::clone(&self.state))
    }

    pub async fn get_attempt(&self, tenant: &str, attempt_id: &str) -> Response<Body> {
        self.request(
            Method::GET,
            &format!("/internal/v1/voice-agent/attempts/{attempt_id}"),
            Some(tenant),
            None,
        )
        .await
    }

    pub async fn request(
        &self,
        method: Method,
        path: &str,
        tenant: Option<&str>,
        idempotency_key: Option<&str>,
    ) -> Response<Body> {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(idempotency_key) = idempotency_key {
            request = request.header("idempotency-key", idempotency_key);
        }
        let mut request = request.body(Body::empty()).unwrap();
        if let Some(tenant) = tenant {
            request
                .extensions_mut()
                .insert(AuthenticatedTenant::try_from_verified_tenant_id(tenant).unwrap());
        }
        self.app.clone().oneshot(request).await.unwrap()
    }

    pub fn disable_durable_store_admission(&self) {
        self.readiness.set_durable_store(false);
    }

    pub fn request_shutdown(&self) {
        self.shutdown.cancel();
    }

    pub fn fail_atomic_completion(&self) {
        self.repository.state.lock().unwrap().fail_atomic_completion = true;
    }

    pub fn has_attempt(&self, tenant: &str, attempt_id: &str) -> bool {
        self.repository
            .state
            .lock()
            .unwrap()
            .attempts
            .contains_key(&(tenant.to_owned(), attempt_id.to_owned()))
    }

    pub fn finalization_job_count(&self) -> usize {
        self.repository
            .state
            .lock()
            .unwrap()
            .finalization_jobs
            .len()
    }

    pub fn orchestrator_attempt_state(&self) -> CallAttemptState {
        self.state.lock().unwrap().attempt.state()
    }

    pub fn reserved_agent_release(&self) -> Option<AgentReleaseBinding> {
        self.state.lock().unwrap().reserved_agent_release.clone()
    }

    pub fn reserved_agent_session_id(&self) -> Option<ChannelAgentSessionId> {
        self.state.lock().unwrap().reserved_agent_session_id.clone()
    }
}

pub struct TelephonyProbe(Arc<Mutex<ControlledState>>);

impl TelephonyProbe {
    pub fn originate_count(&self) -> usize {
        self.0.lock().unwrap().originate_count
    }
}

struct ControlledState {
    attempt: CallAttempt,
    originate_count: usize,
    agent_query_count: usize,
    reserved_agent_release: Option<AgentReleaseBinding>,
    reserved_agent_session_id: Option<ChannelAgentSessionId>,
}

impl ControlledState {
    fn new() -> Self {
        Self {
            attempt: CallAttempt::new(CallAttemptId::parse("attempt-001").unwrap()),
            originate_count: 0,
            agent_query_count: 0,
            reserved_agent_release: None,
            reserved_agent_session_id: None,
        }
    }
}

#[derive(Clone, Copy)]
struct FakeCompliance;

impl CompliancePort for FakeCompliance {
    fn evaluate(&self, _attempt: &CallAttempt) -> Result<ComplianceDecision, PortError> {
        Ok(ComplianceDecision::Approved)
    }
}

#[derive(Clone)]
struct FakeAgent(Arc<Mutex<ControlledState>>);

impl ChannelAgentPort for FakeAgent {
    async fn reserve(&self, request: ReserveAgent) -> Result<AgentReservation, PortError> {
        let mut state = self.0.lock().unwrap();
        state.reserved_agent_release = Some(request.release);
        state.reserved_agent_session_id = Some(request.session_id.clone());
        Ok(AgentReservation {
            session_id: request.session_id,
        })
    }

    async fn attach(&self, _request: AttachCall) -> Result<(), PortError> {
        Ok(())
    }

    async fn play_disclosure(&self, _request: PlayDisclosure) -> Result<(), PortError> {
        Ok(())
    }

    async fn start_conversation(&self, _request: StartConversation) -> Result<(), PortError> {
        Ok(())
    }

    async fn query(&self, _session: &ChannelAgentSessionId) -> Result<AgentObservation, PortError> {
        let mut state = self.0.lock().unwrap();
        let observation = if state.agent_query_count == 0 {
            AgentObservation::MediaReady
        } else {
            AgentObservation::DisclosureCompleted
        };
        state.agent_query_count += 1;
        Ok(observation)
    }
}

#[derive(Clone)]
struct FakeTelephony(Arc<Mutex<ControlledState>>);

impl TelephonyPort for FakeTelephony {
    async fn originate(&self, request: OriginateCall) -> Result<CallObservation, PortError> {
        self.0.lock().unwrap().originate_count += 1;
        Ok(CallObservation::Answered(request.call_id))
    }

    async fn query(&self, call_id: &CallId) -> Result<CallObservation, PortError> {
        Ok(CallObservation::Terminal(call_id.clone()))
    }

    async fn terminate(&self, _request: TerminateCall) -> Result<(), PortError> {
        Ok(())
    }
}

#[derive(Clone)]
struct FakeAttemptStore(Arc<Mutex<ControlledState>>);

impl AttemptStorePort for FakeAttemptStore {
    async fn load(&self, _attempt_id: &CallAttemptId) -> Result<CallAttempt, PortError> {
        Ok(self.0.lock().unwrap().attempt.clone())
    }

    async fn persist_intent(
        &self,
        attempt: &CallAttempt,
        _intent: EffectIntent,
    ) -> Result<(), PortError> {
        self.0.lock().unwrap().attempt = attempt.clone();
        Ok(())
    }

    async fn persist_observation(&self, attempt: &CallAttempt) -> Result<(), PortError> {
        self.0.lock().unwrap().attempt = attempt.clone();
        Ok(())
    }
}

#[derive(Clone, Default)]
struct InMemoryRepository {
    state: Arc<Mutex<RepositoryState>>,
}

impl InMemoryRepository {
    fn shared(&self) -> Arc<Self> {
        Arc::new(self.clone())
    }

    fn insert_release(&self, tenant: &str, release: AgentReleaseResource) {
        self.state
            .lock()
            .unwrap()
            .releases
            .insert((tenant.to_owned(), release.id().to_owned()), release);
    }

    fn insert_campaign(&self, tenant: &str, campaign: CampaignResource) {
        self.state
            .lock()
            .unwrap()
            .campaigns
            .insert((tenant.to_owned(), campaign.id().to_owned()), campaign);
    }
}

#[derive(Default)]
struct RepositoryState {
    releases: HashMap<(String, String), AgentReleaseResource>,
    campaigns: HashMap<(String, String), CampaignResource>,
    attempts: HashMap<(String, String), AttemptResource>,
    finalization_jobs: HashSet<(String, String)>,
    reconciliations: HashSet<(String, String, String)>,
    fail_atomic_completion: bool,
}

impl VoiceAgentRepository for InMemoryRepository {
    async fn release(
        &self,
        tenant: &AuthenticatedTenant,
        id: &str,
    ) -> Result<Option<AgentReleaseResource>, RepositoryError> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .releases
            .get(&(tenant.as_str().to_owned(), id.to_owned()))
            .cloned())
    }

    async fn campaign(
        &self,
        tenant: &AuthenticatedTenant,
        id: &str,
    ) -> Result<Option<CampaignResource>, RepositoryError> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .campaigns
            .get(&(tenant.as_str().to_owned(), id.to_owned()))
            .cloned())
    }

    async fn attempt(
        &self,
        tenant: &AuthenticatedTenant,
        id: &str,
    ) -> Result<Option<AttemptResource>, RepositoryError> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .attempts
            .get(&(tenant.as_str().to_owned(), id.to_owned()))
            .cloned())
    }

    async fn complete_attempt_and_enqueue(
        &self,
        tenant: &AuthenticatedTenant,
        attempt: AttemptResource,
    ) -> Result<(), RepositoryError> {
        let mut state = self.state.lock().unwrap();
        if state.fail_atomic_completion {
            return Err(RepositoryError::unavailable());
        }
        let key = (tenant.as_str().to_owned(), attempt.id().to_owned());
        state.attempts.insert(key.clone(), attempt);
        state.finalization_jobs.insert(key);
        Ok(())
    }

    async fn request_reconcile(
        &self,
        tenant: &AuthenticatedTenant,
        attempt_id: &str,
        idempotency_key: &IdempotencyKey,
    ) -> Result<Option<ReconcileReceipt>, RepositoryError> {
        let mut state = self.state.lock().unwrap();
        if !state
            .attempts
            .contains_key(&(tenant.as_str().to_owned(), attempt_id.to_owned()))
        {
            return Ok(None);
        }
        state.reconciliations.insert((
            tenant.as_str().to_owned(),
            attempt_id.to_owned(),
            idempotency_key.as_str().to_owned(),
        ));
        Ok(Some(ReconcileReceipt {
            attempt_id: attempt_id.to_owned(),
            accepted: true,
        }))
    }
}

fn release_digests() -> ReleaseComponentDigests {
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

fn ready_checks() -> ReadinessChecks {
    ReadinessChecks {
        database: DatabaseCheck {
            status: DatabaseStatus::Ok,
        },
        migrations: MigrationCheck {
            status: MigrationStatus::Ok,
            missing: vec![],
        },
        configuration: ConfigurationCheck {
            status: ConfigurationStatus::Ok,
            missing_or_invalid: vec![],
        },
        notification_providers: NotificationProviderCheck {
            status: NotificationProviderStatus::NotConfigured,
            active: 0,
            unhealthy: 0,
            blocking: false,
        },
        runtime_heartbeat: RuntimeHeartbeatCheck {
            status: RuntimeHeartbeatStatus::Disabled,
            instance_id: String::new(),
        },
        placement_snapshot: PlacementSnapshotCheck {
            status: PlacementSnapshotStatus::Disabled,
            snapshot_version: 0,
            error_code: String::new(),
        },
    }
}
