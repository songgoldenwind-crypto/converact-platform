use std::{error::Error, fmt, future::Future};

use converact_ai_outbound_core::{
    CallAttempt, DomainError, RetryCandidate, RetryDecision, RetryPlan, RetryPolicy, plan_retry,
};
use converact_voice_agent_contracts::{CallAttemptId, ExecutionGeneration, IdempotencyKey};

use crate::AuthenticatedTenant;

/// Stable Campaign retry failure safe for logs and scheduler policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RetryWorkerError {
    code: &'static str,
}

impl RetryWorkerError {
    #[must_use]
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for RetryWorkerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for RetryWorkerError {}

/// Input accepted only after a predecessor reached a definitive terminal state.
#[derive(Clone, Copy, Debug)]
pub struct CampaignRetryRequest<'a> {
    pub tenant: &'a AuthenticatedTenant,
    pub candidate: RetryCandidate<'a>,
    pub policy: RetryPolicy,
    pub expected_generation: ExecutionGeneration,
    pub idempotency_key: &'a IdempotencyKey,
}

/// Narrow persistence command for one already-planned physical Attempt.
#[derive(Clone, Copy, Debug)]
pub struct RetryPersistenceRequest<'a> {
    pub tenant: &'a AuthenticatedTenant,
    pub previous_attempt: &'a CallAttempt,
    pub plan: &'a RetryPlan,
    pub expected_generation: ExecutionGeneration,
    pub idempotency_key: &'a IdempotencyKey,
}

/// Result of the atomic retry write.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetryWriteDecision {
    Created,
    Replayed,
}

/// Durable Campaign scheduling boundary. Implementations own the transaction and fencing.
pub trait RetryDurabilityPort: Sync {
    fn persist_retry(
        &self,
        request: RetryPersistenceRequest<'_>,
    ) -> impl Future<Output = Result<RetryWriteDecision, RetryWorkerError>> + Send;
}

/// Closed worker result. Only `Planned` represents a durable retry Attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RetryWorkerDecision {
    Planned {
        attempt_id: CallAttemptId,
        attempt_number: u8,
        scheduled_for_ms: u64,
        write: RetryWriteDecision,
    },
    NotRetryable,
    Exhausted,
}

/// Pure policy plus one atomic persistence call; it has no real-time session authority.
pub struct CampaignRetryWorker<'a, D> {
    durability: &'a D,
}

impl<'a, D> CampaignRetryWorker<'a, D>
where
    D: RetryDurabilityPort,
{
    #[must_use]
    pub const fn new(durability: &'a D) -> Self {
        Self { durability }
    }

    /// Plans and persists one retry without performing external effects.
    ///
    /// # Errors
    ///
    /// Returns a stable machine code for unresolved outcomes, invalid planning input, or a
    /// durability failure.
    pub async fn plan_and_persist(
        &self,
        request: CampaignRetryRequest<'_>,
    ) -> Result<RetryWorkerDecision, RetryWorkerError> {
        let decision = plan_retry(request.candidate, request.policy).map_err(map_domain_error)?;
        let RetryDecision::Planned(plan) = decision else {
            return Ok(match decision {
                RetryDecision::NotRetryable => RetryWorkerDecision::NotRetryable,
                RetryDecision::Exhausted => RetryWorkerDecision::Exhausted,
                RetryDecision::Planned(_) => unreachable!(),
            });
        };
        let write = self
            .durability
            .persist_retry(RetryPersistenceRequest {
                tenant: request.tenant,
                previous_attempt: request.candidate.previous_attempt,
                plan: &plan,
                expected_generation: request.expected_generation,
                idempotency_key: request.idempotency_key,
            })
            .await?;
        Ok(RetryWorkerDecision::Planned {
            attempt_id: plan.attempt().id().clone(),
            attempt_number: plan.attempt_number(),
            scheduled_for_ms: plan.scheduled_for_ms(),
            write,
        })
    }
}

const fn map_domain_error(error: DomainError) -> RetryWorkerError {
    if matches!(error, DomainError::ReconcileRequired) {
        RetryWorkerError::new("ai_outbound_reconcile_required")
    } else {
        RetryWorkerError::new("ai_outbound_retry_plan_invalid")
    }
}
