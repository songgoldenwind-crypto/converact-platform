use crate::capacity::CodecPairCapacity;
use crate::codec::AudioCodec;
use crate::ivr::{IvrPromptCacheConfig, IvrSessionConfig};
use crate::runtime::{
    NegotiationRole, ProcessingRuntime, ProcessingRuntimeCommand, ProcessingRuntimeConfig,
    ProcessingRuntimeError, ProcessingRuntimeOperation, ProcessingRuntimeResult,
    ProcessingRuntimeSnapshot,
};
use crate::session::{
    ProcessingAction, ProcessingCommand, ProcessingProfile, ProcessingSessionRegistryConfig,
    ProcessingSessionState, ReconcileCommand, SessionError,
};
use crate::worker::{RtpWorkerPoolConfig, WorkerError};
use axum::extract::rejection::JsonRejection;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, SecondsFormat, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::io::Read;
use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const CONTROL_PROTOCOL: &str = "ivekit.processing-control.v1";
const CLIENT_IDENTITY_HEADER: &str = "x-ivekit-client-identity";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceMediaHttpConfig {
    pub bearer_token: Option<String>,
    pub required_client_identity: Option<String>,
    pub max_body_bytes: usize,
    pub max_inflight_requests: usize,
}

impl VoiceMediaHttpConfig {
    fn validate(&self) -> Result<(), VoiceMediaHttpError> {
        if self.max_body_bytes == 0 {
            return Err(VoiceMediaHttpError::InvalidConfiguration("max_body_bytes"));
        }
        if self.max_inflight_requests == 0 {
            return Err(VoiceMediaHttpError::InvalidConfiguration(
                "max_inflight_requests",
            ));
        }
        if self.bearer_token.as_deref() == Some("") {
            return Err(VoiceMediaHttpError::InvalidConfiguration("bearer_token"));
        }
        if self.required_client_identity.as_deref() == Some("") {
            return Err(VoiceMediaHttpError::InvalidConfiguration(
                "required_client_identity",
            ));
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum VoiceMediaHttpError {
    InvalidConfiguration(&'static str),
    Environment { field: String, message: String },
    Runtime(ProcessingRuntimeError),
    Bind(std::io::Error),
    Serve(std::io::Error),
}

impl Display for VoiceMediaHttpError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfiguration(field) => {
                write!(formatter, "invalid voice media HTTP configuration: {field}")
            }
            Self::Environment { field, message } => {
                write!(formatter, "invalid environment variable {field}: {message}")
            }
            Self::Runtime(error) => Display::fmt(error, formatter),
            Self::Bind(error) => {
                write!(formatter, "failed to bind voice media HTTP server: {error}")
            }
            Self::Serve(error) => {
                write!(formatter, "voice media HTTP server failed: {error}")
            }
        }
    }
}

impl Error for VoiceMediaHttpError {}

impl From<ProcessingRuntimeError> for VoiceMediaHttpError {
    fn from(value: ProcessingRuntimeError) -> Self {
        Self::Runtime(value)
    }
}

#[derive(Default)]
struct HttpMetrics {
    commands_succeeded: AtomicU64,
    commands_failed: AtomicU64,
    requests_rejected: AtomicU64,
}

struct VoiceMediaHttpInner {
    runtime: Arc<ProcessingRuntime>,
    bearer_digest: Option<[u8; 32]>,
    client_identity_digest: Option<[u8; 32]>,
    max_body_bytes: usize,
    permits: Arc<Semaphore>,
    draining: AtomicBool,
    metrics: HttpMetrics,
}

#[derive(Clone)]
pub struct VoiceMediaHttpState {
    inner: Arc<VoiceMediaHttpInner>,
}

impl VoiceMediaHttpState {
    pub fn new(
        runtime: Arc<ProcessingRuntime>,
        config: VoiceMediaHttpConfig,
    ) -> Result<Self, VoiceMediaHttpError> {
        config.validate()?;
        Ok(Self {
            inner: Arc::new(VoiceMediaHttpInner {
                runtime,
                bearer_digest: config.bearer_token.as_deref().map(digest),
                client_identity_digest: config.required_client_identity.as_deref().map(digest),
                max_body_bytes: config.max_body_bytes,
                permits: Arc::new(Semaphore::new(config.max_inflight_requests)),
                draining: AtomicBool::new(false),
                metrics: HttpMetrics::default(),
            }),
        })
    }

    fn max_body_bytes(&self) -> usize {
        self.inner.max_body_bytes
    }
}

#[derive(Debug, Deserialize)]
struct WebRtcSessionRequest {
    tenant_id: String,
    call_session_id: Option<String>,
    endpoint_id: Option<String>,
    token: Option<String>,
    ttl_seconds: Option<u64>,
    status: Option<String>,
    expires_at: Option<String>,
    ice_servers: Option<Vec<Value>>,
}

#[derive(Debug, Serialize)]
struct WebRtcSessionResponse {
    token: String,
    token_hash: String,
    endpoint_id: String,
    expires_at: String,
    ice_servers: Vec<Value>,
    boundary: String,
}

#[derive(Debug, Deserialize)]
struct RecordingArchiveRequest {
    tenant_id: String,
    recording_id: String,
    provider_recording_id: Option<String>,
    recording_url: Option<String>,
    archive_url: Option<String>,
    archive_url_base: Option<String>,
    metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct RecordingPurgeRequest {
    tenant_id: String,
    recording_id: String,
    provider_recording_id: Option<String>,
    recording_url: Option<String>,
    archived_recording_url: Option<String>,
    metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ControlCommandRequest {
    protocol_version: String,
    action: String,
    command_id: String,
    tenant_id: String,
    call_id: String,
    leg_id: String,
    cell_id: String,
    owner_node_id: String,
    owner_epoch: String,
    admission_reservation_id: String,
    media_reservation_id: String,
    expires_at: String,
    command_sequence: u32,
    idempotency_key: String,
    payload_hash: String,
    command_hash: String,
    transport_session_id: Option<String>,
    payload: Map<String, Value>,
}

#[derive(Debug, Deserialize)]
struct ReconcileRequest {
    protocol_version: String,
    command_id: String,
    media_reservation_id: String,
    owner_epoch: String,
    command_hash: String,
}

#[derive(Debug, Deserialize)]
struct SessionScanQuery {
    after: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Copy)]
struct ControlProtocolError {
    code: &'static str,
    retryable: bool,
}

impl ControlProtocolError {
    const fn terminal(code: &'static str) -> Self {
        Self {
            code,
            retryable: false,
        }
    }
}

pub fn router(state: VoiceMediaHttpState) -> Router {
    let body_limit = state.max_body_bytes();
    Router::new()
        .route("/health", get(health))
        .route("/ready", get(readiness))
        .route("/metrics", get(metrics))
        .route("/v1/commands", post(execute_command))
        .route("/v1/reconcile", post(reconcile_command))
        .route("/v1/sessions", get(scan_sessions))
        .route("/v1/sessions/{media_reservation_id}", get(query_session))
        .route("/webrtc/session/create", post(issue_session_handler))
        .route("/recordings/archive", post(archive_recording_handler))
        .route("/recordings/purge", post(purge_recording_handler))
        .route("/ivr/gather-digits", post(gather_digits_stub))
        .layer(DefaultBodyLimit::max(body_limit))
        .layer(middleware::from_fn_with_state(state.clone(), request_guard))
        .with_state(state)
}

pub async fn serve_from_env() -> Result<(), VoiceMediaHttpError> {
    let server = ServerConfiguration::from_env()?;
    let runtime = Arc::new(ProcessingRuntime::new(
        server.runtime,
        Arc::new(CodecPairCapacity::uniform(server.codec_pair_capacity)),
    )?);
    let state = VoiceMediaHttpState::new(runtime.clone(), server.http)?;
    spawn_sweeper(runtime, server.sweep_interval, server.sweep_limit);
    let listener = tokio::net::TcpListener::bind(server.listen)
        .await
        .map_err(VoiceMediaHttpError::Bind)?;
    println!("voice-media-rs listening on {}", server.listen);
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(VoiceMediaHttpError::Serve)
}

async fn request_guard(
    State(state): State<VoiceMediaHttpState>,
    request: Request,
    next: Next,
) -> Response {
    let public = is_public_request(request.method(), request.uri().path());
    if !public && !authorized(&state, &request) {
        state
            .inner
            .metrics
            .requests_rejected
            .fetch_add(1, Ordering::Relaxed);
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({
                "error": "unauthorized",
                "message": "voice media control credentials required"
            }),
        );
    }
    if !request_uses_capacity(request.method(), request.uri().path()) {
        return with_service_header(next.run(request).await);
    }
    let permit = match state.inner.permits.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            state
                .inner
                .metrics
                .requests_rejected
                .fetch_add(1, Ordering::Relaxed);
            return json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({
                    "error": "control_capacity_exhausted",
                    "retryable": true
                }),
            );
        }
    };
    with_service_header(run_guarded(next, request, permit).await)
}

