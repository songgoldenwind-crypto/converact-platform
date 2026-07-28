use audio_codec::{create_decoder, create_encoder, CodecType};
use bytes::Bytes;
use rustrtc::rtp::{RtpHeader, RtpPacket};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::{mpsc, Arc, Barrier};
use std::thread;
use std::time::Duration;
use voice_media_rs::codec::AudioCodec;
use voice_media_rs::datagram_pool::{DatagramPool, DatagramPoolConfig};
use voice_media_rs::ivr::{
    GatherCompletionReason, IvrEvent, IvrPromptCacheConfig, IvrSessionConfig, PlaybackStopReason,
};
use voice_media_rs::rtp::{DtmfPhase, ProcessingLeg, RtpSessionConfig, TelephoneEventConfig};
use voice_media_rs::session::ProcessingProfile;
use voice_media_rs::worker::{
    RtpWorkerPool, RtpWorkerPoolConfig, WorkerError, WorkerEvent, WorkerGatherRequest,
    WorkerPlaybackRequest,
};

fn localhost(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

fn media_config() -> RtpSessionConfig {
    RtpSessionConfig {
        profile: ProcessingProfile {
            leg_a_codec: AudioCodec::Pcmu,
            leg_b_codec: AudioCodec::Opus,
            packetization_ms: 20,
            leg_a_payload_type: 0,
            leg_b_payload_type: 111,
        },
        jitter_capacity: 8,
        jitter_wait_depth: 2,
        max_drain_per_datagram: 8,
        max_conceal_frames: 2,
        max_datagram_bytes: 2_048,
        leg_a_telephone_event: Some(TelephoneEventConfig {
            payload_type: 101,
            clock_rate: 8_000,
        }),
        leg_b_telephone_event: Some(TelephoneEventConfig {
            payload_type: 110,
            clock_rate: 48_000,
        }),
        a_to_b_ssrc: 0xAABB_CCDD,
        b_to_a_ssrc: 0x1122_3344,
        a_to_b_initial_sequence: 5_000,
        b_to_a_initial_sequence: 6_000,
        a_to_b_initial_timestamp: 96_000,
        b_to_a_initial_timestamp: 8_000,
        source_rebind_after_ms: 1_000,
    }
}

fn pcma_media_config() -> RtpSessionConfig {
    let mut config = media_config();
    config.profile.leg_a_codec = AudioCodec::Pcma;
    config.profile.leg_a_payload_type = 8;
    config
}

fn worker_config() -> RtpWorkerPoolConfig {
    RtpWorkerPoolConfig {
        worker_count: 1,
        max_sessions_per_worker: 8,
        command_queue_capacity: 16,
        event_queue_capacity: 16,
        critical_event_capacity: 16,
        poll_event_capacity: 64,
        max_commands_per_tick: 16,
        max_critical_events_per_tick: 16,
        max_packets_per_socket_event: 8,
        max_datagram_bytes: 2_048,
        datagram_pool_initial: 16,
        datagram_pool_max: 256,
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
            max_command_history: 32,
            max_digit_history: 32,
            max_gather_digits: 16,
        },
        max_ivr_sessions_per_tick: 8,
    }
}

fn sine(sample_rate: usize, samples: usize) -> Vec<i16> {
    (0..samples)
        .map(|index| {
            let phase = 2.0 * std::f64::consts::PI * 440.0 * index as f64 / sample_rate as f64;
            (phase.sin() * 8_000.0) as i16
        })
        .collect()
}

#[test]
fn datagram_retention_budget_rejects_oversubscription_and_releases_on_remove() {
    let mut config = worker_config();
    config.max_sessions_per_worker = 2;
    config.datagram_pool_initial = 1;
    config.datagram_pool_max = 17;
    let pool = RtpWorkerPool::new(config).expect("worker pool");

    pool.install_session(
        "retention-first",
        localhost(0),
        localhost(0),
        media_config(),
    )
    .expect("first session");
    let admitted = pool.snapshot().expect("admitted snapshot");
    assert_eq!(admitted.datagram_retention_limit, 16);
    assert_eq!(admitted.datagram_retention_used, 16);

    assert_eq!(
        pool.install_session(
            "retention-second",
            localhost(0),
            localhost(0),
            media_config(),
        )
        .expect_err("second session must not consume the worker receive reserve"),
        WorkerError::DatagramRetentionCapacityExhausted {
            requested: 16,
            available: 0,
        }
    );
    assert_eq!(
        pool.snapshot()
            .expect("rejected snapshot")
            .datagram_retention_rejections,
        1
    );

    assert!(pool
        .remove_session("retention-first")
        .expect("remove first"));
    assert_eq!(
        pool.snapshot()
            .expect("released snapshot")
            .datagram_retention_used,
        0
    );
    pool.install_session(
        "retention-second",
        localhost(0),
        localhost(0),
        media_config(),
    )
    .expect("released capacity must be reusable");
}

#[test]
fn sip_info_digit_rejects_invalid_event_identity_before_dispatch() {
    let pool = RtpWorkerPool::new(worker_config()).expect("worker pool");
    assert_eq!(
        pool.submit_sip_info_digit("not-installed", "contains whitespace", '5')
            .expect_err("invalid event identity"),
        WorkerError::Ivr(voice_media_rs::ivr::IvrError::InvalidDigitEventId)
    );
}

