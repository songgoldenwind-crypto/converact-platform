use converact_conversation_understanding_store::{
    UnderstandingTurnAppendOutcome, UnderstandingTurnBatch,
};
use converact_postgres_store::PostgresConversationUnderstandingStore;
use converact_voice_agent_contracts::EnvelopeContext;

use crate::{UnderstandingAppendDecision, UnderstandingDurabilityPort, UnderstandingPortError};

impl UnderstandingDurabilityPort for PostgresConversationUnderstandingStore {
    async fn load_consistent_heads(
        &self,
        context: &EnvelopeContext,
    ) -> Result<
        Vec<converact_conversation_understanding_store::StoredUnderstandingHead>,
        UnderstandingPortError,
    > {
        PostgresConversationUnderstandingStore::load_consistent_heads(self, context)
            .await
            .map_err(|error| UnderstandingPortError::new(error.code()))
    }

    async fn append_turn(
        &self,
        batch: &UnderstandingTurnBatch,
    ) -> Result<UnderstandingAppendDecision, UnderstandingPortError> {
        let outcome = PostgresConversationUnderstandingStore::append_turn(self, batch)
            .await
            .map_err(|error| UnderstandingPortError::new(error.code()))?;
        Ok(match outcome {
            UnderstandingTurnAppendOutcome::Applied => UnderstandingAppendDecision::Applied,
            UnderstandingTurnAppendOutcome::Replayed => UnderstandingAppendDecision::Replayed,
            UnderstandingTurnAppendOutcome::Superseded => UnderstandingAppendDecision::Superseded,
        })
    }
}
