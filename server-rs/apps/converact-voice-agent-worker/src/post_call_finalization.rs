use std::{error::Error, fmt, future::Future};

use converact_kernel_ids::TenantId;
use converact_post_call_finalization_core::FinalizationResolution;
use converact_post_call_finalization_store::{
    ClaimedFinalizationJob, FinalizationLease, FinalizationLeaseCommand,
    FinalizationReconcileCommand,
};

const MAX_BATCH_SIZE: u16 = 1_000;

/// Definitive post-call projection progress for one claimed job.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FinalizationProjectionProgress {
    Projected,
    Incomplete,
    ReconcileRequired(&'static str),
}

/// Bounded batch result without transcript, customer or Provider content.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct FinalizationBatchProgress {
    pub claimed: u16,
    pub projected: u16,
    pub incomplete: u16,
    pub reconcile_required: u16,
}

/// Stable Finalization Worker failure safe for logs and retry policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FinalizationWorkerError {
    code: &'static str,
}

impl FinalizationWorkerError {
    #[must_use]
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for FinalizationWorkerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for FinalizationWorkerError {}

/// Durable queue boundary. Implementations own tenant transactions and lease deadlines.
pub trait FinalizationQueuePort: Sync {
    fn claim_due(
        &self,
        tenant_id: &str,
        lease: &FinalizationLease,
        requested_limit: u16,
    ) -> impl Future<Output = Result<Vec<ClaimedFinalizationJob>, FinalizationWorkerError>> + Send;

    fn complete(
        &self,
        command: &FinalizationLeaseCommand,
        resolution: FinalizationResolution,
    ) -> impl Future<Output = Result<(), FinalizationWorkerError>> + Send;

    fn require_reconcile(
        &self,
        command: &FinalizationReconcileCommand,
    ) -> impl Future<Output = Result<(), FinalizationWorkerError>> + Send;
}

/// D7 projection facade. It has no call-control or established-media authority.
pub trait FinalizationProjectionPort: Sync {
    fn finalize(
        &self,
        tenant_id: &str,
        job: &ClaimedFinalizationJob,
    ) -> impl Future<Output = Result<FinalizationProjectionProgress, FinalizationWorkerError>> + Send;
}

/// Sequential bounded worker over leased post-call jobs.
pub struct ConversationFinalizationWorker<'a, Q, P> {
    queue: &'a Q,
    projector: &'a P,
}

impl<'a, Q, P> ConversationFinalizationWorker<'a, Q, P>
where
    Q: FinalizationQueuePort,
    P: FinalizationProjectionPort,
{
    #[must_use]
    pub const fn new(queue: &'a Q, projector: &'a P) -> Self {
        Self { queue, projector }
    }

    /// Claims and settles one bounded batch without spawning per-job tasks.
    ///
    /// Projection ambiguity and failures become explicit reconciliation; no path repeats a Call.
    ///
    /// # Errors
    ///
    /// Returns bounded tenant, queue, lease or counter failures.
    pub async fn run_batch(
        &self,
        tenant_id: &str,
        lease: &FinalizationLease,
        requested_limit: u16,
    ) -> Result<FinalizationBatchProgress, FinalizationWorkerError> {
        if requested_limit == 0 || requested_limit > MAX_BATCH_SIZE {
            return Err(FinalizationWorkerError::new(
                "post_call_finalization_batch_invalid",
            ));
        }
        let tenant = TenantId::parse(tenant_id)
            .map_err(|_| FinalizationWorkerError::new("post_call_finalization_tenant_invalid"))?;
        let claims = self
            .queue
            .claim_due(tenant_id, lease, requested_limit)
            .await?;
        if claims.len() > usize::from(requested_limit) {
            return Err(FinalizationWorkerError::new(
                "post_call_finalization_claim_bound_exceeded",
            ));
        }
        let mut progress = FinalizationBatchProgress {
            claimed: u16::try_from(claims.len()).map_err(|_| {
                FinalizationWorkerError::new("post_call_finalization_count_invalid")
            })?,
            ..FinalizationBatchProgress::default()
        };

        for job in claims {
            let command = FinalizationLeaseCommand {
                tenant_id: tenant.clone(),
                job_id: job.id().clone(),
                expected_revision: job.revision(),
                lease: lease.clone(),
            };
            let projection = self
                .projector
                .finalize(tenant_id, &job)
                .await
                .unwrap_or_else(|error| {
                    FinalizationProjectionProgress::ReconcileRequired(error.code())
                });
            match projection {
                FinalizationProjectionProgress::Projected => {
                    self.queue
                        .complete(&command, FinalizationResolution::Projected)
                        .await?;
                    increment(&mut progress.projected)?;
                }
                FinalizationProjectionProgress::Incomplete => {
                    self.queue
                        .complete(&command, FinalizationResolution::Incomplete)
                        .await?;
                    increment(&mut progress.incomplete)?;
                }
                FinalizationProjectionProgress::ReconcileRequired(error_code) => {
                    let reconcile = FinalizationReconcileCommand::try_new(command, error_code)
                        .map_err(|_| {
                            FinalizationWorkerError::new(
                                "post_call_finalization_reconcile_reason_invalid",
                            )
                        })?;
                    self.queue.require_reconcile(&reconcile).await?;
                    increment(&mut progress.reconcile_required)?;
                }
            }
        }
        Ok(progress)
    }
}

fn increment(value: &mut u16) -> Result<(), FinalizationWorkerError> {
    *value = value
        .checked_add(1)
        .ok_or_else(|| FinalizationWorkerError::new("post_call_finalization_count_invalid"))?;
    Ok(())
}