fn wire(payload_type: u8, sequence: u16, timestamp: u32, ssrc: u32, payload: Vec<u8>) -> Vec<u8> {
    RtpPacket::new(
        RtpHeader::new(payload_type, sequence, timestamp, ssrc),
        payload,
    )
    .marshal()
    .expect("RTP fixture")
}

fn pcmu(sequence: u16, timestamp: u32, ssrc: u32) -> Vec<u8> {
    wire(
        0,
        sequence,
        timestamp,
        ssrc,
        create_encoder(CodecType::PCMU).encode(&sine(8_000, 160)),
    )
}

fn pcma(sequence: u16, timestamp: u32, ssrc: u32) -> Vec<u8> {
    wire(
        8,
        sequence,
        timestamp,
        ssrc,
        create_encoder(CodecType::PCMA).encode(&sine(8_000, 160)),
    )
}

fn opus(sequence: u16, timestamp: u32, ssrc: u32) -> Vec<u8> {
    wire(
        111,
        sequence,
        timestamp,
        ssrc,
        create_encoder(CodecType::Opus).encode(&sine(48_000, 960)),
    )
}

fn endpoint() -> UdpSocket {
    let socket = UdpSocket::bind(localhost(0)).expect("endpoint bind");
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("read timeout");
    socket
}

#[test]
fn datagram_pool_is_hard_bounded_and_reuses_owner_backing_memory() {
    let pool = DatagramPool::new(DatagramPoolConfig {
        datagram_bytes: 128,
        initial_buffers: 1,
        max_buffers: 2,
    })
    .expect("pool");

    let mut first = pool.try_acquire().expect("preallocated buffer");
    first.full_buffer_mut()[..4].copy_from_slice(b"RTP!");
    first.set_len(4).expect("valid datagram length");
    let bytes = first.into_bytes();
    assert_eq!(bytes, Bytes::from_static(b"RTP!"));

    let second = pool.try_acquire().expect("one lazy allocation");
    assert!(pool.try_acquire().is_none(), "pool must fail closed");
    let retained = bytes.clone();
    drop(bytes);
    assert!(
        pool.try_acquire().is_none(),
        "owner returns only after the final Bytes clone"
    );
    drop(retained);

    let reused = pool.try_acquire().expect("dropped Bytes returns owner");
    assert_eq!(reused.capacity(), 128);
    let stats = pool.stats();
    assert_eq!(stats.allocated_buffers, 2);
    assert_eq!(stats.in_use_buffers, 2);
    assert_eq!(stats.exhausted_acquires, 2);
    assert!(stats.reused_acquires >= 1);
    drop(reused);
    drop(second);
    assert_eq!(pool.stats().in_use_buffers, 0);
}

#[test]
fn datagram_pool_never_exceeds_its_ceiling_under_concurrent_acquire() {
    let pool = Arc::new(
        DatagramPool::new(DatagramPoolConfig {
            datagram_bytes: 128,
            initial_buffers: 0,
            max_buffers: 8,
        })
        .expect("pool"),
    );
    let barrier = Arc::new(Barrier::new(17));
    let (result_tx, result_rx) = mpsc::channel();
    let threads: Vec<_> = (0..16)
        .map(|_| {
            let pool = pool.clone();
            let barrier = barrier.clone();
            let result_tx = result_tx.clone();
            thread::spawn(move || {
                barrier.wait();
                let buffer = pool.try_acquire();
                result_tx.send(buffer.is_some()).expect("result");
                barrier.wait();
                drop(buffer);
            })
        })
        .collect();
    drop(result_tx);

    barrier.wait();
    let acquired = (0..16)
        .filter(|_| result_rx.recv().expect("acquire result"))
        .count();
    assert_eq!(acquired, 8);
    assert_eq!(pool.stats().allocated_buffers, 8);
    assert_eq!(pool.stats().in_use_buffers, 8);
    assert_eq!(pool.stats().exhausted_acquires, 8);
    barrier.wait();
    for thread in threads {
        thread.join().expect("pool worker");
    }
    assert_eq!(pool.stats().in_use_buffers, 0);
}

#[test]
fn fixed_worker_processes_real_udp_in_both_directions_without_task_per_leg() {
    let pool = RtpWorkerPool::new(worker_config()).expect("worker pool");
    let binding = pool
        .install_session("media-1", localhost(0), localhost(0), media_config())
        .expect("install session");
    assert_ne!(binding.leg_a_local_addr, binding.leg_b_local_addr);

    let endpoint_a = endpoint();
    let endpoint_b = endpoint();
    endpoint_b
        .send_to(&opus(10, 48_000, 222), binding.leg_b_local_addr)
        .expect("latch B");
    thread::sleep(Duration::from_millis(40));
    endpoint_a
        .send_to(&pcmu(20, 1_600, 111), binding.leg_a_local_addr)
        .expect("A to B");

    let mut receive = [0_u8; 2_048];
    let (received, source) = endpoint_b.recv_from(&mut receive).expect("Opus response");
    assert_eq!(source, binding.leg_b_local_addr);
    let to_b = RtpPacket::parse(&receive[..received]).expect("wire Opus");
    assert_eq!(to_b.header.payload_type, 111);
    assert_eq!(to_b.header.sequence_number, 5_000);
    assert_eq!(
        create_decoder(CodecType::Opus).decode(&to_b.payload).len(),
        960
    );

    endpoint_b
        .send_to(&opus(11, 48_960, 222), binding.leg_b_local_addr)
        .expect("B to A");
    let (received, source) = endpoint_a.recv_from(&mut receive).expect("PCMU response");
    assert_eq!(source, binding.leg_a_local_addr);
    let to_a = RtpPacket::parse(&receive[..received]).expect("wire PCMU");
    assert_eq!(to_a.header.payload_type, 0);
    assert_eq!(to_a.header.sequence_number, 6_001);
    assert_eq!(to_a.payload.len(), 160);

    let snapshot = pool.snapshot().expect("worker snapshot");
    assert_eq!(snapshot.active_sessions, 1);
    assert!(snapshot.rtp_datagrams_received >= 3);
    assert!(snapshot.rtp_datagrams_sent >= 2);
    assert_eq!(snapshot.worker_threads, 1);
}

