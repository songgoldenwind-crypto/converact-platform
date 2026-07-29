use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

pub const PROCESSING_EVENT_PROTOCOL_VERSION: &str = "ivekit.processing-event.v1";

const FRAME_MAGIC: [u8; 4] = *b"IVE1";
const FRAME_HEADER_BYTES: usize = 40;
const ACK_FRAME_RESERVE_BYTES: u64 = 1_024;
const MAX_EVENTS: usize = 10_000_000;
const MAX_JOURNAL_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 4 * 1024 * 1024;
const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_DIGITS: usize = 1_024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event_type", rename_all = "snake_case")]
pub enum ProcessingTerminalEvent {
    PlaybackCompleted {
        prompt_id: String,
    },
    PlaybackStopped {
        prompt_id: String,
        reason: String,
    },
    GatherCompleted {
        digits: String,
        reason: String,
        minimum_satisfied: bool,
    },
}

impl ProcessingTerminalEvent {
    fn identity_kind(&self) -> &'static str {
        match self {
            Self::PlaybackCompleted { .. } => "playback_completed",
            Self::PlaybackStopped { .. } => "playback_stopped",
            Self::GatherCompleted { .. } => "gather_completed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessingTerminalEventInput {
    pub tenant_id: String,
    pub call_id: String,
    pub cell_id: String,
    pub owner_node_id: String,
    pub owner_epoch: String,
    pub media_reservation_id: String,
    pub command_id: String,
    pub occurred_at_ms: u64,
    pub event: ProcessingTerminalEvent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessingEventRecord {
    pub protocol_version: String,
    pub event_sequence: u64,
    pub event_id: String,
    pub tenant_id: String,
    pub call_id: String,
    pub cell_id: String,
    pub owner_node_id: String,
    pub owner_epoch: String,
    pub media_reservation_id: String,
    pub command_id: String,
    pub occurred_at_ms: u64,
    #[serde(flatten)]
    pub event: ProcessingTerminalEvent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventAppendResult {
    pub record: ProcessingEventRecord,
    pub replayed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessingEventScan {
    pub items: Vec<ProcessingEventRecord>,
    pub acknowledged_through: u64,
    pub next_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventReconcileState {
    Pending(ProcessingEventRecord),
    Acknowledged(ProcessingEventRecord),
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessingEventOutboxConfig {
    pub path: PathBuf,
    pub max_pending_events: usize,
    pub max_acknowledged_events: usize,
    pub max_bytes: u64,
    pub max_record_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessingEventOutboxError {
    InvalidConfiguration { field: &'static str },
    InvalidEvent { field: &'static str },
    UnsafePath,
    JournalLocked,
    JournalCorrupt,
    JournalIo,
    JournalPoisoned,
    JournalCapacityExhausted,
    PendingCapacityExhausted,
    EventIdentityConflict,
    AcknowledgementGap,
    AcknowledgementIdentityConflict,
    ScanInvalid,
}

impl Display for ProcessingEventOutboxError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfiguration { field } => {
                write!(
                    formatter,
                    "invalid processing event outbox configuration: {field}"
                )
            }
            Self::InvalidEvent { field } => {
                write!(formatter, "invalid processing terminal event: {field}")
            }
            Self::UnsafePath => formatter.write_str("processing event outbox path is unsafe"),
            Self::JournalLocked => formatter.write_str("processing event outbox is locked"),
            Self::JournalCorrupt => formatter.write_str("processing event outbox is corrupt"),
            Self::JournalIo => formatter.write_str("processing event outbox I/O failed"),
            Self::JournalPoisoned => formatter.write_str("processing event outbox lock poisoned"),
            Self::JournalCapacityExhausted => {
                formatter.write_str("processing event outbox byte capacity exhausted")
            }
            Self::PendingCapacityExhausted => {
                formatter.write_str("processing event outbox pending capacity exhausted")
            }
            Self::EventIdentityConflict => {
                formatter.write_str("processing event identity payload conflict")
            }
            Self::AcknowledgementGap => formatter.write_str("processing event acknowledgement gap"),
            Self::AcknowledgementIdentityConflict => {
                formatter.write_str("processing event acknowledgement identity conflict")
            }
            Self::ScanInvalid => formatter.write_str("processing event scan is invalid"),
        }
    }
}

impl Error for ProcessingEventOutboxError {}

pub struct ProcessingEventOutbox {
    config: ProcessingEventOutboxConfig,
    lock: File,
    inner: Mutex<OutboxState>,
}

struct OutboxState {
    file: File,
    records: VecDeque<ProcessingEventRecord>,
    next_sequence: u64,
    acknowledged_through: u64,
    bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "frame", rename_all = "snake_case")]
enum JournalFrame {
    Checkpoint {
        next_sequence: u64,
        acknowledged_through: u64,
    },
    Event {
        record: ProcessingEventRecord,
    },
    Acknowledge {
        event_sequence: u64,
        event_id: String,
    },
}

impl ProcessingEventOutbox {
    pub fn open(config: ProcessingEventOutboxConfig) -> Result<Self, ProcessingEventOutboxError> {
        validate_config(&config)?;
        let parent = config
            .path
            .parent()
            .ok_or(ProcessingEventOutboxError::UnsafePath)?;
        assert_safe_directory(parent)?;
        assert_safe_target(&config.path)?;
        let lock_path = PathBuf::from(format!("{}.lock", config.path.display()));
        assert_safe_target(&lock_path)?;
        let lock = open_file(&lock_path)?;
        lock.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => ProcessingEventOutboxError::JournalLocked,
            TryLockError::Error(_) => ProcessingEventOutboxError::JournalIo,
        })?;
        let mut file = open_file(&config.path)?;
        let metadata = file
            .metadata()
            .map_err(|_| ProcessingEventOutboxError::JournalIo)?;
        if !metadata.is_file() || metadata.len() > config.max_bytes {
            return Err(if metadata.is_file() {
                ProcessingEventOutboxError::JournalCapacityExhausted
            } else {
                ProcessingEventOutboxError::UnsafePath
            });
        }
        let replay = replay_journal(&mut file, &config)?;
        Ok(Self {
            config,
            lock,
            inner: Mutex::new(OutboxState {
                file,
                records: replay.records,
                next_sequence: replay.next_sequence,
                acknowledged_through: replay.acknowledged_through,
                bytes: replay.bytes,
            }),
        })
    }

    pub fn append(
        &self,
        input: ProcessingTerminalEventInput,
    ) -> Result<EventAppendResult, ProcessingEventOutboxError> {
        validate_event(&input)?;
        let event_id = event_id(&input);
        let mut state = self.lock_state()?;
        if let Some(existing) = state
            .records
            .iter()
            .find(|record| record.event_id == event_id)
        {
            if same_event(existing, &input) {
                return Ok(EventAppendResult {
                    record: existing.clone(),
                    replayed: true,
                });
            }
            return Err(ProcessingEventOutboxError::EventIdentityConflict);
        }
        if pending_count(&state) >= self.config.max_pending_events {
            return Err(ProcessingEventOutboxError::PendingCapacityExhausted);
        }
        let record = ProcessingEventRecord {
            protocol_version: PROCESSING_EVENT_PROTOCOL_VERSION.to_owned(),
            event_sequence: state.next_sequence,
            event_id,
            tenant_id: input.tenant_id,
            call_id: input.call_id,
            cell_id: input.cell_id,
            owner_node_id: input.owner_node_id,
            owner_epoch: input.owner_epoch,
            media_reservation_id: input.media_reservation_id,
            command_id: input.command_id,
            occurred_at_ms: input.occurred_at_ms,
            event: input.event,
        };
        let frame = encode_frame(
            &JournalFrame::Event {
                record: record.clone(),
            },
            self.config.max_record_bytes,
        )?;
        append_frame(&mut state, &frame, self.config.max_bytes, true)?;
        state.next_sequence = state
            .next_sequence
            .checked_add(1)
            .ok_or(ProcessingEventOutboxError::JournalCapacityExhausted)?;
        state.records.push_back(record.clone());
        Ok(EventAppendResult {
            record,
            replayed: false,
        })
    }

    pub fn acknowledge(
        &self,
        event_sequence: u64,
        event_id: &str,
    ) -> Result<(), ProcessingEventOutboxError> {
        let mut state = self.lock_state()?;
        if event_sequence <= state.acknowledged_through {
            match state
                .records
                .iter()
                .find(|record| record.event_sequence == event_sequence)
            {
                Some(record) if record.event_id == event_id => {
                    compact_if_needed(&mut state, &self.config)?;
                    return Ok(());
                }
                _ => {
                    return Err(ProcessingEventOutboxError::AcknowledgementIdentityConflict);
                }
            }
        }
        if event_sequence != state.acknowledged_through.saturating_add(1) {
            return Err(ProcessingEventOutboxError::AcknowledgementGap);
        }
        let expected = state
            .records
            .iter()
            .find(|record| record.event_sequence == event_sequence)
            .ok_or(ProcessingEventOutboxError::AcknowledgementGap)?;
        if expected.event_id != event_id {
            return Err(ProcessingEventOutboxError::AcknowledgementIdentityConflict);
        }
        let frame = encode_frame(
            &JournalFrame::Acknowledge {
                event_sequence,
                event_id: event_id.to_owned(),
            },
            self.config.max_record_bytes,
        )?;
        append_frame(&mut state, &frame, self.config.max_bytes, false)?;
        state.acknowledged_through = event_sequence;
        compact_if_needed(&mut state, &self.config)
    }

    pub fn scan(
        &self,
        after_sequence: u64,
        limit: usize,
    ) -> Result<ProcessingEventScan, ProcessingEventOutboxError> {
        if limit == 0 || limit > 10_000 {
            return Err(ProcessingEventOutboxError::ScanInvalid);
        }
        let state = self.lock_state()?;
        if after_sequence >= state.next_sequence && after_sequence != 0 {
            return Err(ProcessingEventOutboxError::ScanInvalid);
        }
        let floor = after_sequence.max(state.acknowledged_through);
        Ok(ProcessingEventScan {
            items: state
                .records
                .iter()
                .filter(|record| record.event_sequence > floor)
                .take(limit)
                .cloned()
                .collect(),
            acknowledged_through: state.acknowledged_through,
            next_sequence: state.next_sequence,
        })
    }

    pub fn reconcile(
        &self,
        event_id: &str,
    ) -> Result<EventReconcileState, ProcessingEventOutboxError> {
        if !valid_identifier(event_id) {
            return Err(ProcessingEventOutboxError::InvalidEvent { field: "event_id" });
        }
        let state = self.lock_state()?;
        Ok(
            match state
                .records
                .iter()
                .find(|record| record.event_id == event_id)
            {
                Some(record) if record.event_sequence <= state.acknowledged_through => {
                    EventReconcileState::Acknowledged(record.clone())
                }
                Some(record) => EventReconcileState::Pending(record.clone()),
                None => EventReconcileState::NotFound,
            },
        )
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, OutboxState>, ProcessingEventOutboxError> {
        self.inner
            .lock()
            .map_err(|_| ProcessingEventOutboxError::JournalPoisoned)
    }
}

impl Drop for ProcessingEventOutbox {
    fn drop(&mut self) {
        let _ = self.lock.unlock();
    }
}

struct ReplayState {
    records: VecDeque<ProcessingEventRecord>,
    next_sequence: u64,
    acknowledged_through: u64,
    bytes: u64,
    checkpoint_seen: bool,
}

fn replay_journal(
    file: &mut File,
    config: &ProcessingEventOutboxConfig,
) -> Result<ReplayState, ProcessingEventOutboxError> {
    file.seek(SeekFrom::Start(0))
        .map_err(|_| ProcessingEventOutboxError::JournalIo)?;
    let mut state = ReplayState {
        records: VecDeque::new(),
        next_sequence: 1,
        acknowledged_through: 0,
        bytes: 0,
        checkpoint_seen: false,
    };
    loop {
        let frame_start = state.bytes;
        let Some(header) = read_header(file, frame_start)? else {
            break;
        };
        if header[..4] != FRAME_MAGIC {
            return Err(ProcessingEventOutboxError::JournalCorrupt);
        }
        let length = u32::from_be_bytes(
            header[4..8]
                .try_into()
                .map_err(|_| ProcessingEventOutboxError::JournalCorrupt)?,
        ) as usize;
        if length == 0 || length > config.max_record_bytes {
            return Err(ProcessingEventOutboxError::JournalCorrupt);
        }
        let mut payload = vec![0_u8; length];
        if let Err(error) = file.read_exact(&mut payload) {
            if error.kind() == ErrorKind::UnexpectedEof {
                truncate_tail(file, frame_start)?;
                state.bytes = frame_start;
                break;
            }
            return Err(ProcessingEventOutboxError::JournalIo);
        }
        if Sha256::digest(&payload).as_slice() != &header[8..40] {
            return Err(ProcessingEventOutboxError::JournalCorrupt);
        }
        let frame: JournalFrame = serde_json::from_slice(&payload)
            .map_err(|_| ProcessingEventOutboxError::JournalCorrupt)?;
        state.bytes = state
            .bytes
            .checked_add(FRAME_HEADER_BYTES as u64 + length as u64)
            .ok_or(ProcessingEventOutboxError::JournalCorrupt)?;
        apply_replayed_frame(&mut state, frame)?;
    }
    validate_replayed_state(&state, config)?;
    file.seek(SeekFrom::End(0))
        .map_err(|_| ProcessingEventOutboxError::JournalIo)?;
    Ok(state)
}

fn read_header(
    file: &mut File,
    frame_start: u64,
) -> Result<Option<[u8; FRAME_HEADER_BYTES]>, ProcessingEventOutboxError> {
    let mut header = [0_u8; FRAME_HEADER_BYTES];
    let read = file
        .read(&mut header[..1])
        .map_err(|_| ProcessingEventOutboxError::JournalIo)?;
    if read == 0 {
        return Ok(None);
    }
    if let Err(error) = file.read_exact(&mut header[1..]) {
        if error.kind() == ErrorKind::UnexpectedEof {
            truncate_tail(file, frame_start)?;
            return Ok(None);
        }
        return Err(ProcessingEventOutboxError::JournalIo);
    }
    Ok(Some(header))
}

fn apply_replayed_frame(
    state: &mut ReplayState,
    frame: JournalFrame,
) -> Result<(), ProcessingEventOutboxError> {
    match frame {
        JournalFrame::Checkpoint {
            next_sequence,
            acknowledged_through,
        } => {
            if state.checkpoint_seen
                || !state.records.is_empty()
                || state.next_sequence != 1
                || state.acknowledged_through != 0
                || next_sequence == 0
                || acknowledged_through >= next_sequence
            {
                return Err(ProcessingEventOutboxError::JournalCorrupt);
            }
            state.next_sequence = next_sequence;
            state.acknowledged_through = acknowledged_through;
            state.checkpoint_seen = true;
        }
        JournalFrame::Event { record } => {
            validate_record(&record)?;
            if record.event_sequence > state.next_sequence
                || record.event_sequence == 0
                || state
                    .records
                    .back()
                    .is_some_and(|previous| previous.event_sequence >= record.event_sequence)
            {
                return Err(ProcessingEventOutboxError::JournalCorrupt);
            }
            if record.event_sequence == state.next_sequence {
                state.next_sequence = state
                    .next_sequence
                    .checked_add(1)
                    .ok_or(ProcessingEventOutboxError::JournalCorrupt)?;
            } else if !state.checkpoint_seen {
                return Err(ProcessingEventOutboxError::JournalCorrupt);
            }
            state.records.push_back(record);
        }
        JournalFrame::Acknowledge {
            event_sequence,
            event_id,
        } => {
            if event_sequence != state.acknowledged_through.saturating_add(1) {
                return Err(ProcessingEventOutboxError::JournalCorrupt);
            }
            let record = state
                .records
                .iter()
                .find(|record| record.event_sequence == event_sequence)
                .ok_or(ProcessingEventOutboxError::JournalCorrupt)?;
            if record.event_id != event_id {
                return Err(ProcessingEventOutboxError::JournalCorrupt);
            }
            state.acknowledged_through = event_sequence;
        }
    }
    Ok(())
}

fn validate_replayed_state(
    state: &ReplayState,
    config: &ProcessingEventOutboxConfig,
) -> Result<(), ProcessingEventOutboxError> {
    if state.bytes > config.max_bytes
        || state
            .records
            .iter()
            .filter(|record| record.event_sequence > state.acknowledged_through)
            .count()
            > config.max_pending_events
    {
        return Err(ProcessingEventOutboxError::JournalCapacityExhausted);
    }
    let pending = state
        .records
        .iter()
        .filter(|record| record.event_sequence > state.acknowledged_through)
        .collect::<Vec<_>>();
    let expected_pending = state
        .next_sequence
        .saturating_sub(state.acknowledged_through.saturating_add(1));
    if pending.len() as u64 != expected_pending
        || pending.first().is_some_and(|record| {
            record.event_sequence != state.acknowledged_through.saturating_add(1)
        })
        || pending
            .last()
            .is_some_and(|record| record.event_sequence != state.next_sequence.saturating_sub(1))
    {
        return Err(ProcessingEventOutboxError::JournalCorrupt);
    }
    Ok(())
}

fn encode_frame(
    frame: &JournalFrame,
    max_record_bytes: usize,
) -> Result<Vec<u8>, ProcessingEventOutboxError> {
    let payload = serde_json::to_vec(frame).map_err(|_| ProcessingEventOutboxError::JournalIo)?;
    if payload.is_empty() || payload.len() > max_record_bytes || payload.len() > u32::MAX as usize {
        return Err(ProcessingEventOutboxError::JournalCapacityExhausted);
    }
    let mut encoded = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
    encoded.extend_from_slice(&FRAME_MAGIC);
    encoded.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    encoded.extend_from_slice(&Sha256::digest(&payload));
    encoded.extend_from_slice(&payload);
    Ok(encoded)
}

fn append_frame(
    state: &mut OutboxState,
    frame: &[u8],
    maximum_bytes: u64,
    reserve_ack_frame: bool,
) -> Result<(), ProcessingEventOutboxError> {
    let next_bytes = state
        .bytes
        .checked_add(frame.len() as u64)
        .ok_or(ProcessingEventOutboxError::JournalCapacityExhausted)?;
    let reserve = if reserve_ack_frame {
        ACK_FRAME_RESERVE_BYTES
    } else {
        0
    };
    if next_bytes.saturating_add(reserve) > maximum_bytes {
        return Err(ProcessingEventOutboxError::JournalCapacityExhausted);
    }
    let previous_bytes = state.bytes;
    if let Err(error) = state
        .file
        .write_all(frame)
        .and_then(|_| state.file.sync_data())
    {
        let _ = state.file.set_len(previous_bytes);
        let _ = state.file.sync_data();
        return Err(if error.kind() == ErrorKind::WriteZero {
            ProcessingEventOutboxError::JournalCapacityExhausted
        } else {
            ProcessingEventOutboxError::JournalIo
        });
    }
    state.bytes = next_bytes;
    Ok(())
}

fn compact_if_needed(
    state: &mut OutboxState,
    config: &ProcessingEventOutboxConfig,
) -> Result<(), ProcessingEventOutboxError> {
    let acknowledged = state
        .records
        .iter()
        .filter(|record| record.event_sequence <= state.acknowledged_through)
        .count();
    if acknowledged <= config.max_acknowledged_events.saturating_mul(2) {
        return Ok(());
    }
    let retained_acknowledged = state
        .records
        .iter()
        .filter(|record| record.event_sequence <= state.acknowledged_through)
        .rev()
        .take(config.max_acknowledged_events)
        .cloned()
        .collect::<Vec<_>>();
    let mut retained = retained_acknowledged
        .into_iter()
        .rev()
        .collect::<VecDeque<_>>();
    retained.extend(
        state
            .records
            .iter()
            .filter(|record| record.event_sequence > state.acknowledged_through)
            .cloned(),
    );

    let mut frames = vec![encode_frame(
        &JournalFrame::Checkpoint {
            next_sequence: state.next_sequence,
            acknowledged_through: state.acknowledged_through,
        },
        config.max_record_bytes,
    )?];
    for record in &retained {
        frames.push(encode_frame(
            &JournalFrame::Event {
                record: record.clone(),
            },
            config.max_record_bytes,
        )?);
    }
    let compacted_bytes = frames
        .iter()
        .try_fold(0_u64, |total, frame| total.checked_add(frame.len() as u64))
        .ok_or(ProcessingEventOutboxError::JournalCapacityExhausted)?;
    if compacted_bytes.saturating_add(ACK_FRAME_RESERVE_BYTES) > config.max_bytes {
        return Err(ProcessingEventOutboxError::JournalCapacityExhausted);
    }

    let temporary_path = config.path.with_file_name(format!(
        ".{}.{}.{}.tmp",
        config
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(ProcessingEventOutboxError::UnsafePath)?,
        std::process::id(),
        rand::random::<u64>()
    ));
    let replacement = write_compacted_file(&temporary_path, &frames);
    if let Err(error) = replacement {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temporary_path, &config.path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(if error.kind() == ErrorKind::PermissionDenied {
            ProcessingEventOutboxError::UnsafePath
        } else {
            ProcessingEventOutboxError::JournalIo
        });
    }
    sync_directory(&config.path)?;
    let file = open_file(&config.path)?;
    state.file = file;
    state.records = retained;
    state.bytes = compacted_bytes;
    Ok(())
}

fn write_compacted_file(path: &Path, frames: &[Vec<u8>]) -> Result<(), ProcessingEventOutboxError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| ProcessingEventOutboxError::JournalIo)?;
    for frame in frames {
        file.write_all(frame)
            .map_err(|_| ProcessingEventOutboxError::JournalIo)?;
    }
    file.sync_all()
        .map_err(|_| ProcessingEventOutboxError::JournalIo)
}

fn truncate_tail(file: &mut File, length: u64) -> Result<(), ProcessingEventOutboxError> {
    file.set_len(length)
        .and_then(|_| file.sync_data())
        .map_err(|_| ProcessingEventOutboxError::JournalIo)?;
    file.seek(SeekFrom::Start(length))
        .map_err(|_| ProcessingEventOutboxError::JournalIo)?;
    Ok(())
}

fn pending_count(state: &OutboxState) -> usize {
    state
        .records
        .iter()
        .filter(|record| record.event_sequence > state.acknowledged_through)
        .count()
}

fn event_id(input: &ProcessingTerminalEventInput) -> String {
    let mut digest = Sha256::new();
    for value in [
        PROCESSING_EVENT_PROTOCOL_VERSION,
        input.media_reservation_id.as_str(),
        input.command_id.as_str(),
        input.event.identity_kind(),
    ] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value.as_bytes());
    }
    let hash = digest.finalize();
    let mut encoded = String::with_capacity(17 + 48);
    encoded.push_str("processing-event-");
    for byte in &hash[..24] {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("write to string");
    }
    encoded
}

