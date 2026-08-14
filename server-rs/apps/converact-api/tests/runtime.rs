use std::{future::pending, sync::Arc, time::Duration};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    routing::get,
};
use converact_api::{Dependency, Readiness, ServeError, router, serve};
use serde_json::{Value, json};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{Notify, oneshot},
    time::timeout,
};
use tower::ServiceExt;

#[tokio::test]
async fn liveness_does_not_depend_on_database_or_other_services() {
    let response = router(Readiness::default())
        .oneshot(Request::get("/livez").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await, json!({ "status": "alive" }));
}

#[tokio::test]
async fn readiness_fails_closed_until_every_required_dependency_is_admitted() {
    let readiness = Readiness::default();
    let app = router(readiness.clone());

    assert_eq!(
        status(app.clone(), "/readyz").await,
        StatusCode::SERVICE_UNAVAILABLE
    );
    readiness.admit(Dependency::Postgres);
    readiness.admit(Dependency::Nats);
    assert_eq!(
        status(app.clone(), "/readyz").await,
        StatusCode::SERVICE_UNAVAILABLE
    );
    readiness.admit(Dependency::ObjectStorage);
    assert_eq!(status(app, "/readyz").await, StatusCode::OK);
}

#[tokio::test]
async fn server_stops_within_the_bounded_shutdown_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task = tokio::spawn(serve(
        listener,
        router(Readiness::default()),
        async move {
            let _ = shutdown_rx.await;
        },
        Duration::from_secs(1),
    ));

    shutdown_tx.send(()).unwrap();
    let result = timeout(Duration::from_secs(1), task)
        .await
        .expect("server shutdown deadline")
        .expect("server task");
    assert!(result.is_ok());
}

#[tokio::test]
async fn configured_deadline_cancels_a_hung_in_flight_request() {
    let entered = Arc::new(Notify::new());
    let handler_entered = Arc::clone(&entered);
    let app = Router::new().route(
        "/hang",
        get(move || {
            let handler_entered = Arc::clone(&handler_entered);
            async move {
                handler_entered.notify_one();
                pending::<()>().await;
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task = tokio::spawn(serve(
        listener,
        app,
        async move {
            let _ = shutdown_rx.await;
        },
        Duration::from_millis(25),
    ));
    let client = TcpStream::connect(address).await.unwrap();
    client.writable().await.unwrap();
    client
        .try_write(b"GET /hang HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .unwrap();
    timeout(Duration::from_secs(1), entered.notified())
        .await
        .expect("hung handler entered");

    shutdown_tx.send(()).unwrap();
    let result = timeout(Duration::from_secs(1), task)
        .await
        .expect("bounded server returned")
        .expect("server task");
    assert!(matches!(result, Err(ServeError::ShutdownDeadlineExceeded)));
    drop(client);
}

async fn status(app: axum::Router, path: &str) -> StatusCode {
    app.oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap()
        .status()
}

async fn body_json(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), 1024).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