#[test]
fn worker_destination_hint_delivers_early_media_before_symmetric_rtp() {
    let pool = RtpWorkerPool::new(worker_config()).expect("worker pool");
    let binding = pool
        .install_session(
            "media-destination-hint",
            localhost(0),
            localhost(0),
            media_config(),
        )
        .expect("install session");
    let endpoint_a = endpoint();
    let endpoint_b = endpoint();
    pool.set_destination_hint(
        "media-destination-hint",
        ProcessingLeg::B,
        Some(endpoint_b.local_addr().expect("B local address")),
    )
    .expect("set destination hint");

    endpoint_a
        .send_to(&pcmu(1, 0, 111), binding.leg_a_local_addr)
        .expect("first early packet");
    endpoint_a
        .send_to(&pcmu(2, 160, 111), binding.leg_a_local_addr)
        .expect("second early packet");

    let mut receive = [0_u8; 2_048];
    let (received, source) = endpoint_b.recv_from(&mut receive).expect("early Opus");
    assert_eq!(source, binding.leg_b_local_addr);
    assert_eq!(
        RtpPacket::parse(&receive[..received])
            .expect("wire Opus")
            .header
            .payload_type,
        111
    );
}

#[test]
fn fixed_worker_processes_pcma_and_opus_on_the_real_udp_wire_path() {
    let pool = RtpWorkerPool::new(worker_config()).expect("worker pool");
    let binding = pool
        .install_session(
            "media-pcma",
            localhost(0),
            localhost(0),
            pcma_media_config(),
        )
        .expect("install PCMA session");
    let endpoint_a = endpoint();
    let endpoint_b = endpoint();
    endpoint_b
        .send_to(&opus(10, 48_000, 222), binding.leg_b_local_addr)
        .expect("latch B");
    endpoint_a
        .send_to(&pcma(20, 1_600, 111), binding.leg_a_local_addr)
        .expect("PCMA to Opus");

    let mut receive = [0_u8; 2_048];
    let (received, _) = endpoint_b.recv_from(&mut receive).expect("Opus response");
    let to_b = RtpPacket::parse(&receive[..received]).expect("wire Opus");
    assert_eq!(to_b.header.payload_type, 111);
    assert_eq!(
        create_decoder(CodecType::Opus).decode(&to_b.payload).len(),
        960
    );

    endpoint_b
        .send_to(&opus(11, 48_960, 222), binding.leg_b_local_addr)
        .expect("Opus to PCMA");
    let (received, _) = endpoint_a.recv_from(&mut receive).expect("PCMA response");
    let to_a = RtpPacket::parse(&receive[..received]).expect("wire PCMA");
    assert_eq!(to_a.header.payload_type, 8);
    assert_eq!(to_a.payload.len(), 160);
    assert_eq!(
        create_decoder(CodecType::PCMA).decode(&to_a.payload).len(),
        160
    );
}

#[test]
fn worker_install_is_idempotent_bounded_and_conflict_safe() {
    let mut config = worker_config();
    config.max_sessions_per_worker = 1;
    let pool = RtpWorkerPool::new(config).expect("worker pool");
    let first = pool
        .install_session("media-1", localhost(0), localhost(0), media_config())
        .expect("first session");
    let replay = pool
        .install_session("media-1", localhost(0), localhost(0), media_config())
        .expect("idempotent replay");
    assert_eq!(replay, first);

    let mut conflicting = media_config();
    conflicting.a_to_b_ssrc = 7;
    assert_eq!(
        pool.install_session("media-1", localhost(0), localhost(0), conflicting)
            .expect_err("configuration conflict"),
        WorkerError::SessionConflict
    );
    assert_eq!(
        pool.install_session("media-2", localhost(0), localhost(0), media_config())
            .expect_err("worker capacity"),
        WorkerError::SessionCapacityExhausted { limit: 1 }
    );
    assert!(pool.remove_session("media-1").expect("remove"));
    assert!(!pool.remove_session("media-1").expect("idempotent remove"));
}

#[cfg(unix)]
#[test]
fn reuse_port_allows_two_sessions_to_bind_the_same_udp_addresses() {
    let leg_a = UdpSocket::bind(localhost(0))
        .expect("reserve A")
        .local_addr()
        .expect("A address");
    let leg_b = UdpSocket::bind(localhost(0))
        .expect("reserve B")
        .local_addr()
        .expect("B address");
    let mut config = worker_config();
    config.reuse_port = true;
    let pool = RtpWorkerPool::new(config).expect("worker pool");
    pool.install_session("reuse-port-a", leg_a, leg_b, media_config())
        .expect("first shared bind");
    pool.install_session("reuse-port-b", leg_a, leg_b, media_config())
        .expect("second shared bind");
    assert_eq!(pool.snapshot().expect("snapshot").active_sessions, 2);
}

