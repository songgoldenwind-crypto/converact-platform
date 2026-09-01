use std::{
    error::Error,
    fmt,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use tokio::sync::{Semaphore, SemaphorePermit};

use crate::{
    AcousticEmotionClassifierOutput, AcousticEmotionClassifierPort,
    AcousticEmotionClassifierPortError, AcousticEmotionClassifierRequest,
    ContextualIntentClassifierOutput, ContextualIntentClassifierPort,
    ContextualIntentClassifierPortError, ContextualIntentClassifierRequest,
    FastIntentClassifierOutput, FastIntentClassifierPort, FastIntentClassifierPortError,
    FastIntentClassifierRequest, TextEmotionClassifierOutput, TextEmotionClassifierPort,
    TextEmotionClassifierPortError, TextEmotionClassifierRequest,
};

const MAX_ENDPOINTS: usize = 64;
const MAX_IN_FLIGHT: usize = 4_096;
const MAX_WAITERS: usize = 8_192;
const MAX_QUEUE_DEADLINE_MS: u64 = 30_000;

/// Bounded admission policy for one immutable model endpoint set.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ModelProviderPoolConfig {
    max_in_flight: usize,
    max_waiters: usize,
    queue_deadline_ms: u64,
}

impl ModelProviderPoolConfig {
    /// Builds a fixed-size request admission policy.
    ///
    /// # Errors
    ///
    /// Rejects zero or excessive concurrency, excessive waiters and invalid queue deadlines.
    pub const fn try_new(
        max_in_flight: usize,
        max_waiters: usize,
        queue_deadline_ms: u64,
    ) -> Result<Self, ModelProviderPoolError> {
        if max_in_flight == 0
            || max_in_flight > MAX_IN_FLIGHT
            || max_waiters > MAX_WAITERS
            || queue_deadline_ms == 0
            || queue_deadline_ms > MAX_QUEUE_DEADLINE_MS
            || max_in_flight.checked_add(max_waiters).is_none()
        {
            return Err(ModelProviderPoolError::InvalidConfiguration);
        }
        Ok(Self {
            max_in_flight,
            max_waiters,
            queue_deadline_ms,
        })
    }
}

/// Stable model-pool failure without endpoint, model or customer data.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModelProviderPoolError {
    InvalidConfiguration,
    Saturated,
    QueueTimedOut,
    Closed,
}

impl ModelProviderPoolError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidConfiguration => "model_provider_pool_configuration_invalid",
            Self::Saturated => "model_provider_pool_saturated",
            Self::QueueTimedOut => "model_provider_pool_queue_timed_out",
            Self::Closed => "model_provider_pool_closed",
        }
    }
}

impl fmt::Display for ModelProviderPoolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ModelProviderPoolError {}

/// Immutable endpoint set with O(1) round-robin selection and bounded request admission.
pub struct ModelProviderPool<P> {
    providers: Box<[P]>,
    admission: Semaphore,
    execution: Semaphore,
    next_provider: AtomicUsize,
    queue_deadline: Duration,
}

impl<P> ModelProviderPool<P> {
    /// Creates one pool. Provider values are opaque transport/native inference handles.
    ///
    /// # Errors
    ///
    /// Rejects empty or oversized endpoint sets and invalid capacity arithmetic.
    pub fn try_new(
        providers: Vec<P>,
        config: ModelProviderPoolConfig,
    ) -> Result<Self, ModelProviderPoolError> {
        if providers.is_empty() || providers.len() > MAX_ENDPOINTS {
            return Err(ModelProviderPoolError::InvalidConfiguration);
        }
        let admission_capacity = config
            .max_in_flight
            .checked_add(config.max_waiters)
            .ok_or(ModelProviderPoolError::InvalidConfiguration)?;
        Ok(Self {
            providers: providers.into(),
            admission: Semaphore::new(admission_capacity),
            execution: Semaphore::new(config.max_in_flight),
            next_provider: AtomicUsize::new(0),
            queue_deadline: Duration::from_millis(config.queue_deadline_ms),
        })
    }

