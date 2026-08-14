use std::{env, fmt, io, io::Write, process, time::Duration};

use converact_migration_store::{PostgresRouteStore, StoreConfig, StoreError};
use converact_migration_tool::{
    CliError, LocalDatabaseSettings, parse_invocation, read_request_file, unknown_apply_outcome,
};
use converact_migration_tooling::{
    ExecutionError, ExecutionMode, MigrationRequest, ValidationError, execute,
};
use serde_json::{Value, json};
use tokio::{task::JoinHandle, time::timeout};
use tokio_postgres::{Error as PostgresError, NoTls};

const LEASE_TTL_MS: u64 = 30_000;
const ROLLBACK_WINDOW_MS: u64 = 604_800_000;
const CONNECT_DEADLINE: Duration = Duration::from_secs(5);
const SESSION_SETUP_DEADLINE: Duration = Duration::from_secs(2);
const EXECUTION_DEADLINE: Duration = Duration::from_secs(6);
const CONNECTION_SHUTDOWN_DEADLINE: Duration = Duration::from_secs(2);
const SESSION_BOUNDS_SQL: &str = concat!(
    "SET lock_timeout = '2000ms';",
    "SET statement_timeout = '4000ms';",
    "SET idle_in_transaction_session_timeout = '5000ms';"
);

#[derive(Debug)]
enum ProcessError {
    Cli(CliError),
    Request(ValidationError),
    Execution(ExecutionError),
    Unknown(Value),
}

impl fmt::Display for ProcessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cli(error) => error.fmt(formatter),
            Self::Request(error) => error.fmt(formatter),
            Self::Execution(error) => error.fmt(formatter),
            Self::Unknown(_) => formatter.write_str("authority_migration_outcome_unknown"),
        }
    }
}

impl From<CliError> for ProcessError {
    fn from(value: CliError) -> Self {
        Self::Cli(value)
    }
}

#[tokio::main]
async fn main() {
    match run().await {
        Ok(document) => {
            if write_document(io::stdout().lock(), &document).is_err() {
                process::exit(1);
            }
        }
        Err(ProcessError::Unknown(document)) => {
            let _ = write_document(io::stderr().lock(), &document);
            process::exit(2);
        }
        Err(error) => {
            let document = json!({
                "schema_version": 1,
                "status": "failed",
                "mutation_performed": false,
                "error_code": error.to_string()
            });
            let _ = write_document(io::stderr().lock(), &document);
            process::exit(1);
        }
    }
}

async fn run() -> Result<Value, ProcessError> {
    let invocation = parse_invocation(env::args_os().skip(1))?;
    let document = read_request_file(invocation.request_path())?;
    let request = MigrationRequest::from_json(&document).map_err(ProcessError::Request)?;
    let request = invocation
        .prepare_request(request)
        .map_err(ProcessError::Request)?;
    let store = PostgresRouteStore::new(
        StoreConfig::new(LEASE_TTL_MS, ROLLBACK_WINDOW_MS)
            .map_err(|_| CliError::StoreConfigInvalid)?,
    );
    let settings = LocalDatabaseSettings::from_environment()?;
    let (mut client, connection) =
        timeout(CONNECT_DEADLINE, settings.postgres_config().connect(NoTls))
            .await
            .map_err(|_| CliError::DatabaseConnectionFailed)?
            .map_err(|_| CliError::DatabaseConnectionFailed)?;
    let connection_task = tokio::spawn(connection);
    let session_ready = timeout(
        SESSION_SETUP_DEADLINE,
        client.batch_execute(SESSION_BOUNDS_SQL),
    )
    .await;
    if !matches!(session_ready, Ok(Ok(()))) {
        drop(client);
        abort_connection(connection_task).await;
        return Err(CliError::DatabaseSessionFailed.into());
    }
    let is_apply = request.execution() == ExecutionMode::Apply;
    let execution = timeout(EXECUTION_DEADLINE, execute(&store, &mut client, &request)).await;
    match execution {
        Ok(Ok(outcome)) => {
            drop(client);
            close_connection(connection_task).await;
            Ok(outcome.payload().clone())
        }
        Ok(Err(error)) => {
            drop(client);
            close_connection(connection_task).await;
            if is_apply && matches!(error, ExecutionError::Store(StoreError::Database(_))) {
                return Err(ProcessError::Unknown(
                    unknown_apply_outcome(&request).map_err(ProcessError::Request)?,
                ));
            }
            Err(ProcessError::Execution(error))
        }
        Err(_) => {
            drop(client);
            abort_connection(connection_task).await;
            if is_apply {
                return Err(ProcessError::Unknown(
                    unknown_apply_outcome(&request).map_err(ProcessError::Request)?,
                ));
            }
            Err(CliError::ExecutionTimedOut.into())
        }
    }
}

async fn close_connection(mut task: JoinHandle<Result<(), PostgresError>>) {
    if timeout(CONNECTION_SHUTDOWN_DEADLINE, &mut task)
        .await
        .is_err()
    {
        task.abort();
        let _ = task.await;
    }
}

async fn abort_connection(task: JoinHandle<Result<(), PostgresError>>) {
    task.abort();
    let _ = timeout(CONNECTION_SHUTDOWN_DEADLINE, task).await;
}

fn write_document(mut writer: impl Write, document: &Value) -> Result<(), CliError> {
    serde_json::to_writer(&mut writer, document).map_err(|_| CliError::OutputFailed)?;
    writer.write_all(b"\n").map_err(|_| CliError::OutputFailed)
}