#[test]
fn worker_rejects_a_zero_ivr_timer_budget() {
    let mut config = worker_config();
    config.max_ivr_sessions_per_tick = 0;
    let Err(error) = RtpWorkerPool::new(config) else {
        panic!("zero timer budget must fail closed");
    };
    assert_eq!(
        error,
        WorkerError::InvalidConfiguration {
            field: "max_ivr_sessions_per_tick"
        }
    );
}

#[test]
fn worker_emits_one_completed_dtmf_event_for_rfc4733_retransmits() {
    let pool = RtpWorkerPool::new(worker_config()).expect("worker pool");
    let binding = pool
        .install_session("media-dtmf", localhost(0), localhost(0), media_config())
        .expect("install session");
    let endpoint_a = endpoint();
    let endpoint_b = endpoint();
    endpoint_b
        .send_to(&opus(1, 0, 222), binding.leg_b_local_addr)
        .expect("latch B");
    thread::sleep(Duration::from_millis(40));

    endpoint_a
        .send_to(
            &wire(101, 10, 1_600, 111, vec![5, 10, 0, 160]),
            binding.leg_a_local_addr,
        )
        .expect("DTMF start");
    endpoint_a
        .send_to(
            &wire(101, 11, 1_600, 111, vec![5, 0x80 | 10, 1, 64]),
            binding.leg_a_local_addr,
        )
        .expect("DTMF end");
    endpoint_a
        .send_to(
            &wire(101, 12, 1_600, 111, vec![5, 0x80 | 10, 1, 64]),
            binding.leg_a_local_addr,
        )
        .expect("DTMF retransmit");

    let started = pool
        .recv_event_timeout(Duration::from_secs(2))
        .expect("DTMF started event");
    let completed = pool
        .recv_event_timeout(Duration::from_secs(2))
        .expect("DTMF completed event");
    assert!(matches!(
        started,
        WorkerEvent::Dtmf {
            ref session_id,
            event
        } if session_id.as_ref() == "media-dtmf"
            && event.ingress_leg == ProcessingLeg::A
            && event.phase == DtmfPhase::Started
    ));
    assert!(matches!(
        completed,
        WorkerEvent::Dtmf {
            ref session_id,
            event
        } if session_id.as_ref() == "media-dtmf"
            && event.phase == DtmfPhase::Completed
            && event.duration == 320
    ));
    assert!(
        pool.recv_event_timeout(Duration::from_millis(100))
            .is_none(),
        "repeated end packet must not emit another logical digit"
    );
}

#[test]
fn fixed_worker_drains_a_burst_larger_than_one_readiness_budget() {
    let mut config = worker_config();
    config.max_packets_per_socket_event = 1;
    config.poll_timeout = Duration::from_secs(1);
    let pool = RtpWorkerPool::new(config).expect("worker pool");
    let binding = pool
        .install_session("media-burst", localhost(0), localhost(0), media_config())
        .expect("install session");
    let endpoint_a = endpoint();
    let endpoint_b = endpoint();
    endpoint_b
        .send_to(&opus(1, 0, 222), binding.leg_b_local_addr)
        .expect("latch B");
    endpoint_a
        .send_to(&pcmu(1, 0, 111), binding.leg_a_local_addr)
        .expect("latch A");

    let mut receive = [0_u8; 2_048];
    endpoint_b
        .recv_from(&mut receive)
        .expect("initial A to B packet");

    const BURST: u16 = 32;
    for offset in 0..BURST {
        endpoint_a
            .send_to(
                &pcmu(2 + offset, 160 * u32::from(2 + offset), 111),
                binding.leg_a_local_addr,
            )
            .expect("burst packet");
    }
    for _ in 0..BURST {
        let (received, _) = endpoint_b.recv_from(&mut receive).expect("burst output");
        let packet = RtpPacket::parse(&receive[..received]).expect("wire Opus");
        assert_eq!(packet.header.payload_type, 111);
    }
    assert!(pool.snapshot().expect("snapshot").rtp_datagrams_received >= 34);
}

