#![cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "private foundation consumed by the first R1 domain Store adapter"
    )
)]

use std::{future::Future, pin::Pin, time::Duration};

use deadpool_postgres::{Client, Transaction};

use super::{PostgresRuntime, PostgresRuntimeSettings, TransactionError};

/// Boxed adapter work tied to the exact transaction borrow.
///
/// This stays private: domain crates receive domain-specific Store ports, not
/// a `PostgreSQL` transaction capability.
type TenantTransactionFuture<'a, T, E> = Pin<Box<dyn Future<Output = Result<T, E>> + Send + 'a>>;

enum ClientDisposition<T, E> {
    Reuse(Result<T, TransactionError<E>>),
    Discard(TransactionError<E>),
}

/// A checked-out connection is unsafe to recycle until the complete
/// transaction lifecycle reaches a known commit or rollback outcome.
/// Cancellation drops this guard and physically closes the connection.
struct ClientLease {
    client: Option<Client>,
}

impl ClientLease {
    fn new(client: Client) -> Self {
        Self {
            client: Some(client),
        }
    }

    fn client(&mut self) -> &mut Client {
        self.client.as_mut().expect("client lease is present")
    }

    fn recycle(mut self) {
        drop(self.client.take());
    }
}

impl Drop for ClientLease {
    fn drop(&mut self) {
        if let Some(client) = self.client.take() {
            drop(Client::take(client));
        }
    }
}

impl PostgresRuntime {
    // This executor deliberately stays inside the PostgreSQL adapter crate.
    // Exposing `Transaction` would let an upper layer replace the authoritative
    // tenant GUC or issue transaction-control SQL. Public adapters must expose
    // only domain-specific Store methods and vendor-free domain ports.
    async fn with_tenant_transaction<T, E, F>(
        &self,
        tenant_id: &converact_kernel_ids::TenantId,
        work: F,
    ) -> Result<T, TransactionError<E>>
    where
        T: Send,
        E: Send,
        F: for<'a> FnOnce(&'a Transaction<'a>) -> TenantTransactionFuture<'a, T, E>,
    {
        let _admission = self
            .admission
            .try_acquire()
            .map_err(|_| TransactionError::AdmissionRejected)?;
        let client = self
            .pool
            .get()
            .await
            .map_err(|_| TransactionError::PoolUnavailable)?;
        let mut lease = ClientLease::new(client);
        match run_transaction_lifecycle(lease.client(), tenant_id, self.settings, work).await {
            ClientDisposition::Reuse(result) => {
                lease.recycle();
                result
            }
            ClientDisposition::Discard(error) => Err(error),
        }
    }
}

async fn run_transaction_lifecycle<T, E, F>(
    client: &mut Client,
    tenant_id: &converact_kernel_ids::TenantId,
    settings: PostgresRuntimeSettings,
    work: F,
) -> ClientDisposition<T, E>
where
    T: Send,
    E: Send,
    F: for<'a> FnOnce(&'a Transaction<'a>) -> TenantTransactionFuture<'a, T, E>,
{
    let deadline = tokio::time::Instant::now() + settings.transaction_timeout();
    let Some(Ok(transaction)) = run_before(deadline, client.transaction()).await else {
        return ClientDisposition::Discard(TransactionError::DatabaseUnavailable);
    };

    if run_before(
        deadline,
        bootstrap_transaction(&transaction, tenant_id, settings),
    )
    .await
    .is_none_or(|result| result.is_err())
    {
        return after_rollback(
            transaction,
            settings.rollback_timeout(),
            TransactionError::DatabaseUnavailable,
        )
        .await;
    }

    let value = match run_before(deadline, work(&transaction)).await {
        Some(Ok(value)) => value,
        Some(Err(error)) => {
            return after_rollback(
                transaction,
                settings.rollback_timeout(),
                TransactionError::Work(error),
            )
            .await;
        }
        None => {
            return after_rollback(
                transaction,
                settings.rollback_timeout(),
                TransactionError::DeadlineExceeded,
            )
            .await;
        }
    };

    let Some(remaining) = deadline.checked_duration_since(tokio::time::Instant::now()) else {
        return after_rollback(
            transaction,
            settings.rollback_timeout(),
            TransactionError::DeadlineExceeded,
        )
        .await;
    };
    match tokio::time::timeout(remaining, transaction.commit()).await {
        Ok(Ok(())) => ClientDisposition::Reuse(Ok(value)),
        Ok(Err(_)) | Err(_) => ClientDisposition::Discard(TransactionError::CommitUnknown),
    }
}

async fn after_rollback<T, E>(
    transaction: Transaction<'_>,
    timeout: Duration,
    error: TransactionError<E>,
) -> ClientDisposition<T, E> {
    if rollback_transaction(transaction, timeout).await {
        ClientDisposition::Reuse(Err(error))
    } else {
        ClientDisposition::Discard(TransactionError::RollbackUnknown)
    }
}

async fn bootstrap_transaction(
    transaction: &Transaction<'_>,
    tenant_id: &converact_kernel_ids::TenantId,
    settings: PostgresRuntimeSettings,
) -> Result<(), deadpool_postgres::tokio_postgres::Error> {
    transaction
        .batch_execute("SET LOCAL search_path = pg_catalog, public, pg_temp")
        .await?;
    transaction
        .query_one(
            "SELECT pg_catalog.set_config('app.current_tenant', $1, true)",
            &[&tenant_id.as_str()],
        )
        .await?;
    let statement_timeout = milliseconds_setting(settings.statement_timeout());
    transaction
        .query_one(
            "SELECT pg_catalog.set_config('statement_timeout', $1, true)",
            &[&statement_timeout],
        )
        .await?;
    let lock_timeout = milliseconds_setting(settings.lock_timeout());
    transaction
        .query_one(
            "SELECT pg_catalog.set_config('lock_timeout', $1, true)",
            &[&lock_timeout],
        )
        .await?;
    Ok(())
}

fn milliseconds_setting(duration: Duration) -> String {
    format!("{}ms", duration.as_millis())
}

async fn run_before<T>(
    deadline: tokio::time::Instant,
    future: impl Future<Output = T>,
) -> Option<T> {
    let remaining = deadline.checked_duration_since(tokio::time::Instant::now())?;
    tokio::time::timeout(remaining, future).await.ok()
}

async fn rollback_transaction(transaction: Transaction<'_>, timeout: Duration) -> bool {
    match tokio::time::timeout(timeout, transaction.rollback()).await {
        Ok(Ok(())) => true,
        Ok(Err(_)) | Err(_) => false,
    }
}

#[cfg(test)]
#[path = "physical_tests.rs"]
mod physical_tests;
