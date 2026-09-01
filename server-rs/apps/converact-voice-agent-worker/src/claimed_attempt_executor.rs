use std::sync::Arc;

use converact_ai_outbound_core::{
    AttemptCompletionPort, AttemptStorePort, ChannelAgentPort, CompliancePort, TelephonyPort,
};
use converact_kernel_ids::TenantId;
use converact_postgres_store::PostgresLeasedAttemptStore;
use converact_voice_agent_contracts::{CallAttemptId, CallAttemptState, CampaignState};

use crate::{
    ActiveAttemptContextPort, ActiveAttemptLeasePort, ActiveCallSessionPort, AdmissionReadiness,
    AuthenticatedTenant, ClaimedAttemptExecutor, ShutdownToken, VoiceAgentRepository,
    VoiceAgentWorker, WorkerConfig, WorkerError,
};

/// Lease-scoped Attempt Store plus the identities required before any external effect.
pub trait ClaimedAttemptContext:
    AttemptStorePort + AttemptCompletionPort + Send + Sync + 'static
{
    fn tenant_id(&self) -> &TenantId;
    fn attempt_id(&self) -> &CallAttemptId;
}

impl ClaimedAttemptContext for PostgresLeasedAttemptStore {
    fn tenant_id(&self) -> &TenantId {
        PostgresLeasedAttemptStore::tenant_id(self)
    }

    fn attempt_id(&self) -> &CallAttemptId {
        PostgresLeasedAttemptStore::attempt_id(self)
    }
}

/// Converts one database-fenced claim into the existing outbound orchestration path.
pub struct VoiceAgentClaimExecutor<C, A, T, R> {
    compliance: Arc<C>,
    agent: Arc<A>,
    telephony: Arc<T>,
    repository: Arc<R>,
    config: WorkerConfig,
    readiness: AdmissionReadiness,
    shutdown: ShutdownToken,
}

impl<C, A, T, R> VoiceAgentClaimExecutor<C, A, T, R> {
    #[allow(clippy::too_many_arguments)]
    #[must_use]
    pub const fn new(
        compliance: Arc<C>,
        agent: Arc<A>,
        telephony: Arc<T>,
        repository: Arc<R>,
        config: WorkerConfig,
        readiness: AdmissionReadiness,
        shutdown: ShutdownToken,
    ) -> Self {
        Self {
            compliance,
            agent,
            telephony,
            repository,
            config,
            readiness,
            shutdown,
        }
    }
}

impl<S, C, A, T, R> ClaimedAttemptExecutor<S> for VoiceAgentClaimExecutor<C, A, T, R>
where
    S: ClaimedAttemptContext,
    C: CompliancePort + Send + Sync + 'static,
    A: ChannelAgentPort + Send + Sync + 'static,
    T: TelephonyPort + Send + Sync + 'static,
    R: VoiceAgentRepository,
{
    async fn execute(&self, claim: S) -> Result<(), WorkerError> {
        let tenant = AuthenticatedTenant::try_from_verified_tenant_id(claim.tenant_id().as_str())
            .map_err(|_| WorkerError::new("voice_agent_tenant_invalid"))?;
        let attempt_id = claim.attempt_id().clone();
        let attempt = self
            .repository
            .attempt(&tenant, attempt_id.as_str())
            .await?
            .ok_or_else(|| WorkerError::new("voice_agent_claimed_attempt_not_found"))?;
        if attempt.state() != CallAttemptState::Claimed || attempt.id() != attempt_id.as_str() {
            return Err(WorkerError::new(
                "voice_agent_claimed_attempt_state_invalid",
            ));
        }
        let campaign = self
            .repository
            .campaign(&tenant, attempt.campaign_id())
            .await?
            .ok_or_else(|| WorkerError::new("voice_agent_campaign_not_found"))?;
        if campaign.state() != CampaignState::Running
            || campaign.release_id() != attempt.release_id()
        {
            return Err(WorkerError::new("voice_agent_claim_binding_invalid"));
        }

        VoiceAgentWorker::new(
            Arc::clone(&self.compliance),
            Arc::clone(&self.agent),
            Arc::clone(&self.telephony),
            claim,
            Arc::clone(&self.repository),
            self.config,
            self.readiness.clone(),
            self.shutdown.clone(),
        )
        .run_attempt(&tenant, campaign.id(), &attempt_id)
        .await
        .map(|_| ())
    }
}

