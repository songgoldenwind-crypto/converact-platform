use std::sync::Arc;

use axum::{
    Extension, Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, Response, StatusCode, header},
    middleware,
    routing::{get, post},
};
use converact_voice_agent_contracts::{AgentReleaseId, CallAttemptId, CampaignId, IdempotencyKey};
use serde::Serialize;

use crate::{
    AdmissionReadiness, AuthenticatedTenant, RepositoryErrorKind, ShutdownToken,
    VoiceAgentRepository, WorkerConfig, WorkerResource,
    platform_auth::{PlatformTokenAuthenticator, WallClock, authenticate_platform_token},
};

/// Builds authenticated internal inspection routes and dependency-aware health routes.
pub fn router<R: VoiceAgentRepository>(
    repository: Arc<R>,
    readiness: AdmissionReadiness,
    config: WorkerConfig,
    shutdown: ShutdownToken,
) -> Router {
    protected_routes::<R>()
        .merge(health_routes::<R>())
        .with_state(HttpState {
            repository,
            readiness,
            config,
            shutdown,
        })
}

/// Builds the process-facing router. Health remains public; every internal route requires one
/// verified platform bearer and receives tenant scope only from its signed identity.
pub fn router_with_platform_auth<R, A, C>(
    repository: Arc<R>,
    readiness: AdmissionReadiness,
    config: WorkerConfig,
    shutdown: ShutdownToken,
    authenticator: Arc<A>,
    clock: C,
) -> Router
where
    R: VoiceAgentRepository,
    A: PlatformTokenAuthenticator,
    C: WallClock + Clone,
{
    protected_routes::<R>()
        .route_layer(middleware::from_fn_with_state(
            crate::platform_auth::PlatformAuthState::new(authenticator, clock),
            authenticate_platform_token::<A, C>,
        ))
        .merge(health_routes::<R>())
        .with_state(HttpState {
            repository,
            readiness,
            config,
            shutdown,
        })
}

fn protected_routes<R: VoiceAgentRepository>() -> Router<HttpState<R>> {
    Router::new()
        .route(
            "/internal/v1/voice-agent/releases/{id}",
            get(get_release::<R>),
        )
        .route(
            "/internal/v1/voice-agent/campaigns/{id}",
            get(get_campaign::<R>),
        )
        .route(
            "/internal/v1/voice-agent/attempts/{id}",
            get(get_attempt::<R>),
        )
        .route(
            "/internal/v1/voice-agent/attempts/{id}/reconcile",
            post(reconcile::<R>),
        )
        .route("/internal/v1/voice-agent/workers", get(workers::<R>))
}

fn health_routes<R: VoiceAgentRepository>() -> Router<HttpState<R>> {
    Router::new()
        .route("/livez", get(livez::<R>))
        .route("/readyz", get(readyz::<R>))
}

async fn get_release<R: VoiceAgentRepository>(
    State(state): State<HttpState<R>>,
    tenant: Option<Extension<AuthenticatedTenant>>,
    Path(id): Path<String>,
) -> Response<Body> {
    let Some(tenant) = authenticated_tenant(tenant) else {
        return error_response(StatusCode::UNAUTHORIZED, "authentication_required");
    };
    if AgentReleaseId::parse(&id).is_err() {
        return error_response(StatusCode::NOT_FOUND, "resource_not_found");
    }
    match state.repository.release(&tenant, &id).await {
        Ok(Some(resource)) => json_response(StatusCode::OK, &resource),
        Ok(None) => error_response(StatusCode::NOT_FOUND, "resource_not_found"),
        Err(_) => error_response(StatusCode::SERVICE_UNAVAILABLE, "repository_unavailable"),
    }
}

async fn get_campaign<R: VoiceAgentRepository>(
    State(state): State<HttpState<R>>,
    tenant: Option<Extension<AuthenticatedTenant>>,
    Path(id): Path<String>,
) -> Response<Body> {
    let Some(tenant) = authenticated_tenant(tenant) else {
        return error_response(StatusCode::UNAUTHORIZED, "authentication_required");
    };
    if CampaignId::parse(&id).is_err() {
        return error_response(StatusCode::NOT_FOUND, "resource_not_found");
    }
    match state.repository.campaign(&tenant, &id).await {
        Ok(Some(resource)) => json_response(StatusCode::OK, &resource),
        Ok(None) => error_response(StatusCode::NOT_FOUND, "resource_not_found"),
        Err(_) => error_response(StatusCode::SERVICE_UNAVAILABLE, "repository_unavailable"),
    }
}

