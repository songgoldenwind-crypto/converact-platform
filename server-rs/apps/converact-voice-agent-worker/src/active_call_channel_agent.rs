use std::{collections::HashMap, error::Error, fmt, sync::Arc};

use converact_active_call_adapter::{
    ActiveCallClient, ActiveCallCommand, AdapterCommand, ClientError, ClientFailureKind,
    encode_command,
};
use converact_ai_outbound_core::{
    AgentLegBinding, AgentObservation, AgentReleaseBinding, AgentReservation, ChannelAgentPort,
    PlayDisclosure, PortError, ReserveAgent, StartConversation,
};
use converact_voice_agent_contracts::{CallAttemptId, CallId, ChannelAgentSessionId, TenantId};
use tokio::sync::Mutex;

use crate::{
    ActiveCallArtifactSourcePort, ActiveCallPlaybookResolver, ActiveCallPlaybookResolverError,
    ActiveCallReservationAdapter, ActiveCallReservationObservation, AuthenticatedTenant,
};

const MAX_SESSIONS: usize = 100_000;

/// Invalid bounded configuration for the concrete Active Call channel-agent port.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveCallChannelAgentConfigError {
    InvalidDisclosure,
    InvalidSessionLimit,
}

impl fmt::Display for ActiveCallChannelAgentConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidDisclosure => "active_call_disclosure_invalid",
            Self::InvalidSessionLimit => "active_call_session_limit_invalid",
        })
    }
}

impl Error for ActiveCallChannelAgentConfigError {}

/// Bounded disclosure and local in-flight session policy.
#[derive(Clone)]
pub struct ActiveCallChannelAgentConfig {
    disclosure: Box<str>,
    max_sessions: usize,
}

impl ActiveCallChannelAgentConfig {
    /// Validates disclosure command bounds and the local in-flight session ceiling.
    ///
    /// # Errors
    ///
    /// Rejects a disclosure the pinned adapter cannot encode or an unsafe session bound.
    pub fn new(
        disclosure: impl AsRef<str>,
        max_sessions: usize,
    ) -> Result<Self, ActiveCallChannelAgentConfigError> {
        if !(1..=MAX_SESSIONS).contains(&max_sessions) {
            return Err(ActiveCallChannelAgentConfigError::InvalidSessionLimit);
        }
        encode_command(AdapterCommand::PlayDisclosure {
            text: disclosure.as_ref().to_owned(),
            play_id: "configuration-check".to_owned(),
        })
        .map_err(|_| ActiveCallChannelAgentConfigError::InvalidDisclosure)?;
        Ok(Self {
            disclosure: disclosure.as_ref().into(),
            max_sessions,
        })
    }
}

impl fmt::Debug for ActiveCallChannelAgentConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActiveCallChannelAgentConfig")
            .field("disclosure", &"[REDACTED]")
            .field("max_sessions", &self.max_sessions)
            .finish()
    }
}

/// Complete bounded implementation of the outbound [`ChannelAgentPort`] for Active Call.
pub struct ActiveCallChannelAgent<S> {
    client: Arc<ActiveCallClient>,
    resolver: ActiveCallPlaybookResolver<S>,
    reservation: ActiveCallReservationAdapter,
    config: ActiveCallChannelAgentConfig,
    sessions: Mutex<HashMap<ChannelAgentSessionId, Arc<Mutex<SessionBinding>>>>,
}

