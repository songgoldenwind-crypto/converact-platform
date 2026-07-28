use audio_codec::{create_decoder, create_encoder, CodecType};
use bytes::Bytes;
use rustrtc::rtp::{RtpHeader, RtpPacket};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use voice_media_rs::codec::AudioCodec;
use voice_media_rs::pipeline::Concealment;
use voice_media_rs::rtp::{
    DtmfEvent, DtmfPhase, EmissionKind, PacketDisposition, ProcessingLeg, RtpEmission,
    RtpProcessError, RtpProcessSink, RtpSessionConfig, RtpSessionProcessor, TelephoneEventConfig,
};
use voice_media_rs::session::ProcessingProfile;

#[derive(Debug)]
struct CapturedEmission {
    egress_leg: ProcessingLeg,
    destination: SocketAddr,
    datagram: Vec<u8>,
    kind: EmissionKind,
}

#[derive(Default)]
struct Collector {
    emissions: Vec<CapturedEmission>,
    dtmf_events: Vec<DtmfEvent>,
}

impl RtpProcessSink for Collector {
    fn emit(&mut self, emission: RtpEmission<'_>) {
        self.emissions.push(CapturedEmission {
            egress_leg: emission.egress_leg,
            destination: emission.destination,
            datagram: emission.datagram.to_vec(),
            kind: emission.kind,
        });
    }

    fn on_dtmf(&mut self, event: DtmfEvent) {
        self.dtmf_events.push(event);
    }
}

