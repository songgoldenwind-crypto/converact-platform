use std::{error::Error, io};

use converact_api::{http::router_with_identity, serve_runtime};
use converact_config::RuntimeConfig;
use converact_runtime_health::{BuildIdentity, HealthTaskGroup, RuntimeHealth};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let document = std::env::var("CONVERACT_RUNTIME_CONFIG_JSON").map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "runtime_config_environment_missing",
        )
    })?;
    let config = RuntimeConfig::from_json(&document)?;
    let identity = BuildIdentity::verified(
        "converact-api",
        env!("CARGO_PKG_VERSION"),
        config.source_commit(),
        option_env!("CONVERACT_SOURCE_COMMIT"),
    )?;
    converact_observability::init(&identity, config.tenant_id(), config.cell_id())?;
    let listener = TcpListener::bind(config.bind_address()).await?;

    serve_runtime(
        listener,
        router_with_identity(RuntimeHealth::new(), identity),
        HealthTaskGroup::new(1)?,
        shutdown_signal(),
        config.shutdown_timeout(),
    )
    .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