impl<S> ActiveCallChannelAgent<S>
where
    S: ActiveCallArtifactSourcePort,
{
    #[must_use]
    pub fn new(
        client: Arc<ActiveCallClient>,
        resolver: ActiveCallPlaybookResolver<S>,
        config: ActiveCallChannelAgentConfig,
    ) -> Self {
        Self {
            reservation: ActiveCallReservationAdapter::new(Arc::clone(&client)),
            client,
            resolver,
            config,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    async fn session(
        &self,
        session_id: &ChannelAgentSessionId,
    ) -> Result<Arc<Mutex<SessionBinding>>, PortError> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| PortError::rejected("active_call_session_binding_not_found"))
    }

    async fn observe(
        &self,
        session_id: &ChannelAgentSessionId,
    ) -> Result<AgentObservation, PortError> {
        let binding = self.sessions.lock().await.get(session_id).cloned();
        let Some(binding) = binding else {
            return normalize_unbound_observation(self.reservation.query(session_id).await?);
        };
        let mut state = binding.lock().await;
        if let SessionPhase::ReservationFailed(error) = state.phase {
            return Err(error);
        }
        let observation = self.reservation.query(session_id).await?;
        let normalized = state.reconcile_observation(observation)?;
        let terminal = normalized == AgentObservation::Terminal;
        drop(state);
        if terminal {
            self.remove_session_if_same(session_id, &binding).await;
        }
        Ok(normalized)
    }

    async fn remove_session_if_same(
        &self,
        session_id: &ChannelAgentSessionId,
        binding: &Arc<Mutex<SessionBinding>>,
    ) {
        let mut sessions = self.sessions.lock().await;
        if sessions
            .get(session_id)
            .is_some_and(|current| Arc::ptr_eq(current, binding))
        {
            sessions.remove(session_id);
        }
    }

    async fn reserve_inner(&self, request: ReserveAgent) -> Result<AgentReservation, PortError> {
        let session_id = request.session_id.clone();
        let existing = {
            let sessions = self.sessions.lock().await;
            sessions.get(&session_id).cloned()
        };
        if let Some(binding) = existing {
            let state = binding.lock().await;
            state.validate_reservation(&request)?;
            return state.reservation_result(session_id);
        }

        let tenant = AuthenticatedTenant::try_from_verified_tenant_id(request.tenant_id.as_str())
            .map_err(|_| PortError::rejected("active_call_tenant_invalid"))?;
        let artifact = self
            .resolver
            .resolve(&tenant, &request.release)
            .await
            .map_err(map_resolver_error)?;
        let (binding, inserted) = {
            let mut sessions = self.sessions.lock().await;
            if let Some(existing) = sessions.get(&session_id) {
                (Arc::clone(existing), false)
            } else {
                if sessions.len() >= self.config.max_sessions {
                    return Err(PortError::unavailable(
                        "active_call_session_capacity_exhausted",
                    ));
                }
                let binding = Arc::new(Mutex::new(SessionBinding::new(&request)));
                sessions.insert(session_id.clone(), Arc::clone(&binding));
                (binding, true)
            }
        };

        let mut state = binding.lock().await;
        state.validate_reservation(&request)?;
        if !inserted {
            return state.reservation_result(session_id);
        }

        match self.reservation.reserve(request, artifact).await {
            Ok(reservation) => {
                state.phase = SessionPhase::Reserved;
                Ok(reservation)
            }
            Err(error) => {
                if error.kind() == converact_ai_outbound_core::PortFailureKind::OutcomeUnknown {
                    state.phase = SessionPhase::ReservationUnknown;
                } else {
                    state.phase = SessionPhase::ReservationFailed(error);
                }
                Err(error)
            }
        }
    }

    async fn confirm_attachment_inner(&self, request: AgentLegBinding) -> Result<(), PortError> {
        let binding = self.session(&request.session_id).await?;
        let mut state = binding.lock().await;
        state.validate_attempt(&request.attempt_id)?;
        if state
            .call_id
            .as_ref()
            .is_some_and(|id| id != &request.call_id)
        {
            return Err(PortError::rejected("active_call_call_binding_drift"));
        }
        if state.call_id.as_ref() == Some(&request.call_id)
            && matches!(
                state.phase,
                SessionPhase::Attached
                    | SessionPhase::MediaReady
                    | SessionPhase::DisclosureSent
                    | SessionPhase::DisclosureCompleted
                    | SessionPhase::DisclosureUnknown
                    | SessionPhase::Started
                    | SessionPhase::StartUnknown
            )
        {
            return Ok(());
        }
        if let SessionPhase::ReservationFailed(error) = state.phase {
            return Err(error);
        }
        let observation = self.reservation.query(&request.session_id).await?;
        state.phase = match observation {
            ActiveCallReservationObservation::Attached => SessionPhase::Attached,
            ActiveCallReservationObservation::MediaReady => SessionPhase::MediaReady,
            ActiveCallReservationObservation::DisclosureCompleted => {
                SessionPhase::DisclosureCompleted
            }
            ActiveCallReservationObservation::Started
            | ActiveCallReservationObservation::Active => SessionPhase::Started,
            ActiveCallReservationObservation::Pending => {
                return Err(PortError::unavailable("active_call_session_not_attached"));
            }
            ActiveCallReservationObservation::Terminal => {
                return Err(PortError::rejected("active_call_session_terminal"));
            }
            ActiveCallReservationObservation::NotFound => {
                state.phase = SessionPhase::ReservationUnknown;
                return Err(PortError::outcome_unknown(
                    "active_call_session_not_found_after_reservation",
                ));
            }
        };
        state.call_id = Some(request.call_id);
        Ok(())
    }

    async fn disclose_inner(&self, request: PlayDisclosure) -> Result<(), PortError> {
        let binding = self.session(&request.session_id).await?;
        let mut state = binding.lock().await;
        state.validate_attempt(&request.attempt_id)?;
        if state.call_id.is_none() {
            return Err(PortError::rejected("active_call_call_not_attached"));
        }
        match state.phase {
            SessionPhase::DisclosureSent
            | SessionPhase::DisclosureCompleted
            | SessionPhase::Started => return Ok(()),
            SessionPhase::DisclosureUnknown => {
                return Err(PortError::outcome_unknown(
                    "active_call_disclosure_outcome_unknown",
                ));
            }
            SessionPhase::MediaReady => {}
            _ => return Err(PortError::rejected("active_call_disclosure_not_ready")),
        }
        let command = ActiveCallCommand::try_new(
            request.session_id.clone(),
            AdapterCommand::PlayDisclosure {
                text: self.config.disclosure.to_string(),
                play_id: request.session_id.as_str().to_owned(),
            },
        )
        .map_err(|_| PortError::rejected("active_call_disclosure_invalid"))?;
        match self.client.send_command(command).await {
            Ok(_) => {
                state.phase = SessionPhase::DisclosureSent;
                Ok(())
            }
            Err(error) => {
                let mapped = map_client_mutation_error(error);
                if mapped.kind() == converact_ai_outbound_core::PortFailureKind::OutcomeUnknown {
                    state.phase = SessionPhase::DisclosureUnknown;
                }
                Err(mapped)
            }
        }
    }

    async fn start_inner(&self, request: StartConversation) -> Result<(), PortError> {
        let binding = self.session(&request.session_id).await?;
        let mut state = binding.lock().await;
        state.validate_attempt(&request.attempt_id)?;
        match state.phase {
            SessionPhase::Started => return Ok(()),
            SessionPhase::StartUnknown => {
                return Err(PortError::outcome_unknown(
                    "active_call_start_outcome_unknown",
                ));
            }
            SessionPhase::DisclosureCompleted => {}
            _ => return Err(PortError::rejected("active_call_start_before_disclosure")),
        }
        match self
            .client
            .start_playbook_conversation(request.session_id)
            .await
        {
            Ok(_) => {
                state.phase = SessionPhase::Started;
                Ok(())
            }
            Err(error) => {
                let mapped = map_client_mutation_error(error);
                if mapped.kind() == converact_ai_outbound_core::PortFailureKind::OutcomeUnknown {
                    state.phase = SessionPhase::StartUnknown;
                }
                Err(mapped)
            }
        }
    }
}

