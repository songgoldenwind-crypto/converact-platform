#![forbid(unsafe_code)]

#[cfg(not(feature = "g729"))]
compile_error!("the exact-source rvoip-g729 crate requires its internal g729 feature");

#[path = "../impls/mod.rs"]
pub(crate) mod upstream_impls;

pub(crate) mod codecs {
    pub(crate) mod g729 {
        pub(crate) use crate::upstream_impls as impls;
    }
}

mod adapter;

pub use adapter::{
    EncodedFrame, G729Decoder, G729Encoder, G729Error, G729FrameKind, G729Mode, G729Packetization,
    G729Payload, G729PayloadBuilder, DYNAMIC_PAYLOAD_TYPE_MAX, DYNAMIC_PAYLOAD_TYPE_MIN,
    FRAME_SAMPLES, MAX_PACKET_BYTES, MAX_SPEECH_FRAMES_PER_PACKET, SID_FRAME_BYTES,
    SPEECH_FRAME_BYTES, STATIC_PAYLOAD_TYPE, SUPPORTED_PACKETIZATION_MS, WIRE_CLOCK_RATE_HZ,
    WIRE_CODEC_ID, WIRE_ENCODING_NAME,
};
