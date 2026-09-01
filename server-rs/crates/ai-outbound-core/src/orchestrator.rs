use std::{error::Error, fmt};

use converact_voice_agent_contracts::{
    AttemptCommand, CallAttemptId, CallId, ChannelAgentSessionId, TenantId,
};

use crate::{
    AgentLegBinding, AgentObservation, AgentReleaseBinding, AttemptStorePort, CallAttempt,
    CallObservation, ChannelAgentPort, ComplianceDecision, CompliancePort, DomainError,
    EffectIntent, OriginateCall, OutboundDialBinding, PlayDisclosure, PortError, PortFailureKind,
    ReserveAgent, StartConversation, TelephonyPort,
};

/// Stable orchestration failure safe to persist and expose to workers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OrchestrationError {
    code: &'static str,
}

impl OrchestrationError {
    const fn new(code: &'static str) -> Self {
        Self { code }
    }

    /// Returns the stable machine-readable failure code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for OrchestrationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for OrchestrationError {}

impl From<PortError> for OrchestrationError {
    fn from(error: PortError) -> Self {
        Self::new(error.code())
    }
}

/// Coordinates one leased physical Attempt through explicit, durable effects.
pub struct OutboundOrchestrator<'a, C, A, T, S> {
    compliance: &'a C,
    agent: &'a A,
    telephony: &'a T,
    store: &'a S,
}

