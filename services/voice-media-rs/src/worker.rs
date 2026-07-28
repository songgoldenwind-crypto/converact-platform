use crate::datagram_pool::{
    DatagramPool, DatagramPoolConfig, DatagramPoolError, DatagramPoolStats,
};
use crate::ivr::{
    DigitSource, IvrCommandResult, IvrDigitInput, IvrDigitResult, IvrError, IvrEvent,
    IvrGatherRequest, IvrPcmFrame, IvrPlaybackRequest, IvrPrompt, IvrPromptCache,
    IvrPromptCacheConfig, IvrSession, IvrSessionConfig, IvrSink, PromptCacheError,
};
use crate::rtp::{
    DtmfEvent, DtmfPhase, ProcessingLeg, RtpEgressPolicy, RtpEmission, RtpProcessSink,
    RtpSessionConfig, RtpSessionProcessor,
};
use mio::net::UdpSocket as MioUdpSocket;
use mio::{Events, Interest, Poll, Token, Waker};
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const CONTROL_TOKEN: Token = Token(0);
const MAX_WORKERS: usize = 256;
const MAX_SESSIONS_PER_WORKER: usize = 1_000_000;
const MAX_SESSION_ID_BYTES: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RtpWorkerPoolConfig {
    pub worker_count: usize,
    pub max_sessions_per_worker: usize,
    pub command_queue_capacity: usize,
    pub event_queue_capacity: usize,
    pub critical_event_capacity: usize,
    pub poll_event_capacity: usize,
    pub max_commands_per_tick: usize,
    pub max_critical_events_per_tick: usize,
    pub max_packets_per_socket_event: usize,
    pub max_datagram_bytes: usize,
    pub datagram_pool_initial: usize,
    pub datagram_pool_max: usize,
    pub socket_receive_buffer_bytes: usize,
    pub socket_send_buffer_bytes: usize,
    pub reuse_port: bool,
    pub poll_timeout: Duration,
    pub control_timeout: Duration,
    pub ivr_prompt_cache: IvrPromptCacheConfig,
    pub ivr_session: IvrSessionConfig,
    pub max_ivr_sessions_per_tick: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RtpWorkerBinding {
    pub worker_index: usize,
    pub leg_a_local_addr: SocketAddr,
    pub leg_b_local_addr: SocketAddr,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerPlaybackRequest {
    pub command_id: Arc<str>,
    pub prompt_id: Arc<str>,
    pub egress_leg: ProcessingLeg,
    pub barge_in: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerGatherRequest {
    pub command_id: Arc<str>,
    pub minimum_digits: usize,
    pub maximum_digits: usize,
    pub terminator: Option<char>,
    pub first_digit_timeout_ms: u64,
    pub inter_digit_timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerEvent {
    Dtmf {
        session_id: Arc<str>,
        event: DtmfEvent,
    },
    Ivr {
        session_id: Arc<str>,
        event: IvrEvent,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RtpWorkerPoolSnapshot {
    pub worker_threads: usize,
    pub active_sessions: usize,
    pub rtp_datagrams_received: u64,
    pub rtp_datagrams_sent: u64,
    pub receive_errors: u64,
    pub processing_errors: u64,
    pub send_errors: u64,
    pub send_would_block: u64,
    pub event_queue_drops: u64,
    pub critical_event_reservations: usize,
    pub critical_event_backlog: usize,
    pub critical_event_admission_rejections: u64,
    pub datagram_retention_limit: usize,
    pub datagram_retention_used: usize,
    pub datagram_retention_rejections: u64,
    pub datagram_pool: DatagramPoolStats,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerError {
    InvalidConfiguration { field: &'static str },
    InvalidSessionId,
    SessionConflict,
    SessionCapacityExhausted { limit: usize },
    DatagramRetentionCapacityExhausted { requested: usize, available: usize },
    SessionConfigurationInvalid,
    CommandQueueFull,
    WorkerUnavailable,
    ControlTimeout,
    SocketConfigurationFailed,
    SocketBindFailed,
    SocketRegistrationFailed,
    WorkerStartFailed,
    SnapshotUnavailable,
    SessionNotFound,
    PromptNotFound,
    PromptCache(PromptCacheError),
    Ivr(IvrError),
}

impl Display for WorkerError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfiguration { field } => {
                write!(formatter, "invalid RTP worker configuration: {field}")
            }
            Self::InvalidSessionId => formatter.write_str("invalid RTP worker session id"),
            Self::SessionConflict => formatter.write_str("RTP worker session conflict"),
            Self::SessionCapacityExhausted { limit } => {
                write!(
                    formatter,
                    "RTP worker session capacity exhausted at {limit}"
                )
            }
            Self::DatagramRetentionCapacityExhausted {
                requested,
                available,
            } => write!(
                formatter,
                "RTP datagram retention capacity exhausted: requested {requested}, available {available}"
            ),
            Self::SessionConfigurationInvalid => {
                formatter.write_str("invalid RTP session configuration")
            }
            Self::CommandQueueFull => formatter.write_str("RTP worker command queue is full"),
            Self::WorkerUnavailable => formatter.write_str("RTP worker unavailable"),
            Self::ControlTimeout => formatter.write_str("RTP worker control timeout"),
            Self::SocketConfigurationFailed => {
                formatter.write_str("RTP worker socket configuration failed")
            }
            Self::SocketBindFailed => formatter.write_str("RTP worker socket bind failed"),
            Self::SocketRegistrationFailed => {
                formatter.write_str("RTP worker socket registration failed")
            }
            Self::WorkerStartFailed => formatter.write_str("RTP worker thread start failed"),
            Self::SnapshotUnavailable => formatter.write_str("RTP worker snapshot unavailable"),
            Self::SessionNotFound => formatter.write_str("RTP worker session not found"),
            Self::PromptNotFound => formatter.write_str("IVR prompt not found"),
            Self::PromptCache(error) => Display::fmt(error, formatter),
            Self::Ivr(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for WorkerError {}

impl From<DatagramPoolError> for WorkerError {
    fn from(value: DatagramPoolError) -> Self {
        match value {
            DatagramPoolError::InvalidConfiguration { field } => {
                Self::InvalidConfiguration { field }
            }
        }
    }
}

impl From<PromptCacheError> for WorkerError {
    fn from(value: PromptCacheError) -> Self {
        Self::PromptCache(value)
    }
}

impl From<IvrError> for WorkerError {
    fn from(value: IvrError) -> Self {
        Self::Ivr(value)
    }
}

#[derive(Default)]
struct WorkerCounters {
    active_sessions: AtomicUsize,
    received: AtomicU64,
    sent: AtomicU64,
    receive_errors: AtomicU64,
    processing_errors: AtomicU64,
    send_errors: AtomicU64,
    send_would_block: AtomicU64,
    event_drops: AtomicU64,
    critical_event_reservations: AtomicUsize,
    critical_event_backlog: AtomicUsize,
    critical_event_admission_rejections: AtomicU64,
}

struct WorkerHandle {
    command_tx: SyncSender<ControlCommand>,
    waker: Arc<Waker>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

enum ControlCommand {
    Install {
        session_id: Arc<str>,
        leg_a_bind: SocketAddr,
        leg_b_bind: SocketAddr,
        config: RtpSessionConfig,
        response: SyncSender<Result<RtpWorkerBinding, WorkerError>>,
    },
    Remove {
        session_id: Arc<str>,
        response: SyncSender<Result<bool, WorkerError>>,
    },
    SetDestination {
        session_id: Arc<str>,
        leg: ProcessingLeg,
        destination: Option<SocketAddr>,
        response: SyncSender<Result<(), WorkerError>>,
    },
    Ivr {
        session_id: Arc<str>,
        command: IvrControlCommand,
        response: SyncSender<Result<IvrControlResult, WorkerError>>,
    },
}

enum IvrControlCommand {
    StartPlayback {
        command_id: Arc<str>,
        prompt: Arc<IvrPrompt>,
        egress_leg: ProcessingLeg,
        barge_in: bool,
    },
    StartGather(WorkerGatherRequest),
    StopPlayback {
        command_id: Arc<str>,
        target_command_id: Arc<str>,
    },
    StopGather {
        command_id: Arc<str>,
        target_command_id: Arc<str>,
    },
    Digit {
        event_id: Arc<str>,
        source: DigitSource,
        digit: char,
    },
}

enum IvrControlResult {
    Command(IvrCommandResult),
    Digit(IvrDigitResult),
}

struct WorkerSession {
    session_id: Arc<str>,
    requested_leg_a_bind: SocketAddr,
    requested_leg_b_bind: SocketAddr,
    config: RtpSessionConfig,
    binding: RtpWorkerBinding,
    leg_a_token: Token,
    leg_b_token: Token,
    leg_a_socket: MioUdpSocket,
    leg_b_socket: MioUdpSocket,
    processor: RtpSessionProcessor,
    ivr: IvrSession,
    ivr_deadline_ms: Option<u64>,
    pending_dtmf: Vec<DtmfEvent>,
    pending_dtmf_limit: usize,
    _datagram_retention: DatagramRetentionPermit,
}

struct CriticalEventDelivery {
    capacity: usize,
    reservations: usize,
    pending: VecDeque<WorkerEvent>,
}

struct DatagramRetentionBudgetInner {
    limit: usize,
    used: AtomicUsize,
    rejections: AtomicU64,
}

#[derive(Clone)]
struct DatagramRetentionBudget {
    inner: Arc<DatagramRetentionBudgetInner>,
}

struct DatagramRetentionPermit {
    units: usize,
    inner: Arc<DatagramRetentionBudgetInner>,
}

struct IvrDeadlineEntry {
    deadline_ms: u64,
    session_id: Arc<str>,
}

struct IvrDeadlineQueue {
    heap: Vec<IvrDeadlineEntry>,
    positions: HashMap<Arc<str>, usize>,
    capacity: usize,
}

struct TokenRoute {
    session_id: Arc<str>,
    ingress_leg: ProcessingLeg,
    queued: bool,
}

struct WorkerRuntimeLaunch {
    worker_index: usize,
    config: RtpWorkerPoolConfig,
    poll: Poll,
    command_rx: Receiver<ControlCommand>,
    event_tx: SyncSender<WorkerEvent>,
    datagram_pool: DatagramPool,
    datagram_retention: DatagramRetentionBudget,
    counters: Arc<WorkerCounters>,
    stop: Arc<AtomicBool>,
}

struct WorkerRuntime {
    worker_index: usize,
    config: RtpWorkerPoolConfig,
    poll: Poll,
    command_rx: Receiver<ControlCommand>,
    event_tx: SyncSender<WorkerEvent>,
    datagram_pool: DatagramPool,
    datagram_retention: DatagramRetentionBudget,
    counters: Arc<WorkerCounters>,
    stop: Arc<AtomicBool>,
    sessions: HashMap<Arc<str>, WorkerSession>,
    tokens: HashMap<Token, TokenRoute>,
    ready: VecDeque<Token>,
    ivr_deadlines: IvrDeadlineQueue,
    critical_events: CriticalEventDelivery,
    next_token: usize,
    started: Instant,
    discard_buffer: Vec<u8>,
}

pub struct RtpWorkerPool {
    config: RtpWorkerPoolConfig,
    workers: Vec<WorkerHandle>,
    events: Mutex<Receiver<WorkerEvent>>,
    counters: Arc<WorkerCounters>,
    datagram_pool: DatagramPool,
    datagram_retention: DatagramRetentionBudget,
    prompt_cache: IvrPromptCache,
}

impl RtpWorkerPool {
    pub fn new(config: RtpWorkerPoolConfig) -> Result<Self, WorkerError> {
        validate_config(config)?;
        let prompt_cache = IvrPromptCache::new(config.ivr_prompt_cache)?;
        IvrSession::new(config.ivr_session)?;
        let datagram_pool = DatagramPool::new(DatagramPoolConfig {
            datagram_bytes: config.max_datagram_bytes,
            initial_buffers: config.datagram_pool_initial,
            max_buffers: config.datagram_pool_max,
        })?;
        let datagram_retention =
            DatagramRetentionBudget::new(config.datagram_pool_max - config.worker_count);
        let counters = Arc::new(WorkerCounters::default());
        let (event_tx, event_rx) = mpsc::sync_channel(config.event_queue_capacity);
        let mut workers = Vec::with_capacity(config.worker_count);

        for worker_index in 0..config.worker_count {
            let poll = Poll::new().map_err(|_| {
                shutdown_workers(&mut workers);
                WorkerError::WorkerStartFailed
            })?;
            let waker = Arc::new(Waker::new(poll.registry(), CONTROL_TOKEN).map_err(|_| {
                shutdown_workers(&mut workers);
                WorkerError::WorkerStartFailed
            })?);
            let (command_tx, command_rx) = mpsc::sync_channel(config.command_queue_capacity);
            let stop = Arc::new(AtomicBool::new(false));
            let worker_waker = waker.clone();
            let worker_stop = stop.clone();
            let worker_pool = datagram_pool.clone();
            let worker_retention = datagram_retention.clone();
            let worker_events = event_tx.clone();
            let worker_counters = counters.clone();
            let join = thread::Builder::new()
                .name(format!("ivekit-rtp-{worker_index}"))
                .spawn(move || {
                    WorkerRuntime::new(WorkerRuntimeLaunch {
                        worker_index,
                        config,
                        poll,
                        command_rx,
                        event_tx: worker_events,
                        datagram_pool: worker_pool,
                        datagram_retention: worker_retention,
                        counters: worker_counters,
                        stop: worker_stop,
                    })
                    .run();
                })
                .map_err(|_| {
                    shutdown_workers(&mut workers);
                    WorkerError::WorkerStartFailed
                })?;
            workers.push(WorkerHandle {
                command_tx,
                waker: worker_waker,
                stop,
                join: Some(join),
            });
        }
        drop(event_tx);

        Ok(Self {
            config,
            workers,
            events: Mutex::new(event_rx),
            counters,
            datagram_pool,
            datagram_retention,
            prompt_cache,
        })
    }

    pub fn cache_prompt_pcm(
        &self,
        prompt_id: &str,
        sample_rate_hz: u32,
        samples: &[i16],
    ) -> Result<Arc<IvrPrompt>, WorkerError> {
        self.prompt_cache
            .insert_pcm(prompt_id, sample_rate_hz, samples)
            .map_err(Into::into)
    }

    pub fn remove_cached_prompt(&self, prompt_id: &str) -> Result<bool, WorkerError> {
        self.prompt_cache.remove(prompt_id).map_err(Into::into)
    }

    pub fn install_session(
        &self,
        session_id: &str,
        leg_a_bind: SocketAddr,
        leg_b_bind: SocketAddr,
        config: RtpSessionConfig,
    ) -> Result<RtpWorkerBinding, WorkerError> {
        let session_id = validated_session_id(session_id)?;
        let worker = &self.workers[stable_worker_index(session_id.as_bytes(), self.workers.len())];
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        send_control(
            worker,
            ControlCommand::Install {
                session_id,
                leg_a_bind,
                leg_b_bind,
                config,
                response: response_tx,
            },
        )?;
        receive_response(response_rx, self.config.control_timeout)
    }

    pub fn remove_session(&self, session_id: &str) -> Result<bool, WorkerError> {
        let session_id = validated_session_id(session_id)?;
        let worker = &self.workers[stable_worker_index(session_id.as_bytes(), self.workers.len())];
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        send_control(
            worker,
            ControlCommand::Remove {
                session_id,
                response: response_tx,
            },
        )?;
        receive_response(response_rx, self.config.control_timeout)
    }

    pub fn set_destination_hint(
        &self,
        session_id: &str,
        leg: ProcessingLeg,
        destination: Option<SocketAddr>,
    ) -> Result<(), WorkerError> {
        let session_id = validated_session_id(session_id)?;
        let worker = &self.workers[stable_worker_index(session_id.as_bytes(), self.workers.len())];
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        send_control(
            worker,
            ControlCommand::SetDestination {
                session_id,
                leg,
                destination,
                response: response_tx,
            },
        )?;
        receive_response(response_rx, self.config.control_timeout)
    }

    pub fn start_playback(
        &self,
        session_id: &str,
        request: WorkerPlaybackRequest,
    ) -> Result<IvrCommandResult, WorkerError> {
        let prompt = self
            .prompt_cache
            .get(&request.prompt_id)?
            .ok_or(WorkerError::PromptNotFound)?;
        match self.send_ivr(
            session_id,
            IvrControlCommand::StartPlayback {
                command_id: request.command_id,
                prompt,
                egress_leg: request.egress_leg,
                barge_in: request.barge_in,
            },
        )? {
            IvrControlResult::Command(result) => Ok(result),
            IvrControlResult::Digit(_) => Err(WorkerError::WorkerUnavailable),
        }
    }

    pub fn start_gather(
        &self,
        session_id: &str,
        request: WorkerGatherRequest,
    ) -> Result<IvrCommandResult, WorkerError> {
        match self.send_ivr(session_id, IvrControlCommand::StartGather(request))? {
            IvrControlResult::Command(result) => Ok(result),
            IvrControlResult::Digit(_) => Err(WorkerError::WorkerUnavailable),
        }
    }

    pub fn stop_playback(
        &self,
        session_id: &str,
        command_id: Arc<str>,
        target_command_id: Arc<str>,
    ) -> Result<IvrCommandResult, WorkerError> {
        match self.send_ivr(
            session_id,
            IvrControlCommand::StopPlayback {
                command_id,
                target_command_id,
            },
        )? {
            IvrControlResult::Command(result) => Ok(result),
            IvrControlResult::Digit(_) => Err(WorkerError::WorkerUnavailable),
        }
    }

    pub fn stop_gather(
        &self,
        session_id: &str,
        command_id: Arc<str>,
        target_command_id: Arc<str>,
    ) -> Result<IvrCommandResult, WorkerError> {
        match self.send_ivr(
            session_id,
            IvrControlCommand::StopGather {
                command_id,
                target_command_id,
            },
        )? {
            IvrControlResult::Command(result) => Ok(result),
            IvrControlResult::Digit(_) => Err(WorkerError::WorkerUnavailable),
        }
    }

    pub fn submit_sip_info_digit(
        &self,
        session_id: &str,
        event_id: &str,
        digit: char,
    ) -> Result<IvrDigitResult, WorkerError> {
        let event_id = validated_digit_event_id(event_id)?;
        match self.send_ivr(
            session_id,
            IvrControlCommand::Digit {
                event_id,
                source: DigitSource::SipInfo,
                digit,
            },
        )? {
            IvrControlResult::Digit(result) => Ok(result),
            IvrControlResult::Command(_) => Err(WorkerError::WorkerUnavailable),
        }
    }

    pub fn recv_event_timeout(&self, timeout: Duration) -> Option<WorkerEvent> {
        self.events.lock().ok()?.recv_timeout(timeout).ok()
    }

    pub fn snapshot(&self) -> Result<RtpWorkerPoolSnapshot, WorkerError> {
        if self
            .workers
            .iter()
            .any(|worker| worker.join.as_ref().is_some_and(JoinHandle::is_finished))
        {
            return Err(WorkerError::SnapshotUnavailable);
        }
        Ok(RtpWorkerPoolSnapshot {
            worker_threads: self.workers.len(),
            active_sessions: self.counters.active_sessions.load(Ordering::Acquire),
            rtp_datagrams_received: self.counters.received.load(Ordering::Relaxed),
            rtp_datagrams_sent: self.counters.sent.load(Ordering::Relaxed),
            receive_errors: self.counters.receive_errors.load(Ordering::Relaxed),
            processing_errors: self.counters.processing_errors.load(Ordering::Relaxed),
            send_errors: self.counters.send_errors.load(Ordering::Relaxed),
            send_would_block: self.counters.send_would_block.load(Ordering::Relaxed),
            event_queue_drops: self.counters.event_drops.load(Ordering::Relaxed),
            critical_event_reservations: self
                .counters
                .critical_event_reservations
                .load(Ordering::Acquire),
            critical_event_backlog: self.counters.critical_event_backlog.load(Ordering::Acquire),
            critical_event_admission_rejections: self
                .counters
                .critical_event_admission_rejections
                .load(Ordering::Relaxed),
            datagram_retention_limit: self.datagram_retention.inner.limit,
            datagram_retention_used: self.datagram_retention.used(),
            datagram_retention_rejections: self.datagram_retention.rejections(),
            datagram_pool: self.datagram_pool.stats(),
        })
    }

    fn send_ivr(
        &self,
        session_id: &str,
        command: IvrControlCommand,
    ) -> Result<IvrControlResult, WorkerError> {
        let session_id = validated_session_id(session_id)?;
        let worker = &self.workers[stable_worker_index(session_id.as_bytes(), self.workers.len())];
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        send_control(
            worker,
            ControlCommand::Ivr {
                session_id,
                command,
                response: response_tx,
            },
        )?;
        receive_response(response_rx, self.config.control_timeout)
    }
}

impl Drop for RtpWorkerPool {
    fn drop(&mut self) {
        shutdown_workers(&mut self.workers);
    }
}

impl DatagramRetentionBudget {
    fn new(limit: usize) -> Self {
        Self {
            inner: Arc::new(DatagramRetentionBudgetInner {
                limit,
                used: AtomicUsize::new(0),
                rejections: AtomicU64::new(0),
            }),
        }
    }

    fn try_acquire(&self, units: usize) -> Result<DatagramRetentionPermit, WorkerError> {
        let result = self
            .inner
            .used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(units)
                    .filter(|projected| *projected <= self.inner.limit)
            });
        if result.is_err() {
            self.inner.rejections.fetch_add(1, Ordering::Relaxed);
            return Err(WorkerError::DatagramRetentionCapacityExhausted {
                requested: units,
                available: self
                    .inner
                    .limit
                    .saturating_sub(self.inner.used.load(Ordering::Acquire)),
            });
        }
        Ok(DatagramRetentionPermit {
            units,
            inner: self.inner.clone(),
        })
    }

    fn used(&self) -> usize {
        self.inner.used.load(Ordering::Acquire)
    }

    fn rejections(&self) -> u64 {
        self.inner.rejections.load(Ordering::Relaxed)
    }
}

impl Drop for DatagramRetentionPermit {
    fn drop(&mut self) {
        self.inner.used.fetch_sub(self.units, Ordering::AcqRel);
    }
}

impl IvrDeadlineQueue {
    fn new(capacity: usize) -> Self {
        Self {
            heap: Vec::new(),
            positions: HashMap::new(),
            capacity,
        }
    }

    fn first(&self) -> Option<&IvrDeadlineEntry> {
        self.heap.first()
    }

    fn upsert(&mut self, session_id: &Arc<str>, deadline_ms: u64) -> bool {
        if let Some(index) = self.positions.get(session_id.as_ref()).copied() {
            let previous = self.heap[index].deadline_ms;
            self.heap[index].deadline_ms = deadline_ms;
            if deadline_ms < previous {
                self.sift_up(index);
            } else if deadline_ms > previous {
                self.sift_down(index);
            }
            return true;
        }
        if self.heap.len() >= self.capacity {
            return false;
        }
        let index = self.heap.len();
        self.heap.push(IvrDeadlineEntry {
            deadline_ms,
            session_id: session_id.clone(),
        });
        self.positions.insert(session_id.clone(), index);
        self.sift_up(index);
        true
    }

    fn remove(&mut self, session_id: &str) -> Option<IvrDeadlineEntry> {
        let index = self.positions.remove(session_id)?;
        let removed = self.heap.swap_remove(index);
        if index < self.heap.len() {
            let moved_id = self.heap[index].session_id.clone();
            *self
                .positions
                .get_mut(moved_id.as_ref())
                .expect("deadline heap position must exist") = index;
            if index > 0 && self.less(index, (index - 1) / 2) {
                self.sift_up(index);
            } else {
                self.sift_down(index);
            }
        }
        Some(removed)
    }

    fn sift_up(&mut self, mut index: usize) {
        while index > 0 {
            let parent = (index - 1) / 2;
            if !self.less(index, parent) {
                break;
            }
            self.swap(index, parent);
            index = parent;
        }
    }

    fn sift_down(&mut self, mut index: usize) {
        loop {
            let left = index.saturating_mul(2).saturating_add(1);
            if left >= self.heap.len() {
                break;
            }
            let right = left + 1;
            let smallest = if right < self.heap.len() && self.less(right, left) {
                right
            } else {
                left
            };
            if !self.less(smallest, index) {
                break;
            }
            self.swap(index, smallest);
            index = smallest;
        }
    }

    fn less(&self, left: usize, right: usize) -> bool {
        let left = &self.heap[left];
        let right = &self.heap[right];
        (left.deadline_ms, left.session_id.as_ref())
            < (right.deadline_ms, right.session_id.as_ref())
    }

    fn swap(&mut self, left: usize, right: usize) {
        self.heap.swap(left, right);
        let left_id = self.heap[left].session_id.clone();
        let right_id = self.heap[right].session_id.clone();
        *self
            .positions
            .get_mut(left_id.as_ref())
            .expect("deadline heap position must exist") = left;
        *self
            .positions
            .get_mut(right_id.as_ref())
            .expect("deadline heap position must exist") = right;
    }
}

impl CriticalEventDelivery {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            reservations: 0,
            pending: VecDeque::new(),
        }
    }

    fn reserve(&mut self, counters: &WorkerCounters) -> bool {
        if self.reservations >= self.capacity {
            counters
                .critical_event_admission_rejections
                .fetch_add(1, Ordering::Relaxed);
            return false;
        }
        self.reservations += 1;
        counters
            .critical_event_reservations
            .fetch_add(1, Ordering::AcqRel);
        true
    }

    fn emit(
        &mut self,
        session_id: &Arc<str>,
        event: IvrEvent,
        event_tx: &SyncSender<WorkerEvent>,
        counters: &WorkerCounters,
    ) {
        let terminal = is_terminal_ivr_event(&event);
        let worker_event = WorkerEvent::Ivr {
            session_id: session_id.clone(),
            event,
        };
        if !terminal {
            if event_tx.try_send(worker_event).is_err() {
                counters.event_drops.fetch_add(1, Ordering::Relaxed);
            }
            return;
        }
        if self.reservations == 0 {
            counters.processing_errors.fetch_add(1, Ordering::Relaxed);
            return;
        }
        match event_tx.try_send(worker_event) {
            Ok(()) => self.release(counters),
            Err(TrySendError::Full(event) | TrySendError::Disconnected(event)) => {
                debug_assert!(self.pending.len() < self.capacity);
                self.pending.push_back(event);
                counters
                    .critical_event_backlog
                    .fetch_add(1, Ordering::AcqRel);
            }
        }
    }

    fn flush(
        &mut self,
        event_tx: &SyncSender<WorkerEvent>,
        counters: &WorkerCounters,
        budget: usize,
    ) {
        for _ in 0..budget {
            let Some(event) = self.pending.pop_front() else {
                break;
            };
            counters
                .critical_event_backlog
                .fetch_sub(1, Ordering::AcqRel);
            match event_tx.try_send(event) {
                Ok(()) => self.release(counters),
                Err(TrySendError::Full(event) | TrySendError::Disconnected(event)) => {
                    self.pending.push_front(event);
                    counters
                        .critical_event_backlog
                        .fetch_add(1, Ordering::AcqRel);
                    break;
                }
            }
        }
    }

    fn release(&mut self, counters: &WorkerCounters) {
        debug_assert!(self.reservations > 0);
        self.reservations = self.reservations.saturating_sub(1);
        counters
            .critical_event_reservations
            .fetch_sub(1, Ordering::AcqRel);
    }
}

fn is_terminal_ivr_event(event: &IvrEvent) -> bool {
    matches!(
        event,
        IvrEvent::PlaybackCompleted { .. }
            | IvrEvent::PlaybackStopped { .. }
            | IvrEvent::GatherCompleted { .. }
    )
}

impl WorkerRuntime {
    fn new(launch: WorkerRuntimeLaunch) -> Self {
        let WorkerRuntimeLaunch {
            worker_index,
            config,
            poll,
            command_rx,
            event_tx,
            datagram_pool,
            datagram_retention,
            counters,
            stop,
        } = launch;
        let initial_sessions = config.max_sessions_per_worker.min(4_096);
        Self {
            worker_index,
            config,
            poll,
            command_rx,
            event_tx,
            datagram_pool,
            datagram_retention,
            counters,
            stop,
            sessions: HashMap::with_capacity(initial_sessions),
            tokens: HashMap::with_capacity(initial_sessions.saturating_mul(2)),
            ready: VecDeque::with_capacity(initial_sessions.saturating_mul(2)),
            ivr_deadlines: IvrDeadlineQueue::new(config.max_sessions_per_worker),
            critical_events: CriticalEventDelivery::new(config.critical_event_capacity),
            next_token: 1,
            started: Instant::now(),
            discard_buffer: vec![0; config.max_datagram_bytes],
        }
    }

    fn run(mut self) {
        let mut events = Events::with_capacity(self.config.poll_event_capacity);
        while !self.stop.load(Ordering::Acquire) {
            let timeout = self.next_poll_timeout();
            match self.poll.poll(&mut events, Some(timeout)) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    self.counters.receive_errors.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            }

            self.critical_events.flush(
                &self.event_tx,
                &self.counters,
                self.config.max_critical_events_per_tick,
            );
            self.drain_commands();
            if self.stop.load(Ordering::Acquire) {
                break;
            }
            for event in events.iter() {
                if event.token() != CONTROL_TOKEN && event.is_readable() {
                    self.enqueue_ready(event.token());
                }
            }
            self.drain_ready();
            self.drain_due_ivr();
        }
        self.shutdown();
    }

    fn drain_commands(&mut self) {
        for _ in 0..self.config.max_commands_per_tick {
            match self.command_rx.try_recv() {
                Ok(command) => self.apply_control(command),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.stop.store(true, Ordering::Release);
                    break;
                }
            }
        }
    }

    fn apply_control(&mut self, command: ControlCommand) {
        match command {
            ControlCommand::Install {
                session_id,
                leg_a_bind,
                leg_b_bind,
                config,
                response,
            } => {
                let result = self.install(session_id, leg_a_bind, leg_b_bind, config);
                let _ = response.try_send(result);
            }
            ControlCommand::Remove {
                session_id,
                response,
            } => {
                let removed = self.remove(&session_id);
                let _ = response.try_send(Ok(removed));
            }
            ControlCommand::SetDestination {
                session_id,
                leg,
                destination,
                response,
            } => {
                let result = self
                    .sessions
                    .get_mut(session_id.as_ref())
                    .ok_or(WorkerError::SessionNotFound)
                    .map(|session| {
                        session.processor.set_destination_hint(leg, destination);
                    });
                let _ = response.try_send(result);
            }
            ControlCommand::Ivr {
                session_id,
                command,
                response,
            } => {
                let result = self.apply_ivr_control(&session_id, command);
                let _ = response.try_send(result);
            }
        }
    }

    fn apply_ivr_control(
        &mut self,
        session_id: &Arc<str>,
        command: IvrControlCommand,
    ) -> Result<IvrControlResult, WorkerError> {
        let now_ms = self.now_ms();
        let event_tx = &self.event_tx;
        let counters = &self.counters;
        let Some(session) = self.sessions.get_mut(session_id.as_ref()) else {
            return Err(WorkerError::SessionNotFound);
        };
        let mut sink = WorkerIvrEventSink {
            session_id: session.session_id.clone(),
            event_tx,
            counters,
            critical_events: &mut self.critical_events,
        };
        let result = match command {
            IvrControlCommand::StartPlayback {
                command_id,
                prompt,
                egress_leg,
                barge_in,
            } => IvrControlResult::Command(session.ivr.start_playback(
                IvrPlaybackRequest {
                    command_id,
                    prompt,
                    egress_leg,
                    barge_in,
                    start_at_ms: now_ms,
                },
                &mut sink,
            )?),
            IvrControlCommand::StartGather(request) => {
                IvrControlResult::Command(session.ivr.start_gather(
                    IvrGatherRequest {
                        command_id: request.command_id,
                        minimum_digits: request.minimum_digits,
                        maximum_digits: request.maximum_digits,
                        terminator: request.terminator,
                        first_digit_timeout_ms: request.first_digit_timeout_ms,
                        inter_digit_timeout_ms: request.inter_digit_timeout_ms,
                        start_at_ms: now_ms,
                    },
                    &mut sink,
                )?)
            }
            IvrControlCommand::StopPlayback {
                command_id,
                target_command_id,
            } => IvrControlResult::Command(session.ivr.stop_playback(
                command_id,
                &target_command_id,
                &mut sink,
            )?),
            IvrControlCommand::StopGather {
                command_id,
                target_command_id,
            } => IvrControlResult::Command(session.ivr.stop_gather(
                command_id,
                &target_command_id,
                &mut sink,
            )?),
            IvrControlCommand::Digit {
                event_id,
                source,
                digit,
            } => IvrControlResult::Digit(session.ivr.observe_digit(
                IvrDigitInput {
                    event_id,
                    source,
                    digit,
                    occurred_at_ms: now_ms,
                },
                &mut sink,
            )?),
        };
        self.reschedule_ivr(session_id);
        Ok(result)
    }

    fn next_poll_timeout(&self) -> Duration {
        if !self.ready.is_empty() {
            return Duration::ZERO;
        }
        let Some(entry) = self.ivr_deadlines.first() else {
            return self.config.poll_timeout;
        };
        let remaining_ms = entry.deadline_ms.saturating_sub(self.now_ms());
        self.config
            .poll_timeout
            .min(Duration::from_millis(remaining_ms))
    }

    fn drain_due_ivr(&mut self) {
        for _ in 0..self.config.max_ivr_sessions_per_tick {
            let Some((deadline_ms, session_id)) = self
                .ivr_deadlines
                .first()
                .map(|entry| (entry.deadline_ms, entry.session_id.clone()))
            else {
                break;
            };
            let now_ms = self.now_ms();
            if deadline_ms > now_ms {
                break;
            }
            self.ivr_deadlines.remove(session_id.as_ref());
            let Some(session) = self.sessions.get_mut(session_id.as_ref()) else {
                continue;
            };
            if session.ivr_deadline_ms != Some(deadline_ms) {
                continue;
            }
            session.ivr_deadline_ms = None;
            let WorkerSession {
                session_id,
                leg_a_socket,
                leg_b_socket,
                processor,
                ivr,
                ..
            } = session;
            let mut sink = WorkerIvrRtpSink {
                session_id: session_id.clone(),
                processor,
                leg_a_socket,
                leg_b_socket,
                event_tx: &self.event_tx,
                counters: &self.counters,
                critical_events: &mut self.critical_events,
            };
            ivr.tick(now_ms, &mut sink);
            let next_deadline = ivr.next_wakeup_ms();
            session.ivr_deadline_ms = next_deadline;
            if let Some(next_deadline) = next_deadline {
                debug_assert!(self.ivr_deadlines.upsert(session_id, next_deadline));
            }
        }
    }

    fn reschedule_ivr(&mut self, session_id: &Arc<str>) {
        let Some(next) = self
            .sessions
            .get(session_id.as_ref())
            .map(|session| session.ivr.next_wakeup_ms())
        else {
            return;
        };
        self.set_ivr_deadline(session_id, next);
    }

    fn set_ivr_deadline(&mut self, session_id: &Arc<str>, next: Option<u64>) {
        let Some(session) = self.sessions.get_mut(session_id.as_ref()) else {
            return;
        };
        if session.ivr_deadline_ms.take().is_some() {
            self.ivr_deadlines.remove(session.session_id.as_ref());
        }
        session.ivr_deadline_ms = next;
        if let Some(next) = next {
            debug_assert!(self.ivr_deadlines.upsert(&session.session_id, next));
        }
    }

    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
    }

    fn install(
        &mut self,
        session_id: Arc<str>,
        leg_a_bind: SocketAddr,
        leg_b_bind: SocketAddr,
        session_config: RtpSessionConfig,
    ) -> Result<RtpWorkerBinding, WorkerError> {
        if let Some(existing) = self.sessions.get(session_id.as_ref()) {
            if existing.requested_leg_a_bind == leg_a_bind
                && existing.requested_leg_b_bind == leg_b_bind
                && existing.config == session_config
            {
                return Ok(existing.binding);
            }
            return Err(WorkerError::SessionConflict);
        }
        if self.sessions.len() >= self.config.max_sessions_per_worker {
            return Err(WorkerError::SessionCapacityExhausted {
                limit: self.config.max_sessions_per_worker,
            });
        }
        if session_config.max_datagram_bytes > self.config.max_datagram_bytes {
            return Err(WorkerError::SessionConfigurationInvalid);
        }
        let processor = RtpSessionProcessor::new(session_config)
            .map_err(|_| WorkerError::SessionConfigurationInvalid)?;
        let retained_datagrams = session_config
            .jitter_capacity
            .checked_mul(2)
            .ok_or(WorkerError::SessionConfigurationInvalid)?;
        let datagram_retention = self.datagram_retention.try_acquire(retained_datagrams)?;
        let ivr = IvrSession::new(self.config.ivr_session)?;
        let mut leg_a_socket = bind_socket(leg_a_bind, self.config)?;
        let mut leg_b_socket = bind_socket(leg_b_bind, self.config)?;
        let leg_a_local_addr = leg_a_socket
            .local_addr()
            .map_err(|_| WorkerError::SocketBindFailed)?;
        let leg_b_local_addr = leg_b_socket
            .local_addr()
            .map_err(|_| WorkerError::SocketBindFailed)?;
        let leg_a_token = allocate_token(&mut self.next_token)?;
        let leg_b_token = allocate_token(&mut self.next_token)?;

        self.poll
            .registry()
            .register(&mut leg_a_socket, leg_a_token, Interest::READABLE)
            .map_err(|_| WorkerError::SocketRegistrationFailed)?;
        if self
            .poll
            .registry()
            .register(&mut leg_b_socket, leg_b_token, Interest::READABLE)
            .is_err()
        {
            let _ = self.poll.registry().deregister(&mut leg_a_socket);
            return Err(WorkerError::SocketRegistrationFailed);
        }

        let binding = RtpWorkerBinding {
            worker_index: self.worker_index,
            leg_a_local_addr,
            leg_b_local_addr,
        };
        self.tokens.insert(
            leg_a_token,
            TokenRoute {
                session_id: session_id.clone(),
                ingress_leg: ProcessingLeg::A,
                queued: false,
            },
        );
        self.tokens.insert(
            leg_b_token,
            TokenRoute {
                session_id: session_id.clone(),
                ingress_leg: ProcessingLeg::B,
                queued: false,
            },
        );
        self.sessions.insert(
            session_id.clone(),
            WorkerSession {
                session_id,
                requested_leg_a_bind: leg_a_bind,
                requested_leg_b_bind: leg_b_bind,
                config: session_config,
                binding,
                leg_a_token,
                leg_b_token,
                leg_a_socket,
                leg_b_socket,
                processor,
                ivr,
                ivr_deadline_ms: None,
                pending_dtmf: Vec::new(),
                pending_dtmf_limit: session_config.max_drain_per_datagram,
                _datagram_retention: datagram_retention,
            },
        );
        self.counters.active_sessions.fetch_add(1, Ordering::AcqRel);
        Ok(binding)
    }

    fn remove(&mut self, session_id: &str) -> bool {
        let Some(mut session) = self.sessions.remove(session_id) else {
            return false;
        };
        if session.ivr_deadline_ms.take().is_some() {
            self.ivr_deadlines.remove(session.session_id.as_ref());
        }
        {
            let mut sink = WorkerIvrEventSink {
                session_id: session.session_id.clone(),
                event_tx: &self.event_tx,
                counters: &self.counters,
                critical_events: &mut self.critical_events,
            };
            session.ivr.cancel_for_session_removal(&mut sink);
        }
        self.tokens.remove(&session.leg_a_token);
        self.tokens.remove(&session.leg_b_token);
        let _ = self.poll.registry().deregister(&mut session.leg_a_socket);
        let _ = self.poll.registry().deregister(&mut session.leg_b_socket);
        self.counters.active_sessions.fetch_sub(1, Ordering::AcqRel);
        true
    }

    fn enqueue_ready(&mut self, token: Token) {
        let Some(route) = self.tokens.get_mut(&token) else {
            return;
        };
        if !route.queued {
            route.queued = true;
            self.ready.push_back(token);
        }
    }

    fn drain_ready(&mut self) {
        let socket_budget = self.ready.len().min(self.config.poll_event_capacity);
        for _ in 0..socket_budget {
            let Some(token) = self.ready.pop_front() else {
                break;
            };
            let Some(route) = self.tokens.get_mut(&token) else {
                continue;
            };
            route.queued = false;
            let session_id = route.session_id.clone();
            let ingress_leg = route.ingress_leg;
            if self.process_socket(&session_id, ingress_leg) {
                self.enqueue_ready(token);
            }
        }
    }

    fn process_socket(&mut self, session_id: &Arc<str>, ingress_leg: ProcessingLeg) -> bool {
        for _ in 0..self.config.max_packets_per_socket_event {
            let Some(mut datagram) = self.datagram_pool.try_acquire() else {
                return self.discard_one(session_id, ingress_leg);
            };
            let received = {
                let Some(session) = self.sessions.get_mut(session_id.as_ref()) else {
                    return false;
                };
                match ingress_leg {
                    ProcessingLeg::A => session.leg_a_socket.recv_from(datagram.full_buffer_mut()),
                    ProcessingLeg::B => session.leg_b_socket.recv_from(datagram.full_buffer_mut()),
                }
            };
            let (len, source) = match received {
                Ok(received) => received,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return false,
                Err(_) => {
                    self.counters.receive_errors.fetch_add(1, Ordering::Relaxed);
                    return false;
                }
            };
            if datagram.set_len(len).is_err() {
                self.counters
                    .processing_errors
                    .fetch_add(1, Ordering::Relaxed);
                continue;
            }
            self.counters.received.fetch_add(1, Ordering::Relaxed);
            let bytes = datagram.into_bytes();
            let now_ms = self.now_ms();
            let mut ivr_deadline_update = None;
            {
                let Some(session) = self.sessions.get_mut(session_id.as_ref()) else {
                    return false;
                };
                let WorkerSession {
                    session_id,
                    leg_a_socket,
                    leg_b_socket,
                    processor,
                    ivr,
                    pending_dtmf,
                    pending_dtmf_limit,
                    ..
                } = session;
                pending_dtmf.clear();
                let egress_policy = ivr
                    .active_playback_egress()
                    .map_or(RtpEgressPolicy::Forward, RtpEgressPolicy::Suppress);
                let mut sink = WorkerSink {
                    session_id: session_id.clone(),
                    leg_a_socket,
                    leg_b_socket,
                    event_tx: &self.event_tx,
                    counters: &self.counters,
                    pending_dtmf,
                    dtmf_capacity: *pending_dtmf_limit,
                };
                if processor
                    .process_bytes_with_policy(
                        ingress_leg,
                        source,
                        bytes,
                        now_ms,
                        egress_policy,
                        &mut sink,
                    )
                    .is_err()
                {
                    self.counters
                        .processing_errors
                        .fetch_add(1, Ordering::Relaxed);
                }
                drop(sink);

                if !pending_dtmf.is_empty() {
                    let mut ivr_sink = WorkerIvrEventSink {
                        session_id: session_id.clone(),
                        event_tx: &self.event_tx,
                        counters: &self.counters,
                        critical_events: &mut self.critical_events,
                    };
                    for event in pending_dtmf.drain(..) {
                        let leg = match event.ingress_leg {
                            ProcessingLeg::A => "a",
                            ProcessingLeg::B => "b",
                        };
                        let input = IvrDigitInput {
                            event_id: Arc::from(format!(
                                "rfc4733:{leg}:{}:{}:{}",
                                event.ssrc, event.rtp_timestamp, event.code
                            )),
                            source: DigitSource::Rfc4733,
                            digit: event.digit,
                            occurred_at_ms: now_ms,
                        };
                        if ivr.observe_digit(input, &mut ivr_sink).is_err() {
                            self.counters
                                .processing_errors
                                .fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    ivr_deadline_update = Some(ivr.next_wakeup_ms());
                }
            }
            if let Some(deadline) = ivr_deadline_update {
                self.set_ivr_deadline(session_id, deadline);
            }
        }
        true
    }

    fn discard_one(&mut self, session_id: &str, ingress_leg: ProcessingLeg) -> bool {
        let Some(session) = self.sessions.get_mut(session_id) else {
            return false;
        };
        let result = match ingress_leg {
            ProcessingLeg::A => session.leg_a_socket.recv_from(&mut self.discard_buffer),
            ProcessingLeg::B => session.leg_b_socket.recv_from(&mut self.discard_buffer),
        };
        match result {
            Ok(_) => true,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => false,
            Err(_) => {
                self.counters.receive_errors.fetch_add(1, Ordering::Relaxed);
                false
            }
        }
    }

    fn shutdown(&mut self) {
        let remaining = self.sessions.len();
        for (_, mut session) in self.sessions.drain() {
            let _ = self.poll.registry().deregister(&mut session.leg_a_socket);
            let _ = self.poll.registry().deregister(&mut session.leg_b_socket);
        }
        if remaining > 0 {
            self.counters
                .active_sessions
                .fetch_sub(remaining, Ordering::AcqRel);
        }
    }
}

struct WorkerSink<'a> {
    session_id: Arc<str>,
    leg_a_socket: &'a mut MioUdpSocket,
    leg_b_socket: &'a mut MioUdpSocket,
    event_tx: &'a SyncSender<WorkerEvent>,
    counters: &'a WorkerCounters,
    pending_dtmf: &'a mut Vec<DtmfEvent>,
    dtmf_capacity: usize,
}

impl RtpProcessSink for WorkerSink<'_> {
    fn emit(&mut self, emission: RtpEmission<'_>) {
        send_emission(
            self.leg_a_socket,
            self.leg_b_socket,
            self.counters,
            emission,
        );
    }

    fn on_dtmf(&mut self, event: DtmfEvent) {
        let worker_event = WorkerEvent::Dtmf {
            session_id: self.session_id.clone(),
            event,
        };
        if self.event_tx.try_send(worker_event).is_err() {
            self.counters.event_drops.fetch_add(1, Ordering::Relaxed);
        }
        if event.phase == DtmfPhase::Completed {
            if self.pending_dtmf.len() < self.dtmf_capacity {
                self.pending_dtmf.push(event);
            } else {
                self.counters.event_drops.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

struct WorkerIvrEventSink<'a> {
    session_id: Arc<str>,
    event_tx: &'a SyncSender<WorkerEvent>,
    counters: &'a WorkerCounters,
    critical_events: &'a mut CriticalEventDelivery,
}

impl IvrSink for WorkerIvrEventSink<'_> {
    fn reserve_terminal_event(&mut self) -> bool {
        self.critical_events.reserve(self.counters)
    }

    fn emit_pcm(&mut self, _frame: IvrPcmFrame<'_>) -> bool {
        false
    }

    fn emit_event(&mut self, event: IvrEvent) {
        self.critical_events
            .emit(&self.session_id, event, self.event_tx, self.counters);
    }
}

struct WorkerIvrRtpSink<'a> {
    session_id: Arc<str>,
    processor: &'a mut RtpSessionProcessor,
    leg_a_socket: &'a mut MioUdpSocket,
    leg_b_socket: &'a mut MioUdpSocket,
    event_tx: &'a SyncSender<WorkerEvent>,
    counters: &'a WorkerCounters,
    critical_events: &'a mut CriticalEventDelivery,
}

impl IvrSink for WorkerIvrRtpSink<'_> {
    fn reserve_terminal_event(&mut self) -> bool {
        self.critical_events.reserve(self.counters)
    }

    fn emit_pcm(&mut self, frame: IvrPcmFrame<'_>) -> bool {
        let mut sink = PlaybackPacketSink {
            leg_a_socket: self.leg_a_socket,
            leg_b_socket: self.leg_b_socket,
            counters: self.counters,
        };
        match self
            .processor
            .emit_pcm_48k(frame.egress_leg, frame.samples, frame.marker, &mut sink)
        {
            Ok(emitted) => emitted,
            Err(_) => {
                self.counters
                    .processing_errors
                    .fetch_add(1, Ordering::Relaxed);
                false
            }
        }
    }

    fn emit_event(&mut self, event: IvrEvent) {
        self.critical_events
            .emit(&self.session_id, event, self.event_tx, self.counters);
    }
}

struct PlaybackPacketSink<'a> {
    leg_a_socket: &'a mut MioUdpSocket,
    leg_b_socket: &'a mut MioUdpSocket,
    counters: &'a WorkerCounters,
}

impl RtpProcessSink for PlaybackPacketSink<'_> {
    fn emit(&mut self, emission: RtpEmission<'_>) {
        send_emission(
            self.leg_a_socket,
            self.leg_b_socket,
            self.counters,
            emission,
        );
    }

    fn on_dtmf(&mut self, _event: DtmfEvent) {}
}

fn send_emission(
    leg_a_socket: &mut MioUdpSocket,
    leg_b_socket: &mut MioUdpSocket,
    counters: &WorkerCounters,
    emission: RtpEmission<'_>,
) {
    let socket = match emission.egress_leg {
        ProcessingLeg::A => leg_a_socket,
        ProcessingLeg::B => leg_b_socket,
    };
    match socket.send_to(emission.datagram, emission.destination) {
        Ok(sent) if sent == emission.datagram.len() => {
            counters.sent.fetch_add(1, Ordering::Relaxed);
        }
        Ok(_) => {
            counters.send_errors.fetch_add(1, Ordering::Relaxed);
        }
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
            counters.send_would_block.fetch_add(1, Ordering::Relaxed);
        }
        Err(_) => {
            counters.send_errors.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn bind_socket(
    address: SocketAddr,
    config: RtpWorkerPoolConfig,
) -> Result<MioUdpSocket, WorkerError> {
    let domain = if address.is_ipv4() {
        Domain::IPV4
    } else {
        Domain::IPV6
    };
    let socket = Socket::new(domain, Type::DGRAM, Some(Protocol::UDP))
        .map_err(|_| WorkerError::SocketConfigurationFailed)?;
    socket
        .set_reuse_address(true)
        .map_err(|_| WorkerError::SocketConfigurationFailed)?;
    set_reuse_port(&socket, config.reuse_port)?;
    socket
        .set_recv_buffer_size(config.socket_receive_buffer_bytes)
        .map_err(|_| WorkerError::SocketConfigurationFailed)?;
    socket
        .set_send_buffer_size(config.socket_send_buffer_bytes)
        .map_err(|_| WorkerError::SocketConfigurationFailed)?;
    socket
        .set_nonblocking(true)
        .map_err(|_| WorkerError::SocketConfigurationFailed)?;
    socket
        .bind(&address.into())
        .map_err(|_| WorkerError::SocketBindFailed)?;
    let socket: std::net::UdpSocket = socket.into();
    Ok(MioUdpSocket::from_std(socket))
}

#[cfg(unix)]
fn set_reuse_port(socket: &Socket, enabled: bool) -> Result<(), WorkerError> {
    if enabled {
        socket
            .set_reuse_port(true)
            .map_err(|_| WorkerError::SocketConfigurationFailed)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_reuse_port(_socket: &Socket, enabled: bool) -> Result<(), WorkerError> {
    if enabled {
        return Err(WorkerError::InvalidConfiguration {
            field: "reuse_port",
        });
    }
    Ok(())
}

fn allocate_token(next_token: &mut usize) -> Result<Token, WorkerError> {
    let token = *next_token;
    *next_token = next_token
        .checked_add(1)
        .ok_or(WorkerError::WorkerUnavailable)?;
    Ok(Token(token))
}

fn validated_session_id(session_id: &str) -> Result<Arc<str>, WorkerError> {
    if !valid_worker_identifier(session_id) {
        return Err(WorkerError::InvalidSessionId);
    }
    Ok(Arc::from(session_id))
}

fn validated_digit_event_id(event_id: &str) -> Result<Arc<str>, WorkerError> {
    if !valid_worker_identifier(event_id) {
        return Err(WorkerError::Ivr(IvrError::InvalidDigitEventId));
    }
    Ok(Arc::from(event_id))
}

fn valid_worker_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SESSION_ID_BYTES
        && !value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_whitespace())
}

fn stable_worker_index(session_id: &[u8], worker_count: usize) -> usize {
    let hash = session_id
        .iter()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
        });
    hash as usize % worker_count
}

fn send_control(worker: &WorkerHandle, command: ControlCommand) -> Result<(), WorkerError> {
    match worker.command_tx.try_send(command) {
        Ok(()) => {
            let _ = worker.waker.wake();
            Ok(())
        }
        Err(TrySendError::Full(_)) => Err(WorkerError::CommandQueueFull),
        Err(TrySendError::Disconnected(_)) => Err(WorkerError::WorkerUnavailable),
    }
}

fn receive_response<T>(
    receiver: Receiver<Result<T, WorkerError>>,
    timeout: Duration,
) -> Result<T, WorkerError> {
    match receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err(WorkerError::ControlTimeout),
        Err(RecvTimeoutError::Disconnected) => Err(WorkerError::WorkerUnavailable),
    }
}

