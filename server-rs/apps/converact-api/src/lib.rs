//! Converact platform API process boundary.

use std::{
    error::Error,
    fmt,
    future::{Future, IntoFuture},
    io,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};

use axum::{Json, Router, http::StatusCode, routing::get};
use serde::Serialize;
use tokio::{net::TcpListener, sync::oneshot, time::timeout};

const ALL_REQUIRED_DEPENDENCIES: u8 =
    Dependency::Postgres as u8 | Dependency::Nats as u8 | Dependency::ObjectStorage as u8;

/// A mandatory runtime dependency in the bootstrap readiness gate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum Dependency {
    /// The Cell-local `PostgreSQL` authority store.
    Postgres = 1,
    /// The Cell-local durable event transport.
    Nats = 2,
    /// The object store used by durable artifacts.
    ObjectStorage = 4,
}

/// A constant-time, fail-closed bootstrap readiness gate.
#[derive(Clone, Debug, Default)]
pub struct Readiness(Arc<AtomicU8>);

impl Readiness {
    /// Marks one mandatory dependency admitted.
    pub fn admit(&self, dependency: Dependency) {
        self.0.fetch_or(dependency as u8, Ordering::Release);
    }

    fn is_ready(&self) -> bool {
        self.0.load(Ordering::Acquire) == ALL_REQUIRED_DEPENDENCIES
    }
}

/// Creates the bounded bootstrap HTTP surface.
pub fn router(readiness: Readiness) -> Router {
    Router::new()
        .route("/livez", get(livez))
        .route("/readyz", get(readyz))
        .with_state(readiness)
}

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

async fn livez() -> Json<HealthStatus> {
    Json(HealthStatus { status: "alive" })
}

async fn readyz(
    axum::extract::State(readiness): axum::extract::State<Readiness>,
) -> (StatusCode, Json<HealthStatus>) {
    if readiness.is_ready() {
        (StatusCode::OK, Json(HealthStatus { status: "ready" }))
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(HealthStatus {
                status: "not_ready",
            }),
        )
    }
}

#[derive(Serialize)]
struct HealthStatus {
    status: &'static str,
}
