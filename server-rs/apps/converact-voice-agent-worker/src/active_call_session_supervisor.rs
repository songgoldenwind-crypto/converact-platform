use std::{future::Future, sync::Arc, time::Duration};

use converact_active_call_adapter::{ActiveCallClient, AdapterContext};
use converact_postgres_store::PostgresLeasedAttemptStore;
use converact_voice_agent_contracts::EnvelopeContext;
use tokio::time::sleep;

use crate::{
    ActiveCallEventConsumerError, ActiveCallEventConsumerOutcome, ActiveCallEventInboxPort,
    ActiveCallEventProcessorPort, ActiveCallEventReconcileReason, ShutdownToken, WorkerError,
    consume_active_call_events_once,
};

const MIN_INTERVAL: Duration = Duration::from_millis(1);
const MAX_RENEW_INTERVAL: Duration = Duration::from_secs(60);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);

/// One bounded invocation of the durable Active Call event consumer.
pub trait ActiveCallEventCyclePort: Sync {
    fn consume_once(
        &self,
    ) -> impl Future<Output = Result<ActiveCallEventConsumerOutcome, ActiveCallEventConsumerError>> + Send;
}

/// Concrete single-cycle adapter over the durable Active Call event consumer.
pub struct ActiveCallEventCycle<'a, D, P> {
    client: &'a ActiveCallClient,
    inbox: &'a D,
    processor: &'a P,
    adapter_context: &'a AdapterContext,
    shutdown: &'a ShutdownToken,
}

impl<'a, D, P> ActiveCallEventCycle<'a, D, P> {
    #[must_use]
    pub const fn new(
        client: &'a ActiveCallClient,
        inbox: &'a D,
        processor: &'a P,
        adapter_context: &'a AdapterContext,
        shutdown: &'a ShutdownToken,
    ) -> Self {
        Self {
            client,
            inbox,
            processor,
            adapter_context,
            shutdown,
        }
    }
}

impl<D, P> ActiveCallEventCyclePort for ActiveCallEventCycle<'_, D, P>
where
    D: ActiveCallEventInboxPort + Send + Sync,
    P: ActiveCallEventProcessorPort + Send + Sync,
{
    async fn consume_once(
        &self,
    ) -> Result<ActiveCallEventConsumerOutcome, ActiveCallEventConsumerError> {
        consume_active_call_events_once(
            self.client,
            self.inbox,
            self.processor,
            self.adapter_context,
            self.shutdown,
        )
        .await
    }
}

/// Exact lease heartbeat required while one physical call remains active.
pub trait ActiveAttemptLeasePort: Sync {
    fn renew_active_lease(&self) -> impl Future<Output = Result<(), WorkerError>> + Send;
}

/// Recovers the complete persisted authority for one already-active Attempt.
pub trait ActiveAttemptContextPort: Sync {
    fn load_active_envelope_context(
        &self,
    ) -> impl Future<Output = Result<EnvelopeContext, WorkerError>> + Send;
}

impl ActiveAttemptLeasePort for PostgresLeasedAttemptStore {
    async fn renew_active_lease(&self) -> Result<(), WorkerError> {
        PostgresLeasedAttemptStore::renew_active_lease(self)
            .await
            .map_err(|error| WorkerError::new(error.code()))
    }
}

impl ActiveAttemptContextPort for PostgresLeasedAttemptStore {
    async fn load_active_envelope_context(&self) -> Result<EnvelopeContext, WorkerError> {
        PostgresLeasedAttemptStore::load_active_envelope_context(self)
            .await
            .map_err(|error| WorkerError::new(error.code()))
    }
}

/// Invalid bounded timing policy for one long-lived session supervisor.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActiveCallSessionSupervisorConfigError;

impl std::fmt::Display for ActiveCallSessionSupervisorConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("active_call_session_supervisor_config_invalid")
    }
}

impl std::error::Error for ActiveCallSessionSupervisorConfigError {}

/// Bounded lease-heartbeat and reconnect timing policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActiveCallSessionSupervisorConfig {
    renew_interval: Duration,
    reconnect_delay: Duration,
}

impl ActiveCallSessionSupervisorConfig {
    /// # Errors
    ///
    /// Rejects busy-spin, unresponsive or reconnect-after-renewal timing.
    pub fn new(
        renew_interval: Duration,
        reconnect_delay: Duration,
    ) -> Result<Self, ActiveCallSessionSupervisorConfigError> {
        if renew_interval < MIN_INTERVAL
            || renew_interval > MAX_RENEW_INTERVAL
            || reconnect_delay < MIN_INTERVAL
            || reconnect_delay > MAX_RECONNECT_DELAY
            || reconnect_delay > renew_interval
        {
            return Err(ActiveCallSessionSupervisorConfigError);
        }
        Ok(Self {
            renew_interval,
            reconnect_delay,
        })
    }
}