#[test]
fn fixed_worker_plays_cached_pcm_and_barges_in_from_sip_info() {
    let pool = RtpWorkerPool::new(worker_config()).expect("worker pool");
    pool.cache_prompt_pcm("short", 48_000, &sine(48_000, 1_920))
        .expect("cache prompt");
    pool.cache_prompt_pcm("long", 48_000, &sine(48_000, 9_600))
        .expect("cache long prompt");
    let binding = pool
        .install_session("media-ivr", localhost(0), localhost(0), media_config())
        .expect("install session");
    let endpoint_b = endpoint();
    endpoint_b
        .send_to(&opus(1, 0, 222), binding.leg_b_local_addr)
        .expect("latch B");
    thread::sleep(Duration::from_millis(20));

    pool.start_playback(
        "media-ivr",
        WorkerPlaybackRequest {
            command_id: Arc::from("play-short"),
            prompt_id: Arc::from("short"),
            egress_leg: ProcessingLeg::B,
            barge_in: false,
        },
    )
    .expect("start prompt");
    assert!(matches!(
        pool.recv_event_timeout(Duration::from_secs(2)),
        Some(WorkerEvent::Ivr {
            event: IvrEvent::PlaybackStarted { ref command_id, .. },
            ..
        }) if command_id.as_ref() == "play-short"
    ));

    let mut receive = [0_u8; 2_048];
    let (first_len, _) = endpoint_b
        .recv_from(&mut receive)
        .expect("first prompt packet");
    let first = RtpPacket::parse(&receive[..first_len]).expect("first prompt RTP");
    let (second_len, _) = endpoint_b
        .recv_from(&mut receive)
        .expect("second prompt packet");
    let second = RtpPacket::parse(&receive[..second_len]).expect("second prompt RTP");
    assert_eq!(first.header.payload_type, 111);
    assert_eq!(first.header.sequence_number, 5_000);
    assert_eq!(second.header.sequence_number, 5_001);
    assert!(matches!(
        pool.recv_event_timeout(Duration::from_secs(2)),
        Some(WorkerEvent::Ivr {
            event: IvrEvent::PlaybackCompleted { ref command_id, .. },
            ..
        }) if command_id.as_ref() == "play-short"
    ));

    pool.start_playback(
        "media-ivr",
        WorkerPlaybackRequest {
            command_id: Arc::from("play-long"),
            prompt_id: Arc::from("long"),
            egress_leg: ProcessingLeg::B,
            barge_in: true,
        },
    )
    .expect("start long prompt");
    pool.start_gather(
        "media-ivr",
        WorkerGatherRequest {
            command_id: Arc::from("gather-sip-info"),
            minimum_digits: 1,
            maximum_digits: 4,
            terminator: Some('#'),
            first_digit_timeout_ms: 2_000,
            inter_digit_timeout_ms: 1_000,
        },
    )
    .expect("start gather");
    let digit = pool
        .submit_sip_info_digit("media-ivr", "sip-info-5", '5')
        .expect("SIP INFO digit");
    assert!(digit.accepted);
    assert!(digit.playback_barged_in);
    let terminator = pool
        .submit_sip_info_digit("media-ivr", "sip-info-end", '#')
        .expect("SIP INFO terminator");
    assert!(terminator.gather_completed);

    let mut saw_barge = false;
    let mut saw_gather = false;
    for _ in 0..6 {
        let Some(event) = pool.recv_event_timeout(Duration::from_secs(2)) else {
            break;
        };
        match event {
            WorkerEvent::Ivr {
                event:
                    IvrEvent::PlaybackStopped {
                        reason: PlaybackStopReason::BargeIn,
                        ..
                    },
                ..
            } => saw_barge = true,
            WorkerEvent::Ivr {
                event:
                    IvrEvent::GatherCompleted {
                        ref digits,
                        reason: GatherCompletionReason::Terminator,
                        ..
                    },
                ..
            } if digits.as_ref() == "5" => saw_gather = true,
            _ => {}
        }
        if saw_barge && saw_gather {
            break;
        }
    }
    assert!(saw_barge);
    assert!(saw_gather);
}

#[test]
fn worker_ivr_commands_remain_idempotent_when_internal_clock_advances() {
    let pool = RtpWorkerPool::new(worker_config()).expect("worker pool");
    pool.cache_prompt_pcm("idempotent", 48_000, &sine(48_000, 1_920))
        .expect("cache prompt");
    pool.install_session(
        "media-ivr-idempotent",
        localhost(0),
        localhost(0),
        media_config(),
    )
    .expect("install session");
    let playback = WorkerPlaybackRequest {
        command_id: Arc::from("play-idempotent"),
        prompt_id: Arc::from("idempotent"),
        egress_leg: ProcessingLeg::B,
        barge_in: true,
    };
    assert!(
        !pool
            .start_playback("media-ivr-idempotent", playback.clone())
            .expect("first playback")
            .replayed
    );
    thread::sleep(Duration::from_millis(5));
    assert!(
        pool.start_playback("media-ivr-idempotent", playback)
            .expect("replayed playback")
            .replayed
    );

    let gather = WorkerGatherRequest {
        command_id: Arc::from("gather-idempotent"),
        minimum_digits: 1,
        maximum_digits: 4,
        terminator: Some('#'),
        first_digit_timeout_ms: 2_000,
        inter_digit_timeout_ms: 1_000,
    };
    assert!(
        !pool
            .start_gather("media-ivr-idempotent", gather.clone())
            .expect("first gather")
            .replayed
    );
    thread::sleep(Duration::from_millis(5));
    assert!(
        pool.start_gather("media-ivr-idempotent", gather)
            .expect("replayed gather")
            .replayed
    );
}