impl<S> ChannelAgentPort for ActiveCallChannelAgent<S>
where
    S: ActiveCallArtifactSourcePort,
{
    async fn reserve(&self, request: ReserveAgent) -> Result<AgentReservation, PortError> {
        self.reserve_inner(request).await
    }

    async fn confirm_attachment(&self, request: AgentLegBinding) -> Result<(), PortError> {
        self.confirm_attachment_inner(request).await
    }

    async fn play_disclosure(&self, request: PlayDisclosure) -> Result<(), PortError> {
        self.disclose_inner(request).await
    }

    async fn start_conversation(&self, request: StartConversation) -> Result<(), PortError> {
        self.start_inner(request).await
    }

    async fn query(
        &self,
        session_id: &ChannelAgentSessionId,
    ) -> Result<AgentObservation, PortError> {
        self.observe(session_id).await
    }
}

impl<S> fmt::Debug for ActiveCallChannelAgent<S> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ActiveCallChannelAgent([REDACTED])")
    }
}

struct SessionBinding {
    tenant_id: TenantId,
    attempt_id: CallAttemptId,
    release: AgentReleaseBinding,
    call_id: Option<CallId>,
    phase: SessionPhase,
}

impl SessionBinding {
    fn new(request: &ReserveAgent) -> Self {
        Self {
            tenant_id: request.tenant_id.clone(),
            attempt_id: request.attempt_id.clone(),
            release: request.release.clone(),
            call_id: None,
            phase: SessionPhase::Reserving,
        }
    }

