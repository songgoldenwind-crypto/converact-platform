use std::time::Duration;

use axum::{Router, routing::get};
use converact_voice_agent_worker::{ShutdownToken, serve_worker_http};
use tokio::{net::TcpListener, sync::oneshot};

#[tokio::test]
async fn process_serves_then_marks_draining_and_stops_on_signal() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let shutdown = ShutdownToken::default();
    let observed_shutdown = shutdown.clone();
    let (signal_tx, signal_rx) = oneshot::channel::<()>();
    let process = tokio::spawn(serve_worker_http(
        listener,
        Router::new().route("/livez", get(|| async { "alive" })),
        shutdown,
        async move {
            let _ = signal_rx.await;
        },
        Duration::from_secs(1),
    ));

    let response = reqwest::get(format!("http://{address}/livez"))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(!observed_shutdown.is_cancelled());

    signal_tx.send(()).unwrap();
    process.await.unwrap().unwrap();
    assert!(observed_shutdown.is_cancelled());
}

#[tokio::test]
async fn dependency_failure_can_stop_http_through_shared_shutdown() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let shutdown = ShutdownToken::default();
    let cancel = shutdown.clone();
    let process = tokio::spawn(serve_worker_http(
        listener,
        Router::new().route("/livez", get(|| async { "alive" })),
        shutdown,
        std::future::pending(),
        Duration::from_secs(1),
    ));

    cancel.cancel();
    tokio::time::timeout(Duration::from_millis(100), process)
        .await
        .expect("shared shutdown must stop HTTP")
        .unwrap()
        .unwrap();
}

#[test]
fn executable_process_composes_campaign_admin_with_the_claim_store() {
    let source = include_str!("../src/main.rs");

    for required in [
        "PostgresCampaignAdminStore::new",
        "PostgresCampaignAdminPort::new",
        "router_with_campaign_admin_and_platform_auth",
    ] {
        assert!(
            source.contains(required),
            "missing executable Campaign Admin composition {required}"
        );
    }
}