fn same_event(record: &ProcessingEventRecord, input: &ProcessingTerminalEventInput) -> bool {
    record.protocol_version == PROCESSING_EVENT_PROTOCOL_VERSION
        && record.tenant_id == input.tenant_id
        && record.call_id == input.call_id
        && record.cell_id == input.cell_id
        && record.owner_node_id == input.owner_node_id
        && record.owner_epoch == input.owner_epoch
        && record.media_reservation_id == input.media_reservation_id
        && record.command_id == input.command_id
        && record.event == input.event
}

fn validate_config(config: &ProcessingEventOutboxConfig) -> Result<(), ProcessingEventOutboxError> {
    if !config.path.is_absolute() {
        return Err(ProcessingEventOutboxError::InvalidConfiguration { field: "path" });
    }
    if config.max_pending_events == 0 || config.max_pending_events > MAX_EVENTS {
        return Err(ProcessingEventOutboxError::InvalidConfiguration {
            field: "max_pending_events",
        });
    }
    if config.max_acknowledged_events == 0 || config.max_acknowledged_events > MAX_EVENTS {
        return Err(ProcessingEventOutboxError::InvalidConfiguration {
            field: "max_acknowledged_events",
        });
    }
    if config.max_bytes < 4_096 || config.max_bytes > MAX_JOURNAL_BYTES {
        return Err(ProcessingEventOutboxError::InvalidConfiguration { field: "max_bytes" });
    }
    if config.max_record_bytes < 256
        || config.max_record_bytes > MAX_RECORD_BYTES
        || config.max_record_bytes as u64 + FRAME_HEADER_BYTES as u64 + ACK_FRAME_RESERVE_BYTES
            > config.max_bytes
    {
        return Err(ProcessingEventOutboxError::InvalidConfiguration {
            field: "max_record_bytes",
        });
    }
    Ok(())
}

