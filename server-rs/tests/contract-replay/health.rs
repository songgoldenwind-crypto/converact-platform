use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use converact_api::http::{router, router_with_identity};
use converact_contracts::health::ReadinessResult;
use converact_runtime_health::{BuildIdentity, RuntimeHealth};
use serde_json::Value;
use tower::ServiceExt;

#[tokio::test]
async fn rust_http_replays_every_frozen_typescript_health_vector() {
    let fixture: Value = serde_json::from_str(include_str!("../fixtures/runtime-health-v1.json"))
        .expect("runtime health fixture");
    let request_id = fixture["request_id"].as_str().expect("request id");
    let health = RuntimeHealth::new();

    for vector in fixture["cases"].as_array().expect("health cases") {
        let name = vector["name"].as_str().expect("case name");
        let body_bytes = vector["body_bytes"].as_str().expect("body bytes");
        if vector["state"].is_string() {
            let expected: ReadinessResult =
                serde_json::from_str(body_bytes).expect("readiness body");
            health
                .publish(expected.checks)
                .expect("publish readiness checks");
        }

        let response = router(health.clone())
            .oneshot(
                Request::get(vector["path"].as_str().expect("health path"))
                    .header("x-request-id", request_id)
                    .body(Body::empty())
                    .expect("health request"),
            )
            .await
            .expect("health response");
        assert_eq!(
            response.status().as_u16(),
            u16::try_from(vector["status"].as_u64().expect("status")).expect("HTTP status"),
            "{name}: status",
        );
        for (header, value) in vector["headers"].as_object().expect("headers") {
            assert_eq!(
                response
                    .headers()
                    .get(header)
                    .and_then(|item| item.to_str().ok()),
                value.as_str(),
                "{name}: {header}",
            );
        }
        let body = to_bytes(response.into_body(), 65_536)
            .await
            .expect("health response body");
        assert_eq!(body.as_ref(), body_bytes.as_bytes(), "{name}: body");
    }
}

#[tokio::test]
async fn target_health_headers_bind_source_and_stable_failure_codes() {
    let identity =
        BuildIdentity::new("converact-api", "0.1.0", &"a".repeat(40)).expect("build identity");
    let response = router_with_identity(RuntimeHealth::new(), identity)
        .oneshot(
            Request::get("/readyz")
                .header("x-request-id", "invalid/request")
                .body(Body::empty())
                .expect("health request"),
        )
        .await
        .expect("health response");

    assert_eq!(response.status().as_u16(), 503);
    assert_eq!(response.headers()["x-converact-build-version"], "0.1.0");
    assert_eq!(
        response.headers()["x-converact-source-commit"],
        "a".repeat(40)
    );
    assert_eq!(
        response.headers()["x-converact-readiness-failures"],
        "database_failed,migrations_failed,configuration_failed,runtime_heartbeat_unknown,placement_snapshot_missing"
    );
    assert!(
        response.headers()["x-request-id"]
            .to_str()
            .expect("request id")
            .bytes()
            .enumerate()
            .all(|(index, byte)| match index {
                8 | 13 | 18 | 23 => byte == b'-',
                _ => byte.is_ascii_hexdigit(),
            })
    );
    assert_eq!(response.headers()["x-request-id"].as_bytes().len(), 36);
}