fn shutdown_workers(workers: &mut [WorkerHandle]) {
    for worker in workers.iter() {
        worker.stop.store(true, Ordering::Release);
        let _ = worker.waker.wake();
    }
    for worker in workers.iter_mut() {
        if let Some(join) = worker.join.take() {
            let _ = join.join();
        }
    }
}

fn validate_config(config: RtpWorkerPoolConfig) -> Result<(), WorkerError> {
    if config.worker_count == 0 || config.worker_count > MAX_WORKERS {
        return Err(WorkerError::InvalidConfiguration {
            field: "worker_count",
        });
    }
    if config.max_sessions_per_worker == 0
        || config.max_sessions_per_worker > MAX_SESSIONS_PER_WORKER
    {
        return Err(WorkerError::InvalidConfiguration {
            field: "max_sessions_per_worker",
        });
    }
    if config.datagram_pool_max <= config.worker_count {
        return Err(WorkerError::InvalidConfiguration {
            field: "datagram_pool_max",
        });
    }
    if config.command_queue_capacity == 0 {
        return Err(WorkerError::InvalidConfiguration {
            field: "command_queue_capacity",
        });
    }
    if config.event_queue_capacity == 0 {
        return Err(WorkerError::InvalidConfiguration {
            field: "event_queue_capacity",
        });
    }
    if config.critical_event_capacity == 0 {
        return Err(WorkerError::InvalidConfiguration {
            field: "critical_event_capacity",
        });
    }
    if config.poll_event_capacity == 0 {
        return Err(WorkerError::InvalidConfiguration {
            field: "poll_event_capacity",
        });
    }
    if config.max_commands_per_tick == 0 {
        return Err(WorkerError::InvalidConfiguration {
            field: "max_commands_per_tick",
        });
    }
    if config.max_critical_events_per_tick == 0 {
        return Err(WorkerError::InvalidConfiguration {
            field: "max_critical_events_per_tick",
        });
    }
    if config.max_packets_per_socket_event == 0 {
        return Err(WorkerError::InvalidConfiguration {
            field: "max_packets_per_socket_event",
        });
    }
    if config.max_ivr_sessions_per_tick == 0 {
        return Err(WorkerError::InvalidConfiguration {
            field: "max_ivr_sessions_per_tick",
        });
    }
    if config.socket_receive_buffer_bytes == 0 || config.socket_send_buffer_bytes == 0 {
        return Err(WorkerError::InvalidConfiguration {
            field: "socket_buffer_bytes",
        });
    }
    if config.poll_timeout.is_zero() || config.control_timeout.is_zero() {
        return Err(WorkerError::InvalidConfiguration { field: "timeout" });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::IvrDeadlineQueue;
    use std::sync::Arc;

    #[test]
    fn deadline_queue_updates_in_place_and_keeps_stable_order() {
        let mut queue = IvrDeadlineQueue::new(2);
        let a: Arc<str> = Arc::from("a");
        let b: Arc<str> = Arc::from("b");
        let c: Arc<str> = Arc::from("c");
        assert!(queue.upsert(&b, 20));
        assert!(queue.upsert(&a, 20));
        assert_eq!(queue.first().expect("first").session_id.as_ref(), "a");
        assert_eq!(queue.heap.len(), 2);

        assert!(queue.upsert(&b, 10));
        assert_eq!(
            queue.first().expect("updated first").session_id.as_ref(),
            "b"
        );
        assert_eq!(queue.heap.len(), 2, "update must not append stale timers");
        assert!(!queue.upsert(&c, 5), "queue must fail closed at capacity");

        assert_eq!(queue.remove("b").expect("remove").session_id.as_ref(), "b");
        assert_eq!(queue.first().expect("remaining").session_id.as_ref(), "a");
        assert!(queue.upsert(&c, 30));
        assert_eq!(queue.remove("a").expect("remove").session_id.as_ref(), "a");
        assert_eq!(queue.first().expect("last").session_id.as_ref(), "c");
    }
}