fn validate_event(input: &ProcessingTerminalEventInput) -> Result<(), ProcessingEventOutboxError> {
    for (field, value) in [
        ("tenant_id", input.tenant_id.as_str()),
        ("call_id", input.call_id.as_str()),
        ("cell_id", input.cell_id.as_str()),
        ("owner_node_id", input.owner_node_id.as_str()),
        ("media_reservation_id", input.media_reservation_id.as_str()),
        ("command_id", input.command_id.as_str()),
    ] {
        if !valid_identifier(value) {
            return Err(ProcessingEventOutboxError::InvalidEvent { field });
        }
    }
    if input
        .owner_epoch
        .parse::<u64>()
        .ok()
        .filter(|epoch| *epoch > 0)
        .is_none()
    {
        return Err(ProcessingEventOutboxError::InvalidEvent {
            field: "owner_epoch",
        });
    }
    if input.occurred_at_ms == 0 {
        return Err(ProcessingEventOutboxError::InvalidEvent {
            field: "occurred_at_ms",
        });
    }
    validate_terminal_event(&input.event)
}

fn validate_record(record: &ProcessingEventRecord) -> Result<(), ProcessingEventOutboxError> {
    let input = ProcessingTerminalEventInput {
        tenant_id: record.tenant_id.clone(),
        call_id: record.call_id.clone(),
        cell_id: record.cell_id.clone(),
        owner_node_id: record.owner_node_id.clone(),
        owner_epoch: record.owner_epoch.clone(),
        media_reservation_id: record.media_reservation_id.clone(),
        command_id: record.command_id.clone(),
        occurred_at_ms: record.occurred_at_ms,
        event: record.event.clone(),
    };
    if record.protocol_version != PROCESSING_EVENT_PROTOCOL_VERSION
        || record.event_sequence == 0
        || record.event_id != event_id(&input)
    {
        return Err(ProcessingEventOutboxError::JournalCorrupt);
    }
    validate_event(&input).map_err(|_| ProcessingEventOutboxError::JournalCorrupt)
}

