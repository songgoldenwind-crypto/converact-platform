use crate::capacity::{CapacityError, CodecPairCapacity, CodecPairPermit};
use crate::codec::{AudioCodec, CodecPair};
use std::collections::{hash_map::RandomState, HashMap, VecDeque};
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
        if start > end || start % 2 != 0 || end % 2 != 0 {
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
        self.validate_command(&command, now_ms)?;
        let shard_index = self.shard_index(&command.media_reservation_id);
        let mut shard = lock(&self.shards[shard_index])?;

        if let Some(record) = shard.records.get_mut(&command.media_reservation_id) {
            return self.execute_existing(record, command, now_ms);
        }
        self.execute_new(&mut shard, command)
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
        if limit == 0 {
            return Err(SessionError::InvalidCommand {
                field: "sweep_limit",
            });
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
                    self.release_resources(record)?;
                    record.state = ProcessingSessionState::Expired;
                    record.terminal_at_ms = now_ms;
                    self.active_session_count.fetch_sub(1, Ordering::AcqRel);
                    report.expired += 1;
                } else if record.state.is_terminal()
                    && now_ms.saturating_sub(record.terminal_at_ms)
                        >= self.config.terminal_retention_ms
                {
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

    fn execute_new(
        &self,
        shard: &mut SessionShard,
        command: ProcessingCommand,
    ) -> Result<SessionCommandResult, SessionError> {
        if command.action != ProcessingAction::Offer {
            return Err(SessionError::SessionNotFound);
        }
        if command.command_sequence != 1 {
            return Err(SessionError::SequenceGap {
                expected: 1,
                actual: command.command_sequence,
            });
        }
        let profile = command.profile.ok_or(SessionError::InvalidProfile)?;
        profile.codec_pairs()?;
        self.reserve_session_slot()?;
        let resources = match self.acquire_resources(profile) {
            Ok(resources) => resources,
            Err(error) => {
                self.session_count.fetch_sub(1, Ordering::AcqRel);
                return Err(error);
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

    fn execute_existing(
        &self,
        record: &mut SessionRecord,
        command: ProcessingCommand,
        now_ms: u64,
    ) -> Result<SessionCommandResult, SessionError> {
        assert_identity(record, &command)?;
        if command.owner_epoch < record.owner_epoch {
            return Err(SessionError::StaleOwnerEpoch);
        }
        if command.owner_epoch == record.owner_epoch {
            if let Some(result) = replay(record, &command)? {
                return Ok(result);
            }
        } else {
            if command.command_sequence != 1 {
                return Err(SessionError::OwnerTakeoverSequenceInvalid);
            }
            record.owner_epoch = command.owner_epoch;
            record.owner_node_id = command.owner_node_id.clone();
            record.last_sequence = 0;
            record.commands.clear();
        }

        if command.action != ProcessingAction::Delete {
            validate_lease(
                command.expires_at_ms,
                now_ms,
                self.config.max_lease_horizon_ms,
            )?;
        }
        let expected = record.last_sequence.saturating_add(1);
        if command.command_sequence <= record.last_sequence {
            return Err(SessionError::StaleSequence);
        }
        if command.command_sequence != expected {
            return Err(SessionError::SequenceGap {
                expected,
                actual: command.command_sequence,
            });
        }
        assert_transition(record.state, command.action)?;
        match command.action {
            ProcessingAction::Offer => {
                if command.profile != Some(record.profile) {
                    return Err(SessionError::InvalidProfile);
                }
                record.state = ProcessingSessionState::Prepared;
            }
            ProcessingAction::Answer => {
                record.state = ProcessingSessionState::Committed;
            }
            ProcessingAction::Update | ProcessingAction::Query => {}
            ProcessingAction::Delete => {
                self.release_resources(record)?;
                record.state = ProcessingSessionState::Closed;
                record.terminal_at_ms = now_ms;
                self.active_session_count.fetch_sub(1, Ordering::AcqRel);
            }
        }
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
    record: &SessionRecord,
    command: &ProcessingCommand,
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
    if let Some(recorded) = record
        .commands
        .iter()
        .find(|candidate| candidate.idempotency_key.as_ref() == command.idempotency_key)
    {
        if recorded.idempotency_hash != command.idempotency_hash {
            return Err(SessionError::IdempotencyKeyConflict);
        }
        return Ok(Some(project_result(
            record,
            recorded,
            command.command_id.clone(),
            true,
        )));
    }
    Ok(None)
}

fn push_recorded(record: &mut SessionRecord, command: &ProcessingCommand, maximum: usize) {
    if record.commands.len() >= maximum {
        record.commands.pop_front();
    }
    record.commands.push_back(RecordedCommand {
        command_id: command.command_id.clone().into_boxed_str(),
        idempotency_key: command.idempotency_key.clone().into_boxed_str(),
        command_hash: command.command_hash,
        idempotency_hash: command.idempotency_hash,
        sequence: command.command_sequence,
        state: record.state,
        expires_at_ms: command.expires_at_ms,
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
        applied_command_id: command.command_id.to_string(),
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
