use std::{future::pending, sync::Arc, time::Duration};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    routing::get,
};
use converact_api::{ServeError, http::router, serve, serve_runtime};
use converact_contracts::health::{
    ConfigurationCheck, ConfigurationStatus, DatabaseCheck, DatabaseStatus, MigrationCheck,
    MigrationStatus, NotificationProviderCheck, NotificationProviderStatus, PlacementSnapshotCheck,
    PlacementSnapshotStatus, ReadinessChecks, RuntimeHeartbeatCheck, RuntimeHeartbeatStatus,
};
use converact_runtime_health::{HealthTaskGroup, RuntimeHealth, TaskShutdown};
use serde_json::{Value, json};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{Notify, oneshot},
    time::timeout,
};
use tower::ServiceExt;

#[tokio::test]
async fn liveness_does_not_depend_on_database_or_other_services() {
    let response = router(RuntimeHealth::new())
        .oneshot(Request::get("/livez").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await, json!({ "status": "alive" }));
}

#[tokio::test]
async fn readiness_fails_closed_until_a_complete_check_set_is_published() {
    let health = RuntimeHealth::new();
    let app = router(health.clone());

    assert_eq!(
        status(app.clone(), "/readyz").await,
        StatusCode::SERVICE_UNAVAILABLE
    );
    health
        .publish(ready_checks())
        .expect("publish ready checks");
    assert_eq!(status(app, "/readyz").await, StatusCode::OK);
}

#[tokio::test]
async fn server_stops_within_the_bounded_shutdown_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task = tokio::spawn(serve(
        listener,
        router(RuntimeHealth::new()),
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

#[tokio::test]
async fn runtime_shutdown_drains_owned_child_tasks_under_the_same_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let mut tasks = HealthTaskGroup::new(1).expect("runtime task group");
    tasks
        .spawn(|_| async move { pending::<()>().await })
        .expect("hung health task");
    let task = tokio::spawn(serve_runtime(
        listener,
        router(RuntimeHealth::new()),
        tasks,
        async move {
            let _ = shutdown_rx.await;
        },
        Duration::from_millis(25),
    ));

    shutdown_tx.send(()).unwrap();
    let outcome = timeout(Duration::from_secs(1), task)
        .await
        .expect("bounded runtime returned")
        .expect("runtime task")
        .expect("runtime shutdown");
    assert_eq!(outcome, TaskShutdown::Forced { aborted: 1 });
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

fn ready_checks() -> ReadinessChecks {
    ReadinessChecks {
        database: DatabaseCheck {
            status: DatabaseStatus::Ok,
        },
        migrations: MigrationCheck {
            status: MigrationStatus::Ok,
            missing: vec![],
        },
        configuration: ConfigurationCheck {
            status: ConfigurationStatus::Ok,
            missing_or_invalid: vec![],
        },
        notification_providers: NotificationProviderCheck {
            status: NotificationProviderStatus::NotConfigured,
            active: 0,
            unhealthy: 0,
            blocking: false,
        },
        runtime_heartbeat: RuntimeHeartbeatCheck {
            status: RuntimeHeartbeatStatus::Disabled,
            instance_id: String::new(),
        },
        placement_snapshot: PlacementSnapshotCheck {
            status: PlacementSnapshotStatus::Disabled,
            snapshot_version: 0,
            error_code: String::new(),
        },
    }
}
