use core::fmt::{Display, Formatter};

use crate::upstream_impls::{
    DecoderConfig as UpstreamDecoderConfig, EncoderConfig as UpstreamEncoderConfig,
    FrameType as UpstreamFrameType, G729Decoder as UpstreamDecoder, G729Encoder as UpstreamEncoder,
};

pub const WIRE_CODEC_ID: &str = "G729/8000";
pub const WIRE_ENCODING_NAME: &str = "G729";
pub const WIRE_CLOCK_RATE_HZ: u32 = 8_000;
pub const STATIC_PAYLOAD_TYPE: u8 = 18;
pub const DYNAMIC_PAYLOAD_TYPE_MIN: u8 = 96;
pub const DYNAMIC_PAYLOAD_TYPE_MAX: u8 = 127;
pub const FRAME_SAMPLES: usize = 80;
pub const SPEECH_FRAME_BYTES: usize = 10;
pub const SID_FRAME_BYTES: usize = 2;
pub const MAX_SPEECH_FRAMES_PER_PACKET: usize = 6;
pub const MAX_PACKET_BYTES: usize =
    MAX_SPEECH_FRAMES_PER_PACKET * SPEECH_FRAME_BYTES + SID_FRAME_BYTES;
pub const SUPPORTED_PACKETIZATION_MS: [u16; 6] = [10, 20, 30, 40, 50, 60];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum G729Mode {
    G729A,
    G729AB,
}

impl G729Mode {
    pub const ALL: [Self; 2] = [Self::G729A, Self::G729AB];

    pub const fn wire_codec_id(self) -> &'static str {
        WIRE_CODEC_ID
    }

    pub const fn annex_b_enabled(self) -> bool {
        matches!(self, Self::G729AB)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u16)]
pub enum G729Packetization {
    Ms10 = 10,
    Ms20 = 20,
    Ms30 = 30,
    Ms40 = 40,
    Ms50 = 50,
    Ms60 = 60,
}

impl G729Packetization {
    pub const ALL: [Self; 6] = [
        Self::Ms10,
        Self::Ms20,
        Self::Ms30,
        Self::Ms40,
        Self::Ms50,
        Self::Ms60,
    ];

    pub const fn milliseconds(self) -> u16 {
        self as u16
    }

    pub const fn speech_frames(self) -> usize {
        self.milliseconds() as usize / 10
    }

