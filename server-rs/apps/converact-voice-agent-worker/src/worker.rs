use std::{error::Error, fmt, future::Future};

use converact_ai_outbound_core::{
    AttemptStorePort, ChannelAgentPort, CompliancePort, OutboundOrchestrator, TelephonyPort,
};
use converact_voice_agent_contracts::CallAttemptId;
use converact_voice_agent_contracts::{AgentReleaseState, CampaignState};

use crate::{
    AdmissionReadiness, AttemptResource, AuthenticatedTenant, ConversationEvidence,
    RepositoryError, ShutdownToken, VoiceAgentRepository, WorkerConfig,
};

/// Retrieves bounded terminal evidence after the agent runtime has finalized a session.
pub trait ConversationEvidencePort {
    fn final_evidence(
        &self,
        attempt_id: &CallAttemptId,
    ) -> impl Future<Output = Result<ConversationEvidence, WorkerError>> + Send;
}

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
pub struct VoiceAgentWorker<C, A, T, S, E, R> {
    compliance: C,
    agent: A,
    telephony: T,
    attempt_store: S,
    evidence: E,
    repository: R,
    config: WorkerConfig,
    readiness: AdmissionReadiness,
    shutdown: ShutdownToken,
}

impl<C, A, T, S, E, R> VoiceAgentWorker<C, A, T, S, E, R>
where
    C: CompliancePort,
    A: ChannelAgentPort,
    T: TelephonyPort,
    S: AttemptStorePort,
    E: ConversationEvidencePort,
    R: VoiceAgentRepository,
{
    #[allow(clippy::too_many_arguments)]
    #[must_use]
    pub const fn new(
        compliance: C,
        agent: A,
        telephony: T,
        attempt_store: S,
        evidence: E,
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
            evidence,
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
    /// Returns only stable machine codes from admission, orchestration, evidence or storage.
    pub async fn run_attempt(
        &self,
        tenant: &AuthenticatedTenant,
        campaign_id: &str,
        attempt_id: &CallAttemptId,
    ) -> Result<AttemptResource, WorkerError> {
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

        let orchestrator = OutboundOrchestrator::new(
            &self.compliance,
            &self.agent,
            &self.telephony,
            &self.attempt_store,
        );
        let attempt = orchestrator
            .run_one_attempt(attempt_id)
            .await
            .map_err(|error| WorkerError::new(error.code()))?;
        let evidence = self.evidence.final_evidence(attempt_id).await?;
        let resource =
            AttemptResource::completed(campaign_id, campaign.release_id(), &attempt, &evidence);
        self.repository
            .save_completed_attempt(tenant, resource.clone())
            .await?;
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
