use std::{collections::VecDeque, future::Future, sync::Arc};

use tokio::task::JoinSet;

use crate::{AdmissionReadiness, ShutdownToken, WorkerConfig, WorkerError};

/// Source of one database-fenced, bounded claim batch.
pub trait AttemptClaimSource: Send + Sync + 'static {
    type Claim: Send + 'static;

    fn claim(
        &self,
        limit: u16,
    ) -> impl Future<Output = Result<Vec<Self::Claim>, WorkerError>> + Send;
}

/// Executes one already-admitted claim without creating further unbounded work.
pub trait ClaimedAttemptExecutor<Claim>: Send + Sync + 'static {
    fn execute(&self, claim: Claim) -> impl Future<Output = Result<(), WorkerError>> + Send;
}

/// Bounded outcome of one claim cycle.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ClaimBatchProgress {
    claimed: usize,
    completed: usize,
    failed: usize,
}

impl ClaimBatchProgress {
    #[must_use]
    pub const fn claimed(self) -> usize {
        self.claimed
    }

    #[must_use]
    pub const fn completed(self) -> usize {
        self.completed
    }

    #[must_use]
    pub const fn failed(self) -> usize {
        self.failed
    }
}

/// Fixed-concurrency supervisor for one durable claim cycle.
pub struct ClaimSupervisor<S, E> {
    source: S,
    executor: Arc<E>,
    config: WorkerConfig,
    readiness: AdmissionReadiness,
    shutdown: ShutdownToken,
}

impl<S, E> ClaimSupervisor<S, E> {
    #[must_use]
    pub const fn new(
        source: S,
        executor: Arc<E>,
        config: WorkerConfig,
        readiness: AdmissionReadiness,
        shutdown: ShutdownToken,
    ) -> Self {
        Self {
            source,
            executor,
            config,
            readiness,
            shutdown,
        }
    }
}

impl<S, E> ClaimSupervisor<S, E>
where
    S: AttemptClaimSource,
    E: ClaimedAttemptExecutor<S::Claim>,
{
    /// Claims and drains one bounded batch. Admission is checked before the database claim;
    /// readiness changes after that point do not abandon an already-owned lease.
    ///
    /// # Errors
    ///
    /// Returns a stable admission/source error or rejects a source that violates the requested
    /// batch ceiling before any claim is executed.
    pub async fn run_once(&self) -> Result<ClaimBatchProgress, WorkerError> {
        if self.shutdown.is_cancelled() {
            return Err(WorkerError::new("voice_agent_worker_draining"));
        }
        if !self.readiness.accepts_new_work() {
            return Err(WorkerError::new("voice_agent_admission_unavailable"));
        }

        let claims = self.source.claim(self.config.claim_size()).await?;
        if claims.len() > usize::from(self.config.claim_size()) {
            return Err(WorkerError::new("voice_agent_claim_batch_oversized"));
        }
        let claimed = claims.len();
        let mut pending = VecDeque::from(claims);
        let mut tasks = JoinSet::new();
        let concurrency = usize::from(self.config.worker_count()).min(claimed);
        for _ in 0..concurrency {
            spawn_next(&mut tasks, &mut pending, &self.executor);
        }

        let mut completed = 0;
        let mut failed = 0;
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(Ok(())) => completed += 1,
                Ok(Err(_)) | Err(_) => failed += 1,
            }
            spawn_next(&mut tasks, &mut pending, &self.executor);
        }
        Ok(ClaimBatchProgress {
            claimed,
            completed,
            failed,
        })
    }
}

fn spawn_next<Claim, E>(
    tasks: &mut JoinSet<Result<(), WorkerError>>,
    pending: &mut VecDeque<Claim>,
    executor: &Arc<E>,
) where
    Claim: Send + 'static,
    E: ClaimedAttemptExecutor<Claim>,
{
    if let Some(claim) = pending.pop_front() {
        let executor = Arc::clone(executor);
        tasks.spawn(async move { executor.execute(claim).await });
    }
}
