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
