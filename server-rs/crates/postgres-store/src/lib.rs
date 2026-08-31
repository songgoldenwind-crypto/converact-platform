//! Bounded tenant-scoped `PostgreSQL` runtime foundation.

#![forbid(unsafe_code)]

use std::{error::Error, fmt, time::Duration};

use deadpool_postgres::{
    Manager, ManagerConfig, Pool, RecyclingMethod, Runtime,
    tokio_postgres::{Config as PgConfig, Socket, tls::MakeTlsConnect},
};

mod conversation_result;
mod handoff;
mod tool_action;

pub use conversation_result::{
    PostgresConversationResultStore, PostgresConversationResultStoreError,
    PostgresProjectionWriteDecision, PostgresTranscriptAppendDecision,
};
pub use handoff::{
    PostgresHandoffCreateDecision, PostgresHandoffPrepareDecision, PostgresHandoffStore,
    PostgresHandoffStoreError,
};
pub use tool_action::PostgresToolActionStore;

const MAX_CONNECTIONS: usize = 256;
const MAX_WAITERS: usize = 1_024;
const MAX_POOL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_STATEMENT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_TRANSACTION_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_ROLLBACK_TIMEOUT: Duration = Duration::from_secs(5);

/// Untrusted numeric limits before cross-field validation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PostgresRuntimeLimits {
    pub max_connections: usize,
    pub max_waiters: usize,
    pub pool_wait_timeout: Duration,
    pub connect_timeout: Duration,
    pub recycle_timeout: Duration,
    pub statement_timeout: Duration,
    pub lock_timeout: Duration,
    pub transaction_timeout: Duration,
    pub rollback_timeout: Duration,
}

/// Stable limit validation failure without connection details.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettingsError {
    InvalidMaxConnections,
    InvalidMaxWaiters,
    InvalidTimeout,
}

impl fmt::Display for SettingsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidMaxConnections => "postgres_max_connections_invalid",
            Self::InvalidMaxWaiters => "postgres_max_waiters_invalid",
            Self::InvalidTimeout => "postgres_timeout_invalid",
        })
    }
}

impl Error for SettingsError {}

/// Validated bounded limits shared by the pool and every tenant transaction.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PostgresRuntimeSettings(PostgresRuntimeLimits);

impl PostgresRuntimeSettings {
    /// Validates pool, statement, lock, transaction and rollback deadlines.
    ///
    /// # Errors
    ///
    /// Returns a stable error when a limit is zero, oversized or ordered in a
    /// way that lets an inner operation outlive its containing transaction.
    pub fn new(limits: PostgresRuntimeLimits) -> Result<Self, SettingsError> {
        if !(1..=MAX_CONNECTIONS).contains(&limits.max_connections) {
            return Err(SettingsError::InvalidMaxConnections);
        }
        if limits.max_waiters > MAX_WAITERS {
            return Err(SettingsError::InvalidMaxWaiters);
        }
        let pool_timeouts = [
            limits.pool_wait_timeout,
            limits.connect_timeout,
            limits.recycle_timeout,
        ];
        if pool_timeouts
            .iter()
            .any(|timeout| !valid_duration(*timeout, MAX_POOL_TIMEOUT))
            || !valid_duration(limits.statement_timeout, MAX_STATEMENT_TIMEOUT)
            || !valid_duration(limits.lock_timeout, MAX_STATEMENT_TIMEOUT)
            || limits.lock_timeout > limits.statement_timeout
            || limits.transaction_timeout <= limits.statement_timeout
            || !valid_duration(limits.transaction_timeout, MAX_TRANSACTION_TIMEOUT)
            || !valid_duration(limits.rollback_timeout, MAX_ROLLBACK_TIMEOUT)
            || limits.rollback_timeout > limits.transaction_timeout
        {
            return Err(SettingsError::InvalidTimeout);
        }
        Ok(Self(limits))
    }

    #[must_use]
    pub const fn max_connections(self) -> usize {
        self.0.max_connections
    }

    #[must_use]
    pub const fn max_waiters(self) -> usize {
        self.0.max_waiters
    }

    #[must_use]
    pub const fn pool_wait_timeout(self) -> Duration {
        self.0.pool_wait_timeout
    }

    #[must_use]
    pub const fn connect_timeout(self) -> Duration {
        self.0.connect_timeout
    }

    #[must_use]
    pub const fn recycle_timeout(self) -> Duration {
        self.0.recycle_timeout
    }

    #[must_use]
    pub const fn statement_timeout(self) -> Duration {
        self.0.statement_timeout
    }

    #[must_use]
    pub const fn lock_timeout(self) -> Duration {
        self.0.lock_timeout
    }

    #[must_use]
    pub const fn transaction_timeout(self) -> Duration {
        self.0.transaction_timeout
    }

    #[must_use]
    pub const fn rollback_timeout(self) -> Duration {
        self.0.rollback_timeout
    }
}

fn valid_duration(value: Duration, maximum: Duration) -> bool {
    !value.is_zero() && value <= maximum && value.subsec_nanos().is_multiple_of(1_000_000)
}

/// Stable pool construction failure without credentials or endpoints.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PoolBuildError;

impl fmt::Display for PoolBuildError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("postgres_pool_build_failed")
    }
}

impl Error for PoolBuildError {}

/// Low-cardinality, eventually consistent pool status.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PoolStatus {
    pub max_connections: usize,
    pub connections: usize,
    pub available: usize,
    pub waiting: usize,
}