async fn get_attempt<R: VoiceAgentRepository>(
    State(state): State<HttpState<R>>,
    tenant: Option<Extension<AuthenticatedTenant>>,
    Path(id): Path<String>,
) -> Response<Body> {
    let Some(tenant) = authenticated_tenant(tenant) else {
        return error_response(StatusCode::UNAUTHORIZED, "authentication_required");
    };
    if CallAttemptId::parse(&id).is_err() {
        return error_response(StatusCode::NOT_FOUND, "resource_not_found");
    }
    match state.repository.attempt(&tenant, &id).await {
        Ok(Some(resource)) => json_response(StatusCode::OK, &resource),
        Ok(None) => error_response(StatusCode::NOT_FOUND, "resource_not_found"),
        Err(_) => error_response(StatusCode::SERVICE_UNAVAILABLE, "repository_unavailable"),
    }
}

async fn reconcile<R: VoiceAgentRepository>(
    State(state): State<HttpState<R>>,
    tenant: Option<Extension<AuthenticatedTenant>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response<Body> {
    let Some(tenant) = authenticated_tenant(tenant) else {
        return error_response(StatusCode::UNAUTHORIZED, "authentication_required");
    };
    if CallAttemptId::parse(&id).is_err() {
        return error_response(StatusCode::NOT_FOUND, "resource_not_found");
    }
    let Some(idempotency_key) = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| IdempotencyKey::parse(value).ok())
    else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "idempotency_key_required_or_invalid",
        );
    };
    match state
        .repository
        .request_reconcile(&tenant, &id, &idempotency_key)
        .await
    {
        Ok(Some(receipt)) => json_response(StatusCode::ACCEPTED, &receipt),
        Ok(None) => error_response(StatusCode::NOT_FOUND, "resource_not_found"),
        Err(error) if error.kind() == RepositoryErrorKind::Conflict => {
            error_response(StatusCode::CONFLICT, "idempotency_conflict")
        }
        Err(_) => error_response(StatusCode::SERVICE_UNAVAILABLE, "repository_unavailable"),
    }
}

async fn workers<R: VoiceAgentRepository>(
    State(state): State<HttpState<R>>,
    tenant: Option<Extension<AuthenticatedTenant>>,
) -> Response<Body> {
    if authenticated_tenant(tenant).is_none() {
        return error_response(StatusCode::UNAUTHORIZED, "authentication_required");
    }
    json_response(
        StatusCode::OK,
        &WorkerResource {
            worker_count: state.config.worker_count(),
            claim_size: state.config.claim_size(),
            accepting_new_work: state.readiness.accepts_new_work()
                && !state.shutdown.is_cancelled(),
            shutdown_requested: state.shutdown.is_cancelled(),
        },
    )
}

async fn livez<R: VoiceAgentRepository>(State(_state): State<HttpState<R>>) -> Response<Body> {
    json_response(StatusCode::OK, &HealthStatus { status: "alive" })
}

async fn readyz<R: VoiceAgentRepository>(State(state): State<HttpState<R>>) -> Response<Body> {
    let accepting = state.readiness.accepts_new_work() && !state.shutdown.is_cancelled();
    let mut failures = state.readiness.failure_codes();
    if state.shutdown.is_cancelled() {
        failures.push("worker_draining");
    }
    json_response(
        if accepting {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        &ReadinessStatus {
            status: if accepting { "ready" } else { "not_ready" },
            failures,
        },
    )
}

fn authenticated_tenant(
    tenant: Option<Extension<AuthenticatedTenant>>,
) -> Option<AuthenticatedTenant> {
    tenant.map(|Extension(tenant)| tenant)
}

fn json_response<T: Serialize>(status: StatusCode, value: &T) -> Response<Body> {
    let bytes = serde_json::to_vec(value)
        .unwrap_or_else(|_| br#"{"error":"response_encoding_failed"}"#.to_vec());
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

pub(crate) fn error_response(status: StatusCode, code: &'static str) -> Response<Body> {
    json_response(status, &ErrorBody { error: code })
}

struct HttpState<R> {
    repository: Arc<R>,
    readiness: AdmissionReadiness,
    config: WorkerConfig,
    shutdown: ShutdownToken,
}

impl<R> Clone for HttpState<R> {
    fn clone(&self) -> Self {
        Self {
            repository: Arc::clone(&self.repository),
            readiness: self.readiness.clone(),
            config: self.config,
            shutdown: self.shutdown.clone(),
        }
    }
}

#[derive(Serialize)]
struct HealthStatus {
    status: &'static str,
}

#[derive(Serialize)]
struct ReadinessStatus {
    status: &'static str,
    failures: Vec<&'static str>,
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}