fn validate_terminal_event(
    event: &ProcessingTerminalEvent,
) -> Result<(), ProcessingEventOutboxError> {
    match event {
        ProcessingTerminalEvent::PlaybackCompleted { prompt_id } => {
            require_identifier(prompt_id, "prompt_id")
        }
        ProcessingTerminalEvent::PlaybackStopped { prompt_id, reason } => {
            require_identifier(prompt_id, "prompt_id")?;
            if !matches!(reason.as_str(), "explicit" | "barge_in" | "session_removed") {
                return Err(ProcessingEventOutboxError::InvalidEvent {
                    field: "playback_stop_reason",
                });
            }
            Ok(())
        }
        ProcessingTerminalEvent::GatherCompleted { digits, reason, .. } => {
            if digits.len() > MAX_DIGITS
                || !digits
                    .chars()
                    .all(|digit| matches!(digit, '0'..='9' | '*' | '#' | 'A'..='D'))
            {
                return Err(ProcessingEventOutboxError::InvalidEvent { field: "digits" });
            }
            if !matches!(
                reason.as_str(),
                "maximum_digits" | "terminator" | "timeout" | "explicit_stop" | "session_removed"
            ) {
                return Err(ProcessingEventOutboxError::InvalidEvent {
                    field: "gather_completion_reason",
                });
            }
            Ok(())
        }
    }
}

