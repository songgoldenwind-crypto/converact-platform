use converact_conversation_result_core::TranscriptSegmentDraft;
use converact_postgres_store::{
    PostgresConversationResultStore, PostgresSequencedTranscriptAppend,
};
use converact_voice_agent_contracts::ExecutionGeneration;

use crate::{ActiveCallTranscriptDurabilityPort, ActiveCallTranscriptIngestError};

impl ActiveCallTranscriptDurabilityPort for PostgresConversationResultStore {
    type Append = PostgresSequencedTranscriptAppend;

    async fn append_sequenced_final_segment(
        &self,
        draft: &TranscriptSegmentDraft,
        current_generation: ExecutionGeneration,
    ) -> Result<Self::Append, ActiveCallTranscriptIngestError> {
        PostgresConversationResultStore::append_sequenced_final_segment(
            self,
            draft,
            current_generation,
        )
        .await
        .map_err(|_| ActiveCallTranscriptIngestError::StoreUnavailable)
    }
}
