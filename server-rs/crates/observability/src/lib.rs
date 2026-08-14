//! Bounded observability bootstrap for Converact Rust services.

use std::{error::Error, fmt};

/// The process-global tracing subscriber was already installed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InitError;

impl fmt::Display for InitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("observability_already_initialized")
    }
}

impl Error for InitError {}

/// Installs the process-global structured JSON tracing subscriber.
///
/// # Errors
///
/// Returns [`InitError`] if another global subscriber is already installed.
pub fn init(service_name: &'static str) -> Result<(), InitError> {
    tracing_subscriber::fmt()
        .json()
        .with_current_span(false)
        .with_span_list(false)
        .try_init()
        .map_err(|_| InitError)?;
    tracing::info!(
        service.name = service_name,
        "runtime observability initialized"
    );
    Ok(())
}
