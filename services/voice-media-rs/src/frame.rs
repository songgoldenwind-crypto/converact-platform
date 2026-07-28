#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RtpAudioFrame {
    pub sequence: u16,
    pub timestamp: u32,
    pub payload_type: u8,
    pub marker: bool,
    pub payload: Vec<u8>,
}
