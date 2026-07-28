use crate::capacity::{CapacityError, CodecPairCapacity, CodecPairPermit};
use crate::codec::{AudioCodec, CodecPair};
use std::collections::{hash_map::RandomState, HashMap, VecDeque};
use std::convert::Infallible;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::hash::BuildHasher;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_SHARDS: usize = 1_024;
const MAX_COMMANDS_PER_SESSION: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessingAction {
    Offer,
    Answer,
    Update,
    Delete,
    Query,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessingProfile {
    pub leg_a_codec: AudioCodec,
    pub leg_b_codec: AudioCodec,
    pub packetization_ms: u16,
    pub leg_a_payload_type: u8,
    pub leg_b_payload_type: u8,
}

impl ProcessingProfile {
    pub fn codec_pairs(self) -> Result<(CodecPair, CodecPair), SessionError> {
        if self.packetization_ms != 20
            || self.leg_a_payload_type > 127
            || self.leg_b_payload_type > 127
        {
            return Err(SessionError::InvalidProfile);
        }
        let forward = CodecPair::new(self.leg_a_codec, self.leg_b_codec)
            .map_err(|_| SessionError::InvalidProfile)?;
        let reverse = CodecPair::new(self.leg_b_codec, self.leg_a_codec)
            .map_err(|_| SessionError::InvalidProfile)?;
        Ok((forward, reverse))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessingCommand {
    pub action: ProcessingAction,
    pub command_id: String,
    pub tenant_id: String,
    pub call_id: String,
    pub leg_id: String,
    pub cell_id: String,
    pub owner_node_id: String,
    pub owner_epoch: u64,
    pub admission_reservation_id: String,
    pub media_reservation_id: String,
    pub command_sequence: u32,
    pub idempotency_key: String,
    pub expires_at_ms: u64,
    pub command_hash: [u8; 32],
    pub idempotency_hash: [u8; 32],
    pub profile: Option<ProcessingProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcileCommand {
    pub media_reservation_id: String,
    pub owner_epoch: u64,
    pub command_id: String,
    pub command_hash: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessingSessionState {
    Prepared,
    Committed,
    Closed,
    Expired,
}

impl ProcessingSessionState {
    fn is_active(self) -> bool {
        matches!(self, Self::Prepared | Self::Committed)
    }

    fn is_terminal(self) -> bool {
        matches!(self, Self::Closed | Self::Expired)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessingPorts {
    pub leg_a_rtp_port: u16,
    pub leg_b_rtp_port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessingSessionSnapshot {
    pub media_reservation_id: String,
    pub admission_reservation_id: String,
    pub tenant_id: String,
    pub call_id: String,
    pub leg_id: String,
    pub cell_id: String,
    pub owner_node_id: String,
    pub owner_epoch: u64,
    pub last_sequence: u32,
    pub state: ProcessingSessionState,
    pub profile: ProcessingProfile,
    pub ports: ProcessingPorts,
    pub resources_active: bool,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionCommandResult {
    pub response_command_id: String,
    pub applied_command_id: String,
    pub replayed: bool,
    pub snapshot: ProcessingSessionSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessingSessionRegistryConfig {
    pub max_sessions: usize,
    pub max_commands_per_session: usize,
    pub terminal_retention_ms: u64,
    pub max_lease_horizon_ms: u64,
    pub shard_count: usize,
    pub rtp_port_start: u16,
    pub rtp_port_end: u16,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SweepReport {
    pub inspected: usize,
    pub expired: usize,
    pub evicted: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionScanResult {
    pub inspected: usize,
    pub items: Vec<ProcessingSessionSnapshot>,
    pub next_cursor: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SweepAction {
    ExpirePrepared,
    EvictTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionError {
    InvalidConfiguration { field: &'static str },
    InvalidCommand { field: &'static str },
    InvalidProfile,
    LeaseExpired,
    LeaseHorizonExceeded,
    SessionNotFound,
    SessionCapacityExhausted { limit: usize },
    CodecCapacityExhausted { pair: CodecPair, limit: usize },
    PortCapacityExhausted,
    ReservationIdentityConflict,
    OwnerNodeConflict,
    StaleOwnerEpoch,
    OwnerTakeoverSequenceInvalid,
    StaleSequence,
    SequenceGap { expected: u32, actual: u32 },
    CommandPayloadConflict,
    IdempotencyKeyConflict,
    InvalidTransition,
    RegistryPoisoned,
}

impl SessionError {
    pub const fn retryable(self) -> bool {
        matches!(
            self,
            Self::SessionCapacityExhausted { .. }
                | Self::CodecCapacityExhausted { .. }
                | Self::PortCapacityExhausted
                | Self::RegistryPoisoned
        )
    }
}

impl Display for SessionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfiguration { field } => {
                write!(
                    formatter,
                    "invalid processing registry configuration: {field}"
                )
            }
            Self::InvalidCommand { field } => {
                write!(formatter, "invalid processing command field: {field}")
            }
            Self::InvalidProfile => formatter.write_str("invalid processing profile"),
            Self::LeaseExpired => formatter.write_str("processing lease expired"),
            Self::LeaseHorizonExceeded => formatter.write_str("processing lease horizon exceeded"),
            Self::SessionNotFound => formatter.write_str("processing session not found"),
            Self::SessionCapacityExhausted { limit } => {
                write!(
                    formatter,
                    "processing session capacity exhausted at {limit}"
                )
            }
            Self::CodecCapacityExhausted { pair, limit } => {
                write!(
                    formatter,
                    "processing codec pair {} exhausted at {}",
                    pair.label(),
                    limit
                )
            }
            Self::PortCapacityExhausted => {
                formatter.write_str("processing RTP port capacity exhausted")
            }
            Self::ReservationIdentityConflict => {
                formatter.write_str("processing reservation identity conflict")
            }
            Self::OwnerNodeConflict => formatter.write_str("processing owner node conflict"),
            Self::StaleOwnerEpoch => formatter.write_str("stale processing owner epoch"),
            Self::OwnerTakeoverSequenceInvalid => {
                formatter.write_str("owner takeover must restart command sequence at one")
            }
            Self::StaleSequence => formatter.write_str("stale processing command sequence"),
            Self::SequenceGap { expected, actual } => {
                write!(
                    formatter,
                    "processing command sequence gap: expected {expected}, got {actual}"
                )
            }
            Self::CommandPayloadConflict => {
                formatter.write_str("processing command payload conflict")
            }
            Self::IdempotencyKeyConflict => {
                formatter.write_str("processing idempotency key conflict")
            }
            Self::InvalidTransition => formatter.write_str("invalid processing session transition"),
            Self::RegistryPoisoned => formatter.write_str("processing registry lock poisoned"),
        }
    }
}

impl Error for SessionError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionExecutionError<E> {
    Session(SessionError),
    SideEffect(E),
}

impl<E> From<SessionError> for SessionExecutionError<E> {
    fn from(value: SessionError) -> Self {
        Self::Session(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionSweepError<E> {
    Session(SessionError),
    SideEffect(E),
}

impl<E> From<SessionError> for SessionSweepError<E> {
    fn from(value: SessionError) -> Self {
        Self::Session(value)
    }
}

struct SessionIdentity {
    media_reservation_id: String,
    admission_reservation_id: String,
    tenant_id: String,
    call_id: String,
    leg_id: String,
    cell_id: String,
}

struct SessionResources {
    _forward_permit: CodecPairPermit,
    _reverse_permit: CodecPairPermit,
    ports: ProcessingPorts,
}

struct RecordedCommand {
    command_id: Box<str>,
    applied_command_id: Option<Box<str>>,
    idempotency_key: Box<str>,
    command_hash: [u8; 32],
    idempotency_hash: [u8; 32],
    sequence: u32,
    state: ProcessingSessionState,
    expires_at_ms: u64,
}

struct SessionRecord {
    identity: SessionIdentity,
    owner_node_id: String,
    owner_epoch: u64,
    last_sequence: u32,
    expires_at_ms: u64,
    state: ProcessingSessionState,
    profile: ProcessingProfile,
    assigned_ports: ProcessingPorts,
    resources: Option<SessionResources>,
    commands: VecDeque<RecordedCommand>,
    terminal_at_ms: u64,
}

#[derive(Default)]
struct SessionShard {
    records: HashMap<String, SessionRecord>,
    sweep_order: VecDeque<String>,
}

struct PortPool {
    free: Vec<u16>,
    total: usize,
}

impl PortPool {
    fn new(start: u16, end: u16) -> Result<Self, SessionError> {
        if start > end || !start.is_multiple_of(2) || !end.is_multiple_of(2) {
            return Err(SessionError::InvalidConfiguration {
                field: "rtp_port_range",
            });
        }
        let free: Vec<u16> = (start..=end).step_by(2).collect();
        if free.len() < 2 {
            return Err(SessionError::InvalidConfiguration {
                field: "rtp_port_range",
            });
        }
        let total = free.len();
        Ok(Self { free, total })
    }

    fn allocate_pair(&mut self) -> Option<ProcessingPorts> {
        let leg_a_rtp_port = self.free.pop()?;
        let Some(leg_b_rtp_port) = self.free.pop() else {
            self.free.push(leg_a_rtp_port);
            return None;
        };
        Some(ProcessingPorts {
            leg_a_rtp_port,
            leg_b_rtp_port,
        })
    }

    fn release_pair(&mut self, ports: ProcessingPorts) {
        debug_assert!(self.free.len() + 2 <= self.total);
        self.free.push(ports.leg_a_rtp_port);
        self.free.push(ports.leg_b_rtp_port);
    }
}

pub struct ProcessingSessionRegistry {
    config: ProcessingSessionRegistryConfig,
    capacity: Arc<CodecPairCapacity>,
    shards: Box<[Mutex<SessionShard>]>,
    ports: Mutex<PortPool>,
    hash_builder: RandomState,
    session_count: AtomicUsize,
    active_session_count: AtomicUsize,
    sweep_cursor: AtomicUsize,
}

impl ProcessingSessionRegistry {
    pub fn new(
        config: ProcessingSessionRegistryConfig,
        capacity: Arc<CodecPairCapacity>,
    ) -> Result<Self, SessionError> {
        validate_config(config)?;
        let ports = PortPool::new(config.rtp_port_start, config.rtp_port_end)?;
        let shards = (0..config.shard_count)
            .map(|_| Mutex::new(SessionShard::default()))
            .collect::<Vec<_>>()
            .into_boxed_slice();
        Ok(Self {
            config,
            capacity,
            shards,
            ports: Mutex::new(ports),
            hash_builder: RandomState::new(),
            session_count: AtomicUsize::new(0),
            active_session_count: AtomicUsize::new(0),
            sweep_cursor: AtomicUsize::new(0),
        })
    }

    pub fn execute(
        &self,
        command: ProcessingCommand,
        now_ms: u64,
    ) -> Result<SessionCommandResult, SessionError> {
        match self.execute_with(command, now_ms, |_| Ok::<(), Infallible>(())) {
            Ok(result) => Ok(result),
            Err(SessionExecutionError::Session(error)) => Err(error),
            Err(SessionExecutionError::SideEffect(never)) => match never {},
        }
    }

    pub fn execute_with<F, E>(
        &self,
        command: ProcessingCommand,
        now_ms: u64,
        apply: F,
    ) -> Result<SessionCommandResult, SessionExecutionError<E>>
    where
        F: FnOnce(&ProcessingSessionSnapshot) -> Result<(), E>,
    {
        self.validate_command(&command, now_ms)?;
        let shard_index = self.shard_index(&command.media_reservation_id);
        let mut shard = lock(&self.shards[shard_index])?;

        if let Some(record) = shard.records.get_mut(&command.media_reservation_id) {
            return self.execute_existing(record, command, now_ms, apply);
        }
        self.execute_new(&mut shard, command, apply)
    }

    pub fn reconcile(
        &self,
        command: ReconcileCommand,
    ) -> Result<Option<SessionCommandResult>, SessionError> {
        validate_identifier(&command.media_reservation_id, "media_reservation_id")?;
        validate_identifier(&command.command_id, "command_id")?;
        let shard = lock(&self.shards[self.shard_index(&command.media_reservation_id)])?;
        let Some(record) = shard.records.get(&command.media_reservation_id) else {
            return Ok(None);
        };
        if command.owner_epoch < record.owner_epoch {
            return Err(SessionError::StaleOwnerEpoch);
        }
        if command.owner_epoch > record.owner_epoch {
            return Ok(None);
        }
        let Some(recorded) = record
            .commands
            .iter()
            .find(|candidate| candidate.command_id.as_ref() == command.command_id)
        else {
            return Ok(None);
        };
        if recorded.command_hash != command.command_hash {
            return Err(SessionError::CommandPayloadConflict);
        }
        Ok(Some(project_result(
            record,
            recorded,
            command.command_id,
            true,
        )))
    }

    pub fn snapshot(&self, media_reservation_id: &str) -> Option<ProcessingSessionSnapshot> {
        let shard = self.shards[self.shard_index(media_reservation_id)]
            .lock()
            .ok()?;
        let record = shard.records.get(media_reservation_id)?;
        Some(project_snapshot(
            record,
            record.state,
            record.last_sequence,
            record.expires_at_ms,
        ))
    }

    pub fn scan_active(
        &self,
        after: &str,
        limit: usize,
    ) -> Result<SessionScanResult, SessionError> {
        if limit == 0 || limit > 10_000 {
            return Err(SessionError::InvalidCommand {
                field: "scan_limit",
            });
        }
        if !after.is_empty() {
            validate_identifier(after, "scan_cursor")?;
        }
        let inspection_budget = self.session_count();
        if inspection_budget == 0 {
            return Ok(SessionScanResult::default());
        }

        let shard_count = self.shards.len();
        let start_shard = if after.is_empty() {
            0
        } else {
            self.shard_index(after)
        };
        let mut result = SessionScanResult {
            items: Vec::with_capacity(limit.min(self.active_session_count())),
            ..SessionScanResult::default()
        };
        let mut start_split = None;

        for offset in 0..shard_count {
            if result.items.len() >= limit || result.inspected >= inspection_budget {
                break;
            }
            let shard_index = (start_shard + offset) & (shard_count - 1);
            let shard = lock(&self.shards[shard_index])?;
            let split = if offset == 0 && !after.is_empty() {
                let split = shard
                    .sweep_order
                    .iter()
                    .position(|candidate| candidate == after)
                    .map(|position| position + 1);
                start_split = split;
                split.unwrap_or(0)
            } else {
                0
            };
            for key in shard.sweep_order.iter().skip(split) {
                if result.items.len() >= limit || result.inspected >= inspection_budget {
                    break;
                }
                result.inspected += 1;
                result.next_cursor.clone_from(key);
                let Some(record) = shard.records.get(key) else {
                    continue;
                };
                if matches!(
                    record.state,
                    ProcessingSessionState::Prepared | ProcessingSessionState::Committed
                ) {
                    result.items.push(project_snapshot(
                        record,
                        record.state,
                        record.last_sequence,
                        record.expires_at_ms,
                    ));
                }
            }
        }
        if result.items.len() < limit && result.inspected < inspection_budget {
            if let Some(split) = start_split {
                let shard = lock(&self.shards[start_shard])?;
                for key in shard.sweep_order.iter().take(split) {
                    if result.items.len() >= limit || result.inspected >= inspection_budget {
                        break;
                    }
                    result.inspected += 1;
                    result.next_cursor.clone_from(key);
                    let Some(record) = shard.records.get(key) else {
                        continue;
                    };
                    if matches!(
                        record.state,
                        ProcessingSessionState::Prepared | ProcessingSessionState::Committed
                    ) {
                        result.items.push(project_snapshot(
                            record,
                            record.state,
                            record.last_sequence,
                            record.expires_at_ms,
                        ));
                    }
                }
            }
        }
        Ok(result)
    }

    pub fn command_count(&self, media_reservation_id: &str) -> usize {
        self.shards[self.shard_index(media_reservation_id)]
            .lock()
            .ok()
            .and_then(|shard| {
                shard
                    .records
                    .get(media_reservation_id)
                    .map(|record| record.commands.len())
            })
            .unwrap_or(0)
    }

    pub fn session_count(&self) -> usize {
        self.session_count.load(Ordering::Acquire)
    }

    pub fn active_session_count(&self) -> usize {
        self.active_session_count.load(Ordering::Acquire)
    }

    pub fn available_port_count(&self) -> usize {
        self.ports.lock().map(|ports| ports.free.len()).unwrap_or(0)
    }

    pub fn sweep(&self, now_ms: u64, limit: usize) -> Result<SweepReport, SessionError> {
        match self.sweep_with(now_ms, limit, |_, _| Ok::<(), Infallible>(())) {
            Ok(report) => Ok(report),
            Err(SessionSweepError::Session(error)) => Err(error),
            Err(SessionSweepError::SideEffect(never)) => match never {},
        }
    }

    pub fn sweep_with<F, E>(
        &self,
        now_ms: u64,
        limit: usize,
        mut apply: F,
    ) -> Result<SweepReport, SessionSweepError<E>>
    where
        F: FnMut(SweepAction, &ProcessingSessionSnapshot) -> Result<(), E>,
    {
        if limit == 0 {
            return Err(SessionError::InvalidCommand {
                field: "sweep_limit",
            }
            .into());
        }
        let mut report = SweepReport::default();
        let inspection_budget = limit.min(self.session_count());
        if inspection_budget == 0 {
            return Ok(report);
        }
        let shard_count = self.shards.len();
        let mut shard_index = self.sweep_cursor.fetch_add(1, Ordering::Relaxed) & (shard_count - 1);
        let mut consecutive_empty_shards = 0;

        while report.inspected < inspection_budget && consecutive_empty_shards < shard_count {
            let mut shard = lock(&self.shards[shard_index])?;
            let Some(key) = shard.sweep_order.pop_front() else {
                consecutive_empty_shards += 1;
                shard_index = (shard_index + 1) & (shard_count - 1);
                continue;
            };
            consecutive_empty_shards = 0;
            report.inspected += 1;
            let mut remove = false;
            if let Some(record) = shard.records.get_mut(&key) {
                if record.state == ProcessingSessionState::Prepared
                    && record.expires_at_ms <= now_ms
                {
                    let proposed = project_snapshot(
                        record,
                        ProcessingSessionState::Expired,
                        record.last_sequence,
                        record.expires_at_ms,
                    );
                    if let Err(error) = apply(SweepAction::ExpirePrepared, &proposed) {
                        shard.sweep_order.push_back(key);
                        self.sweep_cursor.store(shard_index, Ordering::Relaxed);
                        return Err(SessionSweepError::SideEffect(error));
                    }
                    self.release_resources(record)?;
                    record.state = ProcessingSessionState::Expired;
                    record.terminal_at_ms = now_ms;
                    self.active_session_count.fetch_sub(1, Ordering::AcqRel);
                    report.expired += 1;
                } else if record.state.is_terminal()
                    && now_ms.saturating_sub(record.terminal_at_ms)
                        >= self.config.terminal_retention_ms
                {
                    let snapshot = project_snapshot(
                        record,
                        record.state,
                        record.last_sequence,
                        record.expires_at_ms,
                    );
                    if let Err(error) = apply(SweepAction::EvictTerminal, &snapshot) {
                        shard.sweep_order.push_back(key);
                        self.sweep_cursor.store(shard_index, Ordering::Relaxed);
                        return Err(SessionSweepError::SideEffect(error));
                    }
                    remove = true;
                }
            }
            if remove {
                if shard.records.remove(&key).is_some() {
                    self.session_count.fetch_sub(1, Ordering::AcqRel);
                    report.evicted += 1;
                }
            } else if shard.records.contains_key(&key) {
                shard.sweep_order.push_back(key);
            }
            shard_index = (shard_index + 1) & (shard_count - 1);
        }
        self.sweep_cursor.store(shard_index, Ordering::Relaxed);
        Ok(report)
    }

    fn execute_new<F, E>(
        &self,
        shard: &mut SessionShard,
        command: ProcessingCommand,
        apply: F,
    ) -> Result<SessionCommandResult, SessionExecutionError<E>>
    where
        F: FnOnce(&ProcessingSessionSnapshot) -> Result<(), E>,
    {
        if command.action != ProcessingAction::Offer {
            return Err(SessionError::SessionNotFound.into());
        }
        if command.command_sequence != 1 {
            return Err(SessionError::SequenceGap {
                expected: 1,
                actual: command.command_sequence,
            }
            .into());
        }
        let profile = command.profile.ok_or(SessionError::InvalidProfile)?;
        profile.codec_pairs()?;
        self.reserve_session_slot()?;
        let resources = match self.acquire_resources(profile) {
            Ok(resources) => resources,
            Err(error) => {
                self.session_count.fetch_sub(1, Ordering::AcqRel);
                return Err(error.into());
            }
        };
        let assigned_ports = resources.ports;
        let mut record = SessionRecord {
            identity: SessionIdentity {
                media_reservation_id: command.media_reservation_id.clone(),
                admission_reservation_id: command.admission_reservation_id.clone(),
                tenant_id: command.tenant_id.clone(),
                call_id: command.call_id.clone(),
                leg_id: command.leg_id.clone(),
                cell_id: command.cell_id.clone(),
            },
            owner_node_id: command.owner_node_id.clone(),
            owner_epoch: command.owner_epoch,
            last_sequence: command.command_sequence,
            expires_at_ms: command.expires_at_ms,
            state: ProcessingSessionState::Prepared,
            profile,
            assigned_ports,
            resources: Some(resources),
            commands: VecDeque::with_capacity(self.config.max_commands_per_session),
            terminal_at_ms: 0,
        };
        let proposed = project_snapshot(
            &record,
            ProcessingSessionState::Prepared,
            command.command_sequence,
            command.expires_at_ms,
        );
        if let Err(error) = apply(&proposed) {
            let resources = record
                .resources
                .take()
                .expect("new processing resources must exist before commit");
            let release_result = self.release_uncommitted_resources(resources);
            self.session_count.fetch_sub(1, Ordering::AcqRel);
            release_result?;
            return Err(SessionExecutionError::SideEffect(error));
        }
        push_recorded(&mut record, &command, self.config.max_commands_per_session);
        let recorded = record
            .commands
            .back()
            .expect("new session command must be recorded");
        let result = project_result(&record, recorded, command.command_id.clone(), false);
        shard
            .sweep_order
            .push_back(command.media_reservation_id.clone());
        shard.records.insert(command.media_reservation_id, record);
        self.active_session_count.fetch_add(1, Ordering::AcqRel);
        Ok(result)
    }

    fn execute_existing<F, E>(
        &self,
        record: &mut SessionRecord,
        command: ProcessingCommand,
        now_ms: u64,
        apply: F,
    ) -> Result<SessionCommandResult, SessionExecutionError<E>>
    where
        F: FnOnce(&ProcessingSessionSnapshot) -> Result<(), E>,
    {
        assert_identity(record, &command)?;
        if command.owner_epoch < record.owner_epoch {
            return Err(SessionError::StaleOwnerEpoch.into());
        }
        let takeover = command.owner_epoch > record.owner_epoch;
        if command.owner_epoch == record.owner_epoch {
            if let Some(result) = replay(record, &command, self.config.max_commands_per_session)? {
                return Ok(result);
            }
        } else if command.command_sequence != 1 {
            return Err(SessionError::OwnerTakeoverSequenceInvalid.into());
        }

        if command.action != ProcessingAction::Delete {
            validate_lease(
                command.expires_at_ms,
                now_ms,
                self.config.max_lease_horizon_ms,
            )?;
        }
        let previous_sequence = if takeover { 0 } else { record.last_sequence };
        let expected = previous_sequence.saturating_add(1);
        if command.command_sequence <= previous_sequence {
            return Err(SessionError::StaleSequence.into());
        }
        if command.command_sequence != expected {
            return Err(SessionError::SequenceGap {
                expected,
                actual: command.command_sequence,
            }
            .into());
        }
        assert_transition(record.state, command.action)?;
        if command.action == ProcessingAction::Offer && command.profile != Some(record.profile) {
            return Err(SessionError::InvalidProfile.into());
        }
        let next_state = match command.action {
            ProcessingAction::Offer => ProcessingSessionState::Prepared,
            ProcessingAction::Answer => ProcessingSessionState::Committed,
            ProcessingAction::Update | ProcessingAction::Query => record.state,
            ProcessingAction::Delete => ProcessingSessionState::Closed,
        };
        let mut proposed = project_snapshot(
            record,
            next_state,
            command.command_sequence,
            command.expires_at_ms,
        );
        if takeover {
            proposed.owner_epoch = command.owner_epoch;
            proposed.owner_node_id.clone_from(&command.owner_node_id);
        }
        apply(&proposed).map_err(SessionExecutionError::SideEffect)?;
        if takeover {
            record.owner_epoch = command.owner_epoch;
            record.owner_node_id.clone_from(&command.owner_node_id);
            record.commands.clear();
        }
        if command.action == ProcessingAction::Delete {
            self.release_resources(record)?;
            record.terminal_at_ms = now_ms;
            self.active_session_count.fetch_sub(1, Ordering::AcqRel);
        }
        record.state = next_state;
        record.last_sequence = command.command_sequence;
        record.expires_at_ms = command.expires_at_ms;
        push_recorded(record, &command, self.config.max_commands_per_session);
        let recorded = record
            .commands
            .back()
            .expect("applied command must be recorded");
        Ok(project_result(record, recorded, command.command_id, false))
    }

    fn validate_command(
        &self,
        command: &ProcessingCommand,
        now_ms: u64,
    ) -> Result<(), SessionError> {
        for (value, field) in [
            (&command.command_id, "command_id"),
            (&command.tenant_id, "tenant_id"),
            (&command.call_id, "call_id"),
            (&command.leg_id, "leg_id"),
            (&command.cell_id, "cell_id"),
            (&command.owner_node_id, "owner_node_id"),
            (
                &command.admission_reservation_id,
                "admission_reservation_id",
            ),
            (&command.media_reservation_id, "media_reservation_id"),
            (&command.idempotency_key, "idempotency_key"),
        ] {
            validate_identifier(value, field)?;
        }
        if command.command_sequence == 0 {
            return Err(SessionError::InvalidCommand {
                field: "command_sequence",
            });
        }
        match command.action {
            ProcessingAction::Offer => {
                command
                    .profile
                    .ok_or(SessionError::InvalidProfile)?
                    .codec_pairs()?;
            }
            _ if command.profile.is_some() => {
                return Err(SessionError::InvalidProfile);
            }
            _ => {}
        }
        if command.action != ProcessingAction::Delete {
            validate_lease(
                command.expires_at_ms,
                now_ms,
                self.config.max_lease_horizon_ms,
            )?;
        }
        Ok(())
    }

    fn reserve_session_slot(&self) -> Result<(), SessionError> {
        let mut count = self.session_count.load(Ordering::Acquire);
        loop {
            if count >= self.config.max_sessions {
                return Err(SessionError::SessionCapacityExhausted {
                    limit: self.config.max_sessions,
                });
            }
            match self.session_count.compare_exchange_weak(
                count,
                count + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(()),
                Err(actual) => count = actual,
            }
        }
    }

    fn acquire_resources(
        &self,
        profile: ProcessingProfile,
    ) -> Result<SessionResources, SessionError> {
        let (forward, reverse) = profile.codec_pairs()?;
        let forward_permit = self
            .capacity
            .try_acquire(forward)
            .map_err(map_capacity_error)?;
        let reverse_permit = self
            .capacity
            .try_acquire(reverse)
            .map_err(map_capacity_error)?;
        let ports = lock(&self.ports)?
            .allocate_pair()
            .ok_or(SessionError::PortCapacityExhausted)?;
        Ok(SessionResources {
            _forward_permit: forward_permit,
            _reverse_permit: reverse_permit,
            ports,
        })
    }

    fn release_resources(&self, record: &mut SessionRecord) -> Result<(), SessionError> {
        let Some(assigned_ports) = record.resources.as_ref().map(|resources| resources.ports)
        else {
            return Ok(());
        };
        let mut ports = lock(&self.ports)?;
        let resources = record
            .resources
            .take()
            .expect("checked processing resources must exist");
        debug_assert_eq!(resources.ports, assigned_ports);
        ports.release_pair(assigned_ports);
        drop(resources);
        Ok(())
    }

    fn release_uncommitted_resources(
        &self,
        resources: SessionResources,
    ) -> Result<(), SessionError> {
        lock(&self.ports)?.release_pair(resources.ports);
        drop(resources);
        Ok(())
    }

    fn shard_index(&self, media_reservation_id: &str) -> usize {
        self.hash_builder.hash_one(media_reservation_id) as usize & (self.shards.len() - 1)
    }
}

fn validate_config(config: ProcessingSessionRegistryConfig) -> Result<(), SessionError> {
    if config.max_sessions == 0 {
        return Err(SessionError::InvalidConfiguration {
            field: "max_sessions",
        });
    }
    if !(4..=MAX_COMMANDS_PER_SESSION).contains(&config.max_commands_per_session) {
        return Err(SessionError::InvalidConfiguration {
            field: "max_commands_per_session",
        });
    }
    if config.max_lease_horizon_ms == 0 {
        return Err(SessionError::InvalidConfiguration {
            field: "max_lease_horizon_ms",
        });
    }
    if config.shard_count == 0
        || config.shard_count > MAX_SHARDS
        || !config.shard_count.is_power_of_two()
    {
        return Err(SessionError::InvalidConfiguration {
            field: "shard_count",
        });
    }
    Ok(())
}

fn validate_identifier(value: &str, field: &'static str) -> Result<(), SessionError> {
    let valid = !value.is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'@' | b'/' | b'-')
        });
    if valid {
        Ok(())
    } else {
        Err(SessionError::InvalidCommand { field })
    }
}

fn validate_lease(
    expires_at_ms: u64,
    now_ms: u64,
    max_horizon_ms: u64,
) -> Result<(), SessionError> {
    if expires_at_ms <= now_ms {
        return Err(SessionError::LeaseExpired);
    }
    if expires_at_ms > now_ms.saturating_add(max_horizon_ms) {
        return Err(SessionError::LeaseHorizonExceeded);
    }
    Ok(())
}

fn assert_identity(
    record: &SessionRecord,
    command: &ProcessingCommand,
) -> Result<(), SessionError> {
    let identity = &record.identity;
    if identity.tenant_id != command.tenant_id
        || identity.call_id != command.call_id
        || identity.leg_id != command.leg_id
        || identity.cell_id != command.cell_id
        || identity.admission_reservation_id != command.admission_reservation_id
    {
        return Err(SessionError::ReservationIdentityConflict);
    }
    if command.owner_epoch <= record.owner_epoch && record.owner_node_id != command.owner_node_id {
        return Err(if command.owner_epoch < record.owner_epoch {
            SessionError::StaleOwnerEpoch
        } else {
            SessionError::OwnerNodeConflict
        });
    }
    Ok(())
}

fn assert_transition(
    state: ProcessingSessionState,
    action: ProcessingAction,
) -> Result<(), SessionError> {
    let allowed = match action {
        ProcessingAction::Offer => state == ProcessingSessionState::Prepared,
        ProcessingAction::Delete => state.is_active(),
        ProcessingAction::Answer | ProcessingAction::Update | ProcessingAction::Query => {
            state.is_active()
        }
    };
    if allowed {
        Ok(())
    } else {
        Err(SessionError::InvalidTransition)
    }
}

fn replay(
    record: &mut SessionRecord,
    command: &ProcessingCommand,
    maximum: usize,
) -> Result<Option<SessionCommandResult>, SessionError> {
    if let Some(recorded) = record
        .commands
        .iter()
        .find(|candidate| candidate.command_id.as_ref() == command.command_id)
    {
        if recorded.command_hash != command.command_hash {
            return Err(SessionError::CommandPayloadConflict);
        }
        return Ok(Some(project_result(
            record,
            recorded,
            command.command_id.clone(),
            true,
        )));
    }
    if let Some(index) = record
        .commands
        .iter()
        .position(|candidate| candidate.idempotency_key.as_ref() == command.idempotency_key)
    {
        let recorded = &record.commands[index];
        if recorded.idempotency_hash != command.idempotency_hash {
            return Err(SessionError::IdempotencyKeyConflict);
        }
        let result = project_result(record, recorded, command.command_id.clone(), true);
        if recorded.command_id.as_ref() != command.command_id {
            let applied_command_id = recorded
                .applied_command_id
                .as_deref()
                .unwrap_or(&recorded.command_id)
                .to_owned();
            let sequence = recorded.sequence;
            let state = recorded.state;
            let expires_at_ms = recorded.expires_at_ms;
            push_replay_alias(
                record,
                command,
                maximum,
                applied_command_id,
                sequence,
                state,
                expires_at_ms,
            );
        }
        return Ok(Some(result));
    }
    Ok(None)
}

fn push_recorded(record: &mut SessionRecord, command: &ProcessingCommand, maximum: usize) {
    if record.commands.len() >= maximum {
        record.commands.pop_front();
    }
    record.commands.push_back(RecordedCommand {
        command_id: command.command_id.clone().into_boxed_str(),
        applied_command_id: None,
        idempotency_key: command.idempotency_key.clone().into_boxed_str(),
        command_hash: command.command_hash,
        idempotency_hash: command.idempotency_hash,
        sequence: command.command_sequence,
        state: record.state,
        expires_at_ms: command.expires_at_ms,
    });
}

fn push_replay_alias(
    record: &mut SessionRecord,
    command: &ProcessingCommand,
    maximum: usize,
    applied_command_id: String,
    sequence: u32,
    state: ProcessingSessionState,
    expires_at_ms: u64,
) {
    if record.commands.len() >= maximum {
        record.commands.pop_front();
    }
    record.commands.push_back(RecordedCommand {
        command_id: command.command_id.clone().into_boxed_str(),
        applied_command_id: Some(applied_command_id.into_boxed_str()),
        idempotency_key: command.idempotency_key.clone().into_boxed_str(),
        command_hash: command.command_hash,
        idempotency_hash: command.idempotency_hash,
        sequence,
        state,
        expires_at_ms,
    });
}

fn project_result(
    record: &SessionRecord,
    command: &RecordedCommand,
    response_command_id: String,
    replayed: bool,
) -> SessionCommandResult {
    SessionCommandResult {
        response_command_id,
        applied_command_id: command
            .applied_command_id
            .as_deref()
            .unwrap_or(&command.command_id)
            .to_string(),
        replayed,
        snapshot: project_snapshot(
            record,
            command.state,
            command.sequence,
            command.expires_at_ms,
        ),
    }
}

fn project_snapshot(
    record: &SessionRecord,
    state: ProcessingSessionState,
    last_sequence: u32,
    expires_at_ms: u64,
) -> ProcessingSessionSnapshot {
    ProcessingSessionSnapshot {
        media_reservation_id: record.identity.media_reservation_id.clone(),
        admission_reservation_id: record.identity.admission_reservation_id.clone(),
        tenant_id: record.identity.tenant_id.clone(),
        call_id: record.identity.call_id.clone(),
        leg_id: record.identity.leg_id.clone(),
        cell_id: record.identity.cell_id.clone(),
        owner_node_id: record.owner_node_id.clone(),
        owner_epoch: record.owner_epoch,
        last_sequence,
        state,
        profile: record.profile,
        ports: record.assigned_ports,
        resources_active: state.is_active() && record.resources.is_some(),
        expires_at_ms,
    }
}

fn map_capacity_error(error: CapacityError) -> SessionError {
    match error {
        CapacityError::Exhausted { pair, limit } => {
            SessionError::CodecCapacityExhausted { pair, limit }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, SessionError> {
    mutex.lock().map_err(|_| SessionError::RegistryPoisoned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn one_item_scan_pages_advance_across_shards_before_wrapping() {
        let registry = ProcessingSessionRegistry::new(
            ProcessingSessionRegistryConfig {
                max_sessions: 4,
                max_commands_per_session: 8,
                terminal_retention_ms: 100,
                max_lease_horizon_ms: 60_000,
                shard_count: 4,
                rtp_port_start: 30_000,
                rtp_port_end: 30_014,
            },
            Arc::new(CodecPairCapacity::uniform(4)),
        )
        .expect("registry");
        let mut shard_zero = Vec::new();
        let mut shard_one = Vec::new();
        for index in 0..10_000 {
            let candidate = format!("scan-{index}");
            match registry.shard_index(&candidate) {
                0 if shard_zero.len() < 2 => shard_zero.push(candidate),
                1 if shard_one.is_empty() => shard_one.push(candidate),
                _ => {}
            }
            if shard_zero.len() == 2 && shard_one.len() == 1 {
                break;
            }
        }
        assert_eq!(shard_zero.len(), 2);
        assert_eq!(shard_one.len(), 1);
        let reservations = [
            shard_zero[0].clone(),
            shard_zero[1].clone(),
            shard_one[0].clone(),
        ];
        for (index, reservation) in reservations.iter().enumerate() {
            registry
                .execute(
                    ProcessingCommand {
                        action: ProcessingAction::Offer,
                        command_id: format!("command-{index}"),
                        tenant_id: "tenant-a".to_owned(),
                        call_id: format!("call-{index}"),
                        leg_id: "leg-a".to_owned(),
                        cell_id: "cell-a".to_owned(),
                        owner_node_id: "node-a".to_owned(),
                        owner_epoch: 1,
                        admission_reservation_id: format!("admission-{index}"),
                        media_reservation_id: reservation.clone(),
                        command_sequence: 1,
                        idempotency_key: format!("idempotency-{index}"),
                        expires_at_ms: 10_000,
                        command_hash: [index as u8; 32],
                        idempotency_hash: [(index + 16) as u8; 32],
                        profile: Some(ProcessingProfile {
                            leg_a_codec: AudioCodec::Pcmu,
                            leg_b_codec: AudioCodec::Opus,
                            packetization_ms: 20,
                            leg_a_payload_type: 0,
                            leg_b_payload_type: 111,
                        }),
                    },
                    1_000,
                )
                .expect("offer");
        }

        let mut cursor = String::new();
        let mut seen = HashSet::new();
        for _ in 0..reservations.len() {
            let page = registry.scan_active(&cursor, 1).expect("scan");
            assert_eq!(page.items.len(), 1);
            seen.insert(page.items[0].media_reservation_id.clone());
            cursor = page.next_cursor;
        }
        assert_eq!(seen, reservations.into_iter().collect());
    }
}
