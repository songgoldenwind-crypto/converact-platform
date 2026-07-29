pub type Sample = i16;
pub type PcmBuf = Vec<Sample>;

pub mod opus;
pub mod pcma;
pub mod pcmu;
pub mod resampler;
pub use resampler::{Resampler, resample};

#[derive(Debug, Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
pub enum CodecType {
    PCMU,
    PCMA,
    Opus,
}

pub trait Decoder: Send + Sync {
    fn decode(&mut self, data: &[u8]) -> PcmBuf;
    fn sample_rate(&self) -> u32;
    fn channels(&self) -> u16;
}

pub trait Encoder: Send + Sync {
    fn encode(&mut self, samples: &[Sample]) -> Vec<u8>;
    fn sample_rate(&self) -> u32;
    fn channels(&self) -> u16;
}

pub fn create_decoder(codec: CodecType) -> Box<dyn Decoder> {
    match codec {
        CodecType::PCMU => Box::new(pcmu::PcmuDecoder::new()),
        CodecType::PCMA => Box::new(pcma::PcmaDecoder::new()),
        CodecType::Opus => Box::new(opus::OpusDecoder::new_default()),
    }
}

pub fn create_encoder(codec: CodecType) -> Box<dyn Encoder> {
    match codec {
        CodecType::PCMU => Box::new(pcmu::PcmuEncoder::new()),
        CodecType::PCMA => Box::new(pcma::PcmaEncoder::new()),
        CodecType::Opus => Box::new(opus::OpusEncoder::new_default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_codec_surface_is_g711_and_opus_only() {
        let codecs = [CodecType::PCMU, CodecType::PCMA, CodecType::Opus];
        for codec in codecs {
            assert_eq!(
                create_encoder(codec).channels(),
                match codec {
                    CodecType::Opus => 2,
                    CodecType::PCMU | CodecType::PCMA => 1,
                }
            );
            assert_eq!(
                create_decoder(codec).channels(),
                match codec {
                    CodecType::Opus => 2,
                    CodecType::PCMU | CodecType::PCMA => 1,
                }
            );
        }
    }
}
