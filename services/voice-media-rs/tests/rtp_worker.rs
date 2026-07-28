use audio_codec::{create_decoder, create_encoder, CodecType};
use bytes::Bytes;
use rustrtc::rtp::{RtpHeader, RtpPacket};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::{mpsc, Arc, Barrier};
use std::thread;
use std::time::Duration;
use voice_media_rs::codec::AudioCodec;
use voice_media_rs::datagram_pool::{DatagramPool, DatagramPoolConfig};
use voice_media_rs::rtp::{DtmfPhase, ProcessingLeg, RtpSessionConfig, TelephoneEventConfig};
use voice_media_rs::session::ProcessingProfile;
use voice_media_rs::worker::{RtpWorkerPool, RtpWorkerPoolConfig, WorkerError, WorkerEvent};

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

fn worker_config() -> RtpWorkerPoolConfig {
    RtpWorkerPoolConfig {
        worker_count: 1,
        max_sessions_per_worker: 8,
        command_queue_capacity: 16,
        event_queue_capacity: 16,
        poll_event_capacity: 64,
        max_commands_per_tick: 16,
        max_packets_per_socket_event: 8,
        max_datagram_bytes: 2_048,
        datagram_pool_initial: 16,
        datagram_pool_max: 128,
        socket_receive_buffer_bytes: 1 << 20,
        socket_send_buffer_bytes: 1 << 20,
        reuse_port: false,
        poll_timeout: Duration::from_millis(20),
        control_timeout: Duration::from_secs(2),
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
