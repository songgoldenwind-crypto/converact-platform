use std::future::Future;

use converact_voice_agent_contracts::IdempotencyKey;
use serde::Serialize;

use crate::{AgentReleaseResource, AttemptResource, AuthenticatedTenant, CampaignResource};

/// Sanitized durable repository failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RepositoryError {
    code: &'static str,
}

impl RepositoryError {
    #[must_use]
    pub const fn unavailable() -> Self {
        Self {
            code: "voice_agent_repository_unavailable",
        }
    }

    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl std::fmt::Display for RepositoryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for RepositoryError {}

/// Idempotent reconciliation request acknowledgement.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ReconcileReceipt {
    pub attempt_id: String,
    pub accepted: bool,
}

/// Durable tenant-scoped inspection and worker projection boundary.
pub trait VoiceAgentRepository: Send + Sync + 'static {
    fn release(
        &self,
        tenant: &AuthenticatedTenant,
        id: &str,
    ) -> impl Future<Output = Result<Option<AgentReleaseResource>, RepositoryError>> + Send;

    fn campaign(
        &self,
        tenant: &AuthenticatedTenant,
        id: &str,
    ) -> impl Future<Output = Result<Option<CampaignResource>, RepositoryError>> + Send;

    fn attempt(
        &self,
        tenant: &AuthenticatedTenant,
        id: &str,
    ) -> impl Future<Output = Result<Option<AttemptResource>, RepositoryError>> + Send;

    fn request_reconcile(
        &self,
        tenant: &AuthenticatedTenant,
        attempt_id: &str,
        idempotency_key: &IdempotencyKey,
    ) -> impl Future<Output = Result<Option<ReconcileReceipt>, RepositoryError>> + Send;
}
