use std::{error::Error, fmt};

use converact_ai_outbound_core::{
    AgentReleaseBinding, AttemptCompletionPort, AttemptStorePort, ChannelAgentPort, CompliancePort,
    OutboundOrchestrator, TelephonyPort, TerminalAttemptCommit,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, AgentReleaseState, CampaignId, CampaignState,
};
use converact_voice_agent_contracts::{CallAttemptId, TenantId};

use crate::{
    ActiveAttemptContextPort, ActiveAttemptLeasePort, ActiveCallSessionPort,
    ActiveCallSessionSupervisorOutcome, AdmissionReadiness, AttemptResource, AuthenticatedTenant,
    RepositoryError, ShutdownToken, VoiceAgentRepository, WorkerConfig,
    channel_agent_session::derive_initial_session_id,
};

/// Stable worker failure safe for logs and retry policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkerError {
    code: &'static str,
}

impl WorkerError {
    #[must_use]
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl From<RepositoryError> for WorkerError {
    fn from(error: RepositoryError) -> Self {
        Self::new(error.code())
    }
}

impl fmt::Display for WorkerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for WorkerError {}

/// Fixed-concurrency process authority over new outbound Attempt claims.
pub struct VoiceAgentWorker<C, A, T, S, R> {
    compliance: C,
    agent: A,
    telephony: T,
    attempt_store: S,
    repository: R,
    config: WorkerConfig,
    readiness: AdmissionReadiness,
    shutdown: ShutdownToken,
}

impl<C, A, T, S, R> VoiceAgentWorker<C, A, T, S, R>
where
    C: CompliancePort,
    A: ChannelAgentPort,
    T: TelephonyPort,
    S: AttemptStorePort + AttemptCompletionPort,
    R: VoiceAgentRepository,
{
    #[allow(clippy::too_many_arguments)]
    #[must_use]
    pub const fn new(
        compliance: C,
        agent: A,
        telephony: T,
        attempt_store: S,
        repository: R,
        config: WorkerConfig,
        readiness: AdmissionReadiness,
        shutdown: ShutdownToken,
    ) -> Self {
        Self {
            compliance,
            agent,
            telephony,
            attempt_store,
            repository,
            config,
            readiness,
            shutdown,
        }
    }

    /// Executes one claimed contact after a single fail-closed admission decision.
    /// Readiness changes after admission do not terminate the established call.
    ///
    /// # Errors
    ///
    /// Returns only stable machine codes from admission, orchestration or atomic storage.
    pub async fn run_attempt(
        &self,
        tenant: &AuthenticatedTenant,
        campaign_id: &str,
        attempt_id: &CallAttemptId,
    ) -> Result<AttemptResource, WorkerError> {
        let binding = self
            .load_execution_binding(tenant, campaign_id, attempt_id)
            .await?;
        let orchestrator = OutboundOrchestrator::new(
            &self.compliance,
            &self.agent,
            &self.telephony,
            &self.attempt_store,
        );
        let active = orchestrator
            .start_one_attempt(
                &binding.tenant_id,
                attempt_id,
                &binding.release,
                &binding.session_id,
            )
            .await
            .map_err(|error| WorkerError::new(error.code()))?;
        let attempt = orchestrator
            .finalize_active_attempt(active.clone())
            .await
            .map_err(|error| WorkerError::new(error.code()))?;
        self.commit_terminal(&binding, &active, attempt).await
    }

    /// Starts one call, supervises its durable Active Call event stream, and only then commits the
    /// terminal Attempt and post-call job.
    ///
    /// # Errors
    ///
    /// Returns stable admission, orchestration, authority, supervision or atomic-store failures.
    pub async fn run_attempt_with_active_session<E>(
        &self,
        tenant: &AuthenticatedTenant,
        campaign_id: &str,
        attempt_id: &CallAttemptId,
        session: &E,
    ) -> Result<AttemptResource, WorkerError>
    where
        S: ActiveAttemptContextPort + ActiveAttemptLeasePort,
        E: ActiveCallSessionPort<S>,
    {
        let binding = self
            .load_execution_binding(tenant, campaign_id, attempt_id)
            .await?;
        let orchestrator = OutboundOrchestrator::new(
            &self.compliance,
            &self.agent,
            &self.telephony,
            &self.attempt_store,
        );
        let active = orchestrator
            .start_one_attempt(
                &binding.tenant_id,
                attempt_id,
                &binding.release,
                &binding.session_id,
            )
            .await
            .map_err(|error| WorkerError::new(error.code()))?;
        let context = self.attempt_store.load_active_envelope_context().await?;
        if !binding.matches_active_context(&context, &active) {
            return Err(WorkerError::new("voice_agent_active_context_mismatch"));
        }
        match session
            .supervise_active_call(&context, &self.attempt_store)
            .await?
        {
            ActiveCallSessionSupervisorOutcome::Completed => {}
            ActiveCallSessionSupervisorOutcome::Draining => {
                return Err(WorkerError::new("voice_agent_worker_draining"));
            }
            ActiveCallSessionSupervisorOutcome::ReconcileRequired { .. } => {
                return Err(WorkerError::new(
                    "voice_agent_active_call_reconcile_required",
                ));
            }
        }
        let attempt = orchestrator
            .finalize_active_attempt(active.clone())
            .await
            .map_err(|error| WorkerError::new(error.code()))?;
        self.commit_terminal(&binding, &active, attempt).await
    }

    async fn load_execution_binding(
        &self,
        tenant: &AuthenticatedTenant,
        campaign_id: &str,
        attempt_id: &CallAttemptId,
    ) -> Result<AttemptExecutionBinding, WorkerError> {
        if self.shutdown.is_cancelled() {
            return Err(WorkerError::new("voice_agent_worker_draining"));
        }
        if !self.readiness.accepts_new_work() {
            return Err(WorkerError::new("voice_agent_admission_unavailable"));
        }

        let campaign = self
            .repository
            .campaign(tenant, campaign_id)
            .await?
            .ok_or_else(|| WorkerError::new("voice_agent_campaign_not_found"))?;
        if campaign.state() != CampaignState::Running {
            return Err(WorkerError::new("voice_agent_campaign_not_running"));
        }
        let release = self
            .repository
            .release(tenant, campaign.release_id())
            .await?
            .ok_or_else(|| WorkerError::new("voice_agent_release_not_found"))?;
        if release.state() != AgentReleaseState::Published {
            return Err(WorkerError::new("voice_agent_release_not_published"));
        }
        let release_binding = AgentReleaseBinding::try_new(
            AgentReleaseId::parse(release.id())
                .map_err(|_| WorkerError::new("voice_agent_release_identity_invalid"))?,
            release.content_hash(),
            release.components().clone(),
        )
        .map_err(|_| WorkerError::new("voice_agent_release_identity_invalid"))?;
        let session_id = derive_initial_session_id(tenant, attempt_id, &release_binding)?;
        let tenant_id = TenantId::parse(tenant.as_str())
            .map_err(|_| WorkerError::new("voice_agent_tenant_invalid"))?;
        Ok(AttemptExecutionBinding {
            tenant_id,
            campaign_id: CampaignId::parse(campaign.id())
                .map_err(|_| WorkerError::new("voice_agent_campaign_identity_invalid"))?,
            release: release_binding,
            session_id,
        })
    }

    async fn commit_terminal(
        &self,
        binding: &AttemptExecutionBinding,
        active: &converact_ai_outbound_core::ActiveAttemptExecution,
        attempt: converact_ai_outbound_core::CallAttempt,
    ) -> Result<AttemptResource, WorkerError> {
        let terminal = TerminalAttemptCommit::try_new(
            attempt.clone(),
            binding.campaign_id.clone(),
            binding.release.id().clone(),
            active.call_id().clone(),
            active.channel_agent_session_id().clone(),
        )
        .map_err(|error| WorkerError::new(error.code()))?;
        self.attempt_store
            .complete_and_enqueue(terminal)
            .await
            .map_err(|error| WorkerError::new(error.code()))?;
        let resource = AttemptResource::terminal_pending(
            binding.campaign_id.as_str(),
            binding.release.id().as_str(),
            &attempt,
        );
        Ok(resource)
    }

    #[must_use]
    pub const fn config(&self) -> WorkerConfig {
        self.config
    }

    #[must_use]
    pub const fn readiness(&self) -> &AdmissionReadiness {
        &self.readiness
    }

    #[must_use]
    pub const fn shutdown_token(&self) -> &ShutdownToken {
        &self.shutdown
    }
}

struct AttemptExecutionBinding {
    tenant_id: TenantId,
    campaign_id: CampaignId,
    release: AgentReleaseBinding,
    session_id: converact_voice_agent_contracts::ChannelAgentSessionId,
}

impl AttemptExecutionBinding {
    fn matches_active_context(
        &self,
        context: &converact_voice_agent_contracts::EnvelopeContext,
        active: &converact_ai_outbound_core::ActiveAttemptExecution,
    ) -> bool {
        context.tenant_id() == self.tenant_id.as_str()
            && context.campaign_id() == &self.campaign_id
            && context.call_attempt_id() == active.attempt().id()
            && context.call_id() == Some(active.call_id())
            && context.agent_release_id() == self.release.id()
            && context.channel_agent_session_id() == Some(active.channel_agent_session_id())
            && &self.session_id == active.channel_agent_session_id()
    }
}
