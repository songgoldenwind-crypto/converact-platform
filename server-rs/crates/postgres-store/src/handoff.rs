use std::{error::Error, fmt, sync::Arc};

use converact_agent_handoff_core::HandoffSession;
use converact_agent_handoff_store::{
    HandoffCommandResolution, HandoffCreateDecision, HandoffPrepareDecision, HandoffSqlStore,
    HandoffStoreCommand, HandoffStoreError, HandoffTransitionWrite,
};
use converact_kernel_ids::TenantId;

use crate::{PostgresRuntime, TransactionError};

/// Initial aggregate persistence outcome.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PostgresHandoffCreateDecision {
    Created,
    Replayed,
}

/// Durable effect-oracle decision with no database types exposed to the application.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PostgresHandoffPrepareDecision {
    Execute,
    Query,
    ReplayApplied,
    ReplayNotApplied,
    Conflict,
    StaleFence,
}

/// Sanitized tenant-transaction or Handoff Store failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PostgresHandoffStoreError {
    code: &'static str,
}

impl PostgresHandoffStoreError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for PostgresHandoffStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for PostgresHandoffStoreError {}

/// Tenant-scoped durable adapter for Handoff commands and immutable receipts.
pub struct PostgresHandoffStore {
    runtime: Arc<PostgresRuntime>,
    sql: HandoffSqlStore,
}

impl PostgresHandoffStore {
    #[must_use]
    pub const fn new(runtime: Arc<PostgresRuntime>, sql: HandoffSqlStore) -> Self {
        Self { runtime, sql }
    }

    /// Creates or exactly replays the requested Handoff in one tenant transaction.
    ///
    /// # Errors
    ///
    /// Returns only sanitized tenant, Store or transaction failure categories.
    pub async fn create_requested(
        &self,
        requested: &HandoffSession,
        command: &HandoffStoreCommand,
    ) -> Result<PostgresHandoffCreateDecision, PostgresHandoffStoreError> {
        let tenant = tenant(requested)?;
        let requested = requested.clone();
        let command = command.clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    sql.create_requested(transaction, &requested, &command)
                        .await
                })
            })
            .await
            .map(|decision| map_create_decision(&decision))
            .map_err(map_transaction_error)
    }

    /// Reserves one transition or classifies its exact replay before any external effect.
    ///
    /// # Errors
    ///
    /// Returns only sanitized tenant, Store or transaction failure categories.
    pub async fn prepare_transition(
        &self,
        write: &HandoffTransitionWrite<'_>,
    ) -> Result<PostgresHandoffPrepareDecision, PostgresHandoffStoreError> {
        let tenant = tenant(write.current())?;
        let command = write.command().clone();
        let current = write.current().clone();
        let next = write.next().clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    let write = HandoffTransitionWrite::try_new(command, &current, &next)?;
                    sql.prepare_transition(transaction, &write).await
                })
            })
            .await
            .and_then(map_prepare_decision)
            .map_err(map_transaction_error)
    }

    /// Applies the already prepared transition under its exact revision/generation fence.
    ///
    /// # Errors
    ///
    /// Returns only sanitized tenant, Store or transaction failure categories.
    pub async fn finalize_applied(
        &self,
        write: &HandoffTransitionWrite<'_>,
    ) -> Result<(), PostgresHandoffStoreError> {
        let tenant = tenant(write.current())?;
        let command = write.command().clone();
        let current = write.current().clone();
        let next = write.next().clone();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    let write = HandoffTransitionWrite::try_new(command, &current, &next)?;
                    sql.finalize_transition(transaction, &write).await.map(drop)
                })
            })
            .await
            .map_err(map_transaction_error)
    }

    /// Records a definitive non-applied external effect without advancing the aggregate.
    ///
    /// # Errors
    ///
    /// Returns only sanitized tenant, Store or transaction failure categories.
    pub async fn finalize_not_applied(
        &self,
        current: &HandoffSession,
        command: &HandoffStoreCommand,
        failure_code: &str,
    ) -> Result<(), PostgresHandoffStoreError> {
        let tenant = tenant(current)?;
        let current = current.clone();
        let command = command.clone();
        let failure_code = failure_code.to_owned();
        let sql = self.sql;
        self.runtime
            .with_tenant_transaction(&tenant, move |transaction| {
                Box::pin(async move {
                    sql.finalize_not_applied(transaction, &current, &command, &failure_code)
                        .await
                        .map(drop)
                })
            })
            .await
            .map_err(map_transaction_error)
    }
}

impl fmt::Debug for PostgresHandoffStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PostgresHandoffStore")
            .finish_non_exhaustive()
    }
}

fn tenant(handoff: &HandoffSession) -> Result<TenantId, PostgresHandoffStoreError> {
    TenantId::parse(handoff.context().tenant_id()).map_err(|_| PostgresHandoffStoreError {
        code: "agent_handoff_store_tenant_invalid",
    })
}

const fn map_create_decision(decision: &HandoffCreateDecision) -> PostgresHandoffCreateDecision {
    match decision {
        HandoffCreateDecision::Created(_) => PostgresHandoffCreateDecision::Created,
        HandoffCreateDecision::Replay(_) => PostgresHandoffCreateDecision::Replayed,
    }
}

fn map_prepare_decision(
    decision: HandoffPrepareDecision,
) -> Result<PostgresHandoffPrepareDecision, TransactionError<HandoffStoreError>> {
    match decision {
        HandoffPrepareDecision::Prepared(_) => Ok(PostgresHandoffPrepareDecision::Execute),
        HandoffPrepareDecision::ReconcileRequired => Ok(PostgresHandoffPrepareDecision::Query),
        HandoffPrepareDecision::Replay(receipt) => match receipt.resolution() {
            Some(HandoffCommandResolution::Applied) => {
                Ok(PostgresHandoffPrepareDecision::ReplayApplied)
            }
            Some(HandoffCommandResolution::NotApplied) => {
                Ok(PostgresHandoffPrepareDecision::ReplayNotApplied)
            }
            None => Err(TransactionError::Work(HandoffStoreError::StoredRowInvalid)),
        },
        HandoffPrepareDecision::Conflict => Ok(PostgresHandoffPrepareDecision::Conflict),
        HandoffPrepareDecision::StaleFence => Ok(PostgresHandoffPrepareDecision::StaleFence),
    }
}

#[allow(clippy::needless_pass_by_value)]
fn map_transaction_error(error: TransactionError<HandoffStoreError>) -> PostgresHandoffStoreError {
    let code = match error {
        TransactionError::Work(error) => error.code(),
        TransactionError::AdmissionRejected => "agent_handoff_store_admission_rejected",
        TransactionError::PoolUnavailable
        | TransactionError::DatabaseUnavailable
        | TransactionError::DeadlineExceeded
        | TransactionError::RollbackUnknown
        | TransactionError::CommitUnknown => "agent_handoff_store_unavailable",
    };
    PostgresHandoffStoreError { code }
}