    fn validate_reservation(&self, request: &ReserveAgent) -> Result<(), PortError> {
        if self.tenant_id != request.tenant_id
            || self.attempt_id != request.attempt_id
            || self.release != request.release
        {
            return Err(PortError::rejected("active_call_session_binding_drift"));
        }
        Ok(())
    }

    fn validate_attempt(&self, attempt_id: &CallAttemptId) -> Result<(), PortError> {
        if &self.attempt_id != attempt_id {
            return Err(PortError::rejected("active_call_attempt_binding_drift"));
        }
        Ok(())
    }

    fn reservation_result(
        &self,
        session_id: ChannelAgentSessionId,
    ) -> Result<AgentReservation, PortError> {
        match self.phase {
            SessionPhase::Reserved
            | SessionPhase::Attached
            | SessionPhase::MediaReady
            | SessionPhase::DisclosureSent
            | SessionPhase::DisclosureCompleted
            | SessionPhase::DisclosureUnknown
            | SessionPhase::Started
            | SessionPhase::StartUnknown => Ok(AgentReservation { session_id }),
            SessionPhase::ReservationUnknown => Err(PortError::outcome_unknown(
                "active_call_playbook_reservation_unknown",
            )),
            SessionPhase::ReservationFailed(error) => Err(error),
            SessionPhase::Reserving => Err(PortError::unavailable(
                "active_call_playbook_reservation_in_progress",
            )),
        }
    }

    fn reconcile_observation(
        &mut self,
        observation: ActiveCallReservationObservation,
    ) -> Result<AgentObservation, PortError> {
        match self.phase {
            SessionPhase::ReservationUnknown => self.reconcile_reservation_unknown(observation),
            SessionPhase::DisclosureUnknown => self.reconcile_disclosure_unknown(observation),
            SessionPhase::StartUnknown => self.reconcile_start_unknown(observation),
            SessionPhase::ReservationFailed(error) => Err(error),
            _ => self.reconcile_known(observation),
        }
    }

    fn reconcile_reservation_unknown(
        &mut self,
        observation: ActiveCallReservationObservation,
    ) -> Result<AgentObservation, PortError> {
        if observation == ActiveCallReservationObservation::NotFound {
            return Err(PortError::outcome_unknown(
                "active_call_playbook_reservation_unknown",
            ));
        }
        self.phase = SessionPhase::Reserved;
        self.reconcile_known(observation)
    }

    fn reconcile_disclosure_unknown(
        &mut self,
        observation: ActiveCallReservationObservation,
    ) -> Result<AgentObservation, PortError> {
        match observation {
            ActiveCallReservationObservation::DisclosureCompleted => {
                self.phase = SessionPhase::DisclosureCompleted;
                Ok(AgentObservation::DisclosureCompleted)
            }
            ActiveCallReservationObservation::Started
            | ActiveCallReservationObservation::Active => {
                self.phase = SessionPhase::Started;
                Ok(AgentObservation::Conversing)
            }
            ActiveCallReservationObservation::Terminal => Ok(AgentObservation::Terminal),
            _ => Err(PortError::outcome_unknown(
                "active_call_disclosure_outcome_unknown",
            )),
        }
    }

    fn reconcile_start_unknown(
        &mut self,
        observation: ActiveCallReservationObservation,
    ) -> Result<AgentObservation, PortError> {
        match observation {
            ActiveCallReservationObservation::Started
            | ActiveCallReservationObservation::Active => {
                self.phase = SessionPhase::Started;
                Ok(AgentObservation::Conversing)
            }
            ActiveCallReservationObservation::Terminal => Ok(AgentObservation::Terminal),
            _ => Err(PortError::outcome_unknown(
                "active_call_start_outcome_unknown",
            )),
        }
    }

