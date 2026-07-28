use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use chrono::{Duration as ChronoDuration, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tower::ServiceExt;
use voice_media_rs::capacity::CodecPairCapacity;
use voice_media_rs::http::{router, VoiceMediaHttpConfig, VoiceMediaHttpState};
use voice_media_rs::ivr::{IvrPromptCacheConfig, IvrSessionConfig};
use voice_media_rs::runtime::{ProcessingRuntime, ProcessingRuntimeConfig};
use voice_media_rs::session::ProcessingSessionRegistryConfig;
use voice_media_rs::worker::RtpWorkerPoolConfig;

fn localhost(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

static NEXT_RTP_PORT: AtomicUsize = AtomicUsize::new(30_000);

fn free_even_pair() -> (u16, u16) {
    loop {
        let start = NEXT_RTP_PORT.fetch_add(4, Ordering::Relaxed);
        if start > 39_996 {
            panic!("no free even UDP pair");
        }
        let start = u16::try_from(start).expect("RTP test port");
        let Ok(first) = UdpSocket::bind(localhost(start)) else {
            continue;
        };
        let Ok(second) = UdpSocket::bind(localhost(start + 2)) else {
            continue;
        };
        drop(first);
        drop(second);
        return (start, start + 2);
    }
}

fn runtime() -> Arc<ProcessingRuntime> {
    let (port_start, port_end) = free_even_pair();
    Arc::new(
        ProcessingRuntime::new(
            ProcessingRuntimeConfig {
                bind_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
                advertised_ip: IpAddr::V4(Ipv4Addr::new(203, 0, 113, 10)),
                registry: ProcessingSessionRegistryConfig {
                    max_sessions: 4,
                    max_commands_per_session: 8,
                    terminal_retention_ms: 100,
                    max_lease_horizon_ms: 60_000,
                    shard_count: 4,
                    rtp_port_start: port_start,
                    rtp_port_end: port_end,
                },
                workers: RtpWorkerPoolConfig {
                    worker_count: 1,
                    max_sessions_per_worker: 4,
                    command_queue_capacity: 16,
                    event_queue_capacity: 16,
                    critical_event_capacity: 16,
                    poll_event_capacity: 64,
                    max_commands_per_tick: 16,
                    max_critical_events_per_tick: 16,
                    max_packets_per_socket_event: 8,
                    max_datagram_bytes: 2_048,
                    datagram_pool_initial: 16,
                    datagram_pool_max: 128,
                    socket_receive_buffer_bytes: 1 << 20,
                    socket_send_buffer_bytes: 1 << 20,
                    reuse_port: false,
                    poll_timeout: Duration::from_millis(20),
                    control_timeout: Duration::from_secs(2),
                    ivr_prompt_cache: IvrPromptCacheConfig {
                        max_prompts: 8,
                        max_frames_per_prompt: 100,
                        max_total_pcm_samples: 8 * 100 * 960,
                    },
                    ivr_session: IvrSessionConfig {
                        max_command_history: 16,
                        max_digit_history: 16,
                        max_gather_digits: 16,
                    },
                    max_ivr_sessions_per_tick: 4,
                },
                jitter_capacity: 8,
                jitter_wait_depth: 2,
                max_drain_per_datagram: 8,
                max_conceal_frames: 2,
                source_rebind_after_ms: 1_000,
            },
            Arc::new(CodecPairCapacity::uniform(4)),
        )
        .expect("runtime"),
    )
}

fn app_with(config: VoiceMediaHttpConfig) -> axum::Router {
    router(VoiceMediaHttpState::new(runtime(), config).expect("HTTP state"))
}

fn app() -> axum::Router {
    app_with(VoiceMediaHttpConfig {
        bearer_token: Some("test-token".to_owned()),
        required_client_identity: None,
        max_body_bytes: 32 * 1024,
        max_inflight_requests: 4,
    })
}

fn offer() -> Value {
    let expires_at =
        (Utc::now() + ChronoDuration::seconds(30)).to_rfc3339_opts(SecondsFormat::Millis, true);
    json!({
        "protocol_version": "ivekit.processing-control.v1",
        "action": "offer",
        "command_id": "cmd-1",
        "tenant_id": "tenant-a",
        "call_id": "call-a",
        "leg_id": "leg-a",
        "cell_id": "cell-a",
        "owner_node_id": "owner-a",
        "owner_epoch": "1",
        "admission_reservation_id": "admission-a",
        "media_reservation_id": "media-a",
        "expires_at": expires_at,
        "command_sequence": 1,
        "idempotency_key": "idem-1",
        "payload_hash": "4141414141414141414141414141414141414141414141414141414141414141",
        "command_hash": "0101010101010101010101010101010101010101010101010101010101010101",
        "payload": {
            "offer_sdp": "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=offer\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio 40000 RTP/AVP 0 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\na=fmtp:101 0-16\r\na=sendrecv\r\na=ptime:20\r\n",
            "media_profile_id": "VOICE-IVR-G711-OPUS-V1",
            "leg_a_codec": "PCMU",
            "leg_b_codec": "OPUS",
            "leg_a_payload_type": 0,
            "leg_b_payload_type": 111,
            "packetization_ms": 20
        }
    })
}

async fn json_body(response: axum::response::Response) -> Value {
    let body = to_bytes(response.into_body(), 128 * 1024)
        .await
        .expect("response body");
    serde_json::from_slice(&body).expect("JSON response")
}

#[tokio::test]
async fn health_is_public_but_processing_commands_require_authentication() {
    let service = app();
    let health = service
        .clone()
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .expect("health request"),
        )
        .await
        .expect("health response");
    assert_eq!(health.status(), StatusCode::OK);
    let health_body = json_body(health).await;
    assert_eq!(health_body["capabilities"]["processing_runtime"], "ready");

    let unauthorized = service
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/commands")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(offer().to_string()))
                .expect("command request"),
        )
        .await
        .expect("command response");
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn configured_client_identity_is_required_in_addition_to_bearer_authentication() {
    let service = app_with(VoiceMediaHttpConfig {
        bearer_token: Some("test-token".to_owned()),
        required_client_identity: Some("trusted-sidecar".to_owned()),
        max_body_bytes: 32 * 1024,
        max_inflight_requests: 4,
    });
    let bearer_only = service
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/commands")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::from(offer().to_string()))
                .expect("command request"),
        )
        .await
        .expect("command response");
    assert_eq!(bearer_only.status(), StatusCode::UNAUTHORIZED);

    let authorized = service
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/commands")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .header("x-ivekit-client-identity", "trusted-sidecar")
                .body(Body::from(offer().to_string()))
                .expect("command request"),
        )
        .await
        .expect("command response");
    assert_eq!(authorized.status(), StatusCode::OK);
}

