use std::{
    error::Error,
    fmt,
    future::{Future, IntoFuture},
    io,
    time::Duration,
};

use axum::Router;
use tokio::{net::TcpListener, sync::oneshot, time::timeout};

use crate::ShutdownToken;

/// Closed HTTP process lifecycle failure.
#[derive(Debug)]
pub enum WorkerServeError {
    Io(io::Error),
    DrainDeadlineExceeded,
}

impl fmt::Display for WorkerServeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Io(_) => "voice_agent_http_io_failed",
            Self::DrainDeadlineExceeded => "voice_agent_http_drain_deadline_exceeded",
        })
    }
}

impl Error for WorkerServeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::DrainDeadlineExceeded => None,
        }
    }
}

/// Serves the Worker HTTP boundary and marks admission as draining before graceful shutdown.
///
/// # Errors
///
/// Returns a sanitized I/O failure or a bounded drain deadline failure.
pub async fn serve_worker_http<F>(
    listener: TcpListener,
    app: Router,
    shutdown: ShutdownToken,
    signal: F,
    drain_timeout: Duration,
) -> Result<(), WorkerServeError>
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
    let external_shutdown = shutdown.clone();

    tokio::select! {
        result = &mut server => {
            shutdown.cancel();
            return result.map_err(WorkerServeError::Io);
        }
        () = signal => {
            shutdown.cancel();
        }
        () = external_shutdown.cancelled() => {}
    }
    let _ = drain_tx.send(());
    match timeout(drain_timeout, &mut server).await {
        Ok(result) => result.map_err(WorkerServeError::Io),
        Err(_) => Err(WorkerServeError::DrainDeadlineExceeded),
    }
}
