use crate::codec::CodecPair;
use std::error::Error;
use std::fmt::{Debug, Display, Formatter};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

struct PairSlots {
    pair: CodecPair,
    limit: usize,
    used: AtomicUsize,
    rejected: AtomicU64,
}

pub struct CodecPairCapacity {
    slots: [Arc<PairSlots>; CodecPair::ALL.len()],
}

impl CodecPairCapacity {
    pub fn uniform(limit: usize) -> Self {
        Self::from_limits([limit; CodecPair::ALL.len()])
    }

    pub fn from_limits(limits: [usize; CodecPair::ALL.len()]) -> Self {
        Self {
            slots: std::array::from_fn(|index| {
                Arc::new(PairSlots {
                    pair: CodecPair::ALL[index],
                    limit: limits[index],
                    used: AtomicUsize::new(0),
                    rejected: AtomicU64::new(0),
                })
            }),
        }
    }

    pub fn try_acquire(&self, pair: CodecPair) -> Result<CodecPairPermit, CapacityError> {
        let slots = Arc::clone(&self.slots[pair.index()]);
        let mut used = slots.used.load(Ordering::Acquire);

        loop {
            if used >= slots.limit {
                slots.rejected.fetch_add(1, Ordering::Relaxed);
                return Err(CapacityError::Exhausted {
                    pair,
                    limit: slots.limit,
                });
            }

            match slots.used.compare_exchange_weak(
                used,
                used + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Ok(CodecPairPermit {
                        slots,
                        released: false,
                    });
                }
                Err(actual) => used = actual,
            }
        }
    }

    pub fn snapshot(&self, pair: CodecPair) -> CapacitySnapshot {
        let slots = &self.slots[pair.index()];
        CapacitySnapshot {
            pair,
            limit: slots.limit,
            used: slots.used.load(Ordering::Acquire),
            rejected: slots.rejected.load(Ordering::Relaxed),
        }
    }

    pub fn snapshots(&self) -> [CapacitySnapshot; CodecPair::ALL.len()] {
        std::array::from_fn(|index| self.snapshot(CodecPair::ALL[index]))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapacitySnapshot {
    pub pair: CodecPair,
    pub limit: usize,
    pub used: usize,
    pub rejected: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapacityError {
    Exhausted { pair: CodecPair, limit: usize },
}

impl Display for CapacityError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Exhausted { pair, limit } => {
                write!(
                    formatter,
                    "codec pair {} exhausted its {} processing slots",
                    pair.label(),
                    limit
                )
            }
        }
    }
}

impl Error for CapacityError {}

pub struct CodecPairPermit {
    slots: Arc<PairSlots>,
    released: bool,
}

impl CodecPairPermit {
    pub fn pair(&self) -> CodecPair {
        self.slots.pair
    }

    pub fn release(mut self) {
        self.release_once();
    }

    fn release_once(&mut self) {
        if !self.released {
            let previous = self.slots.used.fetch_sub(1, Ordering::AcqRel);
            debug_assert!(previous > 0, "processing slot usage underflow");
            self.released = true;
        }
    }
}

impl Debug for CodecPairPermit {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CodecPairPermit")
            .field("pair", &self.slots.pair)
            .field("released", &self.released)
            .finish()
    }
}

impl Drop for CodecPairPermit {
    fn drop(&mut self) {
        self.release_once();
    }
}
