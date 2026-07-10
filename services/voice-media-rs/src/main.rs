use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{SecondsFormat, Utc};
use rand::RngCore;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use tiny_http::{Header, Method, Response, Server, StatusCode};

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

fn main() {
    let port = env::var("PORT").unwrap_or_else(|_| "8093".to_string());
    let address = format!("0.0.0.0:{}", port);
    let server = Server::http(&address).expect("failed to bind voice-media-rs");
    println!("voice-media-rs listening on :{}", port);

    for mut request in server.incoming_requests() {
        let method = request.method().clone();
        let url = request.url().to_string();
        let response = if requires_auth(&method, &url) && !authorize_request(&request) {
            json_response(
                StatusCode(401),
                json!({ "error": "unauthorized", "message": "voice media bearer token required" }),
            )
        } else {
            match (method, url.as_str()) {
                (Method::Get, "/health") => json_response(
                StatusCode(200),
                json!({
                    "status": "ok",
                    "service": "voice-media-rs",
                    "capabilities": {
                        "webrtc_session_create": "ready",
                        "recording_archive": "ready",
                        "recording_purge": "ready",
                        "gather_digits": "stub_experimental"
                    }
                }),
            ),
                (Method::Post, "/webrtc/session/create") => {
                    handle_json_request::<WebRtcSessionRequest, _>(&mut request, issue_session)
                }
                (Method::Post, "/recordings/archive") => {
                    handle_json_request::<RecordingArchiveRequest, _>(&mut request, archive_recording)
                }
                (Method::Post, "/recordings/purge") => {
                    handle_json_request::<RecordingPurgeRequest, _>(&mut request, purge_recording)
                }
                (Method::Post, "/ivr/gather-digits") => json_response(
                    StatusCode(501),
                    json!({
                        "error": "not_implemented",
                        "status": "stub_experimental",
                        "message": "DTMF gather-digits is not implemented; use RustPBX/LiveKit SIP media for production digit collection."
                    }),
                ),
                _ => json_response(StatusCode(404), json!({ "error": "not_found" })),
            }
        };
        let _ = request.respond(response);
    }
}

fn issue_session(payload: WebRtcSessionRequest) -> Value {
    let _request_scope = (&payload.tenant_id, &payload.call_session_id, &payload.status);
    let token = payload.token.unwrap_or_else(generate_token);
    let ttl_seconds = payload.ttl_seconds.unwrap_or(900);
    let expires_at = payload.expires_at.unwrap_or_else(|| {
        chrono_like_expiry(ttl_seconds)
    });
    let ice_servers = payload
        .ice_servers
        .unwrap_or_else(|| vec![json!({ "urls": "stun:stun.l.google.com:19302" })]);
    let response = WebRtcSessionResponse {
        token_hash: hash_token(&token),
        token,
        endpoint_id: payload.endpoint_id.unwrap_or_else(|| "browser".to_string()),
        expires_at,
        ice_servers,
        boundary: "rust_media".to_string(),
    };
    serde_json::to_value(response).unwrap_or_else(|_| json!({ "error": "encode_failed" }))
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

fn generate_token() -> String {
    let mut bytes = [0_u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn chrono_like_expiry(ttl_seconds: u64) -> String {
    (Utc::now() + chrono::Duration::seconds(ttl_seconds as i64)).to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn requires_auth(method: &Method, url: &str) -> bool {
    matches!(method, Method::Post)
        && matches!(
            url,
            "/webrtc/session/create" | "/recordings/archive" | "/recordings/purge"
        )
}

fn authorize_request(request: &tiny_http::Request) -> bool {
    let required = match env::var("VOICE_MEDIA_API_TOKEN") {
        Ok(value) if !value.is_empty() => value,
        _ => return true,
    };
    let header = request
        .headers()
        .iter()
        .find(|value| value.field.equiv("Authorization"))
        .map(|value| value.value.as_str())
        .unwrap_or("");
    let provided = header.strip_prefix("Bearer ").unwrap_or("");
    provided == required
}

fn handle_json_request<T, F>(request: &mut tiny_http::Request, handler: F) -> Response<std::io::Cursor<Vec<u8>>>
where
    T: DeserializeOwned,
    F: FnOnce(T) -> Value,
{
    match read_json_body::<T>(request) {
        Ok(payload) => json_response(StatusCode(200), handler(payload)),
        Err(error) => json_response(
            StatusCode(400),
            json!({ "error": "invalid_json", "message": error }),
        ),
    }
}

fn read_json_body<T>(request: &mut tiny_http::Request) -> Result<T, String>
where
    T: DeserializeOwned,
{
    let mut body = String::new();
    request
        .as_reader()
        .read_to_string(&mut body)
        .map_err(|error| error.to_string())?;
    serde_json::from_str::<T>(&body).map_err(|error| error.to_string())
}

fn json_response(status: StatusCode, payload: Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = serde_json::to_vec(&payload).unwrap_or_else(|_| b"{\"error\":\"encode_failed\"}".to_vec());
    let mut response = Response::from_data(body).with_status_code(status);
    response.add_header(
        Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).expect("content type header"),
    );
    response.add_header(Header::from_bytes(&b"X-Service"[..], &b"voice-media-rs"[..]).expect("service header"));
    response
}