/// Executes both new and crash-recovered calls through one long-lived session supervisor.
pub struct VoiceAgentLongCallClaimExecutor<C, A, T, R, E> {
    compliance: Arc<C>,
    agent: Arc<A>,
    telephony: Arc<T>,
    repository: Arc<R>,
    session: Arc<E>,
    config: WorkerConfig,
    readiness: AdmissionReadiness,
    shutdown: ShutdownToken,
}

impl<C, A, T, R, E> VoiceAgentLongCallClaimExecutor<C, A, T, R, E> {
    #[allow(clippy::too_many_arguments)]
    #[must_use]
    pub const fn new(
        compliance: Arc<C>,
        agent: Arc<A>,
        telephony: Arc<T>,
        repository: Arc<R>,
        session: Arc<E>,
        config: WorkerConfig,
        readiness: AdmissionReadiness,
        shutdown: ShutdownToken,
    ) -> Self {
        Self {
            compliance,
            agent,
            telephony,
            repository,
            session,
            config,
            readiness,
            shutdown,
        }
    }
}

impl<S, C, A, T, R, E> ClaimedAttemptExecutor<S> for VoiceAgentLongCallClaimExecutor<C, A, T, R, E>
where
    S: ClaimedAttemptContext + ActiveAttemptContextPort + ActiveAttemptLeasePort,
    C: CompliancePort + Send + Sync + 'static,
    A: ChannelAgentPort + Send + Sync + 'static,
    T: TelephonyPort + Send + Sync + 'static,
    R: VoiceAgentRepository,
    E: ActiveCallSessionPort<S> + Send + Sync + 'static,
{
    async fn execute(&self, claim: S) -> Result<(), WorkerError> {
        let tenant = AuthenticatedTenant::try_from_verified_tenant_id(claim.tenant_id().as_str())
            .map_err(|_| WorkerError::new("voice_agent_tenant_invalid"))?;
        let attempt_id = claim.attempt_id().clone();
        let attempt = self
            .repository
            .attempt(&tenant, attempt_id.as_str())
            .await?
            .ok_or_else(|| WorkerError::new("voice_agent_claimed_attempt_not_found"))?;
        if attempt.id() != attempt_id.as_str() {
            return Err(WorkerError::new(
                "voice_agent_claimed_attempt_state_invalid",
            ));
        }
        let campaign = self
            .repository
            .campaign(&tenant, attempt.campaign_id())
            .await?
            .ok_or_else(|| WorkerError::new("voice_agent_campaign_not_found"))?;
        if campaign.release_id() != attempt.release_id() {
            return Err(WorkerError::new("voice_agent_claim_binding_invalid"));
        }

        let worker = VoiceAgentWorker::new(
            Arc::clone(&self.compliance),
            Arc::clone(&self.agent),
            Arc::clone(&self.telephony),
            claim,
            Arc::clone(&self.repository),
            self.config,
            self.readiness.clone(),
            self.shutdown.clone(),
        );
        match attempt.state() {
            CallAttemptState::Claimed => {
                if campaign.state() != CampaignState::Running {
                    return Err(WorkerError::new("voice_agent_claim_binding_invalid"));
                }
                worker
                    .run_attempt_with_active_session(
                        &tenant,
                        campaign.id(),
                        &attempt_id,
                        self.session.as_ref(),
                    )
                    .await
            }
            CallAttemptState::Conversing
            | CallAttemptState::HandoffPending
            | CallAttemptState::HumanActive
            | CallAttemptState::AiResuming
            | CallAttemptState::Finalizing => {
                let campaign_id = converact_voice_agent_contracts::CampaignId::parse(campaign.id())
                    .map_err(|_| WorkerError::new("voice_agent_campaign_id_invalid"))?;
                let release_id =
                    converact_voice_agent_contracts::AgentReleaseId::parse(attempt.release_id())
                        .map_err(|_| WorkerError::new("voice_agent_release_id_invalid"))?;
                worker
                    .resume_attempt_with_active_session(
                        &tenant,
                        &campaign_id,
                        &release_id,
                        &attempt_id,
                        self.session.as_ref(),
                    )
                    .await
            }
            _ => Err(WorkerError::new(
                "voice_agent_recovered_attempt_state_unsupported",
            )),
        }
        .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    use converact_ai_outbound_core::{
        ActiveAttemptExecution, AgentLegBinding, AgentObservation, AgentReservation,
        AttemptCommand, CallAttempt, CallAttemptRestoreInput, CallObservation, ComplianceDecision,
        EffectIntent, OriginateCall, OutboundDialBinding, OutboundDialBindingInput, PlayDisclosure,
        PortError, ReleaseComponentDigests, ReserveAgent, StartConversation, TerminalAttemptCommit,
        TerminateCall,
    };
    use converact_contracts::health::{
        ConfigurationCheck, ConfigurationStatus, DatabaseCheck, DatabaseStatus, MigrationCheck,
        MigrationStatus, NotificationProviderCheck, NotificationProviderStatus,
        PlacementSnapshotCheck, PlacementSnapshotStatus, ReadinessChecks, RuntimeHeartbeatCheck,
        RuntimeHeartbeatStatus,
    };
    use converact_runtime_health::RuntimeHealth;
    use converact_voice_agent_contracts::{
        AgentReleaseId, AgentReleaseState, CallAttemptId, CallId, CampaignContactId, CampaignId,
        CampaignState, ChannelAgentSessionId, EnvelopeContext, EnvelopeContextInput,
        ExecutionGeneration, IdempotencyKey, InteractionId, VOICE_AGENT_SCHEMA_VERSION,
    };

    use super::*;
    use crate::{
        ActiveAttemptContextPort, ActiveAttemptLeasePort, ActiveCallSessionPort,
        ActiveCallSessionSupervisorOutcome, AgentReleaseResource, AttemptResource,
        CampaignResource, ReconcileReceipt, RepositoryError, VoiceAgentLongCallClaimExecutor,
    };

    #[tokio::test]
    async fn claimed_attempt_executes_existing_worker_and_completes_once() {
        let fixture = Fixture::new("release-001", "release-001");

        ClaimedAttemptExecutor::execute(&fixture.executor, fixture.claim)
            .await
            .unwrap();

        assert_eq!(fixture.probe.originate_calls.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.state.lock().unwrap().completions, 1);
        assert_eq!(
            fixture.state.lock().unwrap().attempt.state(),
            CallAttemptState::Completed
        );
    }

    #[tokio::test]
    async fn release_binding_drift_fails_before_telephony_or_completion() {
        let fixture = Fixture::new("release-001", "release-002");

        let error = ClaimedAttemptExecutor::execute(&fixture.executor, fixture.claim)
            .await
            .unwrap_err();

        assert_eq!(error.code(), "voice_agent_claim_binding_invalid");
        assert_eq!(fixture.probe.originate_calls.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.state.lock().unwrap().completions, 0);
    }

    #[tokio::test]
    async fn long_call_executor_supervises_new_claim_before_completion() {
        let fixture = LongCallFixture::new(CallAttemptState::Claimed);

        ClaimedAttemptExecutor::execute(&fixture.executor, fixture.claim)
            .await
            .unwrap();

        assert_eq!(fixture.probe.originate_calls.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.probe.active_session_calls.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.state.lock().unwrap().completions, 1);
        assert_eq!(
            fixture.state.lock().unwrap().attempt.state(),
            CallAttemptState::Completed
        );
    }

    #[tokio::test]
    async fn long_call_executor_resumes_conversing_claim_without_redial() {
        let fixture = LongCallFixture::new(CallAttemptState::Conversing);

        ClaimedAttemptExecutor::execute(&fixture.executor, fixture.claim)
            .await
            .unwrap();

        assert_eq!(fixture.probe.originate_calls.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.probe.active_session_calls.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.state.lock().unwrap().completions, 1);
        assert_eq!(
            fixture.state.lock().unwrap().attempt.state(),
            CallAttemptState::Completed
        );
    }

    #[tokio::test]
    async fn long_call_executor_recovers_every_post_start_state_without_redial() {
        for state in [
            CallAttemptState::HandoffPending,
            CallAttemptState::HumanActive,
            CallAttemptState::AiResuming,
            CallAttemptState::Finalizing,
        ] {
            let fixture = LongCallFixture::new(state);

            ClaimedAttemptExecutor::execute(&fixture.executor, fixture.claim)
                .await
                .unwrap();

            assert_eq!(fixture.probe.originate_calls.load(Ordering::SeqCst), 0);
            assert_eq!(fixture.probe.active_session_calls.load(Ordering::SeqCst), 1);
            assert_eq!(fixture.state.lock().unwrap().completions, 1);
            assert_eq!(
                fixture.state.lock().unwrap().attempt.state(),
                CallAttemptState::Completed,
                "{state:?}",
            );
        }
    }

    struct Fixture {
        executor: VoiceAgentClaimExecutor<Probe, Probe, Probe, FixedRepository>,
        claim: TestClaim,
        probe: Arc<Probe>,
        state: Arc<Mutex<ClaimState>>,
    }

    impl Fixture {
        fn new(attempt_release_id: &str, campaign_release_id: &str) -> Self {
            let attempt_id = CallAttemptId::parse("attempt-001").unwrap();
            let attempt = CallAttempt::new(attempt_id.clone())
                .apply(AttemptCommand::Claim)
                .unwrap();
            let state = Arc::new(Mutex::new(ClaimState {
                attempt: attempt.clone(),
                active_execution: None,
                completions: 0,
            }));
            let claim = TestClaim {
                tenant_id: TenantId::parse("tenant-a").unwrap(),
                attempt_id,
                state: Arc::clone(&state),
            };
            let repository = Arc::new(FixedRepository {
                release: AgentReleaseResource::from_durable(
                    campaign_release_id.to_owned(),
                    "agent-definition-001".to_owned(),
                    AgentReleaseState::Published,
                    "9".repeat(64),
                    release_digests(),
                ),
                campaign: CampaignResource::from_durable(
                    "campaign-001".to_owned(),
                    campaign_release_id.to_owned(),
                    CampaignState::Running,
                    1,
                ),
                attempt: AttemptResource::from_durable(
                    "attempt-001".to_owned(),
                    "campaign-001".to_owned(),
                    attempt_release_id.to_owned(),
                    CallAttemptState::Claimed,
                    false,
                    None,
                ),
            });
            let probe = Arc::new(Probe::default());
            let executor = VoiceAgentClaimExecutor::new(
                Arc::clone(&probe),
                Arc::clone(&probe),
                Arc::clone(&probe),
                repository,
                WorkerConfig::new(1, 1).unwrap(),
                ready(),
                ShutdownToken::default(),
            );
            Self {
                executor,
                claim,
                probe,
                state,
            }
        }
    }

    struct LongCallFixture {
        executor: VoiceAgentLongCallClaimExecutor<Probe, Probe, Probe, FixedRepository, Probe>,
        claim: TestClaim,
        probe: Arc<Probe>,
        state: Arc<Mutex<ClaimState>>,
    }

    impl LongCallFixture {
        fn new(attempt_state: CallAttemptState) -> Self {
            let attempt_id = CallAttemptId::parse("attempt-001").unwrap();
            let attempt = match attempt_state {
                CallAttemptState::Claimed => CallAttempt::new(attempt_id.clone())
                    .apply(AttemptCommand::Claim)
                    .unwrap(),
                CallAttemptState::Conversing
                | CallAttemptState::HandoffPending
                | CallAttemptState::HumanActive
                | CallAttemptState::AiResuming
                | CallAttemptState::Finalizing => CallAttempt::restore(CallAttemptRestoreInput {
                    id: attempt_id.clone(),
                    previous_attempt_id: None,
                    state: attempt_state,
                    revision: match attempt_state {
                        CallAttemptState::Conversing => 10,
                        CallAttemptState::HandoffPending | CallAttemptState::Finalizing => 11,
                        CallAttemptState::HumanActive => 12,
                        CallAttemptState::AiResuming => 13,
                        _ => unreachable!(),
                    },
                    disclosure_completed: true,
                })
                .unwrap(),
                _ => panic!("unsupported fixture state"),
            };
            let active_execution = (attempt_state != CallAttemptState::Claimed).then(|| {
                ActiveAttemptExecution::try_new(
                    attempt.clone(),
                    CallId::parse(attempt_id.as_str()).unwrap(),
                    ChannelAgentSessionId::parse("session-001").unwrap(),
                )
                .unwrap()
            });
            let state = Arc::new(Mutex::new(ClaimState {
                attempt: attempt.clone(),
                active_execution,
                completions: 0,
            }));
            let claim = TestClaim {
                tenant_id: TenantId::parse("tenant-a").unwrap(),
                attempt_id,
                state: Arc::clone(&state),
            };
            let repository = Arc::new(FixedRepository {
                release: AgentReleaseResource::from_durable(
                    "release-001".to_owned(),
                    "agent-definition-001".to_owned(),
                    AgentReleaseState::Published,
                    "9".repeat(64),
                    release_digests(),
                ),
                campaign: CampaignResource::from_durable(
                    "campaign-001".to_owned(),
                    "release-001".to_owned(),
                    CampaignState::Running,
                    1,
                ),
                attempt: AttemptResource::from_durable(
                    "attempt-001".to_owned(),
                    "campaign-001".to_owned(),
                    "release-001".to_owned(),
                    attempt_state,
                    attempt.disclosure_completed(),
                    None,
                ),
            });
            let probe = Arc::new(Probe::default());
            let executor = VoiceAgentLongCallClaimExecutor::new(
                Arc::clone(&probe),
                Arc::clone(&probe),
                Arc::clone(&probe),
                repository,
                Arc::clone(&probe),
                WorkerConfig::new(1, 1).unwrap(),
                ready(),
                ShutdownToken::default(),
            );
            Self {
                executor,
                claim,
                probe,
                state,
            }
        }
    }

    struct ClaimState {
        attempt: CallAttempt,
        active_execution: Option<ActiveAttemptExecution>,
        completions: usize,
    }

    struct TestClaim {
        tenant_id: TenantId,
        attempt_id: CallAttemptId,
        state: Arc<Mutex<ClaimState>>,
    }

    impl ClaimedAttemptContext for TestClaim {
        fn tenant_id(&self) -> &TenantId {
            &self.tenant_id
        }

        fn attempt_id(&self) -> &CallAttemptId {
            &self.attempt_id
        }
    }

    impl AttemptStorePort for TestClaim {
        async fn load(&self, _attempt_id: &CallAttemptId) -> Result<CallAttempt, PortError> {
            Ok(self.state.lock().unwrap().attempt.clone())
        }

        async fn load_dial_binding(
            &self,
            _attempt_id: &CallAttemptId,
        ) -> Result<OutboundDialBinding, PortError> {
            OutboundDialBinding::try_new(OutboundDialBindingInput {
                destination: "+8613800138000".to_owned(),
                caller_id: None,
                timeout_secs: 30,
                trunk: Some("carrier-a".to_owned()),
            })
            .map_err(|_| PortError::rejected("ai_outbound_dial_binding_invalid"))
        }

        async fn persist_intent(
            &self,
            _attempt: &CallAttempt,
            _intent: EffectIntent,
        ) -> Result<(), PortError> {
            Ok(())
        }

        async fn persist_observation(&self, attempt: &CallAttempt) -> Result<(), PortError> {
            self.state.lock().unwrap().attempt = attempt.clone();
            Ok(())
        }

        async fn persist_active_execution(
            &self,
            active: &ActiveAttemptExecution,
        ) -> Result<(), PortError> {
            let mut state = self.state.lock().unwrap();
            state.attempt = active.attempt().clone();
            state.active_execution = Some(active.clone());
            Ok(())
        }
    }

    impl ActiveAttemptContextPort for TestClaim {
        async fn load_active_envelope_context(&self) -> Result<EnvelopeContext, WorkerError> {
            let state = self.state.lock().unwrap();
            let active = state
                .active_execution
                .as_ref()
                .ok_or_else(|| WorkerError::new("test_active_execution_missing"))?;
            EnvelopeContext::try_new(EnvelopeContextInput {
                schema_version: VOICE_AGENT_SCHEMA_VERSION,
                tenant_id: self.tenant_id.as_str().to_owned(),
                interaction_id: InteractionId::parse("interaction-001").unwrap(),
                campaign_id: CampaignId::parse("campaign-001").unwrap(),
                campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
                call_attempt_id: self.attempt_id.clone(),
                call_id: Some(active.call_id().clone()),
                agent_release_id: AgentReleaseId::parse("release-001").unwrap(),
                channel_agent_session_id: Some(active.channel_agent_session_id().clone()),
                execution_generation: ExecutionGeneration::new(1).unwrap(),
                trace_id: "trace-active-001".to_owned(),
            })
            .map_err(|_| WorkerError::new("test_active_context_invalid"))
        }
    }

    impl ActiveAttemptLeasePort for TestClaim {
        async fn renew_active_lease(&self) -> Result<(), WorkerError> {
            Ok(())
        }
    }

    impl AttemptCompletionPort for TestClaim {
        async fn complete_and_enqueue(
            &self,
            command: TerminalAttemptCommit,
        ) -> Result<(), PortError> {
            let mut state = self.state.lock().unwrap();
            state.attempt = command.attempt().clone();
            state.completions += 1;
            Ok(())
        }
    }

    #[derive(Default)]
    struct Probe {
        originate_calls: AtomicUsize,
        agent_queries: AtomicUsize,
        active_session_calls: AtomicUsize,
    }

    impl CompliancePort for Probe {
        async fn evaluate(
            &self,
            _tenant_id: &converact_voice_agent_contracts::TenantId,
            _attempt: &CallAttempt,
        ) -> Result<ComplianceDecision, PortError> {
            Ok(ComplianceDecision::Approved)
        }
    }

    impl ChannelAgentPort for Probe {
        async fn reserve(&self, request: ReserveAgent) -> Result<AgentReservation, PortError> {
            Ok(AgentReservation {
                session_id: request.session_id,
            })
        }

        async fn confirm_attachment(&self, _request: AgentLegBinding) -> Result<(), PortError> {
            Ok(())
        }

        async fn play_disclosure(&self, _request: PlayDisclosure) -> Result<(), PortError> {
            Ok(())
        }

        async fn start_conversation(&self, _request: StartConversation) -> Result<(), PortError> {
            Ok(())
        }

        async fn query(
            &self,
            _session: &ChannelAgentSessionId,
        ) -> Result<AgentObservation, PortError> {
            let query = self.agent_queries.fetch_add(1, Ordering::SeqCst);
            Ok(if query == 0 {
                AgentObservation::MediaReady
            } else {
                AgentObservation::DisclosureCompleted
            })
        }
    }

    impl TelephonyPort for Probe {
        async fn originate(&self, request: OriginateCall) -> Result<CallObservation, PortError> {
            self.originate_calls.fetch_add(1, Ordering::SeqCst);
            Ok(CallObservation::Answered(request.call_id))
        }

        async fn add_agent_leg(&self, _request: AgentLegBinding) -> Result<(), PortError> {
            Ok(())
        }

        async fn query(&self, call_id: &CallId) -> Result<CallObservation, PortError> {
            Ok(CallObservation::Terminal(call_id.clone()))
        }

        async fn terminate(&self, _request: TerminateCall) -> Result<(), PortError> {
            Ok(())
        }
    }

    impl ActiveCallSessionPort<TestClaim> for Probe {
        async fn supervise_active_call(
            &self,
            context: &EnvelopeContext,
            lease: &TestClaim,
        ) -> Result<ActiveCallSessionSupervisorOutcome, WorkerError> {
            assert_eq!(context.call_attempt_id(), lease.attempt_id());
            assert_eq!(lease.state.lock().unwrap().completions, 0);
            self.active_session_calls.fetch_add(1, Ordering::SeqCst);
            Ok(ActiveCallSessionSupervisorOutcome::Completed)
        }
    }

    struct FixedRepository {
        release: AgentReleaseResource,
        campaign: CampaignResource,
        attempt: AttemptResource,
    }

    impl VoiceAgentRepository for FixedRepository {
        async fn release(
            &self,
            _tenant: &AuthenticatedTenant,
            id: &str,
        ) -> Result<Option<AgentReleaseResource>, RepositoryError> {
            Ok((self.release.id() == id).then(|| self.release.clone()))
        }

        async fn campaign(
            &self,
            _tenant: &AuthenticatedTenant,
            id: &str,
        ) -> Result<Option<CampaignResource>, RepositoryError> {
            Ok((self.campaign.id() == id).then(|| self.campaign.clone()))
        }

        async fn attempt(
            &self,
            _tenant: &AuthenticatedTenant,
            id: &str,
        ) -> Result<Option<AttemptResource>, RepositoryError> {
            Ok((self.attempt.id() == id).then(|| self.attempt.clone()))
        }

        async fn request_reconcile(
            &self,
            _tenant: &AuthenticatedTenant,
            _attempt_id: &str,
            _idempotency_key: &IdempotencyKey,
        ) -> Result<Option<ReconcileReceipt>, RepositoryError> {
            Ok(None)
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

    fn ready() -> AdmissionReadiness {
        let health = RuntimeHealth::new();
        health
            .publish(ReadinessChecks {
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
            })
            .unwrap();
        let readiness = AdmissionReadiness::new(health);
        readiness.set_durable_store(true);
        readiness.set_agent_reservation(true);
        readiness.set_telephony_control(true);
        readiness
    }
}
