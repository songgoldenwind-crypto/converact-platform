mod support;

use axum::{body::to_bytes, http::Method};
use support::TestWorker;

#[tokio::test]
async fn attempt_resource_is_tenant_scoped_and_no_store() {
    let app = TestWorker::controlled();
    app.seed_completed_attempt().await;

    let response = app.get_attempt("tenant-a", "attempt-001").await;
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(
        app.get_attempt("tenant-b", "attempt-001").await.status(),
        404
    );
}

#[tokio::test]
async fn inspection_requires_authenticated_tenant_context() {
    let app = TestWorker::controlled();

    let response = app
        .request(
            Method::GET,
            "/internal/v1/voice-agent/attempts/attempt-001",
            None,
            None,
        )
        .await;

    assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn reconcile_requires_idempotency_and_returns_bounded_receipt() {
    let app = TestWorker::controlled();
    app.seed_completed_attempt().await;
    let path = "/internal/v1/voice-agent/attempts/attempt-001/reconcile";

    assert_eq!(
        app.request(Method::POST, path, Some("tenant-a"), None)
            .await
            .status(),
        400
    );
    assert_eq!(
        app.request(
            Method::POST,
            path,
            Some("tenant-a"),
            Some("reconcile-attempt-001"),
        )
        .await
        .status(),
        202
    );
}

#[tokio::test]
async fn health_is_fail_closed_for_new_work_without_killing_liveness() {
    let app = TestWorker::controlled();
    app.disable_durable_store_admission();

    assert_eq!(
        app.request(Method::GET, "/livez", None, None)
            .await
            .status(),
        200
    );
    assert_eq!(
        app.request(Method::GET, "/readyz", None, None)
            .await
            .status(),
        503
    );
}

#[tokio::test]
async fn attempt_projection_excludes_customer_and_provider_payloads() {
    let app = TestWorker::controlled();
    app.seed_completed_attempt().await;
    let response = app.get_attempt("tenant-a", "attempt-001").await;
    let body = to_bytes(response.into_body(), 16 * 1024).await.unwrap();
    let body = std::str::from_utf8(&body).unwrap();

    assert!(body.contains("\"post_call_state\":\"pending\""));
    assert!(!body.contains("post_call_error_code"));

    for forbidden in [
        "phone_number",
        "audio",
        "prompt",
        "provider_key",
        "transcript_text",
    ] {
        assert!(!body.contains(forbidden), "leaked {forbidden}");
    }
}
