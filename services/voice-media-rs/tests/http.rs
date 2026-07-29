use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use chrono::{Duration as ChronoDuration, SecondsFormat, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tower::ServiceExt;
use voice_media_rs::capacity::CodecPairCapacity;
use voice_media_rs::event_outbox::{
    ProcessingEventOutbox, ProcessingEventOutboxConfig, ProcessingTerminalEvent,
    ProcessingTerminalEventInput,
};
use voice_media_rs::http::{router, VoiceMediaHttpConfig, VoiceMediaHttpState};
use voice_media_rs::ivr::{IvrPromptCacheConfig, IvrSessionConfig};
use voice_media_rs::runtime::{ProcessingRuntime, ProcessingRuntimeConfig};
use voice_media_rs::session::ProcessingSessionRegistryConfig;
use voice_media_rs::worker::RtpWorkerPoolConfig;

fn localhost(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

static NEXT_RTP_PORT: AtomicUsize = AtomicUsize::new(30_000);
static NEXT_EVENT_DIRECTORY: AtomicUsize = AtomicUsize::new(1);

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
        max_prompt_body_bytes: 512 * 1024,
        max_inflight_requests: 4,
        max_inflight_prompt_requests: 2,
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

async fn authenticated_command(service: axum::Router, body: Value) -> axum::response::Response {
    service
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/commands")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::from(body.to_string()))
                .expect("command request"),
        )
        .await
        .expect("command response")
}

fn pcm16le(samples: &[i16]) -> Vec<u8> {
    samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect()
}

fn sha256_hex(body: &[u8]) -> String {
    format!("{:x}", Sha256::digest(body))
}

async fn put_prompt(
    service: axum::Router,
    prompt_id: &str,
    body: Vec<u8>,
    digest: &str,
    authenticated: bool,
) -> axum::response::Response {
    let mut request = Request::builder()
        .method("PUT")
        .uri(format!("/v1/prompts/{prompt_id}"))
        .header(header::CONTENT_TYPE, "application/vnd.ivekit.pcm16le")
        .header("x-ivekit-sample-rate-hz", "8000")
        .header("x-ivekit-content-sha256", digest);
    if authenticated {
        request = request.header(header::AUTHORIZATION, "Bearer test-token");
    }
    service
        .oneshot(request.body(Body::from(body)).expect("prompt request"))
        .await
        .expect("prompt response")
}

fn owner_fenced_command(
    action: &str,
    sequence: u32,
    transport_session_id: Option<&str>,
    payload: Value,
) -> Value {
    let expires_at =
        (Utc::now() + ChronoDuration::seconds(30)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut command = json!({
        "protocol_version": "ivekit.processing-control.v1",
        "action": action,
        "command_id": format!("cmd-{sequence}"),
        "tenant_id": "tenant-a",
        "call_id": "call-a",
        "leg_id": "leg-a",
        "cell_id": "cell-a",
        "owner_node_id": "owner-a",
        "owner_epoch": "1",
        "admission_reservation_id": "admission-a",
        "media_reservation_id": "media-a",
        "expires_at": expires_at,
        "command_sequence": sequence,
        "idempotency_key": format!("idem-{sequence}"),
        "payload_hash": format!("{:02x}", sequence.wrapping_add(64)).repeat(32),
        "command_hash": format!("{:02x}", sequence).repeat(32),
        "payload": payload
    });
    if let Some(transport_session_id) = transport_session_id {
        command["transport_session_id"] = Value::String(transport_session_id.to_owned());
    }
    command
}

#[tokio::test]
async fn processing_http_lists_reconciles_and_acknowledges_durable_terminal_events() {
    let directory = TestDirectory::new();
    let outbox = Arc::new(
        ProcessingEventOutbox::open(ProcessingEventOutboxConfig {
            path: directory.path().join("processing-events.wal"),
            max_pending_events: 16,
            max_acknowledged_events: 8,
            max_bytes: 1024 * 1024,
            max_record_bytes: 64 * 1024,
        })
        .expect("open event outbox"),
    );
    let record = outbox
        .append(ProcessingTerminalEventInput {
            tenant_id: "tenant-a".to_owned(),
            call_id: "call-a".to_owned(),
            cell_id: "cell-a".to_owned(),
            owner_node_id: "owner-a".to_owned(),
            owner_epoch: "1".to_owned(),
            media_reservation_id: "media-a".to_owned(),
            command_id: "gather-a".to_owned(),
            occurred_at_ms: 1_785_200_000_123,
            event: ProcessingTerminalEvent::GatherCompleted {
                digits: "42".to_owned(),
                reason: "maximum_digits".to_owned(),
                minimum_satisfied: true,
            },
        })
        .expect("append terminal event")
        .record;
    let service = router(
        VoiceMediaHttpState::new_with_event_outbox(
            runtime(),
            VoiceMediaHttpConfig {
                bearer_token: Some("test-token".to_owned()),
                required_client_identity: None,
                max_body_bytes: 32 * 1024,
                max_prompt_body_bytes: 512 * 1024,
                max_inflight_requests: 4,
                max_inflight_prompt_requests: 2,
            },
            outbox,
        )
        .expect("HTTP state"),
    );

    let listed = service
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/events?after_sequence=0&limit=16")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::empty())
                .expect("event scan request"),
        )
        .await
        .expect("event scan response");
    assert_eq!(listed.status(), StatusCode::OK);
    let listed = json_body(listed).await;
    assert_eq!(listed["protocol_version"], "ivekit.processing-event.v1");
    assert_eq!(listed["acknowledged_through"], "0");
    assert_eq!(listed["next_sequence"], "2");
    assert_eq!(listed["items"][0]["event_sequence"], "1");
    assert_eq!(listed["items"][0]["event_id"], record.event_id);
    assert_eq!(listed["items"][0]["event_type"], "gather_completed");
    assert_eq!(listed["items"][0]["digits"], "42");

    let reconciled = service
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/events/{}", record.event_id))
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::empty())
                .expect("event reconcile request"),
        )
        .await
        .expect("event reconcile response");
    assert_eq!(reconciled.status(), StatusCode::OK);
    assert_eq!(json_body(reconciled).await["state"], "pending");

    let acknowledged = service
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/events/ack")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "protocol_version": "ivekit.processing-event.v1",
                        "event_sequence": "1",
                        "event_id": record.event_id
                    })
                    .to_string(),
                ))
                .expect("event ack request"),
        )
        .await
        .expect("event ack response");
    assert_eq!(acknowledged.status(), StatusCode::OK);
    assert_eq!(json_body(acknowledged).await["acknowledged_through"], "1");

    let empty = service
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/events?after_sequence=0&limit=16")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::empty())
                .expect("empty event scan request"),
        )
        .await
        .expect("empty event scan response");
    assert!(json_body(empty).await["items"]
        .as_array()
        .expect("event items")
        .is_empty());
}

