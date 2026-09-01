use std::sync::Arc;

use converact_ai_outbound_core::{
    AttemptCompletionPort, AttemptStorePort, ChannelAgentPort, CompliancePort, TelephonyPort,
};
use converact_kernel_ids::TenantId;
use converact_postgres_store::PostgresLeasedAttemptStore;
use converact_voice_agent_contracts::{CallAttemptId, CallAttemptState, CampaignState};

use crate::{
    AdmissionReadiness, AuthenticatedTenant, ClaimedAttemptExecutor, ShutdownToken,
    VoiceAgentRepository, VoiceAgentWorker, WorkerConfig, WorkerError,
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

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    use converact_ai_outbound_core::{
        AgentLegBinding, AgentObservation, AgentReservation, AttemptCommand, CallAttempt,
        CallObservation, ComplianceDecision, EffectIntent, OriginateCall, OutboundDialBinding,
        OutboundDialBindingInput, PlayDisclosure, PortError, ReleaseComponentDigests, ReserveAgent,
        StartConversation, TerminalAttemptCommit, TerminateCall,
    };
    use converact_contracts::health::{
        ConfigurationCheck, ConfigurationStatus, DatabaseCheck, DatabaseStatus, MigrationCheck,
        MigrationStatus, NotificationProviderCheck, NotificationProviderStatus,
        PlacementSnapshotCheck, PlacementSnapshotStatus, ReadinessChecks, RuntimeHeartbeatCheck,
        RuntimeHeartbeatStatus,
    };
    use converact_runtime_health::RuntimeHealth;
    use converact_voice_agent_contracts::{
        AgentReleaseState, CallAttemptId, CallId, CampaignState, ChannelAgentSessionId,
        IdempotencyKey,
    };

    use super::*;
    use crate::{
        AgentReleaseResource, AttemptResource, CampaignResource, ReconcileReceipt, RepositoryError,
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

    struct ClaimState {
        attempt: CallAttempt,
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
        readiness
    }
}