/// Terminal reason returned after durable event supervision stops.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveCallSessionSupervisorOutcome {
    Completed,
    Draining,
    ReconcileRequired {
        reason: ActiveCallEventReconcileReason,
    },
}

/// Complete long-call supervision boundary used by the outbound Worker.
pub trait ActiveCallSessionPort<L>: Sync {
    fn supervise_active_call(
        &self,
        context: &EnvelopeContext,
        lease: &L,
    ) -> impl Future<Output = Result<ActiveCallSessionSupervisorOutcome, WorkerError>> + Send;
}

/// Owned composition of the durable event cycle and lease-heartbeat supervisor.
pub struct ActiveCallSessionRuntime<D, P> {
    client: Arc<ActiveCallClient>,
    inbox: Arc<D>,
    processor: Arc<P>,
    config: ActiveCallSessionSupervisorConfig,
    shutdown: ShutdownToken,
}

impl<D, P> ActiveCallSessionRuntime<D, P> {
    #[must_use]
    pub const fn new(
        client: Arc<ActiveCallClient>,
        inbox: Arc<D>,
        processor: Arc<P>,
        config: ActiveCallSessionSupervisorConfig,
        shutdown: ShutdownToken,
    ) -> Self {
        Self {
            client,
            inbox,
            processor,
            config,
            shutdown,
        }
    }
}

impl<L, D, P> ActiveCallSessionPort<L> for ActiveCallSessionRuntime<D, P>
where
    L: ActiveAttemptLeasePort,
    D: ActiveCallEventInboxPort + Send + Sync,
    P: ActiveCallEventProcessorPort + Send + Sync,
{
    async fn supervise_active_call(
        &self,
        context: &EnvelopeContext,
        lease: &L,
    ) -> Result<ActiveCallSessionSupervisorOutcome, WorkerError> {
        let adapter_context = AdapterContext::new(context.clone());
        let cycle = ActiveCallEventCycle::new(
            &self.client,
            self.inbox.as_ref(),
            self.processor.as_ref(),
            &adapter_context,
            &self.shutdown,
        );
        ActiveCallSessionSupervisor::new(&cycle, lease, self.config, &self.shutdown)
            .run()
            .await
    }
}

/// Owns exactly one Active Call event future and one lease heartbeat at a time.
pub struct ActiveCallSessionSupervisor<'a, E, L> {
    events: &'a E,
    lease: &'a L,
    config: ActiveCallSessionSupervisorConfig,
    shutdown: &'a ShutdownToken,
}

impl<'a, E, L> ActiveCallSessionSupervisor<'a, E, L> {
    #[must_use]
    pub const fn new(
        events: &'a E,
        lease: &'a L,
        config: ActiveCallSessionSupervisorConfig,
        shutdown: &'a ShutdownToken,
    ) -> Self {
        Self {
            events,
            lease,
            config,
            shutdown,
        }
    }
}

impl<E, L> ActiveCallSessionSupervisor<'_, E, L>
where
    E: ActiveCallEventCyclePort,
    L: ActiveAttemptLeasePort,
{
    /// Runs until the durable stream completes, requires reconciliation or the process drains.
    ///
    /// A reconnect never creates a detached task. The current lease is renewed before every
    /// bounded reconnect delay and periodically while the single event future remains pending.
    ///
    /// # Errors
    ///
    /// Returns the exact stable event-consumer or lease-renewal failure code.
    pub async fn run(&self) -> Result<ActiveCallSessionSupervisorOutcome, WorkerError> {
        loop {
            let cycle = self.events.consume_once();
            tokio::pin!(cycle);
            let outcome = loop {
                tokio::select! {
                    biased;
                    result = &mut cycle => {
                        break result.map_err(|error| WorkerError::new(error.code()))?;
                    }
                    () = self.shutdown.cancelled() => {
                        return Ok(ActiveCallSessionSupervisorOutcome::Draining);
                    }
                    () = sleep(self.config.renew_interval) => {
                        self.lease.renew_active_lease().await?;
                    }
                }
            };
            match outcome {
                ActiveCallEventConsumerOutcome::Completed { .. } => {
                    return Ok(ActiveCallSessionSupervisorOutcome::Completed);
                }
                ActiveCallEventConsumerOutcome::Draining { .. } => {
                    return Ok(ActiveCallSessionSupervisorOutcome::Draining);
                }
                ActiveCallEventConsumerOutcome::ReconcileRequired { reason, .. } => {
                    return Ok(ActiveCallSessionSupervisorOutcome::ReconcileRequired { reason });
                }
                ActiveCallEventConsumerOutcome::Reconnect { .. } => {
                    self.lease.renew_active_lease().await?;
                    tokio::select! {
                        () = self.shutdown.cancelled() => {
                            return Ok(ActiveCallSessionSupervisorOutcome::Draining);
                        }
                        () = sleep(self.config.reconnect_delay) => {}
                    }
                }
            }
        }
    }
}
