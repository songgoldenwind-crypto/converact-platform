use crate::datagram_pool::{
    DatagramPool, DatagramPoolConfig, DatagramPoolError, DatagramPoolStats,
};
use crate::rtp::{
    DtmfEvent, ProcessingLeg, RtpEmission, RtpProcessSink, RtpSessionConfig, RtpSessionProcessor,
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
    pub poll_event_capacity: usize,
    pub max_commands_per_tick: usize,
    pub max_packets_per_socket_event: usize,
    pub max_datagram_bytes: usize,
    pub datagram_pool_initial: usize,
    pub datagram_pool_max: usize,
    pub socket_receive_buffer_bytes: usize,
    pub socket_send_buffer_bytes: usize,
    pub reuse_port: bool,
    pub poll_timeout: Duration,
    pub control_timeout: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RtpWorkerBinding {
    pub worker_index: usize,
    pub leg_a_local_addr: SocketAddr,
    pub leg_b_local_addr: SocketAddr,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerEvent {
    Dtmf {
        session_id: Arc<str>,
        event: DtmfEvent,
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
    pub datagram_pool: DatagramPoolStats,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerError {
    InvalidConfiguration { field: &'static str },
    InvalidSessionId,
    SessionConflict,
    SessionCapacityExhausted { limit: usize },
    SessionConfigurationInvalid,
    CommandQueueFull,
    WorkerUnavailable,
    ControlTimeout,
    SocketConfigurationFailed,
    SocketBindFailed,
    SocketRegistrationFailed,
    WorkerStartFailed,
    SnapshotUnavailable,
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
    counters: Arc<WorkerCounters>,
    stop: Arc<AtomicBool>,
    sessions: HashMap<Arc<str>, WorkerSession>,
    tokens: HashMap<Token, TokenRoute>,
    ready: VecDeque<Token>,
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
}

impl RtpWorkerPool {
    pub fn new(config: RtpWorkerPoolConfig) -> Result<Self, WorkerError> {
        validate_config(config)?;
        let datagram_pool = DatagramPool::new(DatagramPoolConfig {
            datagram_bytes: config.max_datagram_bytes,
            initial_buffers: config.datagram_pool_initial,
            max_buffers: config.datagram_pool_max,
        })?;
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
        })
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
            datagram_pool: self.datagram_pool.stats(),
        })
    }
}

impl Drop for RtpWorkerPool {
    fn drop(&mut self) {
        shutdown_workers(&mut self.workers);
    }
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
            counters,
            stop,
            sessions: HashMap::with_capacity(initial_sessions),
            tokens: HashMap::with_capacity(initial_sessions.saturating_mul(2)),
            ready: VecDeque::with_capacity(initial_sessions.saturating_mul(2)),
            next_token: 1,
            started: Instant::now(),
            discard_buffer: vec![0; config.max_datagram_bytes],
        }
    }

    fn run(mut self) {
        let mut events = Events::with_capacity(self.config.poll_event_capacity);
        while !self.stop.load(Ordering::Acquire) {
            let timeout = if self.ready.is_empty() {
                self.config.poll_timeout
            } else {
                Duration::ZERO
            };
            match self.poll.poll(&mut events, Some(timeout)) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    self.counters.receive_errors.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            }

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
        }
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
            },
        );
        self.counters.active_sessions.fetch_add(1, Ordering::AcqRel);
        Ok(binding)
    }

    fn remove(&mut self, session_id: &str) -> bool {
        let Some(mut session) = self.sessions.remove(session_id) else {
            return false;
        };
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
            let Some(session) = self.sessions.get_mut(session_id.as_ref()) else {
                return false;
            };
            let WorkerSession {
                session_id,
                leg_a_socket,
                leg_b_socket,
                processor,
                ..
            } = session;
            let mut sink = WorkerSink {
                session_id: session_id.clone(),
                leg_a_socket,
                leg_b_socket,
                event_tx: &self.event_tx,
                counters: &self.counters,
            };
            let now_ms = self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
            if processor
                .process_bytes(ingress_leg, source, bytes, now_ms, &mut sink)
                .is_err()
            {
                self.counters
                    .processing_errors
                    .fetch_add(1, Ordering::Relaxed);
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
}

impl RtpProcessSink for WorkerSink<'_> {
    fn emit(&mut self, emission: RtpEmission<'_>) {
        let socket = match emission.egress_leg {
            ProcessingLeg::A => &mut self.leg_a_socket,
            ProcessingLeg::B => &mut self.leg_b_socket,
        };
        match socket.send_to(emission.datagram, emission.destination) {
            Ok(sent) if sent == emission.datagram.len() => {
                self.counters.sent.fetch_add(1, Ordering::Relaxed);
            }
            Ok(_) => {
                self.counters.send_errors.fetch_add(1, Ordering::Relaxed);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                self.counters
                    .send_would_block
                    .fetch_add(1, Ordering::Relaxed);
            }
            Err(_) => {
                self.counters.send_errors.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn on_dtmf(&mut self, event: DtmfEvent) {
        let worker_event = WorkerEvent::Dtmf {
            session_id: self.session_id.clone(),
            event,
        };
        if self.event_tx.try_send(worker_event).is_err() {
            self.counters.event_drops.fetch_add(1, Ordering::Relaxed);
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
    if session_id.is_empty()
        || session_id.len() > MAX_SESSION_ID_BYTES
        || session_id
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_whitespace())
    {
        return Err(WorkerError::InvalidSessionId);
    }
    Ok(Arc::from(session_id))
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
    if config.max_packets_per_socket_event == 0 {
        return Err(WorkerError::InvalidConfiguration {
            field: "max_packets_per_socket_event",
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