async fn run_guarded(next: Next, request: Request, permit: OwnedSemaphorePermit) -> Response {
    let response = next.run(request).await;
    drop(permit);
    response
}

fn is_public_request(method: &Method, path: &str) -> bool {
    method == Method::GET && matches!(path, "/health" | "/ready" | "/metrics")
}

fn request_uses_capacity(method: &Method, path: &str) -> bool {
    !(method == Method::GET && path == "/health")
}

fn authorized(state: &VoiceMediaHttpState, request: &Request) -> bool {
    let bearer_ok = match state.inner.bearer_digest {
        None => true,
        Some(expected) => request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .is_some_and(|value| secure_eq(&digest(value), &expected)),
    };
    let identity_ok = match state.inner.client_identity_digest {
        None => true,
        Some(expected) => request
            .headers()
            .get(CLIENT_IDENTITY_HEADER)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| secure_eq(&digest(value), &expected)),
    };
    bearer_ok && identity_ok
}

async fn health() -> Response {
    json_response(
        StatusCode::OK,
        json!({
            "status": "ok",
            "service": "voice-media-rs",
            "capabilities": {
                "webrtc_session_create": "ready",
                "recording_archive": "ready",
                "recording_purge": "ready",
                "processing_core": "ready",
                "processing_sessions": "ready",
                "processing_runtime": "ready",
                "command_reconcile": "ready",
                "gather_digits": "worker_ready_http_pending"
            }
        }),
    )
}

async fn readiness(State(state): State<VoiceMediaHttpState>) -> Response {
    let runtime = state.inner.runtime.clone();
    let worker = tokio::task::spawn_blocking(move || runtime.worker_snapshot()).await;
    let draining = state.inner.draining.load(Ordering::Acquire);
    let available_ports = state.inner.runtime.available_port_count();
    match worker {
        Ok(Ok(snapshot)) if !draining && available_ports >= 2 && snapshot.worker_threads > 0 => {
            json_response(
                StatusCode::OK,
                json!({
                    "status": "ready",
                    "draining": false,
                    "worker_threads": snapshot.worker_threads,
                    "active_sessions": snapshot.active_sessions,
                    "available_rtp_ports": available_ports
                }),
            )
        }
        Ok(Ok(snapshot)) => json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({
                "status": "not_ready",
                "draining": draining,
                "worker_threads": snapshot.worker_threads,
                "active_sessions": snapshot.active_sessions,
                "available_rtp_ports": available_ports
            }),
        ),
        _ => json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({
                "status": "not_ready",
                "error": "worker_snapshot_unavailable"
            }),
        ),
    }
}

async fn metrics(State(state): State<VoiceMediaHttpState>) -> Response {
    let runtime = state.inner.runtime.clone();
    let worker = tokio::task::spawn_blocking(move || runtime.worker_snapshot())
        .await
        .ok()
        .and_then(Result::ok);
    let active_sessions = state.inner.runtime.registry_active_session_count();
    let total_sessions = state.inner.runtime.registry_session_count();
    let available_ports = state.inner.runtime.available_port_count();
    let body = render_metrics(
        &state,
        worker,
        active_sessions,
        total_sessions,
        available_ports,
    );
    (
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        body,
    )
        .into_response()
}

async fn execute_command(
    State(state): State<VoiceMediaHttpState>,
    payload: Result<Json<ControlCommandRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return invalid_json(error),
    };
    let command_id = request.command_id.clone();
    if state.inner.draining.load(Ordering::Acquire) && request.action == "offer" {
        state
            .inner
            .metrics
            .commands_failed
            .fetch_add(1, Ordering::Relaxed);
        return json_response(
            StatusCode::OK,
            failed_outcome(&command_id, "processing_node_draining", true),
        );
    }
    let transport_session_id = request.transport_session_id.clone();
    let runtime_command = match request.into_runtime_command() {
        Ok(command) => command,
        Err(error) => {
            state
                .inner
                .metrics
                .commands_failed
                .fetch_add(1, Ordering::Relaxed);
            return json_response(
                StatusCode::OK,
                failed_outcome(&command_id, error.code, error.retryable),
            );
        }
    };
    let runtime = state.inner.runtime.clone();
    let now_ms = unix_time_ms();
    let result = tokio::task::spawn_blocking(move || {
        if let Some(expected) = transport_session_id {
            verify_transport_session(
                &runtime,
                &runtime_command.command.media_reservation_id,
                &expected,
            )?;
        }
        runtime.execute(runtime_command, now_ms)
    })
    .await;
    match result {
        Ok(Ok(result)) => {
            state
                .inner
                .metrics
                .commands_succeeded
                .fetch_add(1, Ordering::Relaxed);
            json_response(StatusCode::OK, succeeded_outcome(result))
        }
        Ok(Err(error)) => {
            state
                .inner
                .metrics
                .commands_failed
                .fetch_add(1, Ordering::Relaxed);
            json_response(StatusCode::OK, runtime_failure_outcome(&command_id, &error))
        }
        Err(_) => {
            state
                .inner
                .metrics
                .commands_failed
                .fetch_add(1, Ordering::Relaxed);
            json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                unknown_outcome(&command_id, "processing_control_task_failed"),
            )
        }
    }
}

