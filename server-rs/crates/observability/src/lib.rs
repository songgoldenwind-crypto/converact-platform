//! Bounded observability bootstrap for Converact Rust services.

use std::{error::Error, fmt};

use converact_kernel_ids::{CellId, TenantId};
use converact_runtime_health::BuildIdentity;

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
pub fn init(
    identity: &BuildIdentity,
    tenant_id: &TenantId,
    cell_id: &CellId,
) -> Result<(), InitError> {
    tracing_subscriber::fmt()
        .json()
        .with_current_span(false)
        .with_span_list(false)
        .try_init()
        .map_err(|_| InitError)?;
    emit_runtime_initialized(identity, tenant_id, cell_id);
    Ok(())
}

/// Records one exact-source process startup event on the active subscriber.
pub fn emit_runtime_initialized(identity: &BuildIdentity, tenant_id: &TenantId, cell_id: &CellId) {
    tracing::info!(
        service.name = identity.service_name(),
        build.version = identity.build_version(),
        source.commit = identity.source_commit(),
        tenant.id = tenant_id.as_str(),
        cell.id = cell_id.as_str(),
        "runtime observability initialized"
    );
}