    fn reconcile_known(
        &mut self,
        observation: ActiveCallReservationObservation,
    ) -> Result<AgentObservation, PortError> {
        match observation {
            ActiveCallReservationObservation::Pending => {
                if self.phase != SessionPhase::Reserved {
                    return Err(state_regressed());
                }
                Err(PortError::unavailable("active_call_media_not_ready"))
            }
            ActiveCallReservationObservation::Attached => {
                if !matches!(self.phase, SessionPhase::Reserved | SessionPhase::Attached) {
                    return Err(state_regressed());
                }
                self.phase = SessionPhase::Attached;
                Err(PortError::unavailable("active_call_media_not_ready"))
            }
            ActiveCallReservationObservation::MediaReady => {
                if matches!(
                    self.phase,
                    SessionPhase::DisclosureCompleted | SessionPhase::Started
                ) {
                    return Err(state_regressed());
                }
                if self.phase != SessionPhase::DisclosureSent {
                    self.phase = SessionPhase::MediaReady;
                }
                Ok(AgentObservation::MediaReady)
            }
            ActiveCallReservationObservation::DisclosureCompleted => {
                if self.phase == SessionPhase::Started {
                    return Err(state_regressed());
                }
                self.phase = SessionPhase::DisclosureCompleted;
                Ok(AgentObservation::DisclosureCompleted)
            }
            ActiveCallReservationObservation::Started
            | ActiveCallReservationObservation::Active => {
                self.phase = SessionPhase::Started;
                Ok(AgentObservation::Conversing)
            }
            ActiveCallReservationObservation::Terminal => Ok(AgentObservation::Terminal),
            ActiveCallReservationObservation::NotFound => {
                self.phase = SessionPhase::ReservationUnknown;
                Ok(AgentObservation::NotFound)
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SessionPhase {
    Reserving,
    Reserved,
    ReservationUnknown,
    ReservationFailed(PortError),
    Attached,
    MediaReady,
    DisclosureSent,
    DisclosureCompleted,
    DisclosureUnknown,
    Started,
    StartUnknown,
}

fn normalize_unbound_observation(
    observation: ActiveCallReservationObservation,
) -> Result<AgentObservation, PortError> {
    match observation {
        ActiveCallReservationObservation::Pending | ActiveCallReservationObservation::Attached => {
            Err(PortError::unavailable("active_call_media_not_ready"))
        }
        ActiveCallReservationObservation::MediaReady => Ok(AgentObservation::MediaReady),
        ActiveCallReservationObservation::DisclosureCompleted => {
            Ok(AgentObservation::DisclosureCompleted)
        }
        ActiveCallReservationObservation::Started | ActiveCallReservationObservation::Active => {
            Ok(AgentObservation::Conversing)
        }
        ActiveCallReservationObservation::Terminal => Ok(AgentObservation::Terminal),
        ActiveCallReservationObservation::NotFound => Ok(AgentObservation::NotFound),
    }
}

const fn state_regressed() -> PortError {
    PortError::outcome_unknown("active_call_reservation_state_regressed")
}

fn map_resolver_error(error: ActiveCallPlaybookResolverError) -> PortError {
    match error {
        ActiveCallPlaybookResolverError::Unavailable => PortError::unavailable(error.code()),
        ActiveCallPlaybookResolverError::InvalidConfiguration
        | ActiveCallPlaybookResolverError::NotFound
        | ActiveCallPlaybookResolverError::SourceDrift
        | ActiveCallPlaybookResolverError::CompilerDrift
        | ActiveCallPlaybookResolverError::ArtifactInvalid => PortError::rejected(error.code()),
    }
}

fn map_client_mutation_error(error: ClientError) -> PortError {
    match error.kind() {
        ClientFailureKind::Unavailable => PortError::unavailable(error.code()),
        ClientFailureKind::OutcomeUnknown | ClientFailureKind::InvalidResponse => {
            PortError::outcome_unknown(error.code())
        }
        ClientFailureKind::InvalidConfiguration
        | ClientFailureKind::Rejected
        | ClientFailureKind::CoverageGap => PortError::rejected(error.code()),
    }
}