async fn reconcile_command(
    State(state): State<VoiceMediaHttpState>,
    payload: Result<Json<ReconcileRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return invalid_json(error),
    };
    let command_id = request.command_id.clone();
    let reconcile = match request.into_reconcile_command() {
        Ok(command) => command,
        Err(error) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({
                    "found": true,
                    "outcome": failed_outcome(&command_id, error.code, error.retryable)
                }),
            );
        }
    };
    let runtime = state.inner.runtime.clone();
    match tokio::task::spawn_blocking(move || runtime.reconcile(reconcile)).await {
        Ok(Ok(Some(result))) => json_response(
            StatusCode::OK,
            json!({ "found": true, "outcome": succeeded_outcome(result) }),
        ),
        Ok(Ok(None)) => json_response(StatusCode::OK, json!({ "found": false })),
        Ok(Err(error)) => {
            let (code, retryable) = runtime_error(&error);
            json_response(
                StatusCode::OK,
                json!({
                    "found": true,
                    "outcome": failed_outcome(&command_id, code, retryable)
                }),
            )
        }
        Err(_) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({
                "found": true,
                "outcome": failed_outcome(
                    &command_id,
                    "processing_control_task_failed",
                    true
                )
            }),
        ),
    }
}

async fn query_session(
    State(state): State<VoiceMediaHttpState>,
    Path(media_reservation_id): Path<String>,
) -> Response {
    let runtime = state.inner.runtime.clone();
    match tokio::task::spawn_blocking(move || runtime.session(&media_reservation_id)).await {
        Ok(Ok(Some(snapshot))) => json_response(StatusCode::OK, session_value(&snapshot)),
        Ok(Ok(None)) => json_response(
            StatusCode::NOT_FOUND,
            json!({ "error": "processing_session_not_found" }),
        ),
        Ok(Err(error)) => {
            let (code, retryable) = runtime_error(&error);
            json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": code, "retryable": retryable }),
            )
        }
        Err(_) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "processing_control_task_failed", "retryable": true }),
        ),
    }
}

async fn scan_sessions(
    State(state): State<VoiceMediaHttpState>,
    Query(query): Query<SessionScanQuery>,
) -> Response {
    let after = query.after.unwrap_or_default();
    let limit = query.limit.unwrap_or(256);
    if limit == 0 || limit > 10_000 || after.len() > 256 {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "processing_session_scan_invalid" }),
        );
    }
    let runtime = state.inner.runtime.clone();
    match tokio::task::spawn_blocking(move || runtime.scan_active_sessions(&after, limit)).await {
        Ok(Ok(scan)) => json_response(
            StatusCode::OK,
            json!({
                "items": scan.items.iter().map(orphan_candidate_value).collect::<Vec<_>>(),
                "next_cursor": scan.next_cursor,
                "inspected": scan.inspected
            }),
        ),
        Ok(Err(error)) => {
            let (code, retryable) = runtime_error(&error);
            json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": code, "retryable": retryable }),
            )
        }
        Err(_) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "processing_control_task_failed", "retryable": true }),
        ),
    }
}

async fn issue_session_handler(
    payload: Result<Json<WebRtcSessionRequest>, JsonRejection>,
) -> Response {
    match payload {
        Ok(Json(payload)) => json_response(StatusCode::OK, issue_session(payload)),
        Err(error) => invalid_json(error),
    }
}

async fn archive_recording_handler(
    payload: Result<Json<RecordingArchiveRequest>, JsonRejection>,
) -> Response {
    match payload {
        Ok(Json(payload)) => json_response(StatusCode::OK, archive_recording(payload)),
        Err(error) => invalid_json(error),
    }
}

async fn purge_recording_handler(
    payload: Result<Json<RecordingPurgeRequest>, JsonRejection>,
) -> Response {
    match payload {
        Ok(Json(payload)) => json_response(StatusCode::OK, purge_recording(payload)),
        Err(error) => invalid_json(error),
    }
}

async fn gather_digits_stub() -> Response {
    json_response(
        StatusCode::NOT_IMPLEMENTED,
        json!({
            "error": "not_implemented",
            "status": "stub_experimental",
            "message": "Use the owner-fenced media-control IVR commands for production digit collection."
        }),
    )
}

impl ControlCommandRequest {
    fn into_runtime_command(self) -> Result<ProcessingRuntimeCommand, ControlProtocolError> {
        assert_protocol(&self.protocol_version)?;
        let owner_epoch = parse_u64(&self.owner_epoch, "processing_owner_epoch_invalid")?;
        let expires_at_ms = parse_timestamp(&self.expires_at)?;
        let command_hash = parse_hash(&self.command_hash, "processing_command_hash_invalid")?;
        let idempotency_hash = parse_hash(&self.payload_hash, "processing_payload_hash_invalid")?;
        let (action, operation, profile) = self.operation()?;
        Ok(ProcessingRuntimeCommand {
            command: ProcessingCommand {
                action,
                command_id: self.command_id,
                tenant_id: self.tenant_id,
                call_id: self.call_id,
                leg_id: self.leg_id,
                cell_id: self.cell_id,
                owner_node_id: self.owner_node_id,
                owner_epoch,
                admission_reservation_id: self.admission_reservation_id,
                media_reservation_id: self.media_reservation_id,
                command_sequence: self.command_sequence,
                idempotency_key: self.idempotency_key,
                expires_at_ms,
                command_hash,
                idempotency_hash,
                profile,
            },
            operation,
        })
    }