fn require_identifier(value: &str, field: &'static str) -> Result<(), ProcessingEventOutboxError> {
    if valid_identifier(value) {
        Ok(())
    } else {
        Err(ProcessingEventOutboxError::InvalidEvent { field })
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'@' | b'/' | b'-')
        })
}

fn assert_safe_directory(path: &Path) -> Result<(), ProcessingEventOutboxError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| ProcessingEventOutboxError::UnsafePath)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ProcessingEventOutboxError::UnsafePath);
    }
    Ok(())
}

fn assert_safe_target(path: &Path) -> Result<(), ProcessingEventOutboxError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(ProcessingEventOutboxError::UnsafePath)
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(_) => Err(ProcessingEventOutboxError::JournalIo),
    }
}

fn open_file(path: &Path) -> Result<File, ProcessingEventOutboxError> {
    let existed = path.exists();
    let file = OpenOptions::new()
        .read(true)
        .append(true)
        .create(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| ProcessingEventOutboxError::JournalIo)?;
    let metadata = file
        .metadata()
        .map_err(|_| ProcessingEventOutboxError::JournalIo)?;
    let target = fs::metadata(path).map_err(|_| ProcessingEventOutboxError::JournalIo)?;
    if !metadata.is_file()
        || metadata.dev() != target.dev()
        || metadata.ino() != target.ino()
        || target.permissions().mode() & 0o077 != 0
    {
        return Err(ProcessingEventOutboxError::UnsafePath);
    }
    if !existed {
        file.sync_all()
            .map_err(|_| ProcessingEventOutboxError::JournalIo)?;
        sync_directory(path)?;
    }
    Ok(file)
}

fn sync_directory(path: &Path) -> Result<(), ProcessingEventOutboxError> {
    File::open(
        path.parent()
            .ok_or(ProcessingEventOutboxError::UnsafePath)?,
    )
    .and_then(|directory| directory.sync_all())
    .map_err(|_| ProcessingEventOutboxError::JournalIo)
}