#[test]
fn worker_ivr_replace_mode_suppresses_live_media_and_resumes_contiguously() {
    let pool = RtpWorkerPool::new(worker_config()).expect("worker pool");
    pool.cache_prompt_pcm("replace", 48_000, &sine(48_000, 4 * 960))
        .expect("cache prompt");
    let binding = pool
        .install_session(
            "media-ivr-replace",
            localhost(0),
            localhost(0),
            media_config(),
        )
        .expect("install session");
    let endpoint_a = endpoint();
    let endpoint_b = endpoint();
    endpoint_b
        .send_to(&opus(1, 0, 222), binding.leg_b_local_addr)
        .expect("latch B");
    endpoint_a
        .send_to(&pcmu(1, 0, 111), binding.leg_a_local_addr)
        .expect("latch A");
    let mut receive = [0_u8; 2_048];
    endpoint_b
        .recv_from(&mut receive)
        .expect("initial live packet");

    pool.start_playback(
        "media-ivr-replace",
        WorkerPlaybackRequest {
            command_id: Arc::from("play-replace"),
            prompt_id: Arc::from("replace"),
            egress_leg: ProcessingLeg::B,
            barge_in: false,
        },
    )
    .expect("start prompt");
    assert!(matches!(
        pool.recv_event_timeout(Duration::from_secs(2)),
        Some(WorkerEvent::Ivr {
            event: IvrEvent::PlaybackStarted { .. },
            ..
        })
    ));
    for offset in 0..4_u16 {
        let sequence = 2 + offset;
        endpoint_a
            .send_to(
                &pcmu(sequence, u32::from(sequence) * 160, 111),
                binding.leg_a_local_addr,
            )
            .expect("live media during prompt");
    }

    for expected_sequence in 5_001..=5_004 {
        let (received, _) = endpoint_b.recv_from(&mut receive).expect("prompt packet");
        let packet = RtpPacket::parse(&receive[..received]).expect("wire Opus");
        assert_eq!(packet.header.sequence_number, expected_sequence);
    }
    assert!(matches!(
        pool.recv_event_timeout(Duration::from_secs(2)),
        Some(WorkerEvent::Ivr {
            event: IvrEvent::PlaybackCompleted { .. },
            ..
        })
    ));
    endpoint_b
        .set_read_timeout(Some(Duration::from_millis(100)))
        .expect("short read timeout");
    assert!(
        endpoint_b.recv_from(&mut receive).is_err(),
        "suppressed live packets must not leak beside the prompt"
    );

    endpoint_a
        .send_to(&pcmu(6, 960, 111), binding.leg_a_local_addr)
        .expect("live media after prompt");
    let (received, _) = endpoint_b
        .recv_from(&mut receive)
        .expect("resumed live packet");
    let resumed = RtpPacket::parse(&receive[..received]).expect("resumed wire Opus");
    assert_eq!(resumed.header.sequence_number, 5_005);
}

#[test]
fn ivr_playback_waits_for_a_real_rtp_destination_without_consuming_frames() {
    let pool = RtpWorkerPool::new(worker_config()).expect("worker pool");
    pool.cache_prompt_pcm("late-destination", 48_000, &sine(48_000, 1_920))
        .expect("cache prompt");
    let binding = pool
        .install_session(
            "media-late-destination",
            localhost(0),
            localhost(0),
            media_config(),
        )
        .expect("install session");
    pool.start_playback(
        "media-late-destination",
        WorkerPlaybackRequest {
            command_id: Arc::from("play-late-destination"),
            prompt_id: Arc::from("late-destination"),
            egress_leg: ProcessingLeg::B,
            barge_in: false,
        },
    )
    .expect("start prompt");
    assert!(matches!(
        pool.recv_event_timeout(Duration::from_secs(2)),
        Some(WorkerEvent::Ivr {
            event: IvrEvent::PlaybackStarted { .. },
            ..
        })
    ));

    thread::sleep(Duration::from_millis(80));
    assert!(
        pool.recv_event_timeout(Duration::from_millis(20)).is_none(),
        "playback must not complete before leg B has a learned destination"
    );

    let endpoint_b = endpoint();
    endpoint_b
        .send_to(&opus(1, 0, 222), binding.leg_b_local_addr)
        .expect("latch delayed destination");
    let mut receive = [0_u8; 2_048];
    let (first_len, _) = endpoint_b
        .recv_from(&mut receive)
        .expect("first delayed prompt packet");
    let first = RtpPacket::parse(&receive[..first_len]).expect("wire Opus");
    assert_eq!(first.header.sequence_number, 5_000);
    assert!(
        first.header.marker,
        "first retained IVR frame must keep the marker bit"
    );
    let (second_len, _) = endpoint_b
        .recv_from(&mut receive)
        .expect("second delayed prompt packet");
    let second = RtpPacket::parse(&receive[..second_len]).expect("wire Opus");
    assert_eq!(second.header.sequence_number, 5_001);
    assert!(matches!(
        pool.recv_event_timeout(Duration::from_secs(2)),
        Some(WorkerEvent::Ivr {
            event: IvrEvent::PlaybackCompleted { ref command_id, .. },
            ..
        }) if command_id.as_ref() == "play-late-destination"
    ));
}