    fn operation(
        &self,
    ) -> Result<
        (
            ProcessingAction,
            ProcessingRuntimeOperation,
            Option<ProcessingProfile>,
        ),
        ControlProtocolError,
    > {
        match self.action.as_str() {
            "offer" => Ok((
                ProcessingAction::Offer,
                ProcessingRuntimeOperation::Offer {
                    sdp: payload_text(&self.payload, "offer_sdp")?,
                },
                Some(processing_profile(&self.payload)?),
            )),
            "answer" => Ok((
                ProcessingAction::Answer,
                ProcessingRuntimeOperation::Answer {
                    sdp: payload_sdp(&self.payload, "answer_sdp")?,
                },
                None,
            )),
            "update" => {
                let role = match self.payload.get("sdp_role").and_then(Value::as_str) {
                    Some("offer") => NegotiationRole::Offer,
                    Some("answer") => NegotiationRole::Answer,
                    _ => {
                        return Err(ControlProtocolError::terminal(
                            "processing_sdp_role_invalid",
                        ));
                    }
                };
                Ok((
                    ProcessingAction::Update,
                    ProcessingRuntimeOperation::Update {
                        role,
                        sdp: payload_sdp(&self.payload, "sdp")?,
                    },
                    None,
                ))
            }
            "delete" => Ok((
                ProcessingAction::Delete,
                ProcessingRuntimeOperation::Delete,
                None,
            )),
            "query" => Ok((
                ProcessingAction::Query,
                ProcessingRuntimeOperation::Query,
                None,
            )),
            _ => Err(ControlProtocolError::terminal(
                "processing_action_unsupported",
            )),
        }
    }
}

impl ReconcileRequest {
    fn into_reconcile_command(self) -> Result<ReconcileCommand, ControlProtocolError> {
        assert_protocol(&self.protocol_version)?;
        Ok(ReconcileCommand {
            media_reservation_id: self.media_reservation_id,
            owner_epoch: parse_u64(&self.owner_epoch, "processing_owner_epoch_invalid")?,
            command_id: self.command_id,
            command_hash: parse_hash(&self.command_hash, "processing_command_hash_invalid")?,
        })
    }
}

fn processing_profile(
    payload: &Map<String, Value>,
) -> Result<ProcessingProfile, ControlProtocolError> {
    if payload.get("media_profile_id").and_then(Value::as_str) != Some("VOICE-IVR-G711-OPUS-V1") {
        return Err(ControlProtocolError::terminal(
            "processing_profile_unsupported",
        ));
    }
    Ok(ProcessingProfile {
        leg_a_codec: parse_codec(payload, "leg_a_codec")?,
        leg_b_codec: parse_codec(payload, "leg_b_codec")?,
        packetization_ms: payload_u8(payload, "packetization_ms")?.into(),
        leg_a_payload_type: payload_u8(payload, "leg_a_payload_type")?,
        leg_b_payload_type: payload_u8(payload, "leg_b_payload_type")?,
    })
}

fn parse_codec(
    payload: &Map<String, Value>,
    field: &'static str,
) -> Result<AudioCodec, ControlProtocolError> {
    match payload.get(field).and_then(Value::as_str) {
        Some("PCMU") => Ok(AudioCodec::Pcmu),
        Some("PCMA") => Ok(AudioCodec::Pcma),
        Some("OPUS") => Ok(AudioCodec::Opus),
        _ => Err(ControlProtocolError::terminal(
            "processing_codec_unsupported",
        )),
    }
}

fn payload_u8(
    payload: &Map<String, Value>,
    field: &'static str,
) -> Result<u8, ControlProtocolError> {
    payload
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| u8::try_from(value).ok())
        .ok_or_else(|| {
            let _ = field;
            ControlProtocolError::terminal("processing_profile_invalid")
        })
}

fn payload_text(
    payload: &Map<String, Value>,
    field: &'static str,
) -> Result<String, ControlProtocolError> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 16 * 1024)
        .map(str::to_owned)
        .ok_or_else(|| {
            let _ = field;
            ControlProtocolError::terminal("processing_sdp_invalid")
        })
}

fn payload_sdp(
    payload: &Map<String, Value>,
    preferred: &'static str,
) -> Result<String, ControlProtocolError> {
    payload_text(payload, preferred).or_else(|_| payload_text(payload, "sdp"))
}

fn verify_transport_session(
    runtime: &ProcessingRuntime,
    media_reservation_id: &str,
    expected: &str,
) -> Result<(), ProcessingRuntimeError> {
    let snapshot = runtime
        .session(media_reservation_id)?
        .ok_or(ProcessingRuntimeError::RuntimeStateMissing)?;
    if snapshot.transport_session_id != expected {
        return Err(ProcessingRuntimeError::RuntimeStateConflict);
    }
    Ok(())
}

fn succeeded_outcome(result: ProcessingRuntimeResult) -> Value {
    json!({
        "state": "succeeded",
        "command_id": result.response_command_id,
        "applied_command_id": result.applied_command_id,
        "replayed": result.replayed,
        "transport_session_id": result.snapshot.transport_session_id,
        "effective_sdp": result.snapshot.effective_sdp,
        "session_state": session_state(result.snapshot.session.state),
        "applied_at": timestamp_from_ms(result.snapshot.updated_at_ms)
    })
}

fn unknown_outcome(command_id: &str, error_code: &str) -> Value {
    json!({
        "state": "unknown",
        "command_id": command_id,
        "error_code": error_code,
        "retryable": true
    })
}

fn runtime_failure_outcome(command_id: &str, error: &ProcessingRuntimeError) -> Value {
    let (code, retryable) = runtime_error(error);
    if matches!(
        error,
        ProcessingRuntimeError::Worker(WorkerError::ControlTimeout)
    ) {
        unknown_outcome(command_id, code)
    } else {
        failed_outcome(command_id, code, retryable)
    }
}

fn failed_outcome(command_id: &str, error_code: &str, retryable: bool) -> Value {
    json!({
        "state": "failed",
        "command_id": command_id,
        "error_code": error_code,
        "retryable": retryable
    })
}

fn session_value(snapshot: &ProcessingRuntimeSnapshot) -> Value {
    json!({
        "media_reservation_id": snapshot.session.media_reservation_id,
        "call_id": snapshot.session.call_id,
        "owner_epoch": snapshot.session.owner_epoch.to_string(),
        "last_sequence": snapshot.session.last_sequence,
        "state": session_state(snapshot.session.state),
        "transport_session_id": snapshot.transport_session_id,
        "effective_sdp": snapshot.effective_sdp,
        "expires_at": timestamp_from_ms(snapshot.session.expires_at_ms),
        "updated_at": timestamp_from_ms(snapshot.updated_at_ms)
    })
}

fn orphan_candidate_value(candidate: &crate::runtime::ProcessingRuntimeOrphanCandidate) -> Value {
    json!({
        "tenant_id": candidate.session.tenant_id,
        "call_id": candidate.session.call_id,
        "leg_id": candidate.session.leg_id,
        "cell_id": candidate.session.cell_id,
        "owner_node_id": candidate.session.owner_node_id,
        "owner_epoch": candidate.session.owner_epoch.to_string(),
        "admission_reservation_id": candidate.session.admission_reservation_id,
        "media_reservation_id": candidate.session.media_reservation_id,
        "transport_session_id": candidate.transport_session_id,
        "last_sequence": candidate.session.last_sequence,
        "expires_at": timestamp_from_ms(candidate.session.expires_at_ms),
        "state": session_state(candidate.session.state)
    })
}

