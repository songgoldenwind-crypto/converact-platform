use audio_codec::CodecType;
use std::error::Error;
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum AudioCodec {
    Pcmu,
    Pcma,
    Opus,
}

impl AudioCodec {
    pub const ALL: [Self; 3] = [Self::Pcmu, Self::Pcma, Self::Opus];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Pcmu => "PCMU",
            Self::Pcma => "PCMA",
            Self::Opus => "OPUS",
        }
    }

    pub const fn sample_rate(self) -> u32 {
        match self {
            Self::Pcmu | Self::Pcma => 8_000,
            Self::Opus => 48_000,
        }
    }

    pub const fn clock_rate(self) -> u32 {
        self.sample_rate()
    }

    pub const fn payload_type(self) -> u8 {
        match self {
            Self::Pcmu => 0,
            Self::Pcma => 8,
            Self::Opus => 111,
        }
    }

    pub const fn accepts_payload_type(self, payload_type: u8) -> bool {
        match self {
            Self::Pcmu => payload_type == 0,
            Self::Pcma => payload_type == 8,
            Self::Opus => payload_type >= 96 && payload_type <= 127,
        }
    }

    pub const fn samples_per_packet(self, packetization_ms: u16) -> usize {
        self.sample_rate() as usize * packetization_ms as usize / 1_000
    }

    pub(crate) const fn codec_type(self) -> CodecType {
        match self {
            Self::Pcmu => CodecType::PCMU,
            Self::Pcma => CodecType::PCMA,
            Self::Opus => CodecType::Opus,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioCodecParseError {
    value: String,
}

impl Display for AudioCodecParseError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "unsupported Goal 4 audio codec: {}", self.value)
    }
}

impl Error for AudioCodecParseError {}

impl TryFrom<&str> for AudioCodec {
    type Error = AudioCodecParseError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value.to_ascii_uppercase().as_str() {
            "PCMU" => Ok(Self::Pcmu),
            "PCMA" => Ok(Self::Pcma),
            "OPUS" => Ok(Self::Opus),
            _ => Err(AudioCodecParseError {
                value: value.to_owned(),
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CodecPair {
    source: AudioCodec,
    target: AudioCodec,
}

impl CodecPair {
    pub const ALL: [Self; 6] = [
        Self::from_supported(AudioCodec::Pcmu, AudioCodec::Pcma),
        Self::from_supported(AudioCodec::Pcma, AudioCodec::Pcmu),
        Self::from_supported(AudioCodec::Pcmu, AudioCodec::Opus),
        Self::from_supported(AudioCodec::Opus, AudioCodec::Pcmu),
        Self::from_supported(AudioCodec::Pcma, AudioCodec::Opus),
        Self::from_supported(AudioCodec::Opus, AudioCodec::Pcma),
    ];

    const fn from_supported(source: AudioCodec, target: AudioCodec) -> Self {
        Self { source, target }
    }

    pub fn new(source: AudioCodec, target: AudioCodec) -> Result<Self, UnsupportedCodecPair> {
        let candidate = Self { source, target };
        if Self::ALL.contains(&candidate) {
            Ok(candidate)
        } else {
            Err(UnsupportedCodecPair { source, target })
        }
    }

    pub const fn source(self) -> AudioCodec {
        self.source
    }

    pub const fn target(self) -> AudioCodec {
        self.target
    }

    pub const fn label(self) -> &'static str {
        match (self.source, self.target) {
            (AudioCodec::Pcmu, AudioCodec::Pcma) => "PCMU_TO_PCMA",
            (AudioCodec::Pcma, AudioCodec::Pcmu) => "PCMA_TO_PCMU",
            (AudioCodec::Pcmu, AudioCodec::Opus) => "PCMU_TO_OPUS",
            (AudioCodec::Opus, AudioCodec::Pcmu) => "OPUS_TO_PCMU",
            (AudioCodec::Pcma, AudioCodec::Opus) => "PCMA_TO_OPUS",
            (AudioCodec::Opus, AudioCodec::Pcma) => "OPUS_TO_PCMA",
            _ => "UNSUPPORTED",
        }
    }

    #[inline]
    pub(crate) fn index(self) -> usize {
        match (self.source, self.target) {
            (AudioCodec::Pcmu, AudioCodec::Pcma) => 0,
            (AudioCodec::Pcma, AudioCodec::Pcmu) => 1,
            (AudioCodec::Pcmu, AudioCodec::Opus) => 2,
            (AudioCodec::Opus, AudioCodec::Pcmu) => 3,
            (AudioCodec::Pcma, AudioCodec::Opus) => 4,
            (AudioCodec::Opus, AudioCodec::Pcma) => 5,
            _ => unreachable!("CodecPair can only contain a supported pair"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnsupportedCodecPair {
    pub source: AudioCodec,
    pub target: AudioCodec,
}

impl Display for UnsupportedCodecPair {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "unsupported Goal 4 codec pair: {}_TO_{}",
            self.source.label(),
            self.target.label()
        )
    }
}

impl Error for UnsupportedCodecPair {}
