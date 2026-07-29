use audio_codec::{create_decoder, create_encoder, CodecType};
use rustrtc::rtp::{RtpHeader, RtpPacket};
use rustrtc::{MediaKind, SdpType, SessionDescription};
use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use voice_media_rs::capacity::CodecPairCapacity;
use voice_media_rs::codec::AudioCodec;
use voice_media_rs::event_outbox::{
    ProcessingEventOutbox, ProcessingEventOutboxConfig, ProcessingTerminalEvent,
};
use voice_media_rs::ivr::{IvrEvent, IvrPromptCacheConfig, IvrSessionConfig};
use voice_media_rs::rtp::ProcessingLeg;
use voice_media_rs::runtime::{
    ProcessingRuntime, ProcessingRuntimeCommand, ProcessingRuntimeConfig, ProcessingRuntimeError,
    ProcessingRuntimeOperation,
};
use voice_media_rs::session::{
    ProcessingAction, ProcessingCommand, ProcessingProfile, ProcessingSessionRegistryConfig,
    ProcessingSessionState, ReconcileCommand, SessionError,
};
use voice_media_rs::worker::{RtpWorkerPoolConfig, WorkerError, WorkerEvent};

fn localhost(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

static NEXT_RTP_PORT: AtomicUsize = AtomicUsize::new(40_000);
static NEXT_EVENT_DIRECTORY: AtomicUsize = AtomicUsize::new(1);

fn free_even_pair() -> (u16, u16) {
    loop {
        let start = NEXT_RTP_PORT.fetch_add(4, Ordering::Relaxed);
        if start > 59_996 {
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

fn config(port_start: u16, port_end: u16) -> ProcessingRuntimeConfig {
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
    }
}

fn profile() -> ProcessingProfile {
    ProcessingProfile {
        leg_a_codec: AudioCodec::Pcmu,
        leg_b_codec: AudioCodec::Opus,
        packetization_ms: 20,
        leg_a_payload_type: 0,
        leg_b_payload_type: 111,
    }
}

fn command(action: ProcessingAction, sequence: u32) -> ProcessingCommand {
    ProcessingCommand {
        action,
        command_id: format!("cmd-{sequence}"),
        tenant_id: "tenant-a".to_owned(),
        call_id: "call-a".to_owned(),
        leg_id: "leg-a".to_owned(),
        cell_id: "cell-a".to_owned(),
        owner_node_id: "owner-a".to_owned(),
        owner_epoch: 1,
        admission_reservation_id: "admission-a".to_owned(),
        media_reservation_id: "media-a".to_owned(),
        command_sequence: sequence,
        idempotency_key: format!("idem-{sequence}"),
        expires_at_ms: 10_000,
        command_hash: [sequence as u8; 32],
        idempotency_hash: [(sequence as u8).wrapping_add(64); 32],
        profile: (action == ProcessingAction::Offer).then(profile),
    }
}

struct SdpFixture<'a> {
    sdp_type: SdpType,
    address: IpAddr,
    port: u16,
    payload_type: u8,
    codec: &'a str,
    rate: u32,
    channels: Option<u8>,
    event_payload_type: u8,
    event_rate: u32,
}

fn sdp(spec: SdpFixture<'_>) -> String {
    let family = if spec.address.is_ipv4() { "IP4" } else { "IP6" };
    let channels = spec
        .channels
        .map(|value| format!("/{value}"))
        .unwrap_or_default();
    let kind = match spec.sdp_type {
        SdpType::Offer => "offer",
        SdpType::Answer => "answer",
        _ => "other",
    };
    format!(
        "v=0\r\n\
         o=- 1 1 IN {family} {address}\r\n\
         s={kind}\r\n\
         c=IN {family} {address}\r\n\
         t=0 0\r\n\
         m=audio {port} RTP/AVP {payload_type} {event_payload_type}\r\n\
         a=rtpmap:{payload_type} {codec}/{rate}{channels}\r\n\
         a=rtpmap:{event_payload_type} telephone-event/{event_rate}\r\n\
         a=fmtp:{event_payload_type} 0-16\r\n\
         a=sendrecv\r\n\
         a=ptime:20\r\n",
        address = spec.address,
        port = spec.port,
        payload_type = spec.payload_type,
        event_payload_type = spec.event_payload_type,
        codec = spec.codec,
        rate = spec.rate,
        event_rate = spec.event_rate,
    )
}

fn wire(payload_type: u8, sequence: u16, timestamp: u32, ssrc: u32, payload: Vec<u8>) -> Vec<u8> {
    RtpPacket::new(
        RtpHeader::new(payload_type, sequence, timestamp, ssrc),
        payload,
    )
    .marshal()
    .expect("RTP fixture")
}

fn endpoint() -> UdpSocket {
    let socket = UdpSocket::bind(localhost(0)).expect("endpoint bind");
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("read timeout");
    socket
}

fn established_runtime() -> ProcessingRuntime {
    let (port_start, port_end) = free_even_pair();
    let runtime = ProcessingRuntime::new(
        config(port_start, port_end),
        Arc::new(CodecPairCapacity::uniform(4)),
    )
    .expect("runtime");
    let endpoint_a = endpoint();
    let endpoint_b = endpoint();
    runtime
        .execute(
            ProcessingRuntimeCommand {
                command: command(ProcessingAction::Offer, 1),
                operation: ProcessingRuntimeOperation::Offer {
                    sdp: sdp(SdpFixture {
                        sdp_type: SdpType::Offer,
                        address: endpoint_a.local_addr().expect("A address").ip(),
                        port: endpoint_a.local_addr().expect("A address").port(),
                        payload_type: 0,
                        codec: "PCMU",
                        rate: 8_000,
                        channels: None,
                        event_payload_type: 101,
                        event_rate: 8_000,
                    }),
                },
            },
            1_000,
        )
        .expect("offer");
    runtime
        .execute(
            ProcessingRuntimeCommand {
                command: command(ProcessingAction::Answer, 2),
                operation: ProcessingRuntimeOperation::Answer {
                    sdp: sdp(SdpFixture {
                        sdp_type: SdpType::Answer,
                        address: endpoint_b.local_addr().expect("B address").ip(),
                        port: endpoint_b.local_addr().expect("B address").port(),
                        payload_type: 111,
                        codec: "OPUS",
                        rate: 48_000,
                        channels: Some(2),
                        event_payload_type: 110,
                        event_rate: 48_000,
                    }),
                },
            },
            1_001,
        )
        .expect("answer");
    runtime
}

#[test]
fn runtime_projects_owner_fenced_terminal_events_for_durable_handoff() {
    let runtime = established_runtime();
    let worker_event = WorkerEvent::Ivr {
        session_id: Arc::from("media-a"),
        event: IvrEvent::GatherCompleted {
            command_id: Arc::from("gather-42"),
            digits: Arc::from("42"),
            reason: voice_media_rs::ivr::GatherCompletionReason::MaximumDigits,
            minimum_satisfied: true,
        },
    };
    let terminal = runtime
        .terminal_event_input(worker_event.clone(), 1_785_200_000_123)
        .expect("project terminal event")
        .expect("terminal event");

    assert_eq!(terminal.tenant_id, "tenant-a");
    assert_eq!(terminal.call_id, "call-a");
    assert_eq!(terminal.cell_id, "cell-a");
    assert_eq!(terminal.owner_node_id, "owner-a");
    assert_eq!(terminal.owner_epoch, "1");
    assert_eq!(terminal.media_reservation_id, "media-a");
    assert_eq!(terminal.command_id, "gather-42");
    assert_eq!(
        terminal.event,
        ProcessingTerminalEvent::GatherCompleted {
            digits: "42".to_owned(),
            reason: "maximum_digits".to_owned(),
            minimum_satisfied: true,
        }
    );
    assert!(
        runtime
            .terminal_event_input(
                WorkerEvent::Ivr {
                    session_id: Arc::from("media-a"),
                    event: IvrEvent::GatherStarted {
                        command_id: Arc::from("gather-42"),
                    },
                },
                1_785_200_000_124,
            )
            .expect("project telemetry")
            .is_none(),
        "non-terminal telemetry must not enter the durable outbox"
    );

    let directory = TestDirectory::new();
    let outbox = ProcessingEventOutbox::open(ProcessingEventOutboxConfig {
        path: directory.path().join("processing-events.wal"),
        max_pending_events: 16,
        max_acknowledged_events: 8,
        max_bytes: 1024 * 1024,
        max_record_bytes: 64 * 1024,
    })
    .expect("open event outbox");
    let persisted = runtime
        .persist_terminal_event(&outbox, worker_event, 1_785_200_000_123)
        .expect("persist terminal event")
        .expect("durable terminal event");
    assert_eq!(persisted.record.event_sequence, 1);
    assert_eq!(
        outbox.scan(0, 16).expect("scan persisted event").items,
        vec![persisted.record]
    );
}

#[test]
fn committed_runtime_accepts_and_replays_owner_fenced_sip_info_digit() {
    let runtime = established_runtime();
    let input = ProcessingRuntimeCommand {
        command: command(ProcessingAction::InjectDtmf, 3),
        operation: ProcessingRuntimeOperation::SipInfoDigit {
            event_id: "sip-info-caller-42".to_owned(),
            digit: '5',
        },
    };

    let applied = runtime
        .execute(input.clone(), 1_002)
        .expect("SIP INFO digit");
    assert!(!applied.replayed);
    assert_eq!(applied.snapshot.session.last_sequence, 3);
    assert_eq!(
        applied.snapshot.session.state,
        ProcessingSessionState::Committed
    );

    let replayed = runtime.execute(input, 1_003).expect("SIP INFO replay");
    assert!(replayed.replayed);
    assert_eq!(replayed.applied_command_id, "cmd-3");
    assert_eq!(replayed.snapshot.session.last_sequence, 3);
}

#[test]
fn committed_runtime_executes_replay_safe_ivr_commands_against_preloaded_prompts() {
    let runtime = established_runtime();
    let prompt = runtime
        .cache_prompt_pcm("welcome-v1", 8_000, &vec![1_000; 8_000])
        .expect("cache prompt");
    assert_eq!(prompt.prompt_id, "welcome-v1");
    assert_eq!(prompt.canonical_sample_rate_hz, 48_000);
    assert_eq!(prompt.frame_count, 50);

    let baseline_sdp = runtime
        .session("media-a")
        .expect("session")
        .expect("committed session")
        .effective_sdp;
    let play = ProcessingRuntimeCommand {
        command: command(ProcessingAction::PlayMedia, 3),
        operation: ProcessingRuntimeOperation::PlayMedia {
            prompt_id: "welcome-v1".to_owned(),
            egress_leg: ProcessingLeg::A,
            barge_in: true,
        },
    };
    let played = runtime
        .execute(play.clone(), 1_002)
        .expect("start playback");
    assert!(!played.replayed);
    assert_eq!(played.snapshot.effective_sdp, baseline_sdp);
    assert!(
        runtime
            .execute(play, 1_003)
            .expect("replay playback command")
            .replayed
    );

    runtime
        .execute(
            ProcessingRuntimeCommand {
                command: command(ProcessingAction::StartGather, 4),
                operation: ProcessingRuntimeOperation::StartGather {
                    minimum_digits: 1,
                    maximum_digits: 4,
                    terminator: Some('#'),
                    first_digit_timeout_ms: 5_000,
                    inter_digit_timeout_ms: 2_000,
                },
            },
            1_004,
        )
        .expect("start gather");
    runtime
        .execute(
            ProcessingRuntimeCommand {
                command: command(ProcessingAction::StopMedia, 5),
                operation: ProcessingRuntimeOperation::StopMedia {
                    target_command_id: "cmd-3".to_owned(),
                },
            },
            1_005,
        )
        .expect("stop playback");
    let stopped = runtime
        .execute(
            ProcessingRuntimeCommand {
                command: command(ProcessingAction::StopGather, 6),
                operation: ProcessingRuntimeOperation::StopGather {
                    target_command_id: "cmd-4".to_owned(),
                },
            },
            1_006,
        )
        .expect("stop gather");
    assert_eq!(stopped.snapshot.session.last_sequence, 6);
    assert_eq!(stopped.snapshot.effective_sdp, baseline_sdp);

    let mut playback_stopped = false;
    let mut gather_stopped = false;
    for _ in 0..8 {
        let Some(WorkerEvent::Ivr { event, .. }) =
            runtime.recv_event_timeout(Duration::from_millis(100))
        else {
            continue;
        };
        match event {
            IvrEvent::PlaybackStopped {
                command_id,
                prompt_id,
                reason: voice_media_rs::ivr::PlaybackStopReason::Explicit,
            } => {
                assert_eq!(command_id.as_ref(), "cmd-3");
                assert_eq!(prompt_id.as_ref(), "welcome-v1");
                playback_stopped = true;
            }
            IvrEvent::GatherCompleted {
                command_id,
                digits,
                reason: voice_media_rs::ivr::GatherCompletionReason::ExplicitStop,
                minimum_satisfied,
            } => {
                assert_eq!(command_id.as_ref(), "cmd-4");
                assert!(digits.is_empty());
                assert!(!minimum_satisfied);
                gather_stopped = true;
            }
            _ => {}
        }
        if playback_stopped && gather_stopped {
            break;
        }
    }
    assert!(playback_stopped, "playback terminal event");
    assert!(gather_stopped, "gather terminal event");
    assert!(runtime
        .remove_cached_prompt("welcome-v1")
        .expect("remove prompt"));
    assert!(!runtime
        .remove_cached_prompt("welcome-v1")
        .expect("idempotent prompt removal"));
}

#[test]
fn prepared_runtime_rejects_sip_info_digit_before_worker_dispatch() {
    let (port_start, port_end) = free_even_pair();
    let runtime = ProcessingRuntime::new(
        config(port_start, port_end),
        Arc::new(CodecPairCapacity::uniform(4)),
    )
    .expect("runtime");
    let endpoint_a = endpoint();
    runtime
        .execute(
            ProcessingRuntimeCommand {
                command: command(ProcessingAction::Offer, 1),
                operation: ProcessingRuntimeOperation::Offer {
                    sdp: sdp(SdpFixture {
                        sdp_type: SdpType::Offer,
                        address: endpoint_a.local_addr().expect("A address").ip(),
                        port: endpoint_a.local_addr().expect("A address").port(),
                        payload_type: 0,
                        codec: "PCMU",
                        rate: 8_000,
                        channels: None,
                        event_payload_type: 101,
                        event_rate: 8_000,
                    }),
                },
            },
            1_000,
        )
        .expect("offer");

    assert_eq!(
        runtime
            .execute(
                ProcessingRuntimeCommand {
                    command: command(ProcessingAction::InjectDtmf, 2),
                    operation: ProcessingRuntimeOperation::SipInfoDigit {
                        event_id: "sip-info-caller-42".to_owned(),
                        digit: '5',
                    },
                },
                1_001,
            )
            .expect_err("prepared session must reject digit"),
        ProcessingRuntimeError::Session(SessionError::InvalidTransition)
    );
}

#[test]
fn runtime_negotiates_two_codec_legs_and_transcodes_real_udp() {
    let (port_start, port_end) = free_even_pair();
    let runtime = ProcessingRuntime::new(
        config(port_start, port_end),
        Arc::new(CodecPairCapacity::uniform(4)),
    )
    .expect("runtime");
    let endpoint_a = endpoint();
    let endpoint_b = endpoint();
    let offer_sdp = sdp(SdpFixture {
        sdp_type: SdpType::Offer,
        address: endpoint_a.local_addr().expect("A address").ip(),
        port: endpoint_a.local_addr().expect("A address").port(),
        payload_type: 0,
        codec: "PCMU",
        rate: 8_000,
        channels: None,
        event_payload_type: 101,
        event_rate: 8_000,
    });
    let offer = ProcessingRuntimeCommand {
        command: command(ProcessingAction::Offer, 1),
        operation: ProcessingRuntimeOperation::Offer { sdp: offer_sdp },
    };
    let prepared = runtime.execute(offer.clone(), 1_000).expect("offer");
    assert_eq!(
        prepared.snapshot.session.state,
        ProcessingSessionState::Prepared
    );
    assert!(prepared
        .snapshot
        .transport_session_id
        .starts_with("processing:"));
    let effective_offer =
        SessionDescription::parse(SdpType::Offer, &prepared.snapshot.effective_sdp)
            .expect("effective offer");
    let offer_audio = effective_offer
        .media_sections
        .iter()
        .find(|section| section.kind == MediaKind::Audio)
        .expect("offer audio");
    assert_eq!(
        offer_audio.port,
        prepared.snapshot.session.ports.leg_b_rtp_port
    );
    assert_eq!(offer_audio.formats, ["111", "110"]);
    assert_eq!(
        offer_audio.connection.as_deref(),
        Some("IN IP4 203.0.113.10")
    );

    let replay = runtime.execute(offer, 1_001).expect("offer replay");
    assert!(replay.replayed);
    assert_eq!(
        replay.snapshot.effective_sdp,
        prepared.snapshot.effective_sdp
    );

    let answer_sdp = sdp(SdpFixture {
        sdp_type: SdpType::Answer,
        address: endpoint_b.local_addr().expect("B address").ip(),
        port: endpoint_b.local_addr().expect("B address").port(),
        payload_type: 111,
        codec: "opus",
        rate: 48_000,
        channels: Some(2),
        event_payload_type: 110,
        event_rate: 48_000,
    });
    let committed = runtime
        .execute(
            ProcessingRuntimeCommand {
                command: command(ProcessingAction::Answer, 2),
                operation: ProcessingRuntimeOperation::Answer { sdp: answer_sdp },
            },
            1_002,
        )
        .expect("answer");
    assert_eq!(
        committed.snapshot.session.state,
        ProcessingSessionState::Committed
    );
    let effective_answer =
        SessionDescription::parse(SdpType::Answer, &committed.snapshot.effective_sdp)
            .expect("effective answer");
    let answer_audio = effective_answer
        .media_sections
        .iter()
        .find(|section| section.kind == MediaKind::Audio)
        .expect("answer audio");
    assert_eq!(
        answer_audio.port,
        committed.snapshot.session.ports.leg_a_rtp_port
    );
    assert_eq!(answer_audio.formats, ["0", "101"]);

    let pcmu = create_encoder(CodecType::PCMU).encode(&vec![1_000; 160]);
    for (sequence, timestamp) in [(1, 0), (2, 160)] {
        endpoint_a
            .send_to(
                &wire(0, sequence, timestamp, 111, pcmu.clone()),
                localhost(committed.snapshot.session.ports.leg_a_rtp_port),
            )
            .expect("A media");
    }
    let mut receive = [0_u8; 2_048];
    let (received, _) = endpoint_b.recv_from(&mut receive).expect("Opus output");
    let to_b = RtpPacket::parse(&receive[..received]).expect("Opus RTP");
    assert_eq!(to_b.header.payload_type, 111);
    assert_eq!(
        create_decoder(CodecType::Opus).decode(&to_b.payload).len(),
        960
    );

    let opus = create_encoder(CodecType::Opus).encode(&vec![1_000; 960]);
    for (sequence, timestamp) in [(10, 48_000), (11, 48_960)] {
        endpoint_b
            .send_to(
                &wire(111, sequence, timestamp, 222, opus.clone()),
                localhost(committed.snapshot.session.ports.leg_b_rtp_port),
            )
            .expect("B media");
    }
    let (received, _) = endpoint_a.recv_from(&mut receive).expect("PCMU output");
    let to_a = RtpPacket::parse(&receive[..received]).expect("PCMU RTP");
    assert_eq!(to_a.header.payload_type, 0);
    assert_eq!(to_a.payload.len(), 160);

    let delete = ProcessingRuntimeCommand {
        command: command(ProcessingAction::Delete, 3),
        operation: ProcessingRuntimeOperation::Delete,
    };
    let closed = runtime.execute(delete.clone(), 1_003).expect("delete");
    assert_eq!(
        closed.snapshot.session.state,
        ProcessingSessionState::Closed
    );
    assert_eq!(
        runtime
            .worker_snapshot()
            .expect("worker snapshot")
            .active_sessions,
        0
    );
    assert!(
        runtime
            .execute(delete, 1_004)
            .expect("delete replay")
            .replayed
    );
}

#[test]
fn runtime_commits_single_leg_ivr_and_suppresses_unused_transcoding() {
    let (port_start, port_end) = free_even_pair();
    let runtime = ProcessingRuntime::new(
        config(port_start, port_end),
        Arc::new(CodecPairCapacity::uniform(4)),
    )
    .expect("runtime");
    let endpoint_a = endpoint();
    let _prepared = runtime
        .execute(
            ProcessingRuntimeCommand {
                command: command(ProcessingAction::Offer, 1),
                operation: ProcessingRuntimeOperation::Offer {
                    sdp: sdp(SdpFixture {
                        sdp_type: SdpType::Offer,
                        address: endpoint_a.local_addr().expect("A address").ip(),
                        port: endpoint_a.local_addr().expect("A address").port(),
                        payload_type: 0,
                        codec: "PCMU",
                        rate: 8_000,
                        channels: None,
                        event_payload_type: 101,
                        event_rate: 8_000,
                    }),
                },
            },
            1_000,
        )
        .expect("offer");

    let committed = runtime
        .execute(
            ProcessingRuntimeCommand {
                command: command(ProcessingAction::CommitSingleLeg, 2),
                operation: ProcessingRuntimeOperation::CommitSingleLeg,
            },
            1_001,
        )
        .expect("single-leg commit");
    assert_eq!(
        committed.snapshot.session.state,
        ProcessingSessionState::Committed
    );
    let answer = SessionDescription::parse(SdpType::Answer, &committed.snapshot.effective_sdp)
        .expect("single-leg answer");
    let audio = answer
        .media_sections
        .iter()
        .find(|section| section.kind == MediaKind::Audio)
        .expect("answer audio");
    assert_eq!(audio.port, committed.snapshot.session.ports.leg_a_rtp_port);
    assert_eq!(audio.formats, ["0", "101"]);

    let pcmu = create_encoder(CodecType::PCMU).encode(&vec![1_000; 160]);
    for (sequence, timestamp) in [(1, 0), (2, 160), (3, 320)] {
        endpoint_a
            .send_to(
                &wire(0, sequence, timestamp, 111, pcmu.clone()),
                localhost(committed.snapshot.session.ports.leg_a_rtp_port),
            )
            .expect("A media");
    }
    std::thread::sleep(Duration::from_millis(100));
    let worker = runtime.worker_snapshot().expect("worker snapshot");
    assert!(worker.rtp_datagrams_received >= 3);
    assert_eq!(worker.rtp_datagrams_sent, 0);
}

#[test]
fn runtime_rolls_back_registry_capacity_when_worker_bind_fails() {
    let (port_start, port_end) = free_even_pair();
    let occupied_a = UdpSocket::bind(localhost(port_end)).expect("occupy A");
    let occupied_b = UdpSocket::bind(localhost(port_start)).expect("occupy B");
    let runtime = ProcessingRuntime::new(
        config(port_start, port_end),
        Arc::new(CodecPairCapacity::uniform(4)),
    )
    .expect("runtime");
    let endpoint_a = endpoint();
    let offer = ProcessingRuntimeCommand {
        command: command(ProcessingAction::Offer, 1),
        operation: ProcessingRuntimeOperation::Offer {
            sdp: sdp(SdpFixture {
                sdp_type: SdpType::Offer,
                address: endpoint_a.local_addr().expect("A address").ip(),
                port: endpoint_a.local_addr().expect("A address").port(),
                payload_type: 0,
                codec: "PCMU",
                rate: 8_000,
                channels: None,
                event_payload_type: 101,
                event_rate: 8_000,
            }),
        },
    };

    assert_eq!(
        runtime
            .execute(offer.clone(), 1_000)
            .expect_err("bind failure"),
        ProcessingRuntimeError::Worker(WorkerError::SocketBindFailed)
    );
    assert_eq!(runtime.registry_session_count(), 0);
    assert_eq!(runtime.registry_active_session_count(), 0);
    assert_eq!(runtime.available_port_count(), 2);

    drop(occupied_a);
    drop(occupied_b);
    assert!(runtime.execute(offer, 1_001).is_ok());
}

#[test]
fn runtime_rejects_secure_or_mismatched_sdp_before_allocating_resources() {
    let (port_start, port_end) = free_even_pair();
    let runtime = ProcessingRuntime::new(
        config(port_start, port_end),
        Arc::new(CodecPairCapacity::uniform(4)),
    )
    .expect("runtime");
    let secure = "v=0\r\n\
                  o=- 1 1 IN IP4 127.0.0.1\r\n\
                  s=secure\r\n\
                  c=IN IP4 127.0.0.1\r\n\
                  t=0 0\r\n\
                  m=audio 40000 RTP/SAVP 0\r\n\
                  a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:key\r\n";
    let error = runtime
        .execute(
            ProcessingRuntimeCommand {
                command: command(ProcessingAction::Offer, 1),
                operation: ProcessingRuntimeOperation::Offer {
                    sdp: secure.to_owned(),
                },
            },
            1_000,
        )
        .expect_err("secure SDP unsupported");
    assert_eq!(error, ProcessingRuntimeError::UnsupportedSdp);
    assert_eq!(runtime.registry_session_count(), 0);
    assert_eq!(runtime.available_port_count(), 2);
}

#[test]
fn runtime_sweep_removes_prepared_worker_before_releasing_and_evicting_state() {
    let (port_start, port_end) = free_even_pair();
    let runtime = ProcessingRuntime::new(
        config(port_start, port_end),
        Arc::new(CodecPairCapacity::uniform(4)),
    )
    .expect("runtime");
    let endpoint_a = endpoint();
    let mut offer_command = command(ProcessingAction::Offer, 1);
    offer_command.expires_at_ms = 1_010;
    runtime
        .execute(
            ProcessingRuntimeCommand {
                command: offer_command,
                operation: ProcessingRuntimeOperation::Offer {
                    sdp: sdp(SdpFixture {
                        sdp_type: SdpType::Offer,
                        address: endpoint_a.local_addr().expect("A address").ip(),
                        port: endpoint_a.local_addr().expect("A address").port(),
                        payload_type: 0,
                        codec: "PCMU",
                        rate: 8_000,
                        channels: None,
                        event_payload_type: 101,
                        event_rate: 8_000,
                    }),
                },
            },
            1_000,
        )
        .expect("offer");
    assert_eq!(
        runtime
            .worker_snapshot()
            .expect("worker snapshot")
            .active_sessions,
        1
    );

    let expired = runtime.sweep(1_011, 4).expect("expire prepared");
    assert_eq!(expired.expired, 1);
    assert_eq!(
        runtime
            .worker_snapshot()
            .expect("worker snapshot")
            .active_sessions,
        0
    );
    assert_eq!(
        runtime
            .session("media-a")
            .expect("session")
            .expect("retained terminal")
            .session
            .state,
        ProcessingSessionState::Expired
    );

    let evicted = runtime.sweep(1_111, 4).expect("evict terminal");
    assert_eq!(evicted.evicted, 1);
    assert!(runtime
        .session("media-a")
        .expect("session lookup")
        .is_none());
    assert_eq!(runtime.runtime_state_count().expect("state count"), 0);
}

#[test]
fn runtime_reconcile_returns_the_historical_command_outcome() {
    let (port_start, port_end) = free_even_pair();
    let runtime = ProcessingRuntime::new(
        config(port_start, port_end),
        Arc::new(CodecPairCapacity::uniform(4)),
    )
    .expect("runtime");
    let endpoint_a = endpoint();
    let offer_command = command(ProcessingAction::Offer, 1);
    let applied = runtime
        .execute(
            ProcessingRuntimeCommand {
                command: offer_command.clone(),
                operation: ProcessingRuntimeOperation::Offer {
                    sdp: sdp(SdpFixture {
                        sdp_type: SdpType::Offer,
                        address: endpoint_a.local_addr().expect("A address").ip(),
                        port: endpoint_a.local_addr().expect("A address").port(),
                        payload_type: 0,
                        codec: "PCMU",
                        rate: 8_000,
                        channels: None,
                        event_payload_type: 101,
                        event_rate: 8_000,
                    }),
                },
            },
            1_000,
        )
        .expect("offer");

    let reconciled = runtime
        .reconcile(ReconcileCommand {
            media_reservation_id: offer_command.media_reservation_id.clone(),
            owner_epoch: offer_command.owner_epoch,
            command_id: offer_command.command_id.clone(),
            command_hash: offer_command.command_hash,
        })
        .expect("reconcile")
        .expect("recorded command");
    assert!(reconciled.replayed);
    assert_eq!(reconciled.applied_command_id, offer_command.command_id);
    assert_eq!(
        reconciled.snapshot.effective_sdp,
        applied.snapshot.effective_sdp
    );

    assert!(runtime
        .reconcile(ReconcileCommand {
            media_reservation_id: offer_command.media_reservation_id.clone(),
            owner_epoch: offer_command.owner_epoch,
            command_id: "unknown-command".to_owned(),
            command_hash: [0; 32],
        })
        .expect("unknown command")
        .is_none());
    assert_eq!(
        runtime
            .reconcile(ReconcileCommand {
                media_reservation_id: offer_command.media_reservation_id,
                owner_epoch: offer_command.owner_epoch,
                command_id: offer_command.command_id,
                command_hash: [255; 32],
            })
            .expect_err("payload conflict"),
        ProcessingRuntimeError::Session(SessionError::CommandPayloadConflict)
    );
}

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new() -> Self {
        let sequence = NEXT_EVENT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ivekit-processing-runtime-events-{}-{sequence}",
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