    /// Acquires one bounded execution slot and selects an endpoint in O(1).
    ///
    /// # Errors
    ///
    /// Rejects immediately when active plus waiting capacity is full, and expires queued requests
    /// at the configured deadline. No task is spawned by this operation.
    pub async fn acquire(&self) -> Result<ModelProviderLease<'_, P>, ModelProviderPoolError> {
        let admission = self
            .admission
            .try_acquire()
            .map_err(|_| ModelProviderPoolError::Saturated)?;
        let execution = tokio::time::timeout(self.queue_deadline, self.execution.acquire())
            .await
            .map_err(|_| ModelProviderPoolError::QueueTimedOut)?
            .map_err(|_| ModelProviderPoolError::Closed)?;
        let provider_index =
            self.next_provider.fetch_add(1, Ordering::Relaxed) % self.providers.len();
        Ok(ModelProviderLease {
            provider: &self.providers[provider_index],
            provider_index,
            _admission: admission,
            _execution: execution,
        })
    }
}

impl<P> fmt::Debug for ModelProviderPool<P> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelProviderPool")
            .field("provider_count", &self.providers.len())
            .field("admission_available", &self.admission.available_permits())
            .field("execution_available", &self.execution.available_permits())
            .field("queue_deadline", &self.queue_deadline)
            .finish_non_exhaustive()
    }
}

/// Borrowed endpoint lease that releases both capacity permits on drop.
pub struct ModelProviderLease<'a, P> {
    provider: &'a P,
    provider_index: usize,
    _admission: SemaphorePermit<'a>,
    _execution: SemaphorePermit<'a>,
}

impl<P> ModelProviderLease<'_, P> {
    #[must_use]
    pub const fn provider(&self) -> &P {
        self.provider
    }
}

impl<P> fmt::Debug for ModelProviderLease<'_, P> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelProviderLease")
            .field("provider_index", &self.provider_index)
            .finish_non_exhaustive()
    }
}

/// Applies one shared bounded pool to any supported model-specific Provider port.
pub struct PooledModelProviderPort<P> {
    pool: Arc<ModelProviderPool<P>>,
}

impl<P> PooledModelProviderPort<P> {
    #[must_use]
    pub const fn new(pool: Arc<ModelProviderPool<P>>) -> Self {
        Self { pool }
    }
}

impl<P> Clone for PooledModelProviderPort<P> {
    fn clone(&self) -> Self {
        Self {
            pool: Arc::clone(&self.pool),
        }
    }
}

impl<P> fmt::Debug for PooledModelProviderPort<P> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PooledModelProviderPort")
            .field("pool", &self.pool)
            .finish()
    }
}

impl<P> TextEmotionClassifierPort for PooledModelProviderPort<P>
where
    P: TextEmotionClassifierPort + Send,
{
    async fn classify<'a>(
        &'a self,
        request: TextEmotionClassifierRequest<'a>,
    ) -> Result<TextEmotionClassifierOutput, TextEmotionClassifierPortError> {
        let lease = self
            .pool
            .acquire()
            .await
            .map_err(|error| TextEmotionClassifierPortError::new(error.code()))?;
        lease.provider().classify(request).await
    }
}

impl<P> AcousticEmotionClassifierPort for PooledModelProviderPort<P>
where
    P: AcousticEmotionClassifierPort + Send,
{
    async fn classify<'a>(
        &'a self,
        request: AcousticEmotionClassifierRequest<'a>,
    ) -> Result<AcousticEmotionClassifierOutput, AcousticEmotionClassifierPortError> {
        let lease = self
            .pool
            .acquire()
            .await
            .map_err(|error| AcousticEmotionClassifierPortError::new(error.code()))?;
        lease.provider().classify(request).await
    }
}

impl<P> FastIntentClassifierPort for PooledModelProviderPort<P>
where
    P: FastIntentClassifierPort + Send,
{
    async fn classify<'a>(
        &'a self,
        request: FastIntentClassifierRequest<'a>,
    ) -> Result<FastIntentClassifierOutput, FastIntentClassifierPortError> {
        let lease = self
            .pool
            .acquire()
            .await
            .map_err(|error| FastIntentClassifierPortError::new(error.code()))?;
        lease.provider().classify(request).await
    }
}

impl<P> ContextualIntentClassifierPort for PooledModelProviderPort<P>
where
    P: ContextualIntentClassifierPort + Send,
{
    async fn classify<'a>(
        &'a self,
        request: ContextualIntentClassifierRequest<'a>,
    ) -> Result<ContextualIntentClassifierOutput, ContextualIntentClassifierPortError> {
        let lease = self
            .pool
            .acquire()
            .await
            .map_err(|error| ContextualIntentClassifierPortError::new(error.code()))?;
        lease.provider().classify(request).await
    }
}
