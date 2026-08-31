use converact_agent_handoff_core::HandoffSession;
use converact_agent_handoff_store::{HandoffStoreCommand, HandoffTransitionWrite};
use converact_postgres_store::{
    PostgresHandoffCreateDecision, PostgresHandoffPrepareDecision, PostgresHandoffStore,
    PostgresHandoffStoreError,
};

use super::{
    DurableCreateDecision, DurablePrepareDecision, HandoffDurabilityPort, VoiceHandoffPortError,
};

impl HandoffDurabilityPort for PostgresHandoffStore {
    async fn create_requested(
        &self,
        requested: &HandoffSession,
        command: &HandoffStoreCommand,
    ) -> Result<DurableCreateDecision, VoiceHandoffPortError> {
        PostgresHandoffStore::create_requested(self, requested, command)
            .await
            .map(|decision| match decision {
                PostgresHandoffCreateDecision::Created => DurableCreateDecision::Created,
                PostgresHandoffCreateDecision::Replayed => DurableCreateDecision::Replayed,
            })
            .map_err(port_error)
    }

    async fn prepare_transition(
        &self,
        write: &HandoffTransitionWrite<'_>,
    ) -> Result<DurablePrepareDecision, VoiceHandoffPortError> {
        PostgresHandoffStore::prepare_transition(self, write)
            .await
            .map(|decision| match decision {
                PostgresHandoffPrepareDecision::Execute => DurablePrepareDecision::Execute,
                PostgresHandoffPrepareDecision::Query => DurablePrepareDecision::Query,
                PostgresHandoffPrepareDecision::ReplayApplied => {
                    DurablePrepareDecision::ReplayApplied
                }
                PostgresHandoffPrepareDecision::ReplayNotApplied => {
                    DurablePrepareDecision::ReplayNotApplied
                }
                PostgresHandoffPrepareDecision::Conflict => DurablePrepareDecision::Conflict,
                PostgresHandoffPrepareDecision::StaleFence => DurablePrepareDecision::StaleFence,
            })
            .map_err(port_error)
    }

    async fn finalize_applied(
        &self,
        write: &HandoffTransitionWrite<'_>,
    ) -> Result<(), VoiceHandoffPortError> {
        PostgresHandoffStore::finalize_applied(self, write)
            .await
            .map_err(port_error)
    }

    async fn finalize_not_applied(
        &self,
        current: &HandoffSession,
        command: &HandoffStoreCommand,
        failure_code: &'static str,
    ) -> Result<(), VoiceHandoffPortError> {
        PostgresHandoffStore::finalize_not_applied(self, current, command, failure_code)
            .await
            .map_err(port_error)
    }
}

fn port_error(error: PostgresHandoffStoreError) -> VoiceHandoffPortError {
    VoiceHandoffPortError::new(error.code())
}