fn addr(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

fn sine(sample_rate: usize, samples: usize) -> Vec<i16> {
    (0..samples)
        .map(|index| {
            let phase = 2.0 * std::f64::consts::PI * 440.0 * index as f64 / sample_rate as f64;
            (phase.sin() * 8_000.0) as i16
        })
        .collect()
}

fn encoded(codec: CodecType, sample_rate: usize, samples: usize) -> Vec<u8> {
    create_encoder(codec).encode(&sine(sample_rate, samples))
}

fn wire_packet(
    payload_type: u8,
    sequence: u16,
    timestamp: u32,
    ssrc: u32,
    marker: bool,
    payload: Vec<u8>,
) -> Bytes {
    let mut header = RtpHeader::new(payload_type, sequence, timestamp, ssrc);
    header.marker = marker;
    Bytes::from(
        RtpPacket::new(header, payload)
            .marshal()
            .expect("valid RTP fixture"),
    )
}

fn config() -> RtpSessionConfig {
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

fn pcmu(sequence: u16, timestamp: u32, ssrc: u32) -> Bytes {
    wire_packet(
        0,
        sequence,
        timestamp,
        ssrc,
        false,
        encoded(CodecType::PCMU, 8_000, 160),
    )
}

fn opus(sequence: u16, timestamp: u32, ssrc: u32) -> Bytes {
    wire_packet(
        111,
        sequence,
        timestamp,
        ssrc,
        false,
        encoded(CodecType::Opus, 48_000, 960),
    )
}

#[test]
fn packet_processor_transcodes_both_directions_and_rewrites_wire_headers() {
    let mut processor = RtpSessionProcessor::new(config()).expect("processor");
    let mut collector = Collector::default();

    let no_destination = processor
        .process_bytes(
            ProcessingLeg::B,
            addr(40_002),
            opus(10, 48_000, 222),
            0,
            &mut collector,
        )
        .expect("first B packet");
    assert_eq!(no_destination.disposition, PacketDisposition::Media);
    assert_eq!(no_destination.emitted_packets, 0);
    assert_eq!(processor.stats().no_destination_packets, 1);

    processor
        .process_bytes(
            ProcessingLeg::A,
            addr(40_000),
            pcmu(20, 1_600, 111),
            1,
            &mut collector,
        )
        .expect("A to B");
    assert_eq!(collector.emissions.len(), 1);
    let to_b = &collector.emissions[0];
    assert_eq!(to_b.egress_leg, ProcessingLeg::B);
    assert_eq!(to_b.destination, addr(40_002));
    assert_eq!(
        to_b.kind,
        EmissionKind::Audio {
            concealment: Concealment::None
        }
    );
    let to_b_packet = RtpPacket::parse(&to_b.datagram).expect("wire Opus");
    assert_eq!(to_b_packet.header.payload_type, 111);
    assert_eq!(to_b_packet.header.sequence_number, 5_000);
    assert_eq!(to_b_packet.header.timestamp, 96_000);
    assert_eq!(to_b_packet.header.ssrc, 0xAABB_CCDD);
    assert_eq!(
        create_decoder(CodecType::Opus)
            .decode(&to_b_packet.payload)
            .len(),
        960
    );

    collector.emissions.clear();
    processor
        .process_bytes(
            ProcessingLeg::B,
            addr(40_002),
            opus(11, 48_960, 222),
            2,
            &mut collector,
        )
        .expect("B to A");
    assert_eq!(collector.emissions.len(), 1);
    let to_a = &collector.emissions[0];
    assert_eq!(to_a.egress_leg, ProcessingLeg::A);
    assert_eq!(to_a.destination, addr(40_000));
    let to_a_packet = RtpPacket::parse(&to_a.datagram).expect("wire PCMU");
    assert_eq!(to_a_packet.header.payload_type, 0);
    assert_eq!(to_a_packet.header.sequence_number, 6_001);
    assert_eq!(to_a_packet.header.timestamp, 8_160);
    assert_eq!(to_a_packet.header.ssrc, 0x1122_3344);
    assert_eq!(to_a_packet.payload.len(), 160);
}

#[test]
fn packet_processor_rejects_wrong_payload_type_before_decode() {
    let mut processor = RtpSessionProcessor::new(config()).expect("processor");
    let mut collector = Collector::default();
    let invalid = wire_packet(8, 1, 0, 111, false, vec![0; 160]);

    assert_eq!(
        processor
            .process_bytes(ProcessingLeg::A, addr(40_000), invalid, 0, &mut collector)
            .expect_err("wrong payload type"),
        RtpProcessError::UnexpectedPayloadType {
            leg: ProcessingLeg::A,
            expected_media: 0,
            expected_telephone_event: Some(101),
            actual: 8,
        }
    );
    assert_eq!(processor.stats().unexpected_payload_type_packets, 1);
    assert!(collector.emissions.is_empty());
}

#[test]
fn source_latch_allows_only_same_ssrc_after_rebind_quiet_period() {
    let mut processor = RtpSessionProcessor::new(config()).expect("processor");
    let mut collector = Collector::default();

    processor
        .process_bytes(
            ProcessingLeg::A,
            addr(40_000),
            pcmu(1, 0, 111),
            0,
            &mut collector,
        )
        .expect("initial latch");
    assert_eq!(processor.source(ProcessingLeg::A), Some(addr(40_000)));

    assert_eq!(
        processor
            .process_bytes(
                ProcessingLeg::A,
                addr(50_000),
                pcmu(2, 160, 111),
                999,
                &mut collector,
            )
            .expect_err("early source change"),
        RtpProcessError::SourceRejected {
            leg: ProcessingLeg::A
        }
    );

    processor
        .process_bytes(
            ProcessingLeg::A,
            addr(50_000),
            pcmu(2, 160, 111),
            1_000,
            &mut collector,
        )
        .expect("NAT rebind");
    assert_eq!(processor.source(ProcessingLeg::A), Some(addr(50_000)));

    assert_eq!(
        processor
            .process_bytes(
                ProcessingLeg::A,
                addr(60_000),
                pcmu(3, 320, 999),
                2_000,
                &mut collector,
            )
            .expect_err("SSRC change"),
        RtpProcessError::SourceRejected {
            leg: ProcessingLeg::A
        }
    );
    assert_eq!(processor.stats().source_rebinds, 1);
    assert_eq!(processor.stats().source_rejected_packets, 2);
}

#[test]
fn rfc4733_events_are_remapped_scaled_and_completed_once() {
    let mut processor = RtpSessionProcessor::new(config()).expect("processor");
    let mut collector = Collector::default();

    processor
        .process_bytes(
            ProcessingLeg::B,
            addr(40_002),
            opus(1, 0, 222),
            0,
            &mut collector,
        )
        .expect("latch B");

    let event_start = wire_packet(101, 10, 1_600, 111, true, vec![5, 10, 0, 160]);
    processor
        .process_bytes(
            ProcessingLeg::A,
            addr(40_000),
            event_start,
            1,
            &mut collector,
        )
        .expect("DTMF start");
    let event_end = wire_packet(101, 11, 1_600, 111, false, vec![5, 0x80 | 10, 1, 64]);
    processor
        .process_bytes(ProcessingLeg::A, addr(40_000), event_end, 2, &mut collector)
        .expect("DTMF end");
    let repeated_end = wire_packet(101, 12, 1_600, 111, false, vec![5, 0x80 | 10, 1, 64]);
    processor
        .process_bytes(
            ProcessingLeg::A,
            addr(40_000),
            repeated_end,
            3,
            &mut collector,
        )
        .expect("repeated DTMF end");

    assert_eq!(
        collector.dtmf_events,
        vec![
            DtmfEvent {
                ingress_leg: ProcessingLeg::A,
                code: 5,
                digit: '5',
                phase: DtmfPhase::Started,
                duration: 160,
                volume: 10,
            },
            DtmfEvent {
                ingress_leg: ProcessingLeg::A,
                code: 5,
                digit: '5',
                phase: DtmfPhase::Completed,
                duration: 320,
                volume: 10,
            }
        ]
    );
    let dtmf_packets: Vec<RtpPacket> = collector
        .emissions
        .iter()
        .filter(|emission| emission.kind == EmissionKind::TelephoneEvent)
        .map(|emission| RtpPacket::parse(&emission.datagram).expect("forwarded DTMF"))
        .collect();
    assert_eq!(dtmf_packets.len(), 3);
    assert!(dtmf_packets
        .iter()
        .all(|packet| packet.header.payload_type == 110));
    assert_eq!(dtmf_packets[0].header.sequence_number, 5_000);
    assert_eq!(dtmf_packets[0].header.timestamp, 96_000);
    assert_eq!(
        u16::from_be_bytes([dtmf_packets[0].payload[2], dtmf_packets[0].payload[3]]),
        960
    );
    assert_eq!(
        u16::from_be_bytes([dtmf_packets[1].payload[2], dtmf_packets[1].payload[3]]),
        1_920
    );
    assert_eq!(processor.stats().dtmf_completed, 1);
    assert_eq!(processor.stats().dtmf_repeated_end_packets, 1);
}

#[test]
fn rtcp_is_parsed_separately_and_malformed_datagrams_are_counted() {
    let mut processor = RtpSessionProcessor::new(config()).expect("processor");
    let mut collector = Collector::default();
    let receiver_report = Bytes::from_static(&[0x80, 201, 0, 1, 0, 0, 0, 7]);

    let summary = processor
        .process_bytes(
            ProcessingLeg::A,
            addr(40_001),
            receiver_report,
            0,
            &mut collector,
        )
        .expect("RTCP receiver report");
    assert_eq!(summary.disposition, PacketDisposition::Rtcp);
    assert_eq!(summary.rtcp_packets, 1);

    let malformed_rtcp = Bytes::from_static(&[0x80, 201, 0, 10, 0, 0, 0, 7]);
    assert_eq!(
        processor
            .process_bytes(
                ProcessingLeg::A,
                addr(40_001),
                malformed_rtcp,
                1,
                &mut collector,
            )
            .expect_err("malformed RTCP"),
        RtpProcessError::MalformedRtcp
    );
    assert_eq!(
        processor
            .process_bytes(
                ProcessingLeg::A,
                addr(40_001),
                Bytes::from_static(&[0x80, 0, 0]),
                2,
                &mut collector,
            )
            .expect_err("malformed RTP"),
        RtpProcessError::MalformedRtp
    );
    assert_eq!(processor.stats().rtcp_datagrams_received, 1);
    assert_eq!(processor.stats().rtcp_packets_received, 1);
    assert_eq!(processor.stats().malformed_rtcp_packets, 1);
    assert_eq!(processor.stats().malformed_rtp_packets, 1);
}

#[test]
fn reordered_media_emits_finite_plc_without_unbounded_queueing() {
    let mut processor = RtpSessionProcessor::new(config()).expect("processor");
    let mut collector = Collector::default();

    processor
        .process_bytes(
            ProcessingLeg::B,
            addr(40_002),
            opus(1, 0, 222),
            0,
            &mut collector,
        )
        .expect("latch B");
    processor
        .process_bytes(
            ProcessingLeg::A,
            addr(40_000),
            pcmu(10, 1_600, 111),
            1,
            &mut collector,
        )
        .expect("first audio");
    collector.emissions.clear();

    let waiting = processor
        .process_bytes(
            ProcessingLeg::A,
            addr(40_000),
            pcmu(12, 1_920, 111),
            2,
            &mut collector,
        )
        .expect("out of order packet");
    assert_eq!(waiting.disposition, PacketDisposition::Waiting);
    assert!(collector.emissions.is_empty());

    let drained = processor
        .process_bytes(
            ProcessingLeg::A,
            addr(40_000),
            pcmu(13, 2_080, 111),
            3,
            &mut collector,
        )
        .expect("drain jitter window");
    assert_eq!(drained.emitted_packets, 3);
    assert_eq!(collector.emissions.len(), 3);
    assert_eq!(
        collector.emissions[0].kind,
        EmissionKind::Audio {
            concealment: Concealment::DecayedPrevious { run: 1 }
        }
    );
    let sequences: Vec<u16> = collector
        .emissions
        .iter()
        .map(|emission| {
            RtpPacket::parse(&emission.datagram)
                .expect("emitted RTP")
                .header
                .sequence_number
        })
        .collect();
    assert_eq!(sequences, vec![5_001, 5_002, 5_003]);
    assert_eq!(processor.stats().concealed_audio_packets, 1);
    assert!(processor.buffered_packets(ProcessingLeg::A) <= config().jitter_capacity);
}