    pub const fn try_from_milliseconds(milliseconds: u16) -> Result<Self, G729Error> {
        match milliseconds {
            10 => Ok(Self::Ms10),
            20 => Ok(Self::Ms20),
            30 => Ok(Self::Ms30),
            40 => Ok(Self::Ms40),
            50 => Ok(Self::Ms50),
            60 => Ok(Self::Ms60),
            _ => Err(G729Error::UnsupportedPacketization { milliseconds }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum G729FrameKind {
    Speech,
    Sid,
    NoData,
}

impl G729FrameKind {
    pub const fn byte_len(self) -> usize {
        match self {
            Self::Speech => SPEECH_FRAME_BYTES,
            Self::Sid => SID_FRAME_BYTES,
            Self::NoData => 0,
        }
    }
}

impl From<UpstreamFrameType> for G729FrameKind {
    fn from(value: UpstreamFrameType) -> Self {
        match value {
            UpstreamFrameType::Speech => Self::Speech,
            UpstreamFrameType::Sid => Self::Sid,
            UpstreamFrameType::NoData => Self::NoData,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncodedFrame {
    kind: G729FrameKind,
}

impl EncodedFrame {
    pub const fn kind(self) -> G729FrameKind {
        self.kind
    }

    pub const fn byte_len(self) -> usize {
        self.kind.byte_len()
    }

    pub fn bytes(self, output: &[u8; SPEECH_FRAME_BYTES]) -> &[u8] {
        &output[..self.byte_len()]
    }
}

pub struct G729Encoder {
    mode: G729Mode,
    inner: UpstreamEncoder,
}

impl G729Encoder {
    pub fn new(mode: G729Mode) -> Self {
        Self {
            mode,
            inner: UpstreamEncoder::new(UpstreamEncoderConfig {
                annex_b: mode.annex_b_enabled(),
            }),
        }
    }

    pub const fn mode(&self) -> G729Mode {
        self.mode
    }

    pub fn encode_frame(
        &mut self,
        pcm: &[i16; FRAME_SAMPLES],
        output: &mut [u8; SPEECH_FRAME_BYTES],
    ) -> EncodedFrame {
        let kind = G729FrameKind::from(self.inner.encode(pcm, output));
        output[kind.byte_len()..].fill(0);
        EncodedFrame { kind }
    }

    pub fn reset(&mut self) {
        self.inner.reset();
    }
}

pub struct G729Decoder {
    mode: G729Mode,
    inner: UpstreamDecoder,
}

impl G729Decoder {
    pub fn new(mode: G729Mode) -> Self {
        Self {
            mode,
            inner: UpstreamDecoder::new(UpstreamDecoderConfig {
                annex_b: mode.annex_b_enabled(),
                post_filter: true,
                max_consecutive_erasures: Some(10),
            }),
        }
    }

    pub const fn mode(&self) -> G729Mode {
        self.mode
    }

    pub fn decode_frame(
        &mut self,
        input: &[u8],
        output: &mut [i16; FRAME_SAMPLES],
    ) -> Result<G729FrameKind, G729Error> {
        let (upstream_kind, kind) = match input.len() {
            SPEECH_FRAME_BYTES => (UpstreamFrameType::Speech, G729FrameKind::Speech),
            SID_FRAME_BYTES if self.mode == G729Mode::G729AB => {
                (UpstreamFrameType::Sid, G729FrameKind::Sid)
            }
            SID_FRAME_BYTES => {
                output.fill(0);
                return Err(G729Error::SidForbiddenInG729A);
            }
            0 => {
                output.fill(0);
                return Err(G729Error::NoDataHasNoPacket);
            }
            bytes => {
                output.fill(0);
                return Err(G729Error::InvalidFrameLength { bytes });
            }
        };
        self.inner.decode_with_type(input, upstream_kind, output);
        Ok(kind)
    }

    pub fn decode_erasure(&mut self, output: &mut [i16; FRAME_SAMPLES]) {
        self.inner.decode_erasure(output);
    }

    pub fn reset(&mut self) {
        self.inner.reset();
    }
}

#[derive(Debug, Clone, Copy)]
pub struct G729Payload<'a> {
    mode: G729Mode,
    bytes: &'a [u8],
    speech_frames: usize,
    has_sid: bool,
}

impl<'a> G729Payload<'a> {
    pub fn parse(mode: G729Mode, bytes: &'a [u8]) -> Result<Self, G729Error> {
        if bytes.is_empty() {
            return Err(G729Error::NoDataHasNoPacket);
        }
        if bytes.len() > MAX_PACKET_BYTES {
            return Err(G729Error::InvalidPayloadLength { bytes: bytes.len() });
        }
        let (speech_frames, has_sid) = match bytes.len() % SPEECH_FRAME_BYTES {
            0 => (bytes.len() / SPEECH_FRAME_BYTES, false),
            SID_FRAME_BYTES => ((bytes.len() - SID_FRAME_BYTES) / SPEECH_FRAME_BYTES, true),
            _ => return Err(G729Error::InvalidPayloadLength { bytes: bytes.len() }),
        };
        if speech_frames > MAX_SPEECH_FRAMES_PER_PACKET {
            return Err(G729Error::InvalidPayloadLength { bytes: bytes.len() });
        }
        if has_sid && mode == G729Mode::G729A {
            return Err(G729Error::SidForbiddenInG729A);
        }
        Ok(Self {
            mode,
            bytes,
            speech_frames,
            has_sid,
        })
    }

    pub const fn mode(&self) -> G729Mode {
        self.mode
    }

    pub const fn speech_frame_count(&self) -> usize {
        self.speech_frames
    }

    pub const fn has_sid(&self) -> bool {
        self.has_sid
    }

    pub const fn as_bytes(&self) -> &'a [u8] {
        self.bytes
    }

    pub fn speech_frame(&self, index: usize) -> Option<&'a [u8; SPEECH_FRAME_BYTES]> {
        if index >= self.speech_frames {
            return None;
        }
        let start = index * SPEECH_FRAME_BYTES;
        self.bytes[start..start + SPEECH_FRAME_BYTES]
            .try_into()
            .ok()
    }

    pub fn sid(&self) -> Option<&'a [u8; SID_FRAME_BYTES]> {
        if !self.has_sid {
            return None;
        }
        self.bytes[self.speech_frames * SPEECH_FRAME_BYTES..]
            .try_into()
            .ok()
    }
}

pub struct G729PayloadBuilder<'a> {
    mode: G729Mode,
    output: &'a mut [u8; MAX_PACKET_BYTES],
    length: usize,
    speech_frames: usize,
    has_sid: bool,
}

impl<'a> G729PayloadBuilder<'a> {
    pub fn new(mode: G729Mode, output: &'a mut [u8; MAX_PACKET_BYTES]) -> Self {
        output.fill(0);
        Self {
            mode,
            output,
            length: 0,
            speech_frames: 0,
            has_sid: false,
        }
    }

    pub fn push_speech(&mut self, frame: &[u8; SPEECH_FRAME_BYTES]) -> Result<(), G729Error> {
        if self.has_sid {
            return Err(G729Error::SidMustBeLast);
        }
        if self.speech_frames == MAX_SPEECH_FRAMES_PER_PACKET {
            return Err(G729Error::TooManySpeechFrames);
        }
        let end = self.length + SPEECH_FRAME_BYTES;
        self.output[self.length..end].copy_from_slice(frame);
        self.length = end;
        self.speech_frames += 1;
        Ok(())
    }

    pub fn push_sid(&mut self, frame: &[u8; SID_FRAME_BYTES]) -> Result<(), G729Error> {
        if self.mode == G729Mode::G729A {
            return Err(G729Error::SidForbiddenInG729A);
        }
        if self.has_sid {
            return Err(G729Error::MultipleSidFrames);
        }
        let end = self.length + SID_FRAME_BYTES;
        self.output[self.length..end].copy_from_slice(frame);
        self.length = end;
        self.has_sid = true;
        Ok(())
    }

    pub fn finish(self) -> Result<G729Payload<'a>, G729Error> {
        if self.length == 0 {
            return Err(G729Error::NoDataHasNoPacket);
        }
        Ok(G729Payload {
            mode: self.mode,
            bytes: &self.output[..self.length],
            speech_frames: self.speech_frames,
            has_sid: self.has_sid,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum G729Error {
    UnsupportedPacketization { milliseconds: u16 },
    InvalidPayloadLength { bytes: usize },
    InvalidFrameLength { bytes: usize },
    NoDataHasNoPacket,
    SidForbiddenInG729A,
    SidMustBeLast,
    MultipleSidFrames,
    TooManySpeechFrames,
}

impl Display for G729Error {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::UnsupportedPacketization { milliseconds } => {
                write!(
                    formatter,
                    "unsupported G.729 packetization: {milliseconds} ms"
                )
            }
            Self::InvalidPayloadLength { bytes } => {
                write!(formatter, "invalid G.729 RTP payload length: {bytes} bytes")
            }
            Self::InvalidFrameLength { bytes } => {
                write!(formatter, "invalid G.729 frame length: {bytes} bytes")
            }
            Self::NoDataHasNoPacket => {
                formatter.write_str("G.729 no-data is represented by no RTP packet")
            }
            Self::SidForbiddenInG729A => formatter.write_str("SID is forbidden in G729A mode"),
            Self::SidMustBeLast => formatter.write_str("SID must be the final G.729 payload frame"),
            Self::MultipleSidFrames => {
                formatter.write_str("only one SID frame is allowed in a G.729 payload")
            }
            Self::TooManySpeechFrames => {
                formatter.write_str("G.729 payload exceeds six speech frames")
            }
        }
    }
}

impl std::error::Error for G729Error {}