#[tokio::test]
async fn oversized_control_payload_is_rejected_with_payload_too_large() {
    let service = app_with(VoiceMediaHttpConfig {
        bearer_token: Some("test-token".to_owned()),
        required_client_identity: None,
        max_body_bytes: 1_024,
        max_inflight_requests: 4,
    });
    let response = service
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/commands")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::from(vec![b' '; 2_048]))
                .expect("command request"),
        )
        .await
        .expect("command response");
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn control_protocol_rejects_noncanonical_hashes_and_decimal_fields() {
    let mut uppercase_hash = offer();
    uppercase_hash["payload_hash"] = Value::String("AB".repeat(32));
    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/commands")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::from(uppercase_hash.to_string()))
                .expect("command request"),
        )
        .await
        .expect("command response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["state"], "failed");
    assert_eq!(body["error_code"], "processing_payload_hash_invalid");

    let mut leading_zero_epoch = offer();
    leading_zero_epoch["owner_epoch"] = Value::String("01".to_owned());
    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/commands")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::from(leading_zero_epoch.to_string()))
                .expect("command request"),
        )
        .await
        .expect("command response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["state"], "failed");
    assert_eq!(body["error_code"], "processing_owner_epoch_invalid");
}

#[tokio::test]
async fn readiness_and_metrics_are_public_and_metrics_remain_aggregate_only() {
    let service = app();
    let ready = service
        .clone()
        .oneshot(
            Request::builder()
                .uri("/ready")
                .body(Body::empty())
                .expect("readiness request"),
        )
        .await
        .expect("readiness response");
    assert_eq!(ready.status(), StatusCode::OK);

    let metrics = service
        .oneshot(
            Request::builder()
                .uri("/metrics")
                .body(Body::empty())
                .expect("metrics request"),
        )
        .await
        .expect("metrics response");
    assert_eq!(metrics.status(), StatusCode::OK);
    let body = to_bytes(metrics.into_body(), 128 * 1024)
        .await
        .expect("metrics body");
    let body = std::str::from_utf8(&body).expect("UTF-8 metrics");
    assert!(body.contains("ivekit_voice_processing_sessions"));
    for forbidden in ["tenant_id", "call_id", "reservation_id", "ssrc"] {
        assert!(
            !body.contains(forbidden),
            "metrics must not contain high-cardinality field {forbidden}"
        );
    }
}