fn session_state(state: ProcessingSessionState) -> &'static str {
    match state {
        ProcessingSessionState::Prepared => "prepared",
        ProcessingSessionState::Committed => "committed",
        ProcessingSessionState::Closed => "closed",
        ProcessingSessionState::Expired => "expired",
    }
}

fn runtime_error(error: &ProcessingRuntimeError) -> (&'static str, bool) {
    let code = match error {
        ProcessingRuntimeError::InvalidConfiguration { .. } => "processing_configuration_invalid",
        ProcessingRuntimeError::InvalidOperation => "processing_operation_invalid",
        ProcessingRuntimeError::InvalidSdp => "processing_sdp_invalid",
        ProcessingRuntimeError::UnsupportedSdp => "processing_sdp_unsupported",
        ProcessingRuntimeError::Session(error) => session_error_code(*error),
        ProcessingRuntimeError::Worker(error) => worker_error_code(error),
        ProcessingRuntimeError::RuntimeStatePoisoned => "processing_runtime_state_poisoned",
        ProcessingRuntimeError::RuntimeStateMissing => "processing_session_not_found",
        ProcessingRuntimeError::RuntimeStateConflict => "processing_runtime_state_conflict",
    };
    (code, error.retryable())
}

fn session_error_code(error: SessionError) -> &'static str {
    match error {
        SessionError::InvalidConfiguration { .. } => "processing_configuration_invalid",
        SessionError::InvalidCommand { .. } => "processing_command_invalid",
        SessionError::InvalidProfile => "processing_profile_invalid",
        SessionError::LeaseExpired => "processing_lease_expired",
        SessionError::LeaseHorizonExceeded => "processing_lease_horizon_exceeded",
        SessionError::SessionNotFound => "processing_session_not_found",
        SessionError::SessionCapacityExhausted { .. } => "processing_session_capacity_exhausted",
        SessionError::CodecCapacityExhausted { .. } => "processing_codec_capacity_exhausted",
        SessionError::PortCapacityExhausted => "processing_port_capacity_exhausted",
        SessionError::ReservationIdentityConflict => "processing_reservation_identity_conflict",
        SessionError::OwnerNodeConflict => "processing_owner_node_conflict",
        SessionError::StaleOwnerEpoch => "processing_stale_owner_epoch",
        SessionError::OwnerTakeoverSequenceInvalid => "processing_owner_takeover_sequence_invalid",
        SessionError::StaleSequence => "processing_stale_sequence",
        SessionError::SequenceGap { .. } => "processing_sequence_gap",
        SessionError::CommandPayloadConflict => "processing_command_payload_conflict",
        SessionError::IdempotencyKeyConflict => "processing_idempotency_key_conflict",
        SessionError::InvalidTransition => "processing_transition_invalid",
        SessionError::RegistryPoisoned => "processing_registry_poisoned",
    }
}

fn worker_error_code(error: &WorkerError) -> &'static str {
    match error {
        WorkerError::InvalidConfiguration { .. } => "processing_worker_configuration_invalid",
        WorkerError::InvalidSessionId => "processing_session_id_invalid",
        WorkerError::SessionConflict => "processing_worker_session_conflict",
        WorkerError::SessionCapacityExhausted { .. } => "processing_worker_capacity_exhausted",
        WorkerError::DatagramRetentionCapacityExhausted { .. } => {
            "processing_datagram_capacity_exhausted"
        }
        WorkerError::SessionConfigurationInvalid => {
            "processing_worker_session_configuration_invalid"
        }
        WorkerError::CommandQueueFull => "processing_command_queue_full",
        WorkerError::WorkerUnavailable => "processing_worker_unavailable",
        WorkerError::ControlTimeout => "processing_worker_control_timeout",
        WorkerError::SocketConfigurationFailed => "processing_socket_configuration_failed",
        WorkerError::SocketBindFailed => "processing_socket_bind_failed",
        WorkerError::SocketRegistrationFailed => "processing_socket_registration_failed",
        WorkerError::WorkerStartFailed => "processing_worker_start_failed",
        WorkerError::SnapshotUnavailable => "processing_worker_snapshot_unavailable",
        WorkerError::SessionNotFound => "processing_worker_session_not_found",
        WorkerError::PromptNotFound => "processing_prompt_not_found",
        WorkerError::PromptCache(_) => "processing_prompt_cache_error",
        WorkerError::Ivr(_) => "processing_ivr_error",
    }
}

fn issue_session(payload: WebRtcSessionRequest) -> Value {
    let _request_scope = (
        &payload.tenant_id,
        &payload.call_session_id,
        &payload.status,
    );
    let token = payload.token.unwrap_or_else(generate_token);
    let ttl_seconds = payload.ttl_seconds.unwrap_or(900);
    let expires_at = payload
        .expires_at
        .unwrap_or_else(|| chrono_like_expiry(ttl_seconds));
    let ice_servers = payload
        .ice_servers
        .unwrap_or_else(|| vec![json!({ "urls": "stun:stun.l.google.com:19302" })]);
    serde_json::to_value(WebRtcSessionResponse {
        token_hash: hash_token(&token),
        token,
        endpoint_id: payload.endpoint_id.unwrap_or_else(|| "browser".to_owned()),
        expires_at,
        ice_servers,
        boundary: "rust_media".to_owned(),
    })
    .unwrap_or_else(|_| json!({ "error": "encode_failed" }))
}

fn archive_recording(payload: RecordingArchiveRequest) -> Value {
    let archived_recording_url = payload.archive_url.unwrap_or_else(|| {
        payload
            .archive_url_base
            .as_ref()
            .map(|base| {
                format!(
                    "{}/{}",
                    base.trim_end_matches('/'),
                    payload
                        .provider_recording_id
                        .clone()
                        .unwrap_or_else(|| payload.recording_id.clone())
                )
            })
            .or_else(|| payload.recording_url.clone())
            .unwrap_or_default()
    });
    json!({
        "status": "archived",
        "tenant_id": payload.tenant_id,
        "recording_id": payload.recording_id,
        "provider_recording_id": payload.provider_recording_id.unwrap_or_default(),
        "archived_recording_url": archived_recording_url,
        "processed_at": now_rfc3339(),
        "boundary": "rust_media",
        "metadata": payload.metadata.unwrap_or_else(|| json!({}))
    })
}

fn purge_recording(payload: RecordingPurgeRequest) -> Value {
    json!({
        "status": "purged",
        "tenant_id": payload.tenant_id,
        "recording_id": payload.recording_id,
        "provider_recording_id": payload.provider_recording_id.unwrap_or_default(),
        "purged_recording_url": payload
            .archived_recording_url
            .or(payload.recording_url)
            .unwrap_or_default(),
        "processed_at": now_rfc3339(),
        "boundary": "rust_media",
        "metadata": payload.metadata.unwrap_or_else(|| json!({}))
    })
}