#[test]
fn completed_rfc4733_packet_barges_and_drives_the_worker_gather_state_machine() {
    let pool = RtpWorkerPool::new(worker_config()).expect("worker pool");
    pool.cache_prompt_pcm("rfc4733-barge", 48_000, &sine(48_000, 9_600))
        .expect("cache prompt");
    let binding = pool
        .install_session(
            "media-rfc4733-gather",
            localhost(0),
            localhost(0),
            media_config(),
        )
        .expect("install session");
    pool.start_playback(
        "media-rfc4733-gather",
        WorkerPlaybackRequest {
            command_id: Arc::from("play-rfc4733"),
            prompt_id: Arc::from("rfc4733-barge"),
            egress_leg: ProcessingLeg::B,
            barge_in: true,
        },
    )
    .expect("start prompt");
    pool.start_gather(
        "media-rfc4733-gather",
        WorkerGatherRequest {
            command_id: Arc::from("gather-rfc4733"),
            minimum_digits: 1,
            maximum_digits: 1,
            terminator: None,
            first_digit_timeout_ms: 2_000,
            inter_digit_timeout_ms: 1_000,
        },
    )
    .expect("start gather");
    assert!(matches!(
        pool.recv_event_timeout(Duration::from_secs(2)),
        Some(WorkerEvent::Ivr {
            event: IvrEvent::PlaybackStarted { .. },
            ..
        })
    ));
    assert!(matches!(
        pool.recv_event_timeout(Duration::from_secs(2)),
        Some(WorkerEvent::Ivr {
            event: IvrEvent::GatherStarted { .. },
            ..
        })
    ));

    let endpoint_a = endpoint();
    endpoint_a
        .send_to(
            &wire(101, 10, 1_600, 111, vec![7, 10, 0, 160]),
            binding.leg_a_local_addr,
        )
        .expect("DTMF start");
    endpoint_a
        .send_to(
            &wire(101, 11, 1_600, 111, vec![7, 0x80 | 10, 1, 64]),
            binding.leg_a_local_addr,
        )
        .expect("DTMF end");

    let mut completed = false;
    let mut barged = false;
    for _ in 0..6 {
        let Some(event) = pool.recv_event_timeout(Duration::from_secs(2)) else {
            break;
        };
        if matches!(
            event,
            WorkerEvent::Ivr {
                event: IvrEvent::PlaybackStopped {
                    reason: PlaybackStopReason::BargeIn,
                    ..
                },
                ..
            }
        ) {
            barged = true;
        }
        if matches!(
            event,
            WorkerEvent::Ivr {
                event:
                    IvrEvent::GatherCompleted {
                        ref command_id,
                        ref digits,
                        reason: GatherCompletionReason::MaximumDigits,
                        minimum_satisfied: true,
                    },
                ..
            } if command_id.as_ref() == "gather-rfc4733" && digits.as_ref() == "7"
        ) {
            completed = true;
        }
        if completed && barged {
            break;
        }
    }
    assert!(
        barged,
        "completed RFC 4733 input must barge into replace-mode playback"
    );
    assert!(
        completed,
        "completed RFC 4733 input must complete the active worker gather"
    );
}

#[test]
fn worker_dispatches_explicit_stop_commands_and_replays_without_duplicate_events() {
    let pool = RtpWorkerPool::new(worker_config()).expect("worker pool");
    pool.cache_prompt_pcm("stop-worker", 48_000, &sine(48_000, 9_600))
        .expect("cache prompt");
    pool.install_session(
        "media-stop-worker",
        localhost(0),
        localhost(0),
        media_config(),
    )
    .expect("install session");
    pool.start_playback(
        "media-stop-worker",
        WorkerPlaybackRequest {
            command_id: Arc::from("play-worker"),
            prompt_id: Arc::from("stop-worker"),
            egress_leg: ProcessingLeg::B,
            barge_in: false,
        },
    )
    .expect("start playback");
    pool.start_gather(
        "media-stop-worker",
        WorkerGatherRequest {
            command_id: Arc::from("gather-worker"),
            minimum_digits: 1,
            maximum_digits: 4,
            terminator: None,
            first_digit_timeout_ms: 2_000,
            inter_digit_timeout_ms: 1_000,
        },
    )
    .expect("start gather");
    for _ in 0..2 {
        assert!(matches!(
            pool.recv_event_timeout(Duration::from_secs(2)),
            Some(WorkerEvent::Ivr { .. })
        ));
    }

    assert!(
        !pool
            .stop_playback(
                "media-stop-worker",
                Arc::from("stop-play-worker"),
                Arc::from("play-worker"),
            )
            .expect("stop playback")
            .replayed
    );
    assert!(
        !pool
            .stop_gather(
                "media-stop-worker",
                Arc::from("stop-gather-worker"),
                Arc::from("gather-worker"),
            )
            .expect("stop gather")
            .replayed
    );
    assert!(matches!(
        pool.recv_event_timeout(Duration::from_secs(2)),
        Some(WorkerEvent::Ivr {
            event: IvrEvent::PlaybackStopped {
                reason: PlaybackStopReason::Explicit,
                ..
            },
            ..
        })
    ));
    assert!(matches!(
        pool.recv_event_timeout(Duration::from_secs(2)),
        Some(WorkerEvent::Ivr {
            event: IvrEvent::GatherCompleted {
                reason: GatherCompletionReason::ExplicitStop,
                ..
            },
            ..
        })
    ));
    assert!(
        pool.stop_playback(
            "media-stop-worker",
            Arc::from("stop-play-worker"),
            Arc::from("play-worker"),
        )
        .expect("replay stop playback")
        .replayed
    );
    assert!(
        pool.stop_gather(
            "media-stop-worker",
            Arc::from("stop-gather-worker"),
            Arc::from("gather-worker"),
        )
        .expect("replay stop gather")
        .replayed
    );
    assert!(
        pool.recv_event_timeout(Duration::from_millis(50)).is_none(),
        "stop replay must not emit another terminal event"
    );
    assert_eq!(
        pool.snapshot()
            .expect("snapshot")
            .critical_event_reservations,
        0
    );
}