#[tokio::test]
async fn processing_offer_reconciles_to_the_exact_historical_outcome() {
    let service = app();
    let applied = service
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/commands")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::from(offer().to_string()))
                .expect("offer request"),
        )
        .await
        .expect("offer response");
    assert_eq!(applied.status(), StatusCode::OK);
    let applied_body = json_body(applied).await;
    assert_eq!(applied_body["state"], "succeeded");
    assert_eq!(applied_body["session_state"], "prepared");
    assert!(applied_body["transport_session_id"]
        .as_str()
        .expect("transport ID")
        .starts_with("processing:"));
    assert!(applied_body["effective_sdp"]
        .as_str()
        .expect("effective SDP")
        .contains("m=audio"));

    let reconciled = service
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/reconcile")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::from(
                    json!({
                        "protocol_version": "ivekit.processing-control.v1",
                        "command_id": "cmd-1",
                        "media_reservation_id": "media-a",
                        "owner_epoch": "1",
                        "command_hash": "0101010101010101010101010101010101010101010101010101010101010101"
                    })
                    .to_string(),
                ))
                .expect("reconcile request"),
        )
        .await
        .expect("reconcile response");
    assert_eq!(reconciled.status(), StatusCode::OK);
    let reconciled_body = json_body(reconciled).await;
    assert_eq!(reconciled_body["found"], true);
    assert_eq!(
        reconciled_body["outcome"]["effective_sdp"],
        applied_body["effective_sdp"]
    );
}

#[tokio::test]
async fn active_session_scan_returns_the_complete_release_fence() {
    let service = app();
    let applied = service
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/commands")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::from(offer().to_string()))
                .expect("offer request"),
        )
        .await
        .expect("offer response");
    assert_eq!(applied.status(), StatusCode::OK);

    let scanned = service
        .oneshot(
            Request::builder()
                .uri("/v1/sessions?limit=1")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::empty())
                .expect("scan request"),
        )
        .await
        .expect("scan response");
    assert_eq!(scanned.status(), StatusCode::OK);
    let body = json_body(scanned).await;
    assert_eq!(body["items"][0]["tenant_id"], "tenant-a");
    assert_eq!(body["items"][0]["owner_epoch"], "1");
    assert_eq!(body["items"][0]["admission_reservation_id"], "admission-a");
    assert_eq!(body["items"][0]["media_reservation_id"], "media-a");
    assert_eq!(body["items"][0]["last_sequence"], 1);
    assert_eq!(body["items"][0]["state"], "prepared");
    assert_eq!(body["next_cursor"], "media-a");
    assert_eq!(body["inspected"], 1);
}

#[tokio::test]
async fn idempotency_alias_can_be_reconciled_by_its_own_command_identity() {
    let service = app();
    let first = service
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/commands")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::from(offer().to_string()))
                .expect("offer request"),
        )
        .await
        .expect("offer response");
    assert_eq!(first.status(), StatusCode::OK);

    let mut replay = offer();
    replay["command_id"] = Value::String("cmd-alias".to_owned());
    replay["command_hash"] = Value::String(
        "0202020202020202020202020202020202020202020202020202020202020202".to_owned(),
    );
    let replayed = service
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/commands")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::from(replay.to_string()))
                .expect("replay request"),
        )
        .await
        .expect("replay response");
    assert_eq!(replayed.status(), StatusCode::OK);
    let replayed_body = json_body(replayed).await;
    assert_eq!(replayed_body["command_id"], "cmd-alias");
    assert_eq!(replayed_body["applied_command_id"], "cmd-1");
    assert_eq!(replayed_body["replayed"], true);

    let reconciled = service
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/reconcile")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::from(
                    json!({
                        "protocol_version": "ivekit.processing-control.v1",
                        "command_id": "cmd-alias",
                        "media_reservation_id": "media-a",
                        "owner_epoch": "1",
                        "command_hash": "0202020202020202020202020202020202020202020202020202020202020202"
                    })
                    .to_string(),
                ))
                .expect("reconcile request"),
        )
        .await
        .expect("reconcile response");
    assert_eq!(reconciled.status(), StatusCode::OK);
    let reconciled_body = json_body(reconciled).await;
    assert_eq!(reconciled_body["found"], true);
    assert_eq!(reconciled_body["outcome"]["applied_command_id"], "cmd-1");
}

#[tokio::test]
async fn legacy_webrtc_session_endpoint_remains_compatible() {
    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/webrtc/session/create")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::from(
                    json!({
                        "tenant_id": "tenant-a",
                        "endpoint_id": "browser-a",
                        "ttl_seconds": 60
                    })
                    .to_string(),
                ))
                .expect("WebRTC request"),
        )
        .await
        .expect("WebRTC response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["endpoint_id"], "browser-a");
    assert_eq!(body["boundary"], "rust_media");
    assert_eq!(body["token_hash"].as_str().expect("token hash").len(), 64);
}

#[tokio::test]
async fn legacy_gather_digits_endpoint_remains_an_explicit_stub() {
    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/ivr/gather-digits")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::from("{}"))
                .expect("gather request"),
        )
        .await
        .expect("gather response");
    assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
    let body = json_body(response).await;
    assert_eq!(body["error"], "not_implemented");
    assert_eq!(body["status"], "stub_experimental");
}