fn invalid_json(error: JsonRejection) -> Response {
    let status = error.status();
    json_response(
        status,
        json!({
            "error": "invalid_json",
            "message": error.body_text()
        }),
    )
}

fn json_response(status: StatusCode, payload: Value) -> Response {
    with_service_header((status, Json(payload)).into_response())
}

fn with_service_header(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert("x-service", HeaderValue::from_static("voice-media-rs"));
    response
}

fn generate_token() -> String {
    let mut bytes = [0_u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn hash_token(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn chrono_like_expiry(ttl_seconds: u64) -> String {
    let seconds = i64::try_from(ttl_seconds).unwrap_or(i64::MAX);
    Utc::now()
        .checked_add_signed(chrono::Duration::seconds(seconds))
        .unwrap_or(DateTime::<Utc>::MAX_UTC)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn unix_time_ms() -> u64 {
    u64::try_from(Utc::now().timestamp_millis()).unwrap_or_default()
}

fn parse_timestamp(value: &str) -> Result<u64, ControlProtocolError> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .and_then(|parsed| u64::try_from(parsed.timestamp_millis()).ok())
        .ok_or(ControlProtocolError::terminal("processing_expiry_invalid"))
}

fn timestamp_from_ms(value: u64) -> String {
    i64::try_from(value)
        .ok()
        .and_then(DateTime::<Utc>::from_timestamp_millis)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn assert_protocol(value: &str) -> Result<(), ControlProtocolError> {
    if value == CONTROL_PROTOCOL {
        Ok(())
    } else {
        Err(ControlProtocolError::terminal(
            "processing_protocol_version_unsupported",
        ))
    }
}

fn parse_u64(value: &str, code: &'static str) -> Result<u64, ControlProtocolError> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ControlProtocolError::terminal(code));
    }
    value
        .parse()
        .map_err(|_| ControlProtocolError::terminal(code))
}

fn parse_hash(value: &str, code: &'static str) -> Result<[u8; 32], ControlProtocolError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(ControlProtocolError::terminal(code));
    }
    let mut output = [0_u8; 32];
    for (index, slot) in output.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| ControlProtocolError::terminal(code))?;
    }
    Ok(output)
}

fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

