//! Converact platform API process boundary.

pub mod http;

use std::{
    error::Error,
    fmt,
    future::{Future, IntoFuture},
    io,
    time::Duration,
};

use axum::Router;
use converact_runtime_health::{HealthTaskGroup, TaskShutdown};
use tokio::{net::TcpListener, sync::oneshot, time::timeout};

/// A bounded server lifecycle failure.
#[derive(Debug)]
pub enum ServeError {
    /// The listener or HTTP server failed.
    Io(io::Error),
    /// In-flight work did not finish before the configured deadline.
    ShutdownDeadlineExceeded,
}

impl fmt::Display for ServeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Io(_) => "runtime_server_io_failed",
            Self::ShutdownDeadlineExceeded => "runtime_shutdown_deadline_exceeded",
        })
    }
}

impl Error for ServeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::ShutdownDeadlineExceeded => None,
        }
    }
}

/// Serves one router and cancels in-flight work at the shutdown deadline.
///
/// # Errors
///
/// Returns [`ServeError::Io`] for listener failures and
/// [`ServeError::ShutdownDeadlineExceeded`] if graceful draining exceeds the
/// configured deadline.
pub async fn serve<F>(
    listener: TcpListener,
    app: Router,
    shutdown: F,
    shutdown_timeout: Duration,
) -> Result<(), ServeError>
where
    F: Future<Output = ()> + Send,
{
    let (drain_tx, drain_rx) = oneshot::channel();
    let server = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = drain_rx.await;
        })
        .into_future();
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => return result.map_err(ServeError::Io),
        () = shutdown => {}
    }
    let _ = drain_tx.send(());
    match timeout(shutdown_timeout, &mut server).await {
        Ok(result) => result.map_err(ServeError::Io),
        Err(_) => Err(ServeError::ShutdownDeadlineExceeded),
    }
}

/// Serves HTTP and owns every bounded runtime child under one shutdown deadline.
///
/// # Errors
///
/// Returns [`ServeError::Io`] for listener failures and
/// [`ServeError::ShutdownDeadlineExceeded`] if HTTP draining exceeds the
/// configured deadline. Child tasks are always signalled, aborted at the same
/// deadline if necessary, and fully joined before return.
pub async fn serve_runtime<F>(
    listener: TcpListener,
    app: Router,
    mut tasks: HealthTaskGroup,
    shutdown: F,
    shutdown_timeout: Duration,
) -> Result<TaskShutdown, ServeError>
where
    F: Future<Output = ()> + Send,
{
    let (drain_tx, drain_rx) = oneshot::channel();
    let server = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = drain_rx.await;
        })
        .into_future();
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => {
            let task_outcome = tasks.shutdown(Duration::ZERO).await;
            return result.map(|()| task_outcome).map_err(ServeError::Io);
        },
        () = shutdown => {}
    }
    let _ = drain_tx.send(());
    let (server_result, task_outcome) = tokio::join!(
        async {
            match timeout(shutdown_timeout, &mut server).await {
                Ok(result) => result.map_err(ServeError::Io),
                Err(_) => Err(ServeError::ShutdownDeadlineExceeded),
            }
        },
        tasks.shutdown(shutdown_timeout),
    );
    server_result?;
    Ok(task_outcome)
}
