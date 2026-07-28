use crate::codec::CodecPair;
use crate::frame::RtpAudioFrame;
use crate::jitter::{
    BoundedJitterBuffer, JitterConfigError, JitterPop, JitterPush, SequenceNumbered,
};
use crate::pipeline::{Concealment, PipelineConfig, PipelineError, ProcessingPipeline};
use crate::session::ProcessingProfile;
use bytes::Bytes;
use rustrtc::rtp::{parse_rtcp_packets, RtpHeader, RtpPacket};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::net::SocketAddr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessingLeg {
    A,
    B,
}

impl ProcessingLeg {
    const fn opposite(self) -> Self {
        match self {
            Self::A => Self::B,
            Self::B => Self::A,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RtpEgressPolicy {
    Forward,
    Suppress(ProcessingLeg),
}

impl RtpEgressPolicy {
    fn suppresses(self, egress_leg: ProcessingLeg) -> bool {
        matches!(self, Self::Suppress(leg) if leg == egress_leg)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TelephoneEventConfig {
    pub payload_type: u8,
    pub clock_rate: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RtpSessionConfig {
    pub profile: ProcessingProfile,
    pub jitter_capacity: usize,
    pub jitter_wait_depth: usize,
    pub max_drain_per_datagram: usize,
    pub max_conceal_frames: u16,
    pub max_datagram_bytes: usize,
    pub leg_a_telephone_event: Option<TelephoneEventConfig>,
    pub leg_b_telephone_event: Option<TelephoneEventConfig>,
    pub a_to_b_ssrc: u32,
    pub b_to_a_ssrc: u32,
    pub a_to_b_initial_sequence: u16,
    pub b_to_a_initial_sequence: u16,
    pub a_to_b_initial_timestamp: u32,
    pub b_to_a_initial_timestamp: u32,
    pub source_rebind_after_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DtmfPhase {
    Started,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DtmfEvent {
    pub ingress_leg: ProcessingLeg,
    pub ssrc: u32,
    pub rtp_timestamp: u32,
    pub code: u8,
    pub digit: char,
    pub phase: DtmfPhase,
    pub duration: u16,
    pub volume: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmissionKind {
    Audio { concealment: Concealment },
    Playback,
    TelephoneEvent,
}

#[derive(Debug, Clone, Copy)]
pub struct RtpEmission<'a> {
    pub egress_leg: ProcessingLeg,
    pub destination: SocketAddr,
    pub datagram: &'a [u8],
    pub kind: EmissionKind,
}

pub trait RtpProcessSink {
    fn emit(&mut self, emission: RtpEmission<'_>);
    fn on_dtmf(&mut self, event: DtmfEvent);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PacketDisposition {
    Media,
    TelephoneEvent,
    Suppressed,
    Rtcp,
    Waiting,
    Duplicate,
    Late,
    TooFarAhead,
    WindowCollision,
    BudgetExhausted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RtpProcessSummary {
    pub disposition: PacketDisposition,
    pub emitted_packets: usize,
    pub dtmf_events: usize,
    pub rtcp_packets: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RtpProcessStats {
    pub rtp_packets_received: u64,
    pub rtcp_datagrams_received: u64,
    pub rtcp_packets_received: u64,
    pub malformed_rtp_packets: u64,
    pub malformed_rtcp_packets: u64,
    pub oversized_datagrams: u64,
    pub unexpected_payload_type_packets: u64,
    pub source_rejected_packets: u64,
    pub source_rebinds: u64,
    pub duplicate_packets: u64,
    pub late_packets: u64,
    pub too_far_ahead_packets: u64,
    pub window_collision_packets: u64,
    pub emitted_audio_packets: u64,
    pub emitted_playback_packets: u64,
    pub emitted_dtmf_packets: u64,
    pub suppressed_media_packets: u64,
    pub suppressed_dtmf_packets: u64,
    pub suppressed_gap_packets: u64,
    pub concealed_audio_packets: u64,
    pub unconcealable_gaps: u64,
    pub no_destination_packets: u64,
    pub packet_budget_exhaustions: u64,
    pub dtmf_started: u64,
    pub dtmf_completed: u64,
    pub dtmf_repeated_end_packets: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RtpProcessError {
    InvalidConfiguration {
        field: &'static str,
    },
    DatagramTooLarge {
        limit: usize,
        actual: usize,
    },
    MalformedRtp,
    MalformedRtcp,
    UnexpectedPayloadType {
        leg: ProcessingLeg,
        expected_media: u8,
        expected_telephone_event: Option<u8>,
        actual: u8,
    },
    SourceRejected {
        leg: ProcessingLeg,
    },
    MalformedTelephoneEvent,
    UnsupportedTelephoneEvent {
        code: u8,
    },
    DtmfDurationRegression,
    Pipeline(PipelineError),
}

impl Display for RtpProcessError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfiguration { field } => {
                write!(formatter, "invalid RTP session configuration: {field}")
            }
            Self::DatagramTooLarge { limit, actual } => {
                write!(formatter, "RTP datagram is {actual} bytes; limit is {limit}")
            }
            Self::MalformedRtp => formatter.write_str("malformed RTP datagram"),
            Self::MalformedRtcp => formatter.write_str("malformed RTCP datagram"),
            Self::UnexpectedPayloadType {
                leg,
                expected_media,
                expected_telephone_event,
                actual,
            } => write!(
                formatter,
                "unexpected payload type {actual} on leg {leg:?}; expected media {expected_media} or telephone-event {expected_telephone_event:?}"
            ),
            Self::SourceRejected { leg } => {
                write!(formatter, "RTP source rejected on leg {leg:?}")
            }
            Self::MalformedTelephoneEvent => {
                formatter.write_str("malformed RFC 4733 telephone-event")
            }
            Self::UnsupportedTelephoneEvent { code } => {
                write!(formatter, "unsupported RFC 4733 event code {code}")
            }
            Self::DtmfDurationRegression => {
                formatter.write_str("RFC 4733 event duration moved backwards")
            }
            Self::Pipeline(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for RtpProcessError {}

impl From<PipelineError> for RtpProcessError {
    fn from(value: PipelineError) -> Self {
        Self::Pipeline(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceDecision {
    Accepted,
    Rebound,
    Rejected,
}

#[derive(Debug, Clone, Copy)]
struct SourceLatch {
    address: SocketAddr,
    ssrc: u32,
    last_seen_ms: u64,
}

impl SourceLatch {
    fn accept(
        current: &mut Option<Self>,
        address: SocketAddr,
        ssrc: u32,
        now_ms: u64,
        rebind_after_ms: u64,
    ) -> SourceDecision {
        let Some(latched) = current.as_mut() else {
            *current = Some(Self {
                address,
                ssrc,
                last_seen_ms: now_ms,
            });
            return SourceDecision::Accepted;
        };

        if latched.address == address && latched.ssrc == ssrc {
            latched.last_seen_ms = now_ms;
            return SourceDecision::Accepted;
        }
        if latched.ssrc == ssrc && now_ms.saturating_sub(latched.last_seen_ms) >= rebind_after_ms {
            latched.address = address;
            latched.last_seen_ms = now_ms;
            return SourceDecision::Rebound;
        }
        SourceDecision::Rejected
    }
}

#[derive(Debug, Clone)]
enum IngressKind {
    Audio,
    TelephoneEvent(TelephoneEventPacket),
}

#[derive(Debug, Clone)]
struct IngressPacket {
    sequence: u16,
    timestamp: u32,
    ssrc: u32,
    marker: bool,
    suppress_output: bool,
    payload: Bytes,
    kind: IngressKind,
}

impl SequenceNumbered for IngressPacket {
    fn sequence_number(&self) -> u16 {
        self.sequence
    }
}

#[derive(Debug, Clone, Copy)]
struct TelephoneEventPacket {
    code: u8,
    end: bool,
    volume: u8,
    duration: u16,
}

impl TelephoneEventPacket {
    fn parse(payload: &[u8]) -> Result<Self, RtpProcessError> {
        if payload.len() < 4 {
            return Err(RtpProcessError::MalformedTelephoneEvent);
        }
        let code = payload[0];
        if dtmf_digit(code).is_none() {
            return Err(RtpProcessError::UnsupportedTelephoneEvent { code });
        }
        Ok(Self {
            code,
            end: payload[1] & 0x80 != 0,
            volume: payload[1] & 0x3f,
            duration: u16::from_be_bytes([payload[2], payload[3]]),
        })
    }
}

#[derive(Debug, Clone, Copy)]
struct DtmfState {
    code: u8,
    timestamp: u32,
    last_duration: u16,
    completed: bool,
}

#[derive(Default)]
struct DtmfTracker {
    current: Option<DtmfState>,
}

impl DtmfTracker {
    fn observe(
        &mut self,
        ingress_leg: ProcessingLeg,
        ssrc: u32,
        timestamp: u32,
        packet: TelephoneEventPacket,
        stats: &mut RtpProcessStats,
    ) -> Result<Option<DtmfEvent>, RtpProcessError> {
        let same_event = self
            .current
            .is_some_and(|state| state.code == packet.code && state.timestamp == timestamp);
        if !same_event {
            let phase = if packet.end {
                DtmfPhase::Completed
            } else {
                DtmfPhase::Started
            };
            self.current = Some(DtmfState {
                code: packet.code,
                timestamp,
                last_duration: packet.duration,
                completed: packet.end,
            });
            match phase {
                DtmfPhase::Started => stats.dtmf_started += 1,
                DtmfPhase::Completed => stats.dtmf_completed += 1,
            }
            return Ok(Some(dtmf_event(
                ingress_leg,
                ssrc,
                timestamp,
                packet,
                phase,
            )));
        }

        let state = self
            .current
            .as_mut()
            .expect("same RFC 4733 event must have tracker state");
        if packet.duration < state.last_duration {
            return Err(RtpProcessError::DtmfDurationRegression);
        }
        state.last_duration = packet.duration;
        if packet.end {
            if state.completed {
                stats.dtmf_repeated_end_packets += 1;
                return Ok(None);
            }
            state.completed = true;
            stats.dtmf_completed += 1;
            return Ok(Some(dtmf_event(
                ingress_leg,
                ssrc,
                timestamp,
                packet,
                DtmfPhase::Completed,
            )));
        }
        Ok(None)
    }
}

fn dtmf_event(
    ingress_leg: ProcessingLeg,
    ssrc: u32,
    rtp_timestamp: u32,
    packet: TelephoneEventPacket,
    phase: DtmfPhase,
) -> DtmfEvent {
    DtmfEvent {
        ingress_leg,
        ssrc,
        rtp_timestamp,
        code: packet.code,
        digit: dtmf_digit(packet.code).expect("validated DTMF code"),
        phase,
        duration: packet.duration,
        volume: packet.volume,
    }
}

fn dtmf_digit(code: u8) -> Option<char> {
    match code {
        0..=9 => Some((b'0' + code) as char),
        10 => Some('*'),
        11 => Some('#'),
        12..=15 => Some((b'A' + code - 12) as char),
        _ => None,
    }
}

struct DirectionProcessor {
    ingress_leg: ProcessingLeg,
    egress_leg: ProcessingLeg,
    media_payload_type: u8,
    source_telephone_event: Option<TelephoneEventConfig>,
    target_telephone_event: Option<TelephoneEventConfig>,
    outbound_ssrc: u32,
    max_drain_per_datagram: usize,
    jitter: BoundedJitterBuffer<IngressPacket>,
    pipeline: ProcessingPipeline,
    dtmf: DtmfTracker,
    suppression_tail: bool,
    output_buffer: Vec<u8>,
}

struct DirectionConfig {
    ingress_leg: ProcessingLeg,
    media_payload_type: u8,
    source_telephone_event: Option<TelephoneEventConfig>,
    target_telephone_event: Option<TelephoneEventConfig>,
    pair: CodecPair,
    target_payload_type: u8,
    outbound_ssrc: u32,
    initial_output_sequence: u16,
    initial_output_timestamp: u32,
}

impl DirectionProcessor {
    fn new(direction: DirectionConfig, config: RtpSessionConfig) -> Result<Self, RtpProcessError> {
        let jitter = BoundedJitterBuffer::new(config.jitter_capacity, config.jitter_wait_depth)
            .map_err(map_jitter_config)?;
        let pipeline = ProcessingPipeline::new(PipelineConfig {
            pair: direction.pair,
            packetization_ms: config.profile.packetization_ms,
            target_payload_type: direction.target_payload_type,
            initial_output_sequence: direction.initial_output_sequence,
            initial_output_timestamp: direction.initial_output_timestamp,
            max_conceal_frames: config.max_conceal_frames,
        })?;
        Ok(Self {
            ingress_leg: direction.ingress_leg,
            egress_leg: direction.ingress_leg.opposite(),
            media_payload_type: direction.media_payload_type,
            source_telephone_event: direction.source_telephone_event,
            target_telephone_event: direction.target_telephone_event,
            outbound_ssrc: direction.outbound_ssrc,
            max_drain_per_datagram: config.max_drain_per_datagram,
            jitter,
            pipeline,
            dtmf: DtmfTracker::default(),
            suppression_tail: false,
            output_buffer: Vec::with_capacity(config.max_datagram_bytes),
        })
    }

    fn classify(&self, packet: &RtpPacket) -> Result<IngressKind, RtpProcessError> {
        if packet.header.payload_type == self.media_payload_type {
            return Ok(IngressKind::Audio);
        }
        if self
            .source_telephone_event
            .is_some_and(|event| event.payload_type == packet.header.payload_type)
        {
            return Ok(IngressKind::TelephoneEvent(TelephoneEventPacket::parse(
                &packet.payload,
            )?));
        }
        Err(RtpProcessError::UnexpectedPayloadType {
            leg: self.ingress_leg,
            expected_media: self.media_payload_type,
            expected_telephone_event: self.source_telephone_event.map(|event| event.payload_type),
            actual: packet.header.payload_type,
        })
    }

    fn drain<S: RtpProcessSink>(
        &mut self,
        destination: Option<SocketAddr>,
        stats: &mut RtpProcessStats,
        sink: &mut S,
    ) -> Result<DrainResult, RtpProcessError> {
        let mut result = DrainResult::default();
        for _ in 0..self.max_drain_per_datagram {
            match self.jitter.pop() {
                JitterPop::Frame(packet) => {
                    if !packet.suppress_output {
                        self.suppression_tail = false;
                    }
                    let (kind, output) = match packet.kind {
                        IngressKind::Audio => {
                            if packet.suppress_output {
                                stats.suppressed_media_packets += 1;
                                result.suppressed_packets += 1;
                                continue;
                            }
                            let processed = self.pipeline.process(&RtpAudioFrame {
                                sequence: packet.sequence,
                                timestamp: packet.timestamp,
                                payload_type: self.media_payload_type,
                                marker: packet.marker,
                                payload: packet.payload,
                            })?;
                            (
                                EmissionKind::Audio {
                                    concealment: processed.concealment,
                                },
                                processed.frame,
                            )
                        }
                        IngressKind::TelephoneEvent(event) => {
                            if let Some(observed) = self.dtmf.observe(
                                self.ingress_leg,
                                packet.ssrc,
                                packet.timestamp,
                                event,
                                stats,
                            )? {
                                sink.on_dtmf(observed);
                                result.dtmf_events += 1;
                            }
                            if packet.suppress_output {
                                stats.suppressed_dtmf_packets += 1;
                                result.suppressed_packets += 1;
                                continue;
                            }
                            let Some(target) = self.target_telephone_event else {
                                continue;
                            };
                            let source = self
                                .source_telephone_event
                                .expect("classified telephone-event must have source config");
                            let (sequence, timestamp) = self
                                .pipeline
                                .map_rtp_timing(packet.sequence, packet.timestamp);
                            let payload = scale_dtmf_duration(
                                packet.payload,
                                source.clock_rate,
                                target.clock_rate,
                            );
                            (
                                EmissionKind::TelephoneEvent,
                                RtpAudioFrame {
                                    sequence,
                                    timestamp,
                                    payload_type: target.payload_type,
                                    marker: packet.marker,
                                    payload,
                                },
                            )
                        }
                    };
                    self.emit(output, kind, destination, stats, sink);
                    result.emitted_packets += usize::from(destination.is_some());
                }
                JitterPop::Gap { .. } => {
                    if self.suppression_tail {
                        stats.suppressed_gap_packets += 1;
                        result.suppressed_packets += 1;
                        continue;
                    }
                    match self.pipeline.conceal() {
                        Ok(processed) => {
                            self.emit(
                                processed.frame,
                                EmissionKind::Audio {
                                    concealment: processed.concealment,
                                },
                                destination,
                                stats,
                                sink,
                            );
                            result.emitted_packets += usize::from(destination.is_some());
                        }
                        Err(PipelineError::NoFrameForConcealment) => {
                            stats.unconcealable_gaps += 1;
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
                JitterPop::Waiting => {
                    result.waiting = true;
                    return Ok(result);
                }
                JitterPop::Empty => return Ok(result),
            }
        }

        if !self.jitter.is_empty() {
            result.budget_exhausted = true;
            stats.packet_budget_exhaustions += 1;
        }
        Ok(result)
    }

    fn emit<S: RtpProcessSink>(
        &mut self,
        frame: RtpAudioFrame,
        kind: EmissionKind,
        destination: Option<SocketAddr>,
        stats: &mut RtpProcessStats,
        sink: &mut S,
    ) {
        match kind {
            EmissionKind::Audio { concealment } => {
                stats.emitted_audio_packets += u64::from(destination.is_some());
                if concealment != Concealment::None {
                    stats.concealed_audio_packets += 1;
                }
            }
            EmissionKind::Playback => {
                stats.emitted_playback_packets += u64::from(destination.is_some());
            }
            EmissionKind::TelephoneEvent => {
                stats.emitted_dtmf_packets += u64::from(destination.is_some());
            }
        }
        let Some(destination) = destination else {
            stats.no_destination_packets += 1;
            return;
        };

        let mut header = RtpHeader::new(
            frame.payload_type,
            frame.sequence,
            frame.timestamp,
            self.outbound_ssrc,
        );
        header.marker = frame.marker;
        RtpPacket {
            header,
            payload: frame.payload,
            padding_len: 0,
        }
        .marshal_into(&mut self.output_buffer);
        sink.emit(RtpEmission {
            egress_leg: self.egress_leg,
            destination,
            datagram: &self.output_buffer,
            kind,
        });
    }
}

#[derive(Default)]
struct DrainResult {
    emitted_packets: usize,
    dtmf_events: usize,
    suppressed_packets: usize,
    waiting: bool,
    budget_exhausted: bool,
}

pub struct RtpSessionProcessor {
    config: RtpSessionConfig,
    leg_a_source: Option<SourceLatch>,
    leg_b_source: Option<SourceLatch>,
    leg_a_destination_hint: Option<SocketAddr>,
    leg_b_destination_hint: Option<SocketAddr>,
    a_to_b: DirectionProcessor,
    b_to_a: DirectionProcessor,
    stats: RtpProcessStats,
}

impl RtpSessionProcessor {
    pub fn new(config: RtpSessionConfig) -> Result<Self, RtpProcessError> {
        validate_config(config)?;
        let (a_to_b_pair, b_to_a_pair) = config
            .profile
            .codec_pairs()
            .map_err(|_| RtpProcessError::InvalidConfiguration { field: "profile" })?;
        let a_to_b = DirectionProcessor::new(
            DirectionConfig {
                ingress_leg: ProcessingLeg::A,
                media_payload_type: config.profile.leg_a_payload_type,
                source_telephone_event: config.leg_a_telephone_event,
                target_telephone_event: config.leg_b_telephone_event,
                pair: a_to_b_pair,
                target_payload_type: config.profile.leg_b_payload_type,
                outbound_ssrc: config.a_to_b_ssrc,
                initial_output_sequence: config.a_to_b_initial_sequence,
                initial_output_timestamp: config.a_to_b_initial_timestamp,
            },
            config,
        )?;
        let b_to_a = DirectionProcessor::new(
            DirectionConfig {
                ingress_leg: ProcessingLeg::B,
                media_payload_type: config.profile.leg_b_payload_type,
                source_telephone_event: config.leg_b_telephone_event,
                target_telephone_event: config.leg_a_telephone_event,
                pair: b_to_a_pair,
                target_payload_type: config.profile.leg_a_payload_type,
                outbound_ssrc: config.b_to_a_ssrc,
                initial_output_sequence: config.b_to_a_initial_sequence,
                initial_output_timestamp: config.b_to_a_initial_timestamp,
            },
            config,
        )?;
        Ok(Self {
            config,
            leg_a_source: None,
            leg_b_source: None,
            leg_a_destination_hint: None,
            leg_b_destination_hint: None,
            a_to_b,
            b_to_a,
            stats: RtpProcessStats::default(),
        })
    }

    pub fn process_bytes<S: RtpProcessSink>(
        &mut self,
        ingress_leg: ProcessingLeg,
        source: SocketAddr,
        datagram: Bytes,
        now_ms: u64,
        sink: &mut S,
    ) -> Result<RtpProcessSummary, RtpProcessError> {
        self.process_bytes_with_policy(
            ingress_leg,
            source,
            datagram,
            now_ms,
            RtpEgressPolicy::Forward,
            sink,
        )
    }

    pub fn process_bytes_with_policy<S: RtpProcessSink>(
        &mut self,
        ingress_leg: ProcessingLeg,
        source: SocketAddr,
        datagram: Bytes,
        now_ms: u64,
        egress_policy: RtpEgressPolicy,
        sink: &mut S,
    ) -> Result<RtpProcessSummary, RtpProcessError> {
        if datagram.len() > self.config.max_datagram_bytes {
            self.stats.oversized_datagrams += 1;
            return Err(RtpProcessError::DatagramTooLarge {
                limit: self.config.max_datagram_bytes,
                actual: datagram.len(),
            });
        }
        if is_rtcp(&datagram) {
            return self.process_rtcp(ingress_leg, source, &datagram);
        }

        let packet = match RtpPacket::parse_bytes(datagram) {
            Ok(packet) => packet,
            Err(_) => {
                self.stats.malformed_rtp_packets += 1;
                return Err(RtpProcessError::MalformedRtp);
            }
        };
        let kind = match ingress_leg {
            ProcessingLeg::A => self.a_to_b.classify(&packet),
            ProcessingLeg::B => self.b_to_a.classify(&packet),
        };
        let kind = match kind {
            Ok(kind) => kind,
            Err(error @ RtpProcessError::UnexpectedPayloadType { .. }) => {
                self.stats.unexpected_payload_type_packets += 1;
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        self.accept_source(ingress_leg, source, packet.header.ssrc, now_ms)?;
        self.stats.rtp_packets_received += 1;

        let disposition = match kind {
            IngressKind::Audio => PacketDisposition::Media,
            IngressKind::TelephoneEvent(_) => PacketDisposition::TelephoneEvent,
        };
        let suppress_output = egress_policy.suppresses(ingress_leg.opposite());
        let ingress = IngressPacket {
            sequence: packet.header.sequence_number,
            timestamp: packet.header.timestamp,
            ssrc: packet.header.ssrc,
            marker: packet.header.marker,
            suppress_output,
            payload: packet.payload,
            kind,
        };
        let destination = self.destination(ingress_leg.opposite());
        let direction = match ingress_leg {
            ProcessingLeg::A => &mut self.a_to_b,
            ProcessingLeg::B => &mut self.b_to_a,
        };
        match direction.jitter.push(ingress) {
            JitterPush::Duplicate => {
                self.stats.duplicate_packets += 1;
                return Ok(empty_summary(PacketDisposition::Duplicate));
            }
            JitterPush::Late => {
                self.stats.late_packets += 1;
                return Ok(empty_summary(PacketDisposition::Late));
            }
            JitterPush::TooFarAhead { .. } => {
                self.stats.too_far_ahead_packets += 1;
                return Ok(empty_summary(PacketDisposition::TooFarAhead));
            }
            JitterPush::WindowCollision => {
                self.stats.window_collision_packets += 1;
                return Ok(empty_summary(PacketDisposition::WindowCollision));
            }
            JitterPush::Accepted => {
                if suppress_output {
                    direction.suppression_tail = true;
                }
            }
        }
        let drained = direction.drain(destination, &mut self.stats, sink)?;
        let disposition = if drained.budget_exhausted {
            PacketDisposition::BudgetExhausted
        } else if drained.suppressed_packets > 0 && drained.emitted_packets == 0 {
            PacketDisposition::Suppressed
        } else if drained.waiting && drained.emitted_packets == 0 {
            PacketDisposition::Waiting
        } else {
            disposition
        };
        Ok(RtpProcessSummary {
            disposition,
            emitted_packets: drained.emitted_packets,
            dtmf_events: drained.dtmf_events,
            rtcp_packets: 0,
        })
    }

    pub fn emit_pcm_48k<S: RtpProcessSink>(
        &mut self,
        egress_leg: ProcessingLeg,
        samples: &[i16],
        marker: bool,
        sink: &mut S,
    ) -> Result<bool, RtpProcessError> {
        let Some(destination) = self.destination(egress_leg) else {
            self.stats.no_destination_packets += 1;
            return Ok(false);
        };
        let direction = match egress_leg {
            ProcessingLeg::A => &mut self.b_to_a,
            ProcessingLeg::B => &mut self.a_to_b,
        };
        let processed = direction.pipeline.generate_pcm_48k(samples, marker)?;
        direction.emit(
            processed.frame,
            EmissionKind::Playback,
            Some(destination),
            &mut self.stats,
            sink,
        );
        Ok(true)
    }

    pub fn source(&self, leg: ProcessingLeg) -> Option<SocketAddr> {
        match leg {
            ProcessingLeg::A => self.leg_a_source.map(|source| source.address),
            ProcessingLeg::B => self.leg_b_source.map(|source| source.address),
        }
    }

    pub fn set_destination_hint(&mut self, leg: ProcessingLeg, destination: Option<SocketAddr>) {
        match leg {
            ProcessingLeg::A => self.leg_a_destination_hint = destination,
            ProcessingLeg::B => self.leg_b_destination_hint = destination,
        }
    }

    pub fn buffered_packets(&self, ingress_leg: ProcessingLeg) -> usize {
        match ingress_leg {
            ProcessingLeg::A => self.a_to_b.jitter.len(),
            ProcessingLeg::B => self.b_to_a.jitter.len(),
        }
    }

    pub fn stats(&self) -> RtpProcessStats {
        self.stats
    }

    fn destination(&self, leg: ProcessingLeg) -> Option<SocketAddr> {
        self.source(leg).or(match leg {
            ProcessingLeg::A => self.leg_a_destination_hint,
            ProcessingLeg::B => self.leg_b_destination_hint,
        })
    }

    fn accept_source(
        &mut self,
        leg: ProcessingLeg,
        address: SocketAddr,
        ssrc: u32,
        now_ms: u64,
    ) -> Result<(), RtpProcessError> {
        let latch = match leg {
            ProcessingLeg::A => &mut self.leg_a_source,
            ProcessingLeg::B => &mut self.leg_b_source,
        };
        match SourceLatch::accept(
            latch,
            address,
            ssrc,
            now_ms,
            self.config.source_rebind_after_ms,
        ) {
            SourceDecision::Accepted => Ok(()),
            SourceDecision::Rebound => {
                self.stats.source_rebinds += 1;
                Ok(())
            }
            SourceDecision::Rejected => {
                self.stats.source_rejected_packets += 1;
                Err(RtpProcessError::SourceRejected { leg })
            }
        }
    }

    fn process_rtcp(
        &mut self,
        ingress_leg: ProcessingLeg,
        source: SocketAddr,
        datagram: &[u8],
    ) -> Result<RtpProcessSummary, RtpProcessError> {
        if self
            .source(ingress_leg)
            .is_some_and(|expected| expected != source)
        {
            self.stats.source_rejected_packets += 1;
            return Err(RtpProcessError::SourceRejected { leg: ingress_leg });
        }
        let packets = match parse_rtcp_packets(datagram, Some(source)) {
            Ok(packets) => packets,
            Err(_) => {
                self.stats.malformed_rtcp_packets += 1;
                return Err(RtpProcessError::MalformedRtcp);
            }
        };
        self.stats.rtcp_datagrams_received += 1;
        self.stats.rtcp_packets_received += packets.len() as u64;
        Ok(RtpProcessSummary {
            disposition: PacketDisposition::Rtcp,
            emitted_packets: 0,
            dtmf_events: 0,
            rtcp_packets: packets.len(),
        })
    }
}

fn empty_summary(disposition: PacketDisposition) -> RtpProcessSummary {
    RtpProcessSummary {
        disposition,
        emitted_packets: 0,
        dtmf_events: 0,
        rtcp_packets: 0,
    }
}

fn is_rtcp(datagram: &[u8]) -> bool {
    datagram
        .get(1)
        .is_some_and(|packet_type| (192..=223).contains(packet_type))
}

fn scale_dtmf_duration(payload: Bytes, source_rate: u32, target_rate: u32) -> Bytes {
    if source_rate == target_rate || payload.len() < 4 {
        return payload;
    }
    let duration = u16::from_be_bytes([payload[2], payload[3]]);
    let scaled = (u64::from(duration) * u64::from(target_rate) / u64::from(source_rate))
        .min(u64::from(u16::MAX)) as u16;
    let mut output = payload.to_vec();
    output[2..4].copy_from_slice(&scaled.to_be_bytes());
    output.into()
}

fn validate_config(config: RtpSessionConfig) -> Result<(), RtpProcessError> {
    if config.profile.codec_pairs().is_err() {
        return Err(RtpProcessError::InvalidConfiguration { field: "profile" });
    }
    if config.max_drain_per_datagram == 0 || config.max_drain_per_datagram > config.jitter_capacity
    {
        return Err(RtpProcessError::InvalidConfiguration {
            field: "max_drain_per_datagram",
        });
    }
    if config.max_datagram_bytes < 12 || config.max_datagram_bytes > u16::MAX as usize {
        return Err(RtpProcessError::InvalidConfiguration {
            field: "max_datagram_bytes",
        });
    }
    if config.source_rebind_after_ms == 0 {
        return Err(RtpProcessError::InvalidConfiguration {
            field: "source_rebind_after_ms",
        });
    }
    validate_telephone_event(
        config.leg_a_telephone_event,
        config.profile.leg_a_payload_type,
        config.profile.leg_a_codec.clock_rate(),
        "leg_a_telephone_event",
    )?;
    validate_telephone_event(
        config.leg_b_telephone_event,
        config.profile.leg_b_payload_type,
        config.profile.leg_b_codec.clock_rate(),
        "leg_b_telephone_event",
    )?;
    BoundedJitterBuffer::<IngressPacket>::new(config.jitter_capacity, config.jitter_wait_depth)
        .map_err(map_jitter_config)?;
    Ok(())
}

fn validate_telephone_event(
    event: Option<TelephoneEventConfig>,
    media_payload_type: u8,
    media_clock_rate: u32,
    field: &'static str,
) -> Result<(), RtpProcessError> {
    if event.is_some_and(|event| {
        event.payload_type > 127
            || event.payload_type == media_payload_type
            || event.clock_rate != media_clock_rate
    }) {
        return Err(RtpProcessError::InvalidConfiguration { field });
    }
    Ok(())
}

fn map_jitter_config(error: JitterConfigError) -> RtpProcessError {
    let field = match error {
        JitterConfigError::CapacityTooSmall => "jitter_capacity",
        JitterConfigError::InvalidWaitDepth => "jitter_wait_depth",
    };
    RtpProcessError::InvalidConfiguration { field }
}