fn secure_eq(left: &[u8; 32], right: &[u8; 32]) -> bool {
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn render_metrics(
    state: &VoiceMediaHttpState,
    worker: Option<crate::worker::RtpWorkerPoolSnapshot>,
    active_sessions: usize,
    total_sessions: usize,
    available_ports: usize,
) -> String {
    let worker = worker.unwrap_or_default();
    format!(
        "# TYPE ivekit_voice_processing_commands_total counter\n\
         ivekit_voice_processing_commands_total{{result=\"succeeded\"}} {}\n\
         ivekit_voice_processing_commands_total{{result=\"failed\"}} {}\n\
         # TYPE ivekit_voice_processing_control_rejected_total counter\n\
         ivekit_voice_processing_control_rejected_total {}\n\
         # TYPE ivekit_voice_processing_sessions gauge\n\
         ivekit_voice_processing_sessions{{result=\"active\"}} {active_sessions}\n\
         ivekit_voice_processing_sessions{{result=\"retained\"}} {total_sessions}\n\
         # TYPE ivekit_voice_processing_rtp_packets_total counter\n\
         ivekit_voice_processing_rtp_packets_total{{direction=\"received\"}} {}\n\
         ivekit_voice_processing_rtp_packets_total{{direction=\"sent\"}} {}\n\
         # TYPE ivekit_voice_processing_queue_dropped_total counter\n\
         ivekit_voice_processing_queue_dropped_total{{result=\"telemetry\"}} {}\n\
         # TYPE ivekit_voice_processing_rtp_ports_available gauge\n\
         ivekit_voice_processing_rtp_ports_available {available_ports}\n\
         # TYPE ivekit_voice_processing_datagram_retention gauge\n\
         ivekit_voice_processing_datagram_retention{{result=\"used\"}} {}\n\
         ivekit_voice_processing_datagram_retention{{result=\"limit\"}} {}\n",
        state
            .inner
            .metrics
            .commands_succeeded
            .load(Ordering::Relaxed),
        state.inner.metrics.commands_failed.load(Ordering::Relaxed),
        state
            .inner
            .metrics
            .requests_rejected
            .load(Ordering::Relaxed),
        worker.rtp_datagrams_received,
        worker.rtp_datagrams_sent,
        worker.event_queue_drops,
        worker.datagram_retention_used,
        worker.datagram_retention_limit
    )
}

#[derive(Debug, Clone)]
struct ServerConfiguration {
    listen: SocketAddr,
    http: VoiceMediaHttpConfig,
    runtime: ProcessingRuntimeConfig,
    codec_pair_capacity: usize,
    sweep_interval: Duration,
    sweep_limit: usize,
}

impl ServerConfiguration {
    fn from_env() -> Result<Self, VoiceMediaHttpError> {
        let worker_count = checked_nonzero_usize(
            env_value("VOICE_MEDIA_WORKER_THREADS")?.unwrap_or_else(|| {
                std::thread::available_parallelism()
                    .map(usize::from)
                    .unwrap_or(1)
            }),
            "worker_count",
        )?;
        let max_sessions = checked_nonzero_usize(
            env_value("VOICE_MEDIA_MAX_SESSIONS")?.unwrap_or(10_000),
            "max_sessions",
        )?;
        let jitter_capacity = checked_nonzero_usize(
            env_value("VOICE_MEDIA_JITTER_CAPACITY")?.unwrap_or(8),
            "jitter_capacity",
        )?;
        let datagram_pool_max = max_sessions
            .checked_mul(2)
            .and_then(|value| value.checked_mul(jitter_capacity))
            .and_then(|value| value.checked_add(worker_count))
            .ok_or(VoiceMediaHttpError::InvalidConfiguration(
                "datagram_pool_max",
            ))?;
        let allow_unauthenticated =
            env::var("VOICE_MEDIA_ALLOW_UNAUTHENTICATED").as_deref() == Ok("1");
        let bearer_token = env_secret("VOICE_MEDIA_API_TOKEN", "VOICE_MEDIA_API_TOKEN_FILE")?;
        if bearer_token.is_none() && !allow_unauthenticated {
            return Err(VoiceMediaHttpError::Environment {
                field: "VOICE_MEDIA_API_TOKEN".to_owned(),
                message: "required unless VOICE_MEDIA_ALLOW_UNAUTHENTICATED=1".to_owned(),
            });
        }
        let bind_ip: std::net::IpAddr = env_parse("VOICE_MEDIA_RTP_BIND_IP", "0.0.0.0")?;
        let advertised_ip: std::net::IpAddr =
            env_parse("VOICE_MEDIA_RTP_ADVERTISED_IP", "127.0.0.1")?;
        let rtp_port_start: u16 = env_value("VOICE_MEDIA_RTP_PORT_START")?.unwrap_or(20_000);
        let rtp_port_end: u16 = env_value("VOICE_MEDIA_RTP_PORT_END")?.unwrap_or(59_998);
        let max_sessions_per_worker = max_sessions.div_ceil(worker_count);
        let sweep_interval_ms: u64 = env_value("VOICE_MEDIA_SWEEP_INTERVAL_MS")?.unwrap_or(1_000);
        let sweep_limit: usize = env_value("VOICE_MEDIA_SWEEP_LIMIT")?.unwrap_or(1_024);
        let codec_pair_capacity = checked_nonzero_usize(
            env_value("VOICE_MEDIA_CODEC_PAIR_CAPACITY")?.unwrap_or(max_sessions),
            "codec_pair_capacity",
        )?;
        if sweep_interval_ms == 0 {
            return Err(VoiceMediaHttpError::InvalidConfiguration("sweep_interval"));
        }
        if sweep_limit == 0 {
            return Err(VoiceMediaHttpError::InvalidConfiguration("sweep_limit"));
        }
        Ok(Self {
            listen: env_parse(
                "VOICE_MEDIA_LISTEN",
                &format!(
                    "0.0.0.0:{}",
                    env::var("PORT").unwrap_or_else(|_| "8093".to_owned())
                ),
            )?,
            http: VoiceMediaHttpConfig {
                bearer_token,
                required_client_identity: env::var("VOICE_MEDIA_CLIENT_IDENTITY")
                    .ok()
                    .filter(|value| !value.is_empty()),
                max_body_bytes: env_value("VOICE_MEDIA_MAX_BODY_BYTES")?.unwrap_or(128 * 1024),
                max_inflight_requests: env_value("VOICE_MEDIA_MAX_INFLIGHT_CONTROL")?
                    .unwrap_or(1_024),
            },
            runtime: ProcessingRuntimeConfig {
                bind_ip,
                advertised_ip,
                registry: ProcessingSessionRegistryConfig {
                    max_sessions,
                    max_commands_per_session: env_value("VOICE_MEDIA_COMMAND_HISTORY_PER_SESSION")?
                        .unwrap_or(32),
                    terminal_retention_ms: env_value("VOICE_MEDIA_TERMINAL_RETENTION_MS")?
                        .unwrap_or(300_000),
                    max_lease_horizon_ms: env_value("VOICE_MEDIA_MAX_LEASE_HORIZON_MS")?
                        .unwrap_or(86_400_000),
                    shard_count: env_value("VOICE_MEDIA_SESSION_SHARDS")?
                        .unwrap_or(default_shard_count(worker_count)?),
                    rtp_port_start,
                    rtp_port_end,
                },
                workers: RtpWorkerPoolConfig {
                    worker_count,
                    max_sessions_per_worker,
                    command_queue_capacity: env_value("VOICE_MEDIA_WORKER_COMMAND_QUEUE")?
                        .unwrap_or(4_096),
                    event_queue_capacity: env_value("VOICE_MEDIA_EVENT_QUEUE")?.unwrap_or(16_384),
                    critical_event_capacity: env_value("VOICE_MEDIA_CRITICAL_EVENT_QUEUE")?
                        .unwrap_or(max_sessions.saturating_mul(2)),
                    poll_event_capacity: env_value("VOICE_MEDIA_POLL_EVENT_CAPACITY")?
                        .unwrap_or(1_024),
                    max_commands_per_tick: env_value("VOICE_MEDIA_COMMANDS_PER_TICK")?
                        .unwrap_or(256),
                    max_critical_events_per_tick: env_value(
                        "VOICE_MEDIA_CRITICAL_EVENTS_PER_TICK",
                    )?
                    .unwrap_or(256),
                    max_packets_per_socket_event: env_value(
                        "VOICE_MEDIA_PACKETS_PER_SOCKET_EVENT",
                    )?
                    .unwrap_or(64),
                    max_datagram_bytes: env_value("VOICE_MEDIA_MAX_DATAGRAM_BYTES")?
                        .unwrap_or(2_048),
                    datagram_pool_initial: env_value("VOICE_MEDIA_DATAGRAM_POOL_INITIAL")?
                        .unwrap_or(datagram_pool_max.min(4_096)),
                    datagram_pool_max,
                    socket_receive_buffer_bytes: env_value(
                        "VOICE_MEDIA_SOCKET_RECEIVE_BUFFER_BYTES",
                    )?
                    .unwrap_or(8 * 1024 * 1024),
                    socket_send_buffer_bytes: env_value("VOICE_MEDIA_SOCKET_SEND_BUFFER_BYTES")?
                        .unwrap_or(8 * 1024 * 1024),
                    reuse_port: env::var("VOICE_MEDIA_REUSE_PORT").as_deref() != Ok("0"),
                    poll_timeout: Duration::from_millis(
                        env_value("VOICE_MEDIA_POLL_TIMEOUT_MS")?.unwrap_or(5),
                    ),
                    control_timeout: Duration::from_millis(
                        env_value("VOICE_MEDIA_CONTROL_TIMEOUT_MS")?.unwrap_or(2_000),
                    ),
                    ivr_prompt_cache: IvrPromptCacheConfig {
                        max_prompts: env_value("VOICE_MEDIA_MAX_PROMPTS")?.unwrap_or(64),
                        max_frames_per_prompt: env_value("VOICE_MEDIA_MAX_PROMPT_FRAMES")?
                            .unwrap_or(500),
                        max_total_pcm_samples: env_value("VOICE_MEDIA_MAX_PROMPT_PCM_SAMPLES")?
                            .unwrap_or(64 * 500 * 960),
                    },
                    ivr_session: IvrSessionConfig {
                        max_command_history: env_value("VOICE_MEDIA_IVR_COMMAND_HISTORY")?
                            .unwrap_or(64),
                        max_digit_history: env_value("VOICE_MEDIA_IVR_DIGIT_HISTORY")?
                            .unwrap_or(64),
                        max_gather_digits: env_value("VOICE_MEDIA_MAX_GATHER_DIGITS")?
                            .unwrap_or(64),
                    },
                    max_ivr_sessions_per_tick: env_value("VOICE_MEDIA_IVR_SESSIONS_PER_TICK")?
                        .unwrap_or(256),
                },
                jitter_capacity,
                jitter_wait_depth: env_value("VOICE_MEDIA_JITTER_WAIT_DEPTH")?.unwrap_or(2),
                max_drain_per_datagram: env_value("VOICE_MEDIA_MAX_DRAIN_PER_DATAGRAM")?
                    .unwrap_or(default_max_drain_per_datagram(jitter_capacity)),
                max_conceal_frames: env_value("VOICE_MEDIA_MAX_CONCEAL_FRAMES")?.unwrap_or(3),
                source_rebind_after_ms: env_value("VOICE_MEDIA_SOURCE_REBIND_MS")?.unwrap_or(2_000),
            },
            codec_pair_capacity,
            sweep_interval: Duration::from_millis(sweep_interval_ms),
            sweep_limit,
        })
    }
}

fn checked_nonzero_usize(value: usize, field: &'static str) -> Result<usize, VoiceMediaHttpError> {
    if value == 0 {
        return Err(VoiceMediaHttpError::InvalidConfiguration(field));
    }
    Ok(value)
}

fn default_shard_count(worker_count: usize) -> Result<usize, VoiceMediaHttpError> {
    worker_count
        .checked_mul(8)
        .and_then(|value| value.checked_next_power_of_two())
        .ok_or(VoiceMediaHttpError::InvalidConfiguration("shard_count"))
}

fn default_max_drain_per_datagram(jitter_capacity: usize) -> usize {
    jitter_capacity.min(16)
}

fn env_value<T>(field: &str) -> Result<Option<T>, VoiceMediaHttpError>
where
    T: FromStr,
    T::Err: Display,
{
    match env::var(field) {
        Ok(value) => {
            value
                .parse::<T>()
                .map(Some)
                .map_err(|error| VoiceMediaHttpError::Environment {
                    field: field.to_owned(),
                    message: error.to_string(),
                })
        }
        Err(env::VarError::NotPresent) => Ok(None),
        Err(error) => Err(VoiceMediaHttpError::Environment {
            field: field.to_owned(),
            message: error.to_string(),
        }),
    }
}

fn env_secret(
    value_field: &'static str,
    file_field: &'static str,
) -> Result<Option<String>, VoiceMediaHttpError> {
    let value = match env::var(value_field) {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => None,
        Err(error) => {
            return Err(VoiceMediaHttpError::Environment {
                field: value_field.to_owned(),
                message: error.to_string(),
            });
        }
    };
    let file_path = match env::var(file_field) {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => None,
        Err(error) => {
            return Err(VoiceMediaHttpError::Environment {
                field: file_field.to_owned(),
                message: error.to_string(),
            });
        }
    };
    if value.is_some() && file_path.is_some() {
        return Err(VoiceMediaHttpError::Environment {
            field: value_field.to_owned(),
            message: format!("{value_field} and {file_field} are mutually exclusive"),
        });
    }
    let Some(value) = value else {
        let Some(path) = file_path else {
            return Ok(None);
        };
        let file = std::fs::File::open(path).map_err(|error| VoiceMediaHttpError::Environment {
            field: file_field.to_owned(),
            message: error.to_string(),
        })?;
        let mut bytes = Vec::with_capacity(512);
        file.take(4_097).read_to_end(&mut bytes).map_err(|error| {
            VoiceMediaHttpError::Environment {
                field: file_field.to_owned(),
                message: error.to_string(),
            }
        })?;
        if bytes.len() > 4_096 {
            return Err(VoiceMediaHttpError::Environment {
                field: file_field.to_owned(),
                message: "secret exceeds 4096 bytes".to_owned(),
            });
        }
        let value = String::from_utf8(bytes).map_err(|error| VoiceMediaHttpError::Environment {
            field: file_field.to_owned(),
            message: error.to_string(),
        })?;
        return validated_secret(value, file_field).map(Some);
    };
    validated_secret(value, value_field).map(Some)
}

fn validated_secret(value: String, field: &'static str) -> Result<String, VoiceMediaHttpError> {
    let value = value.trim().to_owned();
    if value.is_empty() || value.len() > 4_096 || value.chars().any(char::is_control) {
        return Err(VoiceMediaHttpError::Environment {
            field: field.to_owned(),
            message: "secret is empty, oversized, or contains control characters".to_owned(),
        });
    }
    Ok(value)
}

fn env_parse<T>(field: &str, fallback: &str) -> Result<T, VoiceMediaHttpError>
where
    T: FromStr,
    T::Err: Display,
{
    env::var(field)
        .unwrap_or_else(|_| fallback.to_owned())
        .parse::<T>()
        .map_err(|error| VoiceMediaHttpError::Environment {
            field: field.to_owned(),
            message: error.to_string(),
        })
}

fn spawn_sweeper(runtime: Arc<ProcessingRuntime>, interval: Duration, limit: usize) {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(interval);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            let runtime = runtime.clone();
            let result =
                tokio::task::spawn_blocking(move || runtime.sweep(unix_time_ms(), limit)).await;
            if let Ok(Err(error)) = result {
                eprintln!("voice media session sweep failed: {error}");
            }
        }
    });
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = terminate.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_and_metrics_use_capacity_but_health_stays_constant_time() {
        assert!(!request_uses_capacity(&Method::GET, "/health"));
        assert!(request_uses_capacity(&Method::GET, "/ready"));
        assert!(request_uses_capacity(&Method::GET, "/metrics"));
        assert!(request_uses_capacity(&Method::POST, "/v1/commands"));
    }

    #[test]
    fn generated_defaults_are_valid_for_non_power_of_two_cpu_counts() {
        assert_eq!(default_shard_count(1).expect("one worker"), 8);
        assert_eq!(default_shard_count(10).expect("ten workers"), 128);
        assert_eq!(default_shard_count(16).expect("sixteen workers"), 128);
        assert_eq!(default_max_drain_per_datagram(8), 8);
        assert_eq!(default_max_drain_per_datagram(32), 16);
    }

    #[test]
    fn zero_codec_capacity_is_rejected_before_runtime_startup() {
        assert!(checked_nonzero_usize(0, "codec_pair_capacity").is_err());
        assert_eq!(
            checked_nonzero_usize(1, "codec_pair_capacity").expect("capacity"),
            1
        );
    }

    #[test]
    fn secret_files_allow_one_trailing_newline_but_reject_controls() {
        assert_eq!(
            validated_secret("processing-token\n".to_owned(), "token").expect("secret"),
            "processing-token"
        );
        assert!(validated_secret("processing\0token".to_owned(), "token").is_err());
    }

    #[test]
    fn worker_control_timeout_projects_an_unknown_outcome() {
        let outcome = runtime_failure_outcome(
            "command-a",
            &ProcessingRuntimeError::Worker(WorkerError::ControlTimeout),
        );
        assert_eq!(outcome["state"], "unknown");
        assert_eq!(outcome["error_code"], "processing_worker_control_timeout");
        assert_eq!(outcome["retryable"], true);
    }
}
