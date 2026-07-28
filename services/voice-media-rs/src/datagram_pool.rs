use bytes::Bytes;
use crossbeam_queue::ArrayQueue;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

const MIN_DATAGRAM_BYTES: usize = 12;
const MAX_DATAGRAM_BYTES: usize = u16::MAX as usize;
const MAX_POOL_BUFFERS: usize = 4_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DatagramPoolConfig {
    pub datagram_bytes: usize,
    pub initial_buffers: usize,
    pub max_buffers: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatagramPoolError {
    InvalidConfiguration { field: &'static str },
}

impl Display for DatagramPoolError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfiguration { field } => {
                write!(formatter, "invalid datagram pool configuration: {field}")
            }
        }
    }
}

impl Error for DatagramPoolError {}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DatagramPoolStats {
    pub allocated_buffers: usize,
    pub available_buffers: usize,
    pub in_use_buffers: usize,
    pub reused_acquires: u64,
    pub lazy_allocations: u64,
    pub exhausted_acquires: u64,
}

struct DatagramPoolInner {
    available: ArrayQueue<Vec<u8>>,
    datagram_bytes: usize,
    max_buffers: usize,
    allocated: AtomicUsize,
    in_use: AtomicUsize,
    reused: AtomicU64,
    lazy_allocations: AtomicU64,
    exhausted: AtomicU64,
}

#[derive(Clone)]
pub struct DatagramPool {
    inner: Arc<DatagramPoolInner>,
}

impl DatagramPool {
    pub fn new(config: DatagramPoolConfig) -> Result<Self, DatagramPoolError> {
        validate_config(config)?;
        let available = ArrayQueue::new(config.max_buffers);
        for _ in 0..config.initial_buffers {
            available
                .push(vec![0; config.datagram_bytes])
                .expect("validated datagram pool capacity");
        }
        Ok(Self {
            inner: Arc::new(DatagramPoolInner {
                available,
                datagram_bytes: config.datagram_bytes,
                max_buffers: config.max_buffers,
                allocated: AtomicUsize::new(config.initial_buffers),
                in_use: AtomicUsize::new(0),
                reused: AtomicU64::new(0),
                lazy_allocations: AtomicU64::new(0),
                exhausted: AtomicU64::new(0),
            }),
        })
    }

    pub fn try_acquire(&self) -> Option<DatagramBuffer> {
        let buffer = if let Some(buffer) = self.inner.available.pop() {
            self.inner.reused.fetch_add(1, Ordering::Relaxed);
            buffer
        } else if self
            .inner
            .allocated
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |allocated| {
                (allocated < self.inner.max_buffers).then_some(allocated + 1)
            })
            .is_ok()
        {
            self.inner.lazy_allocations.fetch_add(1, Ordering::Relaxed);
            vec![0; self.inner.datagram_bytes]
        } else {
            self.inner.exhausted.fetch_add(1, Ordering::Relaxed);
            return None;
        };
        self.inner.in_use.fetch_add(1, Ordering::AcqRel);
        Some(DatagramBuffer {
            buffer: Some(buffer),
            len: 0,
            pool: self.inner.clone(),
        })
    }

    pub fn stats(&self) -> DatagramPoolStats {
        DatagramPoolStats {
            allocated_buffers: self.inner.allocated.load(Ordering::Acquire),
            available_buffers: self.inner.available.len(),
            in_use_buffers: self.inner.in_use.load(Ordering::Acquire),
            reused_acquires: self.inner.reused.load(Ordering::Relaxed),
            lazy_allocations: self.inner.lazy_allocations.load(Ordering::Relaxed),
            exhausted_acquires: self.inner.exhausted.load(Ordering::Relaxed),
        }
    }
}

pub struct DatagramBuffer {
    buffer: Option<Vec<u8>>,
    len: usize,
    pool: Arc<DatagramPoolInner>,
}

impl DatagramBuffer {
    pub fn full_buffer_mut(&mut self) -> &mut [u8] {
        self.buffer
            .as_mut()
            .expect("owned datagram buffer")
            .as_mut_slice()
    }

    pub fn set_len(&mut self, len: usize) -> Result<(), DatagramPoolError> {
        if len > self.pool.datagram_bytes {
            return Err(DatagramPoolError::InvalidConfiguration {
                field: "datagram_length",
            });
        }
        self.len = len;
        Ok(())
    }

    pub fn capacity(&self) -> usize {
        self.buffer
            .as_ref()
            .expect("owned datagram buffer")
            .capacity()
    }

    pub fn into_bytes(mut self) -> Bytes {
        let owner = DatagramOwner {
            buffer: self.buffer.take(),
            len: self.len,
            pool: self.pool.clone(),
        };
        Bytes::from_owner(owner)
    }
}

impl Drop for DatagramBuffer {
    fn drop(&mut self) {
        if let Some(buffer) = self.buffer.take() {
            return_buffer(&self.pool, buffer);
        }
    }
}

struct DatagramOwner {
    buffer: Option<Vec<u8>>,
    len: usize,
    pool: Arc<DatagramPoolInner>,
}

impl AsRef<[u8]> for DatagramOwner {
    fn as_ref(&self) -> &[u8] {
        &self
            .buffer
            .as_ref()
            .expect("owned datagram bytes")
            .as_slice()[..self.len]
    }
}

impl Drop for DatagramOwner {
    fn drop(&mut self) {
        if let Some(buffer) = self.buffer.take() {
            return_buffer(&self.pool, buffer);
        }
    }
}

fn return_buffer(pool: &DatagramPoolInner, buffer: Vec<u8>) {
    if pool.available.push(buffer).is_err() {
        pool.allocated.fetch_sub(1, Ordering::AcqRel);
    }
    pool.in_use.fetch_sub(1, Ordering::AcqRel);
}

fn validate_config(config: DatagramPoolConfig) -> Result<(), DatagramPoolError> {
    if !(MIN_DATAGRAM_BYTES..=MAX_DATAGRAM_BYTES).contains(&config.datagram_bytes) {
        return Err(DatagramPoolError::InvalidConfiguration {
            field: "datagram_bytes",
        });
    }
    if config.max_buffers == 0 || config.max_buffers > MAX_POOL_BUFFERS {
        return Err(DatagramPoolError::InvalidConfiguration {
            field: "max_buffers",
        });
    }
    if config.initial_buffers > config.max_buffers {
        return Err(DatagramPoolError::InvalidConfiguration {
            field: "initial_buffers",
        });
    }
    config
        .datagram_bytes
        .checked_mul(config.initial_buffers)
        .ok_or(DatagramPoolError::InvalidConfiguration {
            field: "initial_allocation",
        })?;
    Ok(())
}
