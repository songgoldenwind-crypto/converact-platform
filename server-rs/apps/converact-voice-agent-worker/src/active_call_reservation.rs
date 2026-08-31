use std::{fmt, sync::Arc};

use converact_active_call_adapter::{
    ActiveCallClient, ClientError, ClientFailureKind, PlaybookReservationState,
};
use converact_ai_outbound_core::{AgentReservation, PortError, ReserveAgent};
use converact_voice_agent_contracts::ChannelAgentSessionId;

use crate::ActiveCallPlaybookArtifact;

/// Closed reservation observations from the pinned Active Call process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveCallReservationObservation {
    Pending,
    Active,
    NotFound,
}

/// Real bounded Active Call Playbook reservation transport.
pub struct ActiveCallReservationAdapter {
    client: Arc<ActiveCallClient>,
}

impl ActiveCallReservationAdapter {
    #[must_use]
    pub const fn new(client: Arc<ActiveCallClient>) -> Self {
        Self { client }
    }

    /// Reserves the exact artifact under the platform-owned session identity.
    ///
    /// # Errors
    ///
    /// Rejects cross-Release artifacts before I/O and preserves unknown mutation outcomes.
    pub async fn reserve(
        &self,
        request: ReserveAgent,
        artifact: ActiveCallPlaybookArtifact,
    ) -> Result<AgentReservation, PortError> {
        if artifact.release() != &request.release {
            return Err(PortError::rejected("active_call_artifact_release_mismatch"));
        }
        let session_id = request.session_id;
        let reservation = self
            .client
            .reserve_playbook(session_id.clone(), artifact.into_playbook())
            .await
            .map_err(map_mutation_error)?;
        if reservation.session_id != session_id {
            return Err(PortError::outcome_unknown(
                "active_call_playbook_session_mismatch",
            ));
        }
        Ok(AgentReservation { session_id })
    }

    /// Reads the process-local reservation state without authorizing a retry on `NotFound`.
    ///
    /// # Errors
    ///
    /// Returns a sanitized unavailable or rejected failure from the private client.
    pub async fn query(
        &self,
        session_id: &ChannelAgentSessionId,
    ) -> Result<ActiveCallReservationObservation, PortError> {
        self.client
            .query_playbook_reservation(session_id)
            .await
            .map(|state| match state {
                PlaybookReservationState::Pending => ActiveCallReservationObservation::Pending,
                PlaybookReservationState::Active => ActiveCallReservationObservation::Active,
                PlaybookReservationState::NotFound => ActiveCallReservationObservation::NotFound,
            })
            .map_err(map_query_error)
    }
}

impl fmt::Debug for ActiveCallReservationAdapter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ActiveCallReservationAdapter([REDACTED])")
    }
}

fn map_mutation_error(error: ClientError) -> PortError {
    match error.kind() {
        ClientFailureKind::Unavailable => PortError::unavailable(error.code()),
        ClientFailureKind::OutcomeUnknown | ClientFailureKind::InvalidResponse => {
            PortError::outcome_unknown(error.code())
        }
        ClientFailureKind::InvalidConfiguration | ClientFailureKind::Rejected => {
            PortError::rejected(error.code())
        }
    }
}

fn map_query_error(error: ClientError) -> PortError {
    match error.kind() {
        ClientFailureKind::Unavailable | ClientFailureKind::OutcomeUnknown => {
            PortError::unavailable(error.code())
        }
        ClientFailureKind::InvalidConfiguration
        | ClientFailureKind::Rejected
        | ClientFailureKind::InvalidResponse => PortError::rejected(error.code()),
    }
}