/// Bounded pool owner. Construction is inert and opens no connection.
///
/// Raw transactions are intentionally unavailable outside this adapter:
///
/// ```compile_fail
/// use converact_kernel_ids::TenantId;
/// use converact_postgres_store::PostgresRuntime;
///
/// async fn bypass(runtime: &PostgresRuntime, tenant: &TenantId) {
///     let _ = runtime
///         .with_tenant_transaction::<(), (), _>(tenant, |transaction| {
///             Box::pin(async move {
///                 transaction.batch_execute("COMMIT").await.map_err(|_| ())
///             })
///         })
///         .await;
/// }
/// ```
pub struct PostgresRuntime {
    pool: Pool,
    settings: PostgresRuntimeSettings,
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "used by the internal transaction runner before its first domain adapter"
        )
    )]
    admission: tokio::sync::Semaphore,
}

/// Stable transaction result categories. Database errors are intentionally
/// not exposed because they may contain topology or query details.
#[derive(Eq, PartialEq)]
pub enum TransactionError<E> {
    AdmissionRejected,
    PoolUnavailable,
    DatabaseUnavailable,
    Work(E),
    DeadlineExceeded,
    RollbackUnknown,
    CommitUnknown,
}

impl<E> fmt::Debug for TransactionError<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AdmissionRejected => "TransactionError::AdmissionRejected",
            Self::PoolUnavailable => "TransactionError::PoolUnavailable",
            Self::DatabaseUnavailable => "TransactionError::DatabaseUnavailable",
            Self::Work(_) => "TransactionError::Work([REDACTED])",
            Self::DeadlineExceeded => "TransactionError::DeadlineExceeded",
            Self::RollbackUnknown => "TransactionError::RollbackUnknown",
            Self::CommitUnknown => "TransactionError::CommitUnknown",
        })
    }
}

impl<E> fmt::Display for TransactionError<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AdmissionRejected => "postgres_admission_rejected",
            Self::PoolUnavailable => "postgres_pool_unavailable",
            Self::DatabaseUnavailable => "postgres_transaction_unavailable",
            Self::Work(_) => "postgres_transaction_work_failed",
            Self::DeadlineExceeded => "postgres_transaction_deadline_exceeded",
            Self::RollbackUnknown => "postgres_transaction_rollback_unknown",
            Self::CommitUnknown => "postgres_transaction_commit_unknown",
        })
    }
}

impl<E: Error + 'static> Error for TransactionError<E> {}

impl PostgresRuntime {
    /// Builds an inert fixed-capacity pool over the workspace's existing
    /// `tokio-postgres` driver.
    ///
    /// # Errors
    ///
    /// Returns one value-free error if the pool cannot be configured.
    pub fn build<T>(
        mut pg_config: PgConfig,
        tls: T,
        settings: PostgresRuntimeSettings,
    ) -> Result<Self, PoolBuildError>
    where
        T: MakeTlsConnect<Socket> + Clone + Sync + Send + 'static,
        T::Stream: Sync + Send,
        T::TlsConnect: Sync + Send,
        <T::TlsConnect as deadpool_postgres::tokio_postgres::tls::TlsConnect<Socket>>::Future: Send,
    {
        pg_config.connect_timeout(settings.connect_timeout());
        let manager = Manager::from_config(
            pg_config,
            tls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Clean,
            },
        );
        let pool = Pool::builder(manager)
            .max_size(settings.max_connections())
            .wait_timeout(Some(settings.pool_wait_timeout()))
            .create_timeout(Some(settings.connect_timeout()))
            .recycle_timeout(Some(settings.recycle_timeout()))
            .runtime(Runtime::Tokio1)
            .build()
            .map_err(|_| PoolBuildError)?;
        let admission =
            tokio::sync::Semaphore::new(settings.max_connections() + settings.max_waiters());
        Ok(Self {
            pool,
            settings,
            admission,
        })
    }

    /// Returns bounded pool counters for health/metrics only.
    #[must_use]
    pub fn status(&self) -> PoolStatus {
        let status = self.pool.status();
        PoolStatus {
            max_connections: status.max_size,
            connections: status.size,
            available: status.available,
            waiting: status.waiting,
        }
    }

    #[must_use]
    pub const fn pool_wait_timeout(&self) -> Duration {
        self.settings.pool_wait_timeout()
    }

    #[must_use]
    pub const fn connect_timeout(&self) -> Duration {
        self.settings.connect_timeout()
    }

    #[must_use]
    pub const fn recycle_timeout(&self) -> Duration {
        self.settings.recycle_timeout()
    }

    #[must_use]
    pub const fn max_waiters(&self) -> usize {
        self.settings.max_waiters()
    }
}

mod audit;
mod outbox_worker;
mod platform_event;
mod platform_outbox;
mod tenant_transaction;

pub use audit::{AuditAppendResult, AuditAppendStatus, AuditStoreError, AuditStoreFailure};
pub use outbox_worker::{
    OutboxDeliveryFinalizationApplyStatus, OutboxDeliveryFinalizationCommand,
    OutboxDeliveryFinalizationCommandError, OutboxDeliveryFinalizationReconcileStatus,
};
pub use platform_event::{
    DeliveryLeaseToken, DeliveryLeaseTokenError, EffectAppendStatus, InboxAppendStatus,
    PlatformStoreError, PlatformStorePolicy, PlatformStorePolicyError,
};
pub use platform_outbox::{
    OutboxClaim, OutboxClaimApplyDisposition, OutboxClaimBatch, OutboxClaimCommand,
    OutboxClaimCommandError, OutboxClaimReconcileStatus, OutboxEnqueueStatus, OutboxSnapshot,
    OutboxStatus, OutboxTransitionApplyStatus, OutboxTransitionCommand,
    OutboxTransitionCommandError, OutboxTransitionKind, OutboxTransitionReconcileStatus,
};

impl fmt::Debug for PostgresRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PostgresRuntime")
            .field("settings", &self.settings)
            .field("status", &self.status())
            .finish_non_exhaustive()
    }
}
