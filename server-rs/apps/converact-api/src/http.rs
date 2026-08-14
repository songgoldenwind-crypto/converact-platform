//! Runtime health HTTP adapter.

use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderValue, Response, StatusCode, header},
    routing::get,
};
use converact_contracts::health::ReadinessStatus;
use converact_runtime_health::{BuildIdentity, RuntimeHealth};
use serde::Serialize;

static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Creates the legacy-compatible liveness and readiness routes.
pub fn router(health: RuntimeHealth) -> Router {
    health_router(HttpState {
        health,
        identity: None,
    })
}

/// Creates target health routes with exact build/source identity headers.
pub fn router_with_identity(health: RuntimeHealth, identity: BuildIdentity) -> Router {
    health_router(HttpState {
        health,
        identity: Some(identity),
    })
}

fn health_router(state: HttpState) -> Router {
    Router::new()
        .route("/livez", get(livez))
        .route("/readyz", get(readyz))
        .route("/health", get(readyz))
        .with_state(state)
}

async fn livez(State(state): State<HttpState>, headers: HeaderMap) -> Response<Body> {
    json_response(
        StatusCode::OK,
        &Liveness { status: "alive" },
        &request_id(&headers),
        state.identity.as_ref(),
        &[],
    )
}

async fn readyz(State(state): State<HttpState>, headers: HeaderMap) -> Response<Body> {
    let (snapshot, failures) = state.health.snapshot_with_failure_codes();
    let status = if snapshot.status == ReadinessStatus::Ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    json_response(
        status,
        &snapshot,
        &request_id(&headers),
        state.identity.as_ref(),
        &failures,
    )
}

fn json_response<T: Serialize>(
    status: StatusCode,
    body: &T,
    request_id: &str,
    identity: Option<&BuildIdentity>,
    failures: &[String],
) -> Response<Body> {
    let bytes = serde_json::to_vec(body).unwrap_or_else(|_| br#"{"status":"not_ready"}"#.to_vec());
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    if let Ok(value) = HeaderValue::from_str(request_id) {
        headers.insert("x-request-id", value);
    }
    if let Some(identity) = identity {
        insert_header(
            headers,
            "x-converact-build-version",
            identity.build_version(),
        );
        insert_header(
            headers,
            "x-converact-source-commit",
            identity.source_commit(),
        );
        if !failures.is_empty() {
            insert_header(
                headers,
                "x-converact-readiness-failures",
                &failures.join(","),
            );
        }
    }
    response
}

fn insert_header(headers: &mut HeaderMap, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(name, value);
    }
}

fn request_id(headers: &HeaderMap) -> String {
    let provided = headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| bounded_request_id(value));
    provided.map_or_else(fallback_request_id, str::to_owned)
}

fn bounded_request_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((&first, remainder)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= 128
        && first.is_ascii_alphanumeric()
        && remainder
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'))
}

fn fallback_request_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    let sequence = u128::from(REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let process = u128::from(std::process::id());
    let value = timestamp ^ (process << 64) ^ sequence;
    let hex = format!("{value:032x}");
    format!(
        "{}-{}-4{}-8{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    )
}

#[derive(Serialize)]
struct Liveness {
    status: &'static str,
}

#[derive(Clone, Debug)]
struct HttpState {
    health: RuntimeHealth,
    identity: Option<BuildIdentity>,
}
