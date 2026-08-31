use std::{error::Error, fmt, future::Future};

use converact_conversation_result_store::{
    BadCaseView, ConversationEvaluationView, ConversationResultView, EntityCursor, QueryLimit,
    QueryPage, TranscriptSegmentView,
};
use converact_voice_agent_contracts::InteractionId;

use crate::AuthenticatedTenant;

/// Explicit capabilities injected only after tenant authentication and authorization.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConversationQualityAccess {
    read_result: bool,
    read_transcript_text: bool,
    read_quality: bool,
}

impl ConversationQualityAccess {
    #[must_use]
    pub const fn new(read_result: bool, read_transcript_text: bool, read_quality: bool) -> Self {
        Self {
            read_result,
            read_transcript_text,
            read_quality,
        }
    }

    #[must_use]
    pub const fn can_read_result(self) -> bool {
        self.read_result
    }

    #[must_use]
    pub const fn can_read_transcript_text(self) -> bool {
        self.read_transcript_text
    }

    #[must_use]
    pub const fn can_read_quality(self) -> bool {
        self.read_quality
    }
}

/// Sanitized failure from the conversation-quality query boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConversationQualityQueryError {
    code: &'static str,
}

impl ConversationQualityQueryError {
    #[must_use]
    pub const fn invalid_query() -> Self {
        Self {
            code: "conversation_result_query_invalid",
        }
    }

    #[must_use]
    pub const fn unavailable() -> Self {
        Self {
            code: "conversation_quality_query_unavailable",
        }
    }

    #[must_use]
    pub(crate) const fn new(code: &'static str) -> Self {
        Self { code }
    }

    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }

    #[must_use]
    pub fn is_invalid_query(self) -> bool {
        self.code == "conversation_result_query_invalid"
    }
}

impl fmt::Display for ConversationQualityQueryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for ConversationQualityQueryError {}

/// Tenant-scoped read boundary for final conversation evidence and quality queues.
pub trait ConversationQualityQueryPort: Send + Sync + 'static {
    fn load_latest_result(
        &self,
        tenant: &AuthenticatedTenant,
        interaction_id: &InteractionId,
    ) -> impl Future<Output = Result<Option<ConversationResultView>, ConversationQualityQueryError>> + Send;

    fn list_transcript(
        &self,
        tenant: &AuthenticatedTenant,
        interaction_id: &InteractionId,
        cursor: Option<EntityCursor>,
        limit: QueryLimit,
    ) -> impl Future<
        Output = Result<QueryPage<TranscriptSegmentView>, ConversationQualityQueryError>,
    > + Send;

    fn list_evaluations(
        &self,
        tenant: &AuthenticatedTenant,
        interaction_id: &InteractionId,
        cursor: Option<EntityCursor>,
        limit: QueryLimit,
    ) -> impl Future<
        Output = Result<QueryPage<ConversationEvaluationView>, ConversationQualityQueryError>,
    > + Send;

    fn list_bad_cases(
        &self,
        tenant: &AuthenticatedTenant,
        cursor: Option<EntityCursor>,
        limit: QueryLimit,
    ) -> impl Future<Output = Result<QueryPage<BadCaseView>, ConversationQualityQueryError>> + Send;
}