#[tokio::test]
async fn processing_http_accepts_only_explicit_single_digit_sip_info_commands() {
    let service = app();
    let offered = authenticated_command(service.clone(), offer()).await;
    assert_eq!(offered.status(), StatusCode::OK);
    let offered_body = json_body(offered).await;
    assert_eq!(offered_body["state"], "succeeded");
    let transport_session_id = offered_body["transport_session_id"]
        .as_str()
        .expect("processing transport session")
        .to_owned();

    let expires_at =
        (Utc::now() + ChronoDuration::seconds(30)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let answer = json!({
        "protocol_version": "ivekit.processing-control.v1",
        "action": "answer",
        "command_id": "cmd-2",
        "tenant_id": "tenant-a",
        "call_id": "call-a",
        "leg_id": "leg-a",
        "cell_id": "cell-a",
        "owner_node_id": "owner-a",
        "owner_epoch": "1",
        "admission_reservation_id": "admission-a",
        "media_reservation_id": "media-a",
        "expires_at": expires_at,
        "command_sequence": 2,
        "idempotency_key": "idem-2",
        "payload_hash": "4242424242424242424242424242424242424242424242424242424242424242",
        "command_hash": "0202020202020202020202020202020202020202020202020202020202020202",
        "transport_session_id": transport_session_id.clone(),
        "payload": {
            "answer_sdp": "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=answer\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio 40002 RTP/AVP 111 110\r\na=rtpmap:111 OPUS/48000/2\r\na=rtpmap:110 telephone-event/48000\r\na=fmtp:110 0-16\r\na=sendrecv\r\na=ptime:20\r\n"
        }
    });
    let answered = authenticated_command(service.clone(), answer).await;
    assert_eq!(answered.status(), StatusCode::OK);
    let answered_body = json_body(answered).await;
    assert_eq!(answered_body["state"], "succeeded", "{answered_body}");

    let digit = json!({
        "protocol_version": "ivekit.processing-control.v1",
        "action": "inject_dtmf",
        "command_id": "cmd-3",
        "tenant_id": "tenant-a",
        "call_id": "call-a",
        "leg_id": "leg-a",
        "cell_id": "cell-a",
        "owner_node_id": "owner-a",
        "owner_epoch": "1",
        "admission_reservation_id": "admission-a",
        "media_reservation_id": "media-a",
        "expires_at": expires_at,
        "command_sequence": 3,
        "idempotency_key": "idem-3",
        "payload_hash": "4343434343434343434343434343434343434343434343434343434343434343",
        "command_hash": "0303030303030303030303030303030303030303030303030303030303030303",
        "transport_session_id": transport_session_id,
        "payload": {
            "source": "sip_info",
            "event_id": "sip-info-caller-42",
            "digit": "5"
        }
    });
    let accepted = authenticated_command(service.clone(), digit.clone()).await;
    assert_eq!(accepted.status(), StatusCode::OK);
    assert_eq!(json_body(accepted).await["state"], "succeeded");

    let mut invalid = digit;
    invalid["command_id"] = json!("cmd-4");
    invalid["command_sequence"] = json!(4);
    invalid["idempotency_key"] = json!("idem-4");
    invalid["command_hash"] =
        json!("0404040404040404040404040404040404040404040404040404040404040404");
    invalid["payload"]["source"] = json!("rfc4733");
    let rejected = authenticated_command(service, invalid).await;
    assert_eq!(rejected.status(), StatusCode::OK);
    let rejected_body = json_body(rejected).await;
    assert_eq!(rejected_body["state"], "failed");
    assert_eq!(
        rejected_body["error_code"],
        "processing_dtmf_source_invalid"
    );
    assert_eq!(rejected_body["retryable"], false);
}

#[tokio::test]
async fn processing_http_executes_owner_fenced_playback_and_gather_commands() {
    let service = app();
    let prompt_body = pcm16le(&vec![1_000; 8_000]);
    let prompt_digest = sha256_hex(&prompt_body);
    let uploaded = put_prompt(
        service.clone(),
        "welcome-v1",
        prompt_body,
        &prompt_digest,
        true,
    )
    .await;
    assert_eq!(uploaded.status(), StatusCode::OK);

    let offered = authenticated_command(service.clone(), offer()).await;
    assert_eq!(offered.status(), StatusCode::OK);
    let offered = json_body(offered).await;
    assert_eq!(offered["state"], "succeeded");
    let transport_session_id = offered["transport_session_id"]
        .as_str()
        .expect("processing transport session")
        .to_owned();

    let answered = authenticated_command(
        service.clone(),
        owner_fenced_command(
            "answer",
            2,
            Some(&transport_session_id),
            json!({
                "answer_sdp": "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=answer\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio 40002 RTP/AVP 111 110\r\na=rtpmap:111 OPUS/48000/2\r\na=rtpmap:110 telephone-event/48000\r\na=fmtp:110 0-16\r\na=sendrecv\r\na=ptime:20\r\n"
            }),
        ),
    )
    .await;
    assert_eq!(json_body(answered).await["state"], "succeeded");

    for command in [
        owner_fenced_command(
            "play_media",
            3,
            Some(&transport_session_id),
            json!({
                "prompt_id": "welcome-v1",
                "egress_leg": "a",
                "barge_in": true
            }),
        ),
        owner_fenced_command(
            "start_gather",
            4,
            Some(&transport_session_id),
            json!({
                "minimum_digits": 1,
                "maximum_digits": 4,
                "terminator": "#",
                "first_digit_timeout_ms": 5000,
                "inter_digit_timeout_ms": 2000
            }),
        ),
        owner_fenced_command(
            "stop_media",
            5,
            Some(&transport_session_id),
            json!({ "target_command_id": "cmd-3" }),
        ),
        owner_fenced_command(
            "stop_gather",
            6,
            Some(&transport_session_id),
            json!({ "target_command_id": "cmd-4" }),
        ),
    ] {
        let response = authenticated_command(service.clone(), command).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["state"], "succeeded", "{body}");
    }

    let rejected = authenticated_command(
        service,
        owner_fenced_command(
            "play_media",
            7,
            Some(&transport_session_id),
            json!({
                "prompt_id": "welcome-v1",
                "egress_leg": "a",
                "barge_in": true,
                "file": "/tmp/unsafe.wav"
            }),
        ),
    )
    .await;
    let rejected = json_body(rejected).await;
    assert_eq!(rejected["state"], "failed");
    assert_eq!(rejected["error_code"], "processing_play_payload_invalid");
    assert_eq!(rejected["retryable"], false);
}