#[test]
fn ivr_event_queue_overload_and_session_removal_never_block_control() {
    let mut config = worker_config();
    config.event_queue_capacity = 1;
    let pool = RtpWorkerPool::new(config).expect("worker pool");
    pool.cache_prompt_pcm("long", 48_000, &sine(48_000, 9_600))
        .expect("cache prompt");
    pool.install_session(
        "media-ivr-remove",
        localhost(0),
        localhost(0),
        media_config(),
    )
    .expect("install session");
    pool.start_playback(
        "media-ivr-remove",
        WorkerPlaybackRequest {
            command_id: Arc::from("play-remove"),
            prompt_id: Arc::from("long"),
            egress_leg: ProcessingLeg::A,
            barge_in: true,
        },
    )
    .expect("start prompt");
    pool.start_gather(
        "media-ivr-remove",
        WorkerGatherRequest {
            command_id: Arc::from("gather-remove"),
            minimum_digits: 1,
            maximum_digits: 4,
            terminator: Some('#'),
            first_digit_timeout_ms: 2_000,
            inter_digit_timeout_ms: 1_000,
        },
    )
    .expect("start gather despite full event queue");
    assert!(pool.remove_session("media-ivr-remove").expect("remove"));
    let queued = pool.snapshot().expect("queued snapshot");
    assert_eq!(queued.active_sessions, 0);
    assert_eq!(queued.critical_event_reservations, 2);
    assert_eq!(queued.critical_event_backlog, 2);
    assert!(matches!(
        pool.recv_event_timeout(Duration::from_secs(2)),
        Some(WorkerEvent::Ivr {
            event: IvrEvent::PlaybackStarted { .. },
            ..
        })
    ));

    let mut playback_cancelled = false;
    let mut gather_cancelled = false;
    for _ in 0..2 {
        match pool.recv_event_timeout(Duration::from_secs(2)) {
            Some(WorkerEvent::Ivr {
                event:
                    IvrEvent::PlaybackStopped {
                        reason: PlaybackStopReason::SessionRemoved,
                        ..
                    },
                ..
            }) => playback_cancelled = true,
            Some(WorkerEvent::Ivr {
                event:
                    IvrEvent::GatherCompleted {
                        reason: GatherCompletionReason::SessionRemoved,
                        ..
                    },
                ..
            }) => gather_cancelled = true,
            other => panic!("unexpected reliable terminal event: {other:?}"),
        }
    }
    assert!(playback_cancelled);
    assert!(gather_cancelled);
    let delivered = pool.snapshot().expect("delivered snapshot");
    assert_eq!(delivered.critical_event_reservations, 0);
    assert_eq!(delivered.critical_event_backlog, 0);
    assert!(
        delivered.event_queue_drops >= 1,
        "non-terminal gather-start telemetry may drop under overload"
    );
}

#[test]
fn terminal_event_capacity_rejects_new_work_but_not_idempotent_replay() {
    let mut config = worker_config();
    config.critical_event_capacity = 1;
    let pool = RtpWorkerPool::new(config).expect("worker pool");
    pool.cache_prompt_pcm("reserved", 48_000, &sine(48_000, 9_600))
        .expect("cache prompt");
    pool.install_session(
        "media-terminal-capacity",
        localhost(0),
        localhost(0),
        media_config(),
    )
    .expect("install session");
    let playback = WorkerPlaybackRequest {
        command_id: Arc::from("play-reserved"),
        prompt_id: Arc::from("reserved"),
        egress_leg: ProcessingLeg::B,
        barge_in: false,
    };
    assert!(
        !pool
            .start_playback("media-terminal-capacity", playback.clone())
            .expect("first playback")
            .replayed
    );
    assert!(
        pool.start_playback("media-terminal-capacity", playback)
            .expect("idempotent replay")
            .replayed
    );
    assert_eq!(
        pool.start_gather(
            "media-terminal-capacity",
            WorkerGatherRequest {
                command_id: Arc::from("gather-rejected"),
                minimum_digits: 1,
                maximum_digits: 4,
                terminator: None,
                first_digit_timeout_ms: 2_000,
                inter_digit_timeout_ms: 1_000,
            },
        )
        .expect_err("terminal capacity must reject new gather"),
        WorkerError::Ivr(voice_media_rs::ivr::IvrError::TerminalEventCapacityExhausted)
    );
    assert_eq!(
        pool.snapshot()
            .expect("snapshot")
            .critical_event_admission_rejections,
        1
    );
}

#[test]
fn bounded_ivr_timer_budget_eventually_services_every_due_session() {
    let mut config = worker_config();
    config.max_sessions_per_worker = 8;
    config.max_ivr_sessions_per_tick = 1;
    let pool = RtpWorkerPool::new(config).expect("worker pool");
    for index in 0..8 {
        let session_id = format!("timer-{index}");
        pool.install_session(&session_id, localhost(0), localhost(0), media_config())
            .expect("install timer session");
        pool.start_gather(
            &session_id,
            WorkerGatherRequest {
                command_id: Arc::from(format!("gather-{index}")),
                minimum_digits: 1,
                maximum_digits: 4,
                terminator: None,
                first_digit_timeout_ms: 20,
                inter_digit_timeout_ms: 20,
            },
        )
        .expect("start gather");
    }
    let mut started = 0;
    let mut completed = std::collections::BTreeSet::new();
    for _ in 0..16 {
        match pool.recv_event_timeout(Duration::from_secs(2)) {
            Some(WorkerEvent::Ivr {
                event: IvrEvent::GatherStarted { .. },
                ..
            }) => started += 1,
            Some(WorkerEvent::Ivr {
                session_id,
                event:
                    IvrEvent::GatherCompleted {
                        reason: GatherCompletionReason::Timeout,
                        ..
                    },
            }) => {
                completed.insert(session_id);
            }
            other => panic!("unexpected timer event: {other:?}"),
        }
    }
    assert_eq!(started, 8);
    assert_eq!(completed.len(), 8);
    assert_eq!(
        pool.snapshot()
            .expect("snapshot")
            .critical_event_reservations,
        0
    );
}
