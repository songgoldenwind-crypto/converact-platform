use crate::capacity::CodecPairCapacity;
use crate::codec::AudioCodec;
use crate::event_outbox::{
    EventAppendResult, ProcessingEventOutbox, ProcessingEventOutboxError, ProcessingTerminalEvent,
    ProcessingTerminalEventInput,
};
use crate::ivr::{GatherCompletionReason, IvrEvent, PlaybackStopReason};
use crate::rtp::{ProcessingLeg, RtpSessionConfig, TelephoneEventConfig};
use crate::session::{
    ProcessingAction, ProcessingCommand, ProcessingProfile, ProcessingSessionRegistry,
    ProcessingSessionRegistryConfig, ProcessingSessionSnapshot, ReconcileCommand, SessionError,
    SessionExecutionError, SessionSweepError, SweepAction, SweepReport,
};
use crate::worker::{
    RtpWorkerPool, RtpWorkerPoolConfig, RtpWorkerPoolSnapshot, WorkerError, WorkerEvent,
    WorkerGatherRequest, WorkerPlaybackRequest,
};
use rand::{rngs::OsRng, RngCore};
use rustrtc::{AddressType, Attribute, MediaKind, SdpType, SessionDescription};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

const MAX_SDP_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessingRuntimeConfig {
    pub bind_ip: IpAddr,
    pub advertised_ip: IpAddr,
    pub registry: ProcessingSessionRegistryConfig,
    pub workers: RtpWorkerPoolConfig,
    pub jitter_capacity: usize,
    pub jitter_wait_depth: usize,
    pub max_drain_per_datagram: usize,
    pub max_conceal_frames: u16,
    pub source_rebind_after_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NegotiationRole {
    Offer,
    Answer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessingRuntimeOperation {
    Offer {
        sdp: String,
    },
    Answer {
        sdp: String,
    },
    CommitSingleLeg,
    Update {
        role: NegotiationRole,
        sdp: String,
    },
    PlayMedia {
        prompt_id: String,
        egress_leg: ProcessingLeg,
        barge_in: bool,
    },
    StopMedia {
        target_command_id: String,
    },
    StartGather {
        minimum_digits: usize,
        maximum_digits: usize,
        terminator: Option<char>,
        first_digit_timeout_ms: u64,
        inter_digit_timeout_ms: u64,
    },
    StopGather {
        target_command_id: String,
    },
    SipInfoDigit {
        event_id: String,
        digit: char,
    },
    Delete,
    Query,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessingRuntimeCommand {
    pub command: ProcessingCommand,
    pub operation: ProcessingRuntimeOperation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessingRuntimeSnapshot {
    pub session: ProcessingSessionSnapshot,
    pub transport_session_id: String,
    pub effective_sdp: String,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessingRuntimeResult {
    pub response_command_id: String,
    pub applied_command_id: String,
    pub replayed: bool,
    pub snapshot: ProcessingRuntimeSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessingPromptSnapshot {
    pub prompt_id: String,
    pub canonical_sample_rate_hz: u32,
    pub frame_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessingRuntimeOrphanCandidate {
    pub session: ProcessingSessionSnapshot,
    pub transport_session_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProcessingRuntimeScanResult {
    pub inspected: usize,
    pub items: Vec<ProcessingRuntimeOrphanCandidate>,
    pub next_cursor: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessingRuntimeError {
    InvalidConfiguration { field: &'static str },
    InvalidOperation,
    InvalidSdp,
    UnsupportedSdp,
    Session(SessionError),
    Worker(WorkerError),
    RuntimeStatePoisoned,
    RuntimeStateMissing,
    RuntimeStateConflict,
}

impl ProcessingRuntimeError {
    pub const fn retryable(self) -> bool {
        match self {
            Self::Session(error) => error.retryable(),
            Self::Worker(
                WorkerError::SessionCapacityExhausted { .. }
                | WorkerError::DatagramRetentionCapacityExhausted { .. }
                | WorkerError::CommandQueueFull
                | WorkerError::WorkerUnavailable
                | WorkerError::ControlTimeout
                | WorkerError::WorkerStartFailed
                | WorkerError::SnapshotUnavailable,
            ) => true,
            _ => false,
        }
    }
}

impl Display for ProcessingRuntimeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfiguration { field } => {
                write!(
                    formatter,
                    "invalid processing runtime configuration: {field}"
                )
            }
            Self::InvalidOperation => formatter.write_str("invalid processing runtime operation"),
            Self::InvalidSdp => formatter.write_str("invalid processing SDP"),
            Self::UnsupportedSdp => formatter.write_str("unsupported processing SDP"),
            Self::Session(error) => Display::fmt(error, formatter),
            Self::Worker(error) => Display::fmt(error, formatter),
            Self::RuntimeStatePoisoned => {
                formatter.write_str("processing runtime state lock poisoned")
            }
            Self::RuntimeStateMissing => formatter.write_str("processing runtime state missing"),
            Self::RuntimeStateConflict => formatter.write_str("processing runtime state conflict"),
        }
    }
}

impl Error for ProcessingRuntimeError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessingEventHandoffError {
    Runtime(ProcessingRuntimeError),
    Outbox(ProcessingEventOutboxError),
}

impl Display for ProcessingEventHandoffError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Runtime(error) => Display::fmt(error, formatter),
            Self::Outbox(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for ProcessingEventHandoffError {}

impl From<SessionError> for ProcessingRuntimeError {
    fn from(value: SessionError) -> Self {
        Self::Session(value)
    }
}

impl From<WorkerError> for ProcessingRuntimeError {
    fn from(value: WorkerError) -> Self {
        Self::Worker(value)
    }
}

struct RuntimeCommandRecord {
    command_id: Box<str>,
    effective_sdp: Box<str>,
    updated_at_ms: u64,
}

struct RuntimeSession {
    profile: ProcessingProfile,
    leg_a_telephone_event: Option<TelephoneEventConfig>,
    leg_b_telephone_event: Option<TelephoneEventConfig>,
    transport_session_id: String,
    effective_sdp: String,
    single_leg_answer_sdp: String,
    updated_at_ms: u64,
    commands: VecDeque<RuntimeCommandRecord>,
}

struct ParsedAudio {
    description: SessionDescription,
    remote: SocketAddr,
    telephone_event: Option<TelephoneEventConfig>,
}

pub struct ProcessingRuntime {
    config: ProcessingRuntimeConfig,
    registry: ProcessingSessionRegistry,
    workers: RtpWorkerPool,
    sessions: Mutex<HashMap<String, RuntimeSession>>,
}

impl ProcessingRuntime {
    pub fn new(
        config: ProcessingRuntimeConfig,
        capacity: Arc<CodecPairCapacity>,
    ) -> Result<Self, ProcessingRuntimeError> {
        validate_runtime_config(config)?;
        let registry = ProcessingSessionRegistry::new(config.registry, capacity)?;
        let workers = RtpWorkerPool::new(config.workers)?;
        Ok(Self {
            config,
            registry,
            workers,
            sessions: Mutex::new(HashMap::with_capacity(
                config.registry.max_sessions.min(4_096),
            )),
        })
    }

    pub fn execute(
        &self,
        input: ProcessingRuntimeCommand,
        now_ms: u64,
    ) -> Result<ProcessingRuntimeResult, ProcessingRuntimeError> {
        validate_operation(input.command.action, &input.operation)?;
        let prepared = self.prepare_operation(&input)?;
        let command = input.command;
        let command_id = command.command_id.clone();
        let media_reservation_id = command.media_reservation_id.clone();
        let result = self
            .registry
            .execute_with(command, now_ms, |proposed| {
                self.apply_operation(
                    &media_reservation_id,
                    &command_id,
                    proposed,
                    &prepared,
                    now_ms,
                )
            })
            .map_err(map_execution_error)?;
        self.project_result(result)
    }

    pub fn session(
        &self,
        media_reservation_id: &str,
    ) -> Result<Option<ProcessingRuntimeSnapshot>, ProcessingRuntimeError> {
        let Some(session) = self.registry.snapshot(media_reservation_id) else {
            return Ok(None);
        };
        let states = self.lock_sessions()?;
        let state = states
            .get(media_reservation_id)
            .ok_or(ProcessingRuntimeError::RuntimeStateMissing)?;
        Ok(Some(project_runtime_snapshot(
            session,
            state,
            state.updated_at_ms,
        )))
    }

    pub fn reconcile(
        &self,
        command: ReconcileCommand,
    ) -> Result<Option<ProcessingRuntimeResult>, ProcessingRuntimeError> {
        self.registry
            .reconcile(command)?
            .map(|result| self.project_result(result))
            .transpose()
    }

    pub fn scan_active_sessions(
        &self,
        after: &str,
        limit: usize,
    ) -> Result<ProcessingRuntimeScanResult, ProcessingRuntimeError> {
        let scan = self.registry.scan_active(after, limit)?;
        Ok(ProcessingRuntimeScanResult {
            inspected: scan.inspected,
            items: scan
                .items
                .into_iter()
                .map(|session| ProcessingRuntimeOrphanCandidate {
                    transport_session_id: transport_session_id(&session.media_reservation_id),
                    session,
                })
                .collect(),
            next_cursor: scan.next_cursor,
        })
    }

    pub fn worker_snapshot(&self) -> Result<RtpWorkerPoolSnapshot, ProcessingRuntimeError> {
        self.workers.snapshot().map_err(Into::into)
    }

    pub fn cache_prompt_pcm(
        &self,
        prompt_id: &str,
        sample_rate_hz: u32,
        samples: &[i16],
    ) -> Result<ProcessingPromptSnapshot, ProcessingRuntimeError> {
        let prompt = self
            .workers
            .cache_prompt_pcm(prompt_id, sample_rate_hz, samples)?;
        Ok(ProcessingPromptSnapshot {
            prompt_id: prompt.id().to_owned(),
            canonical_sample_rate_hz: prompt.sample_rate_hz(),
            frame_count: prompt.frame_count(),
        })
    }

    pub fn remove_cached_prompt(&self, prompt_id: &str) -> Result<bool, ProcessingRuntimeError> {
        self.workers
            .remove_cached_prompt(prompt_id)
            .map_err(Into::into)
    }

    pub fn recv_event_timeout(&self, timeout: Duration) -> Option<WorkerEvent> {
        self.workers.recv_event_timeout(timeout)
    }

    pub fn terminal_event_input(
        &self,
        event: WorkerEvent,
        occurred_at_ms: u64,
    ) -> Result<Option<ProcessingTerminalEventInput>, ProcessingRuntimeError> {
        let WorkerEvent::Ivr { session_id, event } = event else {
            return Ok(None);
        };
        let (command_id, event) = match event {
            IvrEvent::PlaybackCompleted {
                command_id,
                prompt_id,
            } => (
                command_id,
                ProcessingTerminalEvent::PlaybackCompleted {
                    prompt_id: prompt_id.to_string(),
                },
            ),
            IvrEvent::PlaybackStopped {
                command_id,
                prompt_id,
                reason,
            } => (
                command_id,
                ProcessingTerminalEvent::PlaybackStopped {
                    prompt_id: prompt_id.to_string(),
                    reason: playback_stop_reason(reason).to_owned(),
                },
            ),
            IvrEvent::GatherCompleted {
                command_id,
                digits,
                reason,
                minimum_satisfied,
            } => (
                command_id,
                ProcessingTerminalEvent::GatherCompleted {
                    digits: digits.to_string(),
                    reason: gather_completion_reason(reason).to_owned(),
                    minimum_satisfied,
                },
            ),
            IvrEvent::PlaybackStarted { .. } | IvrEvent::GatherStarted { .. } => {
                return Ok(None);
            }
        };
        let session = self
            .registry
            .snapshot(&session_id)
            .ok_or(ProcessingRuntimeError::RuntimeStateMissing)?;
        Ok(Some(ProcessingTerminalEventInput {
            tenant_id: session.tenant_id,
            call_id: session.call_id,
            cell_id: session.cell_id,
            owner_node_id: session.owner_node_id,
            owner_epoch: session.owner_epoch.to_string(),
            media_reservation_id: session.media_reservation_id,
            command_id: command_id.to_string(),
            occurred_at_ms,
            event,
        }))
    }

    pub fn persist_terminal_event(
        &self,
        outbox: &ProcessingEventOutbox,
        event: WorkerEvent,
        occurred_at_ms: u64,
    ) -> Result<Option<EventAppendResult>, ProcessingEventHandoffError> {
        let Some(input) = self
            .terminal_event_input(event, occurred_at_ms)
            .map_err(ProcessingEventHandoffError::Runtime)?
        else {
            return Ok(None);
        };
        outbox
            .append(input)
            .map(Some)
            .map_err(ProcessingEventHandoffError::Outbox)
    }

    pub fn registry_session_count(&self) -> usize {
        self.registry.session_count()
    }

    pub fn registry_active_session_count(&self) -> usize {
        self.registry.active_session_count()
    }

    pub fn available_port_count(&self) -> usize {
        self.registry.available_port_count()
    }

    pub fn runtime_state_count(&self) -> Result<usize, ProcessingRuntimeError> {
        Ok(self.lock_sessions()?.len())
    }

    pub fn sweep(&self, now_ms: u64, limit: usize) -> Result<SweepReport, ProcessingRuntimeError> {
        self.registry
            .sweep_with(now_ms, limit, |action, snapshot| {
                self.apply_sweep(action, snapshot, now_ms)
            })
            .map_err(map_sweep_error)
    }

    fn prepare_operation(
        &self,
        input: &ProcessingRuntimeCommand,
    ) -> Result<PreparedOperation, ProcessingRuntimeError> {
        match &input.operation {
            ProcessingRuntimeOperation::Offer { sdp } => {
                let profile = input
                    .command
                    .profile
                    .ok_or(ProcessingRuntimeError::InvalidOperation)?;
                Ok(PreparedOperation::Negotiation {
                    role: NegotiationRole::Offer,
                    parsed: Box::new(parse_audio_sdp(
                        sdp,
                        SdpType::Offer,
                        profile.leg_a_codec,
                        profile.leg_a_payload_type,
                    )?),
                })
            }
            ProcessingRuntimeOperation::Answer { sdp } => {
                let profile = self
                    .registry
                    .snapshot(&input.command.media_reservation_id)
                    .ok_or(SessionError::SessionNotFound)?
                    .profile;
                Ok(PreparedOperation::Negotiation {
                    role: NegotiationRole::Answer,
                    parsed: Box::new(parse_audio_sdp(
                        sdp,
                        SdpType::Answer,
                        profile.leg_b_codec,
                        profile.leg_b_payload_type,
                    )?),
                })
            }
            ProcessingRuntimeOperation::CommitSingleLeg => Ok(PreparedOperation::CommitSingleLeg),
            ProcessingRuntimeOperation::Update { role, sdp } => {
                let profile = self
                    .registry
                    .snapshot(&input.command.media_reservation_id)
                    .ok_or(SessionError::SessionNotFound)?
                    .profile;
                let (sdp_type, codec, payload_type) = match role {
                    NegotiationRole::Offer => (
                        SdpType::Offer,
                        profile.leg_a_codec,
                        profile.leg_a_payload_type,
                    ),
                    NegotiationRole::Answer => (
                        SdpType::Answer,
                        profile.leg_b_codec,
                        profile.leg_b_payload_type,
                    ),
                };
                Ok(PreparedOperation::Negotiation {
                    role: *role,
                    parsed: Box::new(parse_audio_sdp(sdp, sdp_type, codec, payload_type)?),
                })
            }
            ProcessingRuntimeOperation::PlayMedia {
                prompt_id,
                egress_leg,
                barge_in,
            } => Ok(PreparedOperation::PlayMedia {
                prompt_id: prompt_id.clone(),
                egress_leg: *egress_leg,
                barge_in: *barge_in,
            }),
            ProcessingRuntimeOperation::StopMedia { target_command_id } => {
                Ok(PreparedOperation::StopMedia {
                    target_command_id: target_command_id.clone(),
                })
            }
            ProcessingRuntimeOperation::StartGather {
                minimum_digits,
                maximum_digits,
                terminator,
                first_digit_timeout_ms,
                inter_digit_timeout_ms,
            } => Ok(PreparedOperation::StartGather {
                minimum_digits: *minimum_digits,
                maximum_digits: *maximum_digits,
                terminator: *terminator,
                first_digit_timeout_ms: *first_digit_timeout_ms,
                inter_digit_timeout_ms: *inter_digit_timeout_ms,
            }),
            ProcessingRuntimeOperation::StopGather { target_command_id } => {
                Ok(PreparedOperation::StopGather {
                    target_command_id: target_command_id.clone(),
                })
            }
            ProcessingRuntimeOperation::SipInfoDigit { event_id, digit } => {
                Ok(PreparedOperation::SipInfoDigit {
                    event_id: event_id.clone(),
                    digit: *digit,
                })
            }
            ProcessingRuntimeOperation::Delete => Ok(PreparedOperation::Delete),
            ProcessingRuntimeOperation::Query => Ok(PreparedOperation::Query),
        }
    }

    fn apply_operation(
        &self,
        media_reservation_id: &str,
        command_id: &str,
        proposed: &ProcessingSessionSnapshot,
        operation: &PreparedOperation,
        now_ms: u64,
    ) -> Result<(), ProcessingRuntimeError> {
        match operation {
            PreparedOperation::Negotiation {
                role: NegotiationRole::Offer,
                parsed,
            } => self.apply_offer(media_reservation_id, command_id, proposed, parsed, now_ms),
            PreparedOperation::Negotiation {
                role: NegotiationRole::Answer,
                parsed,
            } => self.apply_answer(media_reservation_id, command_id, proposed, parsed, now_ms),
            PreparedOperation::CommitSingleLeg => {
                let answer_sdp = {
                    let sessions = self.lock_sessions()?;
                    sessions
                        .get(media_reservation_id)
                        .ok_or(ProcessingRuntimeError::RuntimeStateMissing)?
                        .single_leg_answer_sdp
                        .clone()
                };
                self.workers.set_single_leg(media_reservation_id, true)?;
                self.record_existing_outcome(
                    media_reservation_id,
                    command_id,
                    Some(answer_sdp),
                    now_ms,
                )
            }
            PreparedOperation::PlayMedia {
                prompt_id,
                egress_leg,
                barge_in,
            } => {
                self.workers.start_playback(
                    media_reservation_id,
                    WorkerPlaybackRequest {
                        command_id: Arc::from(command_id),
                        prompt_id: Arc::from(prompt_id.as_str()),
                        egress_leg: *egress_leg,
                        barge_in: *barge_in,
                    },
                )?;
                self.record_existing_outcome(media_reservation_id, command_id, None, now_ms)
            }
            PreparedOperation::StopMedia { target_command_id } => {
                self.workers.stop_playback(
                    media_reservation_id,
                    Arc::from(command_id),
                    Arc::from(target_command_id.as_str()),
                )?;
                self.record_existing_outcome(media_reservation_id, command_id, None, now_ms)
            }
            PreparedOperation::StartGather {
                minimum_digits,
                maximum_digits,
                terminator,
                first_digit_timeout_ms,
                inter_digit_timeout_ms,
            } => {
                self.workers.start_gather(
                    media_reservation_id,
                    WorkerGatherRequest {
                        command_id: Arc::from(command_id),
                        minimum_digits: *minimum_digits,
                        maximum_digits: *maximum_digits,
                        terminator: *terminator,
                        first_digit_timeout_ms: *first_digit_timeout_ms,
                        inter_digit_timeout_ms: *inter_digit_timeout_ms,
                    },
                )?;
                self.record_existing_outcome(media_reservation_id, command_id, None, now_ms)
            }
            PreparedOperation::StopGather { target_command_id } => {
                self.workers.stop_gather(
                    media_reservation_id,
                    Arc::from(command_id),
                    Arc::from(target_command_id.as_str()),
                )?;
                self.record_existing_outcome(media_reservation_id, command_id, None, now_ms)
            }
            PreparedOperation::SipInfoDigit { event_id, digit } => {
                self.workers
                    .submit_sip_info_digit(media_reservation_id, event_id, *digit)?;
                self.record_existing_outcome(media_reservation_id, command_id, None, now_ms)
            }
            PreparedOperation::Delete => {
                if !self.workers.remove_session(media_reservation_id)? {
                    return Err(ProcessingRuntimeError::RuntimeStateMissing);
                }
                self.record_existing_outcome(media_reservation_id, command_id, None, now_ms)
            }
            PreparedOperation::Query => {
                self.record_existing_outcome(media_reservation_id, command_id, None, now_ms)
            }
        }
    }

    fn apply_offer(
        &self,
        media_reservation_id: &str,
        command_id: &str,
        proposed: &ProcessingSessionSnapshot,
        parsed: &ParsedAudio,
        now_ms: u64,
    ) -> Result<(), ProcessingRuntimeError> {
        let leg_b_telephone_event = default_telephone_event(
            proposed.profile.leg_b_codec,
            proposed.profile.leg_b_payload_type,
        );
        let rtp_config = self.rtp_session_config(
            proposed.profile,
            parsed.telephone_event,
            leg_b_telephone_event,
        );
        let leg_a_bind = SocketAddr::new(self.config.bind_ip, proposed.ports.leg_a_rtp_port);
        let leg_b_bind = SocketAddr::new(self.config.bind_ip, proposed.ports.leg_b_rtp_port);
        self.workers
            .install_session(media_reservation_id, leg_a_bind, leg_b_bind, rtp_config)?;
        if let Err(error) = self.workers.set_destination_hint(
            media_reservation_id,
            ProcessingLeg::A,
            Some(parsed.remote),
        ) {
            let _ = self.workers.remove_session(media_reservation_id);
            return Err(error.into());
        }
        let effective_sdp = rewrite_sdp(
            &parsed.description,
            self.config.advertised_ip,
            proposed.ports.leg_b_rtp_port,
            proposed.profile.leg_b_codec,
            proposed.profile.leg_b_payload_type,
            leg_b_telephone_event,
            proposed.profile.packetization_ms,
        );
        let single_leg_answer_sdp = rewrite_sdp(
            &parsed.description,
            self.config.advertised_ip,
            proposed.ports.leg_a_rtp_port,
            proposed.profile.leg_a_codec,
            proposed.profile.leg_a_payload_type,
            parsed.telephone_event,
            proposed.profile.packetization_ms,
        );
        let mut sessions = match self.lock_sessions() {
            Ok(sessions) => sessions,
            Err(error) => {
                let _ = self.workers.remove_session(media_reservation_id);
                return Err(error);
            }
        };
        if sessions.contains_key(media_reservation_id) {
            let _ = self.workers.remove_session(media_reservation_id);
            return Err(ProcessingRuntimeError::RuntimeStateConflict);
        }
        let mut state = RuntimeSession {
            profile: proposed.profile,
            leg_a_telephone_event: parsed.telephone_event,
            leg_b_telephone_event,
            transport_session_id: transport_session_id(media_reservation_id),
            effective_sdp: effective_sdp.clone(),
            single_leg_answer_sdp,
            updated_at_ms: now_ms,
            commands: VecDeque::with_capacity(self.config.registry.max_commands_per_session),
        };
        push_runtime_command(
            &mut state,
            command_id,
            &effective_sdp,
            now_ms,
            self.config.registry.max_commands_per_session,
        );
        sessions.insert(media_reservation_id.to_owned(), state);
        Ok(())
    }

    fn apply_answer(
        &self,
        media_reservation_id: &str,
        command_id: &str,
        proposed: &ProcessingSessionSnapshot,
        parsed: &ParsedAudio,
        now_ms: u64,
    ) -> Result<(), ProcessingRuntimeError> {
        let (profile, leg_a_telephone_event, leg_b_telephone_event) = {
            let sessions = self.lock_sessions()?;
            let state = sessions
                .get(media_reservation_id)
                .ok_or(ProcessingRuntimeError::RuntimeStateMissing)?;
            (
                state.profile,
                state.leg_a_telephone_event,
                state.leg_b_telephone_event,
            )
        };
        if profile != proposed.profile || parsed.telephone_event != leg_b_telephone_event {
            return Err(ProcessingRuntimeError::RuntimeStateConflict);
        }
        self.workers.set_destination_hint(
            media_reservation_id,
            ProcessingLeg::B,
            Some(parsed.remote),
        )?;
        let effective_sdp = rewrite_sdp(
            &parsed.description,
            self.config.advertised_ip,
            proposed.ports.leg_a_rtp_port,
            proposed.profile.leg_a_codec,
            proposed.profile.leg_a_payload_type,
            leg_a_telephone_event,
            proposed.profile.packetization_ms,
        );
        self.record_existing_outcome(
            media_reservation_id,
            command_id,
            Some(effective_sdp),
            now_ms,
        )
    }

    fn record_existing_outcome(
        &self,
        media_reservation_id: &str,
        command_id: &str,
        effective_sdp: Option<String>,
        now_ms: u64,
    ) -> Result<(), ProcessingRuntimeError> {
        let mut sessions = self.lock_sessions()?;
        let state = sessions
            .get_mut(media_reservation_id)
            .ok_or(ProcessingRuntimeError::RuntimeStateMissing)?;
        if let Some(effective_sdp) = effective_sdp {
            state.effective_sdp = effective_sdp;
        }
        state.updated_at_ms = now_ms;
        let effective_sdp = state.effective_sdp.clone();
        push_runtime_command(
            state,
            command_id,
            &effective_sdp,
            now_ms,
            self.config.registry.max_commands_per_session,
        );
        Ok(())
    }

    fn project_result(
        &self,
        result: crate::session::SessionCommandResult,
    ) -> Result<ProcessingRuntimeResult, ProcessingRuntimeError> {
        let sessions = self.lock_sessions()?;
        let state = sessions
            .get(&result.snapshot.media_reservation_id)
            .ok_or(ProcessingRuntimeError::RuntimeStateMissing)?;
        let outcome = state
            .commands
            .iter()
            .find(|candidate| candidate.command_id.as_ref() == result.applied_command_id)
            .ok_or(ProcessingRuntimeError::RuntimeStateMissing)?;
        Ok(ProcessingRuntimeResult {
            response_command_id: result.response_command_id,
            applied_command_id: result.applied_command_id,
            replayed: result.replayed,
            snapshot: ProcessingRuntimeSnapshot {
                session: result.snapshot,
                transport_session_id: state.transport_session_id.clone(),
                effective_sdp: outcome.effective_sdp.to_string(),
                updated_at_ms: outcome.updated_at_ms,
            },
        })
    }

    fn rtp_session_config(
        &self,
        profile: ProcessingProfile,
        leg_a_telephone_event: Option<TelephoneEventConfig>,
        leg_b_telephone_event: Option<TelephoneEventConfig>,
    ) -> RtpSessionConfig {
        let mut entropy = [0_u8; 24];
        OsRng.fill_bytes(&mut entropy);
        RtpSessionConfig {
            profile,
            jitter_capacity: self.config.jitter_capacity,
            jitter_wait_depth: self.config.jitter_wait_depth,
            max_drain_per_datagram: self.config.max_drain_per_datagram,
            max_conceal_frames: self.config.max_conceal_frames,
            max_datagram_bytes: self.config.workers.max_datagram_bytes,
            leg_a_telephone_event,
            leg_b_telephone_event,
            a_to_b_ssrc: u32::from_be_bytes(entropy[0..4].try_into().expect("entropy")),
            b_to_a_ssrc: u32::from_be_bytes(entropy[4..8].try_into().expect("entropy")),
            a_to_b_initial_sequence: u16::from_be_bytes(
                entropy[8..10].try_into().expect("entropy"),
            ),
            b_to_a_initial_sequence: u16::from_be_bytes(
                entropy[10..12].try_into().expect("entropy"),
            ),
            a_to_b_initial_timestamp: u32::from_be_bytes(
                entropy[12..16].try_into().expect("entropy"),
            ),
            b_to_a_initial_timestamp: u32::from_be_bytes(
                entropy[16..20].try_into().expect("entropy"),
            ),
            source_rebind_after_ms: self.config.source_rebind_after_ms,
        }
    }

    fn apply_sweep(
        &self,
        action: SweepAction,
        snapshot: &ProcessingSessionSnapshot,
        now_ms: u64,
    ) -> Result<(), ProcessingRuntimeError> {
        let mut sessions = self.lock_sessions()?;
        match action {
            SweepAction::ExpirePrepared => {
                let state = sessions
                    .get_mut(&snapshot.media_reservation_id)
                    .ok_or(ProcessingRuntimeError::RuntimeStateMissing)?;
                if !self
                    .workers
                    .remove_session(&snapshot.media_reservation_id)?
                {
                    return Err(ProcessingRuntimeError::RuntimeStateMissing);
                }
                state.updated_at_ms = now_ms;
            }
            SweepAction::EvictTerminal => {
                if sessions.remove(&snapshot.media_reservation_id).is_none() {
                    return Err(ProcessingRuntimeError::RuntimeStateMissing);
                }
            }
        }
        Ok(())
    }

    fn lock_sessions(
        &self,
    ) -> Result<MutexGuard<'_, HashMap<String, RuntimeSession>>, ProcessingRuntimeError> {
        self.sessions
            .lock()
            .map_err(|_| ProcessingRuntimeError::RuntimeStatePoisoned)
    }
}

fn playback_stop_reason(reason: PlaybackStopReason) -> &'static str {
    match reason {
        PlaybackStopReason::Explicit => "explicit",
        PlaybackStopReason::BargeIn => "barge_in",
        PlaybackStopReason::SessionRemoved => "session_removed",
    }
}

fn gather_completion_reason(reason: GatherCompletionReason) -> &'static str {
    match reason {
        GatherCompletionReason::MaximumDigits => "maximum_digits",
        GatherCompletionReason::Terminator => "terminator",
        GatherCompletionReason::Timeout => "timeout",
        GatherCompletionReason::ExplicitStop => "explicit_stop",
        GatherCompletionReason::SessionRemoved => "session_removed",
    }
}

enum PreparedOperation {
    Negotiation {
        role: NegotiationRole,
        parsed: Box<ParsedAudio>,
    },
    CommitSingleLeg,
    PlayMedia {
        prompt_id: String,
        egress_leg: ProcessingLeg,
        barge_in: bool,
    },
    StopMedia {
        target_command_id: String,
    },
    StartGather {
        minimum_digits: usize,
        maximum_digits: usize,
        terminator: Option<char>,
        first_digit_timeout_ms: u64,
        inter_digit_timeout_ms: u64,
    },
    StopGather {
        target_command_id: String,
    },
    SipInfoDigit {
        event_id: String,
        digit: char,
    },
    Delete,
    Query,
}

fn validate_runtime_config(config: ProcessingRuntimeConfig) -> Result<(), ProcessingRuntimeError> {
    if config.jitter_capacity == 0 {
        return Err(ProcessingRuntimeError::InvalidConfiguration {
            field: "jitter_capacity",
        });
    }
    if config.jitter_wait_depth == 0 || config.jitter_wait_depth > config.jitter_capacity {
        return Err(ProcessingRuntimeError::InvalidConfiguration {
            field: "jitter_wait_depth",
        });
    }
    if config.max_drain_per_datagram == 0 {
        return Err(ProcessingRuntimeError::InvalidConfiguration {
            field: "max_drain_per_datagram",
        });
    }
    if config.source_rebind_after_ms == 0 {
        return Err(ProcessingRuntimeError::InvalidConfiguration {
            field: "source_rebind_after_ms",
        });
    }
    Ok(())
}

fn validate_operation(
    action: ProcessingAction,
    operation: &ProcessingRuntimeOperation,
) -> Result<(), ProcessingRuntimeError> {
    let matches = matches!(
        (action, operation),
        (
            ProcessingAction::Offer,
            ProcessingRuntimeOperation::Offer { .. }
        ) | (
            ProcessingAction::Answer,
            ProcessingRuntimeOperation::Answer { .. }
        ) | (
            ProcessingAction::CommitSingleLeg,
            ProcessingRuntimeOperation::CommitSingleLeg
        ) | (
            ProcessingAction::Update,
            ProcessingRuntimeOperation::Update { .. }
        ) | (
            ProcessingAction::PlayMedia,
            ProcessingRuntimeOperation::PlayMedia { .. }
        ) | (
            ProcessingAction::StopMedia,
            ProcessingRuntimeOperation::StopMedia { .. }
        ) | (
            ProcessingAction::StartGather,
            ProcessingRuntimeOperation::StartGather { .. }
        ) | (
            ProcessingAction::StopGather,
            ProcessingRuntimeOperation::StopGather { .. }
        ) | (
            ProcessingAction::InjectDtmf,
            ProcessingRuntimeOperation::SipInfoDigit { .. }
        ) | (ProcessingAction::Delete, ProcessingRuntimeOperation::Delete)
            | (ProcessingAction::Query, ProcessingRuntimeOperation::Query)
    );
    if matches {
        Ok(())
    } else {
        Err(ProcessingRuntimeError::InvalidOperation)
    }
}

fn parse_audio_sdp(
    raw: &str,
    sdp_type: SdpType,
    expected_codec: AudioCodec,
    expected_payload_type: u8,
) -> Result<ParsedAudio, ProcessingRuntimeError> {
    if raw.is_empty() || raw.len() > MAX_SDP_BYTES {
        return Err(ProcessingRuntimeError::InvalidSdp);
    }
    let description =
        SessionDescription::parse(sdp_type, raw).map_err(|_| ProcessingRuntimeError::InvalidSdp)?;
    let mut active_audio = description
        .media_sections
        .iter()
        .filter(|section| section.kind == MediaKind::Audio && section.port != 0);
    let section = active_audio
        .next()
        .ok_or(ProcessingRuntimeError::UnsupportedSdp)?;
    if active_audio.next().is_some()
        || description
            .media_sections
            .iter()
            .any(|candidate| candidate.kind != MediaKind::Audio && candidate.port != 0)
        || !matches!(section.protocol.as_str(), "RTP/AVP" | "RTP/AVPF")
        || section.attributes.iter().any(|attribute| {
            matches!(
                attribute.key.as_str(),
                "crypto" | "fingerprint" | "setup" | "ice-ufrag" | "ice-pwd" | "candidate"
            )
        })
    {
        return Err(ProcessingRuntimeError::UnsupportedSdp);
    }
    let capabilities = section.to_audio_capabilities();
    let expected = capabilities
        .iter()
        .find(|capability| capability.payload_type == expected_payload_type)
        .ok_or(ProcessingRuntimeError::UnsupportedSdp)?;
    if !expected
        .codec_name
        .eq_ignore_ascii_case(expected_codec.label())
        || expected.clock_rate != expected_codec.clock_rate()
        || (expected_codec == AudioCodec::Opus && !matches!(expected.channels, 1 | 2))
        || (expected_codec != AudioCodec::Opus && expected.channels != 1)
    {
        return Err(ProcessingRuntimeError::UnsupportedSdp);
    }
    let telephone_event = capabilities
        .iter()
        .find(|capability| {
            capability
                .codec_name
                .eq_ignore_ascii_case("telephone-event")
        })
        .map(|capability| TelephoneEventConfig {
            payload_type: capability.payload_type,
            clock_rate: capability.clock_rate,
        });
    if telephone_event.is_some_and(|event| {
        event.payload_type == expected_payload_type
            || !matches!(event.clock_rate, 8_000 | 16_000 | 32_000 | 48_000)
    }) {
        return Err(ProcessingRuntimeError::UnsupportedSdp);
    }
    let connection = section
        .connection
        .as_deref()
        .or(description.session.connection.as_deref())
        .ok_or(ProcessingRuntimeError::InvalidSdp)?
        .to_owned();
    let remote_port = section.port;
    drop(active_audio);
    let remote_ip = parse_connection(&connection)?;
    Ok(ParsedAudio {
        description,
        remote: SocketAddr::new(remote_ip, remote_port),
        telephone_event,
    })
}

fn parse_connection(value: &str) -> Result<IpAddr, ProcessingRuntimeError> {
    let mut parts = value.split_whitespace();
    let network = parts.next();
    let address_type = parts.next();
    let address = parts.next();
    if network != Some("IN") || parts.next().is_some() {
        return Err(ProcessingRuntimeError::InvalidSdp);
    }
    let address = address
        .ok_or(ProcessingRuntimeError::InvalidSdp)?
        .parse::<IpAddr>()
        .map_err(|_| ProcessingRuntimeError::InvalidSdp)?;
    if !matches!(
        (address_type, address),
        (Some("IP4"), IpAddr::V4(_)) | (Some("IP6"), IpAddr::V6(_))
    ) {
        return Err(ProcessingRuntimeError::InvalidSdp);
    }
    Ok(address)
}

fn default_telephone_event(
    codec: AudioCodec,
    media_payload_type: u8,
) -> Option<TelephoneEventConfig> {
    let payload_type = match codec {
        AudioCodec::Pcmu | AudioCodec::Pcma => 101,
        AudioCodec::Opus => 110,
    };
    (payload_type != media_payload_type).then_some(TelephoneEventConfig {
        payload_type,
        clock_rate: codec.clock_rate(),
    })
}

fn rewrite_sdp(
    input: &SessionDescription,
    advertised_ip: IpAddr,
    port: u16,
    codec: AudioCodec,
    payload_type: u8,
    telephone_event: Option<TelephoneEventConfig>,
    packetization_ms: u16,
) -> String {
    let mut output = input.clone();
    let connection = connection_line(advertised_ip);
    output.session.connection = Some(connection.clone());
    output.session.origin.address_type = address_type(advertised_ip);
    output.session.origin.unicast_address = advertised_ip.to_string();
    output.session.attributes.clear();
    output
        .media_sections
        .retain(|section| section.kind == MediaKind::Audio);
    let section = output
        .media_sections
        .first_mut()
        .expect("validated SDP must contain audio");
    section.port = port;
    section.connection = Some(connection);
    section.formats.clear();
    section.formats.push(payload_type.to_string());
    if let Some(event) = telephone_event {
        section.formats.push(event.payload_type.to_string());
    }
    section.attributes.clear();
    section.attributes.push(Attribute::new(
        "rtpmap",
        Some(codec_rtpmap(payload_type, codec)),
    ));
    if codec == AudioCodec::Opus {
        section.attributes.push(Attribute::new(
            "fmtp",
            Some(format!(
                "{payload_type} minptime={packetization_ms};useinbandfec=1"
            )),
        ));
    }
    if let Some(event) = telephone_event {
        section.attributes.push(Attribute::new(
            "rtpmap",
            Some(format!(
                "{} telephone-event/{}",
                event.payload_type, event.clock_rate
            )),
        ));
        section.attributes.push(Attribute::new(
            "fmtp",
            Some(format!("{} 0-16", event.payload_type)),
        ));
    }
    section
        .attributes
        .push(Attribute::new("ptime", Some(packetization_ms.to_string())));
    output.to_sdp_string()
}

fn codec_rtpmap(payload_type: u8, codec: AudioCodec) -> String {
    match codec {
        AudioCodec::Pcmu => format!("{payload_type} PCMU/8000"),
        AudioCodec::Pcma => format!("{payload_type} PCMA/8000"),
        AudioCodec::Opus => format!("{payload_type} opus/48000/2"),
    }
}

fn address_type(address: IpAddr) -> AddressType {
    match address {
        IpAddr::V4(_) => AddressType::Ipv4,
        IpAddr::V6(_) => AddressType::Ipv6,
    }
}

fn connection_line(address: IpAddr) -> String {
    let family = match address {
        IpAddr::V4(_) => "IP4",
        IpAddr::V6(_) => "IP6",
    };
    format!("IN {family} {address}")
}

fn transport_session_id(media_reservation_id: &str) -> String {
    let digest = Sha256::digest(media_reservation_id.as_bytes());
    format!("processing:{digest:x}")
}

fn push_runtime_command(
    state: &mut RuntimeSession,
    command_id: &str,
    effective_sdp: &str,
    updated_at_ms: u64,
    maximum: usize,
) {
    if state.commands.len() >= maximum {
        state.commands.pop_front();
    }
    state.commands.push_back(RuntimeCommandRecord {
        command_id: command_id.to_owned().into_boxed_str(),
        effective_sdp: effective_sdp.to_owned().into_boxed_str(),
        updated_at_ms,
    });
}

fn project_runtime_snapshot(
    session: ProcessingSessionSnapshot,
    state: &RuntimeSession,
    updated_at_ms: u64,
) -> ProcessingRuntimeSnapshot {
    ProcessingRuntimeSnapshot {
        session,
        transport_session_id: state.transport_session_id.clone(),
        effective_sdp: state.effective_sdp.clone(),
        updated_at_ms,
    }
}

fn map_execution_error(
    error: SessionExecutionError<ProcessingRuntimeError>,
) -> ProcessingRuntimeError {
    match error {
        SessionExecutionError::Session(error) => error.into(),
        SessionExecutionError::SideEffect(error) => error,
    }
}

fn map_sweep_error(error: SessionSweepError<ProcessingRuntimeError>) -> ProcessingRuntimeError {
    match error {
        SessionSweepError::Session(error) => error.into(),
        SessionSweepError::SideEffect(error) => error,
    }
}
