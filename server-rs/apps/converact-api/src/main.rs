use std::{error::Error, io};

use converact_api::{Readiness, router, serve};
use converact_config::RuntimeConfig;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    converact_observability::init("converact-api")?;
    let document = std::env::var("CONVERACT_RUNTIME_CONFIG_JSON").map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "runtime_config_environment_missing",
        )
    })?;
    let config = RuntimeConfig::from_json(&document)?;
    let listener = TcpListener::bind(config.bind_address()).await?;

    serve(
        listener,
        router(Readiness::default()),
        shutdown_signal(),
        config.shutdown_timeout(),
    )
    .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