impl<'a, C, A, T, S> OutboundOrchestrator<'a, C, A, T, S>
where
    C: CompliancePort,
    A: ChannelAgentPort,
    T: TelephonyPort,
    S: AttemptStorePort,
{
    /// Creates an orchestrator from four narrow authority ports.
    #[must_use]
    pub const fn new(compliance: &'a C, agent: &'a A, telephony: &'a T, store: &'a S) -> Self {
        Self {
            compliance,
            agent,
            telephony,
            store,
        }
    }

    /// Advances one planned Attempt through the tracer-bullet happy path.
    ///
    /// Each external mutation has a durable intent before it is issued. An indeterminate
    /// mutation result is persisted as `outcome_unknown` and is never retried here. The returned
    /// terminal aggregate is deliberately not written through [`AttemptStorePort`]; the caller
    /// must commit it together with the required post-call work in one atomic repository boundary.
    ///
    /// # Errors
    ///
    /// Returns a stable error for blocked compliance, unavailable dependencies, unexpected
    /// observations, persistence failures, and indeterminate external effects.
    pub async fn run_one_attempt(
        &self,
        tenant_id: &TenantId,
        attempt_id: &CallAttemptId,
        release: &AgentReleaseBinding,
        session_id: &ChannelAgentSessionId,
    ) -> Result<CallAttempt, OrchestrationError> {
        let (attempt, dial) = self
            .prepare_attempt(tenant_id, attempt_id, release, session_id)
            .await?;
        let (attempt, call_id) = self.originate_and_attach(attempt, session_id, dial).await?;
        let attempt = self.disclose_and_start(attempt, session_id).await?;
        self.finalize_when_terminal(attempt, &call_id).await
    }

    async fn prepare_attempt(
        &self,
        tenant_id: &TenantId,
        attempt_id: &CallAttemptId,
        release: &AgentReleaseBinding,
        session_id: &ChannelAgentSessionId,
    ) -> Result<(CallAttempt, OutboundDialBinding), OrchestrationError> {
        let mut attempt = self.store.load(attempt_id).await?;
        if attempt.state() != converact_voice_agent_contracts::CallAttemptState::Claimed {
            return Err(OrchestrationError::new("orchestration_attempt_not_claimed"));
        }

        attempt = match self.compliance.evaluate(tenant_id, &attempt).await? {
            ComplianceDecision::Approved => {
                transition(&attempt, AttemptCommand::ApproveCompliance)?
            }
            ComplianceDecision::Blocked(_) => {
                let blocked = transition(&attempt, AttemptCommand::BlockCompliance)?;
                self.store.persist_observation(&blocked).await?;
                return Err(OrchestrationError::new("compliance_blocked"));
            }
        };
        self.store.persist_observation(&attempt).await?;

        let dial = self.store.load_dial_binding(attempt.id()).await?;

        self.store
            .persist_intent(&attempt, EffectIntent::ReserveAgent)
            .await?;
        let reservation = match self
            .agent
            .reserve(ReserveAgent {
                tenant_id: tenant_id.clone(),
                attempt_id: attempt.id().clone(),
                release: release.clone(),
                session_id: session_id.clone(),
            })
            .await
        {
            Ok(reservation) => reservation,
            Err(error) if error.kind() == PortFailureKind::OutcomeUnknown => {
                return self.mark_unknown(attempt, "outcome_unknown").await;
            }
            Err(error) => return Err(error.into()),
        };
        if reservation.session_id != *session_id {
            return self
                .mark_unknown(attempt, "agent_session_identity_mismatch")
                .await;
        }

        attempt = transition(&attempt, AttemptCommand::ReserveAgentCapacity)?;
        self.store.persist_observation(&attempt).await?;

        Ok((attempt, dial))
    }

    async fn originate_and_attach(
        &self,
        mut attempt: CallAttempt,
        session_id: &ChannelAgentSessionId,
        dial: OutboundDialBinding,
    ) -> Result<(CallAttempt, CallId), OrchestrationError> {
        let call_id = CallId::parse(attempt.id().as_str())
            .map_err(|_| OrchestrationError::new("call_identity_invalid"))?;
        self.store
            .persist_intent(&attempt, EffectIntent::OriginateCall)
            .await?;
        attempt = transition(&attempt, AttemptCommand::Dial)?;
        let observed_call_id = match self
            .telephony
            .originate(OriginateCall {
                attempt_id: attempt.id().clone(),
                call_id: call_id.clone(),
                agent_session_id: session_id.clone(),
                dial,
            })
            .await
        {
            Ok(CallObservation::Answered(observed)) if observed == call_id => observed,
            Ok(_) => {
                return self
                    .mark_unknown(attempt, "telephony_observation_unexpected")
                    .await;
            }
            Err(error) if error.kind() == PortFailureKind::OutcomeUnknown => {
                return self.mark_unknown(attempt, "outcome_unknown").await;
            }
            Err(error) => {
                let failed = transition(&attempt, AttemptCommand::MarkFailedBeforeAnswer)?;
                self.store.persist_observation(&failed).await?;
                return Err(error.into());
            }
        };
        attempt = transition(&attempt, AttemptCommand::ObserveAnswered)?;
        self.store.persist_observation(&attempt).await?;

        self.store
            .persist_intent(&attempt, EffectIntent::AttachAgent)
            .await?;
        let binding = AgentLegBinding {
            attempt_id: attempt.id().clone(),
            call_id: observed_call_id.clone(),
            session_id: session_id.clone(),
        };
        let attach_result = self.telephony.add_agent_leg(binding.clone()).await;
        self.require_known_post_answer_effect(&attempt, attach_result)
            .await?;
        let confirm_result = self.agent.confirm_attachment(binding).await;
        self.require_known_post_answer_effect(&attempt, confirm_result)
            .await?;
        attempt = transition(&attempt, AttemptCommand::AttachAgent)?;
        self.store.persist_observation(&attempt).await?;

        expect_agent_observation(
            self.agent.query(session_id).await?,
            AgentObservation::MediaReady,
        )?;
        attempt = transition(&attempt, AttemptCommand::AwaitDisclosure)?;
        self.store.persist_observation(&attempt).await?;

        Ok((attempt, observed_call_id))
    }

    async fn disclose_and_start(
        &self,
        mut attempt: CallAttempt,
        session_id: &ChannelAgentSessionId,
    ) -> Result<CallAttempt, OrchestrationError> {
        self.store
            .persist_intent(&attempt, EffectIntent::PlayDisclosure)
            .await?;
        let disclosure_result = self
            .agent
            .play_disclosure(PlayDisclosure {
                attempt_id: attempt.id().clone(),
                session_id: session_id.clone(),
            })
            .await;
        self.require_known_post_answer_effect(&attempt, disclosure_result)
            .await?;
        expect_agent_observation(
            self.agent.query(session_id).await?,
            AgentObservation::DisclosureCompleted,
        )?;
        attempt = transition(&attempt, AttemptCommand::CompleteDisclosure)?;
        self.store.persist_observation(&attempt).await?;

        self.store
            .persist_intent(&attempt, EffectIntent::StartConversation)
            .await?;
        attempt = transition(&attempt, AttemptCommand::StartConversation)?;
        let conversation_result = self
            .agent
            .start_conversation(StartConversation {
                attempt_id: attempt.id().clone(),
                session_id: session_id.clone(),
            })
            .await;
        self.require_known_post_answer_effect(&attempt, conversation_result)
            .await?;
        self.store.persist_observation(&attempt).await?;

        Ok(attempt)
    }

    async fn finalize_when_terminal(
        &self,
        mut attempt: CallAttempt,
        call_id: &CallId,
    ) -> Result<CallAttempt, OrchestrationError> {
        match self.telephony.query(call_id).await? {
            CallObservation::Terminal(observed) | CallObservation::NotFound(observed)
                if &observed == call_id => {}
            _ => {
                return self
                    .mark_unknown(attempt, "telephony_observation_unexpected")
                    .await;
            }
        }
        attempt = transition(&attempt, AttemptCommand::Finalize)?;
        attempt = transition(&attempt, AttemptCommand::Complete)?;
        Ok(attempt)
    }

    /// Queries external authority for an Attempt whose mutation outcome is unknown.
    ///
    /// This method deliberately does not create a retry. A later reconciliation policy consumes
    /// the persisted observation and decides the deterministic terminal state.
    ///
    /// # Errors
    ///
    /// Returns a stable error when the Attempt is not reconcilable, persistence fails, or the
    /// telephony query fails.
    pub async fn reconcile(
        &self,
        attempt_id: &CallAttemptId,
    ) -> Result<CallObservation, OrchestrationError> {
        let mut attempt = self.store.load(attempt_id).await?;
        attempt = transition(&attempt, AttemptCommand::RequireReconcile)?;
        self.store.persist_observation(&attempt).await?;
        let call_id = CallId::parse(attempt.id().as_str())
            .map_err(|_| OrchestrationError::new("call_identity_invalid"))?;
        let observation = self.telephony.query(&call_id).await?;
        Ok(observation)
    }

    async fn mark_unknown<R>(
        &self,
        attempt: CallAttempt,
        code: &'static str,
    ) -> Result<R, OrchestrationError> {
        let unknown = transition(&attempt, AttemptCommand::MarkOutcomeUnknown)?;
        self.store.persist_observation(&unknown).await?;
        Err(OrchestrationError::new(code))
    }

    async fn require_known_post_answer_effect(
        &self,
        attempt: &CallAttempt,
        result: Result<(), PortError>,
    ) -> Result<(), OrchestrationError> {
        match result {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == PortFailureKind::OutcomeUnknown => {
                self.mark_unknown(attempt.clone(), "outcome_unknown").await
            }
            Err(error) => {
                let failed = transition(attempt, AttemptCommand::MarkFailedAfterAnswer)?;
                self.store.persist_observation(&failed).await?;
                Err(error.into())
            }
        }
    }
}

fn transition(
    attempt: &CallAttempt,
    command: AttemptCommand,
) -> Result<CallAttempt, OrchestrationError> {
    attempt
        .apply(command)
        .map_err(|_error: DomainError| OrchestrationError::new("orchestration_state_invalid"))
}

fn expect_agent_observation(
    actual: AgentObservation,
    expected: AgentObservation,
) -> Result<(), OrchestrationError> {
    if actual == expected {
        Ok(())
    } else {
        Err(OrchestrationError::new("agent_observation_unexpected"))
    }
}
