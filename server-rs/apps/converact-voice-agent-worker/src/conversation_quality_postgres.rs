use converact_conversation_result_store::{
    BadCaseView, ConversationEvaluationView, ConversationResultView, EntityCursor, QueryLimit,
    QueryPage, TranscriptSegmentView,
};
use converact_postgres_store::{
    PostgresConversationResultStore, PostgresConversationResultStoreError,
};
use converact_voice_agent_contracts::InteractionId;

use crate::{AuthenticatedTenant, ConversationQualityQueryError, ConversationQualityQueryPort};

impl ConversationQualityQueryPort for PostgresConversationResultStore {
    async fn load_latest_result(
        &self,
        tenant: &AuthenticatedTenant,
        interaction_id: &InteractionId,
    ) -> Result<Option<ConversationResultView>, ConversationQualityQueryError> {
        PostgresConversationResultStore::load_latest_result(
            self,
            tenant.as_str(),
            interaction_id.as_str(),
        )
        .await
        .map_err(query_error)
    }

    async fn list_transcript(
        &self,
        tenant: &AuthenticatedTenant,
        interaction_id: &InteractionId,
        cursor: Option<EntityCursor>,
        limit: QueryLimit,
    ) -> Result<QueryPage<TranscriptSegmentView>, ConversationQualityQueryError> {
        PostgresConversationResultStore::list_transcript(
            self,
            tenant.as_str(),
            interaction_id.as_str(),
            cursor.as_ref(),
            limit,
        )
        .await
        .map_err(query_error)
    }

    async fn list_evaluations(
        &self,
        tenant: &AuthenticatedTenant,
        interaction_id: &InteractionId,
        cursor: Option<EntityCursor>,
        limit: QueryLimit,
    ) -> Result<QueryPage<ConversationEvaluationView>, ConversationQualityQueryError> {
        PostgresConversationResultStore::list_evaluations(
            self,
            tenant.as_str(),
            interaction_id.as_str(),
            cursor.as_ref(),
            limit,
        )
        .await
        .map_err(query_error)
    }

    async fn list_bad_cases(
        &self,
        tenant: &AuthenticatedTenant,
        cursor: Option<EntityCursor>,
        limit: QueryLimit,
    ) -> Result<QueryPage<BadCaseView>, ConversationQualityQueryError> {
        PostgresConversationResultStore::list_bad_cases(
            self,
            tenant.as_str(),
            cursor.as_ref(),
            limit,
        )
        .await
        .map_err(query_error)
    }
}

fn query_error(error: PostgresConversationResultStoreError) -> ConversationQualityQueryError {
    ConversationQualityQueryError::new(error.code())
}
