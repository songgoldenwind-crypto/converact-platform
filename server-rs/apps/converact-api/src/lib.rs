//! Converact platform API process boundary.

pub mod http;

use std::{
    convert::Infallible,
    error::Error,
    fmt,
    future::{Future, IntoFuture},
    io,
    time::Duration,
};

use axum::{
    Router,
    extract::Request,
    response::Response,
    serve::{IncomingStream, Listener},
};
use converact_runtime_health::{HealthTaskGroup, TaskShutdown};
use tokio::{net::TcpListener, sync::oneshot, time::timeout};
use tower::Service;

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
    serve_with_listener(listener, app, shutdown, shutdown_timeout).await
}

/// Serves one make-service through any Axum listener and one drain deadline.
///
/// # Errors
///
/// Returns [`ServeError::Io`] for listener failures and
/// [`ServeError::ShutdownDeadlineExceeded`] if graceful draining exceeds the
/// configured deadline.
pub async fn serve_with_listener<L, M, S, F>(
    listener: L,
    make_service: M,
    shutdown: F,
    shutdown_timeout: Duration,
) -> Result<(), ServeError>
where
    L: Listener,
    L::Addr: fmt::Debug,
    M: for<'a> Service<IncomingStream<'a, L>, Error = Infallible, Response = S> + Send + 'static,
    for<'a> <M as Service<IncomingStream<'a, L>>>::Future: Send,
    S: Service<Request, Response = Response, Error = Infallible> + Clone + Send + 'static,
    S::Future: Send,
    F: Future<Output = ()> + Send,
{
    let (drain_tx, drain_rx) = oneshot::channel();
    let server = axum::serve(listener, make_service)
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
    tasks: HealthTaskGroup,
    shutdown: F,
    shutdown_timeout: Duration,
) -> Result<TaskShutdown, ServeError>
where
    F: Future<Output = ()> + Send,
{
    serve_with_listener_runtime(listener, app, tasks, shutdown, shutdown_timeout).await
}

/// Serves any Axum listener and owns bounded runtime children under one
/// shutdown deadline.
///
/// # Errors
///
/// Returns [`ServeError::Io`] for listener failures and
/// [`ServeError::ShutdownDeadlineExceeded`] if graceful draining exceeds the
/// configured deadline. Child tasks are always signalled, aborted at the same
/// deadline if necessary, and fully joined before return.
pub async fn serve_with_listener_runtime<L, M, S, F>(
    listener: L,
    make_service: M,
    mut tasks: HealthTaskGroup,
    shutdown: F,
    shutdown_timeout: Duration,
) -> Result<TaskShutdown, ServeError>
where
    L: Listener,
    L::Addr: fmt::Debug,
    M: for<'a> Service<IncomingStream<'a, L>, Error = Infallible, Response = S> + Send + 'static,
    for<'a> <M as Service<IncomingStream<'a, L>>>::Future: Send,
    S: Service<Request, Response = Response, Error = Infallible> + Clone + Send + 'static,
    S::Future: Send,
    F: Future<Output = ()> + Send,
{
    let (drain_tx, drain_rx) = oneshot::channel();
    let server = axum::serve(listener, make_service)
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