#[tokio::test]
async fn processing_http_commits_single_leg_ivr_without_a_fake_remote() {
    let service = app();
    let offered = authenticated_command(service.clone(), offer()).await;
    assert_eq!(offered.status(), StatusCode::OK);
    let offered = json_body(offered).await;
    let transport_session_id = offered["transport_session_id"]
        .as_str()
        .expect("processing transport session");

    let committed = authenticated_command(
        service,
        owner_fenced_command(
            "commit_single_leg",
            2,
            Some(transport_session_id),
            json!({}),
        ),
    )
    .await;
    assert_eq!(committed.status(), StatusCode::OK);
    let committed = json_body(committed).await;
    assert_eq!(committed["state"], "succeeded");
    assert_eq!(committed["session_state"], "committed");
    assert!(committed["effective_sdp"]
        .as_str()
        .expect("single-leg answer SDP")
        .contains("m=audio"));
}

#[tokio::test]
async fn prompt_preload_is_authenticated_bounded_and_digest_verified() {
    let service = app_with(VoiceMediaHttpConfig {
        bearer_token: Some("test-token".to_owned()),
        required_client_identity: None,
        max_body_bytes: 1_024,
        max_prompt_body_bytes: 4_096,
        max_inflight_requests: 4,
        max_inflight_prompt_requests: 1,
    });
    let prompt_body = pcm16le(&vec![1_000; 1_600]);
    let prompt_digest = sha256_hex(&prompt_body);

    let unauthorized = put_prompt(
        service.clone(),
        "welcome-v1",
        prompt_body.clone(),
        &prompt_digest,
        false,
    )
    .await;
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let uploaded = put_prompt(
        service.clone(),
        "welcome-v1",
        prompt_body.clone(),
        &prompt_digest,
        true,
    )
    .await;
    assert_eq!(uploaded.status(), StatusCode::OK);
    let uploaded = json_body(uploaded).await;
    assert_eq!(uploaded["prompt_id"], "welcome-v1");
    assert_eq!(uploaded["source_sample_rate_hz"], 8_000);
    assert_eq!(uploaded["canonical_sample_rate_hz"], 48_000);
    assert_eq!(uploaded["frame_count"], 10);
    assert_eq!(uploaded["content_sha256"], prompt_digest);

    let digest_mismatch = put_prompt(
        service.clone(),
        "tampered-v1",
        prompt_body,
        &"00".repeat(32),
        true,
    )
    .await;
    assert_eq!(digest_mismatch.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        json_body(digest_mismatch).await["error"],
        "processing_prompt_digest_mismatch"
    );

    let oversized_body = vec![0_u8; 4_098];
    let oversized_digest = sha256_hex(&oversized_body);
    let oversized = put_prompt(
        service.clone(),
        "oversized-v1",
        oversized_body,
        &oversized_digest,
        true,
    )
    .await;
    assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let removed = service
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/v1/prompts/welcome-v1")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::empty())
                .expect("prompt delete request"),
        )
        .await
        .expect("prompt delete response");
    assert_eq!(removed.status(), StatusCode::OK);
    assert_eq!(json_body(removed).await["removed"], true);
}

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new() -> Self {
        let sequence = NEXT_EVENT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ivekit-processing-http-events-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create event test directory");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.path).expect("remove event test directory");
    }
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
        max_prompt_body_bytes: 512 * 1024,
        max_inflight_requests: 4,
        max_inflight_prompt_requests: 2,
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
        max_prompt_body_bytes: 4_096,
        max_inflight_requests: 4,
        max_inflight_prompt_requests: 1,
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
