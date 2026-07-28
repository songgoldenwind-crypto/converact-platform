use crate::codec::CodecPair;
use crate::frame::RtpAudioFrame;
use audio_codec::{create_decoder, create_encoder, Decoder, Encoder, Resampler};
use std::error::Error;
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PipelineConfig {
    pub pair: CodecPair,
    pub packetization_ms: u16,
    pub target_payload_type: u8,
    pub initial_output_sequence: u16,
    pub initial_output_timestamp: u32,
    pub max_conceal_frames: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Concealment {
    None,
    DecayedPrevious { run: u16 },
    Silence { run: u16 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessedAudioFrame {
    pub frame: RtpAudioFrame,
    pub concealment: Concealment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipelineError {
    UnsupportedPacketization { milliseconds: u16 },
    InvalidPayloadType { payload_type: u8 },
    DecodeFailed,
    EncodeFailed,
    NoFrameForConcealment,
}

impl Display for PipelineError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedPacketization { milliseconds } => {
                write!(
                    formatter,
                    "Goal 4 G.711/Opus slice only supports 20 ms, got {milliseconds} ms"
                )
            }
            Self::InvalidPayloadType { payload_type } => {
                write!(formatter, "invalid RTP payload type {payload_type}")
            }
            Self::DecodeFailed => formatter.write_str("audio decoder returned no PCM"),
            Self::EncodeFailed => formatter.write_str("audio encoder returned no payload"),
            Self::NoFrameForConcealment => {
                formatter.write_str("cannot conceal before the first real audio frame")
            }
        }
    }
}

impl Error for PipelineError {}

#[derive(Debug, Clone, Copy)]
struct SourceDomain {
    sequence: u16,
    timestamp: u32,
}

struct RtpTiming {
    source: Option<SourceDomain>,
    output_sequence: u16,
    output_timestamp: u32,
    last_output: Option<(u16, u32)>,
    source_clock_rate: u32,
    target_clock_rate: u32,
    target_packet_ticks: u32,
}

impl RtpTiming {
    fn new(config: PipelineConfig) -> Self {
        Self {
            source: None,
            output_sequence: config.initial_output_sequence,
            output_timestamp: config.initial_output_timestamp,
            last_output: None,
            source_clock_rate: config.pair.source().clock_rate(),
            target_clock_rate: config.pair.target().clock_rate(),
            target_packet_ticks: config
                .pair
                .target()
                .samples_per_packet(config.packetization_ms)
                as u32,
        }
    }

    fn map(&mut self, sequence: u16, timestamp: u32) -> (u16, u32) {
        let source = *self.source.get_or_insert(SourceDomain {
            sequence,
            timestamp,
        });
        let sequence_delta = sequence.wrapping_sub(source.sequence);
        let timestamp_delta = timestamp.wrapping_sub(source.timestamp);
        let scaled_timestamp_delta = (u64::from(timestamp_delta)
            * u64::from(self.target_clock_rate)
            / u64::from(self.source_clock_rate)) as u32;
        let output = (
            self.output_sequence.wrapping_add(sequence_delta),
            self.output_timestamp.wrapping_add(scaled_timestamp_delta),
        );
        self.last_output = Some(output);
        output
    }

    fn next_gap(&mut self) -> Result<(u16, u32), PipelineError> {
        let (last_sequence, last_timestamp) = self
            .last_output
            .ok_or(PipelineError::NoFrameForConcealment)?;
        let output = (
            last_sequence.wrapping_add(1),
            last_timestamp.wrapping_add(self.target_packet_ticks),
        );
        self.last_output = Some(output);
        Ok(output)
    }
}

pub struct ProcessingPipeline {
    config: PipelineConfig,
    decoder: Box<dyn Decoder>,
    encoder: Box<dyn Encoder>,
    resampler: Option<Resampler>,
    timing: RtpTiming,
    last_real_pcm: Vec<i16>,
    conceal_run: u16,
}

impl ProcessingPipeline {
    pub fn new(config: PipelineConfig) -> Result<Self, PipelineError> {
        if config.packetization_ms != 20 {
            return Err(PipelineError::UnsupportedPacketization {
                milliseconds: config.packetization_ms,
            });
        }
        if config.target_payload_type > 127 {
            return Err(PipelineError::InvalidPayloadType {
                payload_type: config.target_payload_type,
            });
        }

        let decoder = create_decoder(config.pair.source().codec_type());
        let encoder = create_encoder(config.pair.target().codec_type());
        let resampler = (decoder.sample_rate() != encoder.sample_rate()).then(|| {
            Resampler::new(
                decoder.sample_rate() as usize,
                encoder.sample_rate() as usize,
            )
        });
        let timing = RtpTiming::new(config);

        Ok(Self {
            config,
            decoder,
            encoder,
            resampler,
            timing,
            last_real_pcm: Vec::new(),
            conceal_run: 0,
        })
    }

    pub fn process(&mut self, input: &RtpAudioFrame) -> Result<ProcessedAudioFrame, PipelineError> {
        let mut pcm = self.decoder.decode(&input.payload);
        if pcm.is_empty() {
            return Err(PipelineError::DecodeFailed);
        }
        if let Some(resampler) = &mut self.resampler {
            pcm = resampler.resample(&pcm);
        }
        normalize_pcm(
            &mut pcm,
            self.config
                .pair
                .target()
                .samples_per_packet(self.config.packetization_ms),
        );

        let payload = self.encoder.encode(&pcm);
        if payload.is_empty() {
            return Err(PipelineError::EncodeFailed);
        }
        let (sequence, timestamp) = self.timing.map(input.sequence, input.timestamp);
        self.last_real_pcm = pcm;
        self.conceal_run = 0;

        Ok(ProcessedAudioFrame {
            frame: RtpAudioFrame {
                sequence,
                timestamp,
                payload_type: self.config.target_payload_type,
                marker: input.marker,
                payload,
            },
            concealment: Concealment::None,
        })
    }

    pub fn conceal(&mut self) -> Result<ProcessedAudioFrame, PipelineError> {
        if self.last_real_pcm.is_empty() {
            return Err(PipelineError::NoFrameForConcealment);
        }

        self.conceal_run = self.conceal_run.saturating_add(1);
        let (pcm, concealment) = if self.conceal_run <= self.config.max_conceal_frames {
            let decay = 0.8_f32.powi(i32::from(self.conceal_run));
            (
                self.last_real_pcm
                    .iter()
                    .map(|sample| (f32::from(*sample) * decay) as i16)
                    .collect(),
                Concealment::DecayedPrevious {
                    run: self.conceal_run,
                },
            )
        } else {
            (
                vec![0; self.last_real_pcm.len()],
                Concealment::Silence {
                    run: self.conceal_run,
                },
            )
        };

        let payload = self.encoder.encode(&pcm);
        if payload.is_empty() {
            return Err(PipelineError::EncodeFailed);
        }
        let (sequence, timestamp) = self.timing.next_gap()?;

        Ok(ProcessedAudioFrame {
            frame: RtpAudioFrame {
                sequence,
                timestamp,
                payload_type: self.config.target_payload_type,
                marker: false,
                payload,
            },
            concealment,
        })
    }
}

fn normalize_pcm(pcm: &mut Vec<i16>, expected_samples: usize) {
    match pcm.len().cmp(&expected_samples) {
        std::cmp::Ordering::Less => {
            let pad = pcm.last().copied().unwrap_or_default();
            pcm.resize(expected_samples, pad);
        }
        std::cmp::Ordering::Greater => pcm.truncate(expected_samples),
        std::cmp::Ordering::Equal => {}
    }
}
