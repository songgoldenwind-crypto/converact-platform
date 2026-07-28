use crate::frame::RtpAudioFrame;
use std::error::Error;
use std::fmt::{Display, Formatter};

const HALF_SEQUENCE_SPACE: u16 = 1 << 15;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JitterPush {
    Accepted,
    Duplicate,
    Late,
    TooFarAhead { distance: u16 },
    WindowCollision,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JitterPop {
    Frame(RtpAudioFrame),
    Gap { sequence: u16 },
    Waiting,
    Empty,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct JitterStats {
    pub accepted: u64,
    pub duplicate: u64,
    pub late: u64,
    pub too_far_ahead: u64,
    pub window_collision: u64,
    pub gaps: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JitterConfigError {
    CapacityTooSmall,
    InvalidWaitDepth,
}

impl Display for JitterConfigError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CapacityTooSmall => {
                formatter.write_str("jitter capacity must be at least two packets")
            }
            Self::InvalidWaitDepth => {
                formatter.write_str("jitter wait depth must be within the packet window")
            }
        }
    }
}

impl Error for JitterConfigError {}

pub struct BoundedJitterBuffer {
    slots: Vec<Option<RtpAudioFrame>>,
    expected: Option<u16>,
    len: usize,
    wait_depth: u16,
    stats: JitterStats,
}

impl BoundedJitterBuffer {
    pub fn new(capacity: usize, wait_depth: usize) -> Result<Self, JitterConfigError> {
        if capacity < 2 {
            return Err(JitterConfigError::CapacityTooSmall);
        }
        if wait_depth == 0 || wait_depth >= capacity || capacity > HALF_SEQUENCE_SPACE as usize {
            return Err(JitterConfigError::InvalidWaitDepth);
        }

        Ok(Self {
            slots: vec![None; capacity],
            expected: None,
            len: 0,
            wait_depth: wait_depth as u16,
            stats: JitterStats::default(),
        })
    }

    pub fn push(&mut self, frame: RtpAudioFrame) -> JitterPush {
        let expected = *self.expected.get_or_insert(frame.sequence);
        let distance = frame.sequence.wrapping_sub(expected);

        if distance >= HALF_SEQUENCE_SPACE {
            self.stats.late += 1;
            return JitterPush::Late;
        }
        if distance as usize >= self.slots.len() {
            self.stats.too_far_ahead += 1;
            return JitterPush::TooFarAhead { distance };
        }

        let index = frame.sequence as usize % self.slots.len();
        match &self.slots[index] {
            Some(existing) if existing.sequence == frame.sequence => {
                self.stats.duplicate += 1;
                JitterPush::Duplicate
            }
            Some(_) => {
                self.stats.window_collision += 1;
                JitterPush::WindowCollision
            }
            None => {
                self.slots[index] = Some(frame);
                self.len += 1;
                self.stats.accepted += 1;
                JitterPush::Accepted
            }
        }
    }

    pub fn pop(&mut self) -> JitterPop {
        let Some(expected) = self.expected else {
            return JitterPop::Empty;
        };

        let index = expected as usize % self.slots.len();
        if self.slots[index]
            .as_ref()
            .is_some_and(|frame| frame.sequence == expected)
        {
            let frame = self.slots[index]
                .take()
                .expect("checked jitter slot must contain a frame");
            self.len -= 1;
            self.expected = Some(expected.wrapping_add(1));
            return JitterPop::Frame(frame);
        }

        if self.len == 0 {
            return JitterPop::Empty;
        }

        let furthest = self
            .slots
            .iter()
            .flatten()
            .map(|frame| frame.sequence.wrapping_sub(expected))
            .filter(|distance| *distance < HALF_SEQUENCE_SPACE)
            .max()
            .unwrap_or(0);

        if furthest >= self.wait_depth {
            self.expected = Some(expected.wrapping_add(1));
            self.stats.gaps += 1;
            JitterPop::Gap { sequence: expected }
        } else {
            JitterPop::Waiting
        }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn capacity(&self) -> usize {
        self.slots.len()
    }

    pub fn stats(&self) -> JitterStats {
        self.stats
    }
}
