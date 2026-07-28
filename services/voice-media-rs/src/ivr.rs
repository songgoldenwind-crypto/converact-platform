use crate::rtp::ProcessingLeg;
use audio_codec::Resampler;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::sync::{Arc, Mutex, MutexGuard};

const CANONICAL_SAMPLE_RATE_HZ: u32 = 48_000;
const PACKETIZATION_MS: u16 = 20;
const SAMPLES_PER_FRAME: usize =
    CANONICAL_SAMPLE_RATE_HZ as usize * PACKETIZATION_MS as usize / 1_000;
const MAX_PROMPT_ID_BYTES: usize = 256;
const MAX_COMMAND_ID_BYTES: usize = 256;
const MAX_CACHE_PROMPTS: usize = 1_000_000;
const MAX_HISTORY: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IvrPromptCacheConfig {
    pub max_prompts: usize,
    pub max_frames_per_prompt: usize,
    pub max_total_pcm_samples: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IvrPromptCacheStats {
    pub prompt_count: usize,
    pub total_pcm_samples: usize,
    pub insertions: u64,
    pub replays: u64,
    pub removals: u64,
    pub rejected_insertions: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptCacheError {
    InvalidConfiguration { field: &'static str },
    InvalidPromptId,
    InvalidSampleRate,
    EmptyPrompt,
    PromptConflict,
    PromptCapacityExhausted { limit: usize },
    PromptFrameCapacityExhausted { limit: usize },
    PcmCapacityExhausted { limit: usize },
    PromptInUse,
    CachePoisoned,
}

impl Display for PromptCacheError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfiguration { field } => {
                write!(formatter, "invalid IVR prompt cache configuration: {field}")
            }
            Self::InvalidPromptId => formatter.write_str("invalid IVR prompt id"),
            Self::InvalidSampleRate => formatter.write_str("invalid IVR prompt sample rate"),
            Self::EmptyPrompt => formatter.write_str("IVR prompt has no PCM samples"),
            Self::PromptConflict => formatter.write_str("IVR prompt id has another body"),
            Self::PromptCapacityExhausted { limit } => {
                write!(formatter, "IVR prompt cache exhausted at {limit} prompts")
            }
            Self::PromptFrameCapacityExhausted { limit } => {
                write!(formatter, "IVR prompt exceeds {limit} frames")
            }
            Self::PcmCapacityExhausted { limit } => {
                write!(
                    formatter,
                    "IVR prompt PCM cache exhausted at {limit} samples"
                )
            }
            Self::PromptInUse => formatter.write_str("IVR prompt is still in use"),
            Self::CachePoisoned => formatter.write_str("IVR prompt cache lock poisoned"),
        }
    }
}

impl Error for PromptCacheError {}

#[derive(Debug)]
pub struct IvrPrompt {
    id: Arc<str>,
    fingerprint: [u8; 32],
    samples: Box<[i16]>,
}

impl IvrPrompt {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub const fn sample_rate_hz(&self) -> u32 {
        CANONICAL_SAMPLE_RATE_HZ
    }

    pub const fn packetization_ms(&self) -> u16 {
        PACKETIZATION_MS
    }

    pub fn frame_count(&self) -> usize {
        self.samples.len() / SAMPLES_PER_FRAME
    }

    pub fn frame(&self, index: usize) -> Option<&[i16]> {
        let start = index.checked_mul(SAMPLES_PER_FRAME)?;
        let end = start.checked_add(SAMPLES_PER_FRAME)?;
        self.samples.get(start..end)
    }

    fn sample_count(&self) -> usize {
        self.samples.len()
    }
}

struct PromptCacheState {
    prompts: HashMap<Arc<str>, Arc<IvrPrompt>>,
    total_pcm_samples: usize,
    insertions: u64,
    replays: u64,
    removals: u64,
    rejected_insertions: u64,
}

#[derive(Clone)]
pub struct IvrPromptCache {
    config: IvrPromptCacheConfig,
    state: Arc<Mutex<PromptCacheState>>,
}

impl IvrPromptCache {
    pub fn new(config: IvrPromptCacheConfig) -> Result<Self, PromptCacheError> {
        validate_cache_config(config)?;
        Ok(Self {
            config,
            state: Arc::new(Mutex::new(PromptCacheState {
                prompts: HashMap::with_capacity(config.max_prompts.min(4_096)),
                total_pcm_samples: 0,
                insertions: 0,
                replays: 0,
                removals: 0,
                rejected_insertions: 0,
            })),
        })
    }

    pub fn insert_pcm(
        &self,
        prompt_id: &str,
        source_sample_rate_hz: u32,
        samples: &[i16],
    ) -> Result<Arc<IvrPrompt>, PromptCacheError> {
        validate_prompt_id(prompt_id)?;
        if !(8_000..=192_000).contains(&source_sample_rate_hz) {
            return Err(PromptCacheError::InvalidSampleRate);
        }
        if samples.is_empty() {
            return Err(PromptCacheError::EmptyPrompt);
        }
        let fingerprint = pcm_fingerprint(source_sample_rate_hz, samples);
        let expected_samples: usize = ((samples.len() as u128
            * u128::from(CANONICAL_SAMPLE_RATE_HZ))
        .div_ceil(u128::from(source_sample_rate_hz)))
        .try_into()
        .map_err(|_| PromptCacheError::PcmCapacityExhausted {
            limit: self.config.max_total_pcm_samples,
        })?;
        let frame_count = expected_samples.div_ceil(SAMPLES_PER_FRAME);
        if frame_count > self.config.max_frames_per_prompt {
            let mut state = self.lock_state()?;
            state.rejected_insertions = state.rejected_insertions.saturating_add(1);
            return Err(PromptCacheError::PromptFrameCapacityExhausted {
                limit: self.config.max_frames_per_prompt,
            });
        }
        let stored_samples = frame_count.checked_mul(SAMPLES_PER_FRAME).ok_or(
            PromptCacheError::PcmCapacityExhausted {
                limit: self.config.max_total_pcm_samples,
            },
        )?;
        let mut state = self.lock_state()?;
        if let Some(existing) = state.prompts.get(prompt_id).cloned() {
            if existing.fingerprint == fingerprint {
                state.replays = state.replays.saturating_add(1);
                return Ok(existing);
            }
            state.rejected_insertions = state.rejected_insertions.saturating_add(1);
            return Err(PromptCacheError::PromptConflict);
        }
        if state.prompts.len() >= self.config.max_prompts {
            state.rejected_insertions = state.rejected_insertions.saturating_add(1);
            return Err(PromptCacheError::PromptCapacityExhausted {
                limit: self.config.max_prompts,
            });
        }
        let projected_samples = state.total_pcm_samples.checked_add(stored_samples).ok_or(
            PromptCacheError::PcmCapacityExhausted {
                limit: self.config.max_total_pcm_samples,
            },
        )?;
        if projected_samples > self.config.max_total_pcm_samples {
            state.rejected_insertions = state.rejected_insertions.saturating_add(1);
            return Err(PromptCacheError::PcmCapacityExhausted {
                limit: self.config.max_total_pcm_samples,
            });
        }

        let mut canonical = if source_sample_rate_hz == CANONICAL_SAMPLE_RATE_HZ {
            samples.to_vec()
        } else {
            Resampler::new(
                source_sample_rate_hz as usize,
                CANONICAL_SAMPLE_RATE_HZ as usize,
            )
            .resample(samples)
        };
        match canonical.len().cmp(&expected_samples) {
            std::cmp::Ordering::Less => canonical.resize(expected_samples, 0),
            std::cmp::Ordering::Greater => canonical.truncate(expected_samples),
            std::cmp::Ordering::Equal => {}
        }
        canonical.resize(stored_samples, 0);
        let prompt = Arc::new(IvrPrompt {
            id: Arc::from(prompt_id),
            fingerprint,
            samples: canonical.into_boxed_slice(),
        });

        state.prompts.insert(prompt.id.clone(), prompt.clone());
        state.total_pcm_samples = projected_samples;
        state.insertions = state.insertions.saturating_add(1);
        Ok(prompt)
    }

    pub fn get(&self, prompt_id: &str) -> Result<Option<Arc<IvrPrompt>>, PromptCacheError> {
        Ok(self.lock_state()?.prompts.get(prompt_id).cloned())
    }

    pub fn remove(&self, prompt_id: &str) -> Result<bool, PromptCacheError> {
        let mut state = self.lock_state()?;
        let Some(prompt) = state.prompts.get(prompt_id) else {
            return Ok(false);
        };
        if Arc::strong_count(prompt) > 1 {
            return Err(PromptCacheError::PromptInUse);
        }
        let Some(prompt) = state.prompts.remove(prompt_id) else {
            unreachable!("prompt was checked while holding the cache lock");
        };
        state.total_pcm_samples = state
            .total_pcm_samples
            .saturating_sub(prompt.sample_count());
        state.removals = state.removals.saturating_add(1);
        Ok(true)
    }

    pub fn stats(&self) -> IvrPromptCacheStats {
        let Ok(state) = self.state.lock() else {
            return IvrPromptCacheStats::default();
        };
        IvrPromptCacheStats {
            prompt_count: state.prompts.len(),
            total_pcm_samples: state.total_pcm_samples,
            insertions: state.insertions,
            replays: state.replays,
            removals: state.removals,
            rejected_insertions: state.rejected_insertions,
        }
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, PromptCacheState>, PromptCacheError> {
        self.state
            .lock()
            .map_err(|_| PromptCacheError::CachePoisoned)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IvrSessionConfig {
    pub max_command_history: usize,
    pub max_digit_history: usize,
    pub max_gather_digits: usize,
}

#[derive(Debug, Clone)]
pub struct IvrPlaybackRequest {
    pub command_id: Arc<str>,
    pub prompt: Arc<IvrPrompt>,
    pub egress_leg: ProcessingLeg,
    pub barge_in: bool,
    pub start_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IvrGatherRequest {
    pub command_id: Arc<str>,
    pub minimum_digits: usize,
    pub maximum_digits: usize,
    pub terminator: Option<char>,
    pub first_digit_timeout_ms: u64,
    pub inter_digit_timeout_ms: u64,
    pub start_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DigitSource {
    Rfc4733,
    SipInfo,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IvrDigitInput {
    pub event_id: Arc<str>,
    pub source: DigitSource,
    pub digit: char,
    pub occurred_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IvrCommandResult {
    pub replayed: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IvrDigitResult {
    pub replayed: bool,
    pub accepted: bool,
    pub playback_barged_in: bool,
    pub gather_completed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackStopReason {
    Explicit,
    BargeIn,
    SessionRemoved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatherCompletionReason {
    MaximumDigits,
    Terminator,
    Timeout,
    ExplicitStop,
    SessionRemoved,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IvrEvent {
    PlaybackStarted {
        command_id: Arc<str>,
        prompt_id: Arc<str>,
        egress_leg: ProcessingLeg,
    },
    PlaybackCompleted {
        command_id: Arc<str>,
        prompt_id: Arc<str>,
    },
    PlaybackStopped {
        command_id: Arc<str>,
        prompt_id: Arc<str>,
        reason: PlaybackStopReason,
    },
    GatherStarted {
        command_id: Arc<str>,
    },
    GatherCompleted {
        command_id: Arc<str>,
        digits: Arc<str>,
        reason: GatherCompletionReason,
        minimum_satisfied: bool,
    },
}

#[derive(Debug, Clone, Copy)]
pub struct IvrPcmFrame<'a> {
    pub egress_leg: ProcessingLeg,
    pub marker: bool,
    pub samples: &'a [i16],
}

pub trait IvrSink {
    fn reserve_terminal_event(&mut self) -> bool {
        true
    }

    fn emit_pcm(&mut self, frame: IvrPcmFrame<'_>) -> bool;
    fn emit_event(&mut self, event: IvrEvent);
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IvrSessionStats {
    pub playback_frames_emitted: u64,
    pub playback_backpressure: u64,
    pub late_playback_frames_skipped: u64,
    pub digits_accepted: u64,
    pub command_replays: u64,
    pub digit_replays: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IvrError {
    InvalidConfiguration { field: &'static str },
    InvalidCommandId,
    InvalidDigitEventId,
    InvalidDigit,
    InvalidGather,
    CommandConflict,
    DigitEventConflict,
    PlaybackBusy,
    GatherBusy,
    PlaybackNotActive,
    GatherNotActive,
    TargetCommandConflict,
    TerminalEventCapacityExhausted,
}

impl Display for IvrError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfiguration { field } => {
                write!(formatter, "invalid IVR session configuration: {field}")
            }
            Self::InvalidCommandId => formatter.write_str("invalid IVR command id"),
            Self::InvalidDigitEventId => formatter.write_str("invalid IVR digit event id"),
            Self::InvalidDigit => formatter.write_str("invalid IVR digit"),
            Self::InvalidGather => formatter.write_str("invalid IVR gather request"),
            Self::CommandConflict => formatter.write_str("IVR command payload conflict"),
            Self::DigitEventConflict => formatter.write_str("IVR digit event payload conflict"),
            Self::PlaybackBusy => formatter.write_str("IVR playback already active"),
            Self::GatherBusy => formatter.write_str("IVR gather already active"),
            Self::PlaybackNotActive => formatter.write_str("IVR playback not active"),
            Self::GatherNotActive => formatter.write_str("IVR gather not active"),
            Self::TargetCommandConflict => formatter.write_str("IVR target command conflict"),
            Self::TerminalEventCapacityExhausted => {
                formatter.write_str("IVR terminal event capacity exhausted")
            }
        }
    }
}

impl Error for IvrError {}

struct PlaybackState {
    command_id: Arc<str>,
    prompt: Arc<IvrPrompt>,
    egress_leg: ProcessingLeg,
    barge_in: bool,
    frame_index: usize,
    emitted_frames: usize,
    next_due_ms: u64,
}

struct GatherState {
    request: IvrGatherRequest,
    digits: String,
    deadline_ms: u64,
}

struct CommandRecord {
    command_id: Arc<str>,
    payload_hash: [u8; 32],
}

struct DigitRecord {
    event_id: Arc<str>,
    source: DigitSource,
    digit: char,
    result: IvrDigitResult,
}

pub struct IvrSession {
    config: IvrSessionConfig,
    playback: Option<PlaybackState>,
    gather: Option<GatherState>,
    commands: VecDeque<CommandRecord>,
    digits: VecDeque<DigitRecord>,
    stats: IvrSessionStats,
}

impl IvrSession {
    pub fn new(config: IvrSessionConfig) -> Result<Self, IvrError> {
        if config.max_command_history == 0 || config.max_command_history > MAX_HISTORY {
            return Err(IvrError::InvalidConfiguration {
                field: "max_command_history",
            });
        }
        if config.max_digit_history == 0 || config.max_digit_history > MAX_HISTORY {
            return Err(IvrError::InvalidConfiguration {
                field: "max_digit_history",
            });
        }
        if config.max_gather_digits == 0 || config.max_gather_digits > 1_024 {
            return Err(IvrError::InvalidConfiguration {
                field: "max_gather_digits",
            });
        }
        Ok(Self {
            config,
            playback: None,
            gather: None,
            commands: VecDeque::new(),
            digits: VecDeque::new(),
            stats: IvrSessionStats::default(),
        })
    }

    pub fn start_playback<S: IvrSink>(
        &mut self,
        request: IvrPlaybackRequest,
        sink: &mut S,
    ) -> Result<IvrCommandResult, IvrError> {
        validate_command_id(&request.command_id)?;
        let hash = playback_hash(&request);
        if self.command_replayed(&request.command_id, hash)? {
            self.stats.command_replays = self.stats.command_replays.saturating_add(1);
            return Ok(IvrCommandResult { replayed: true });
        }
        if self.playback.is_some() {
            return Err(IvrError::PlaybackBusy);
        }
        if !sink.reserve_terminal_event() {
            return Err(IvrError::TerminalEventCapacityExhausted);
        }
        let command_id = request.command_id.clone();
        let prompt_id = request.prompt.id.clone();
        let egress_leg = request.egress_leg;
        self.playback = Some(PlaybackState {
            command_id: command_id.clone(),
            prompt: request.prompt,
            egress_leg,
            barge_in: request.barge_in,
            frame_index: 0,
            emitted_frames: 0,
            next_due_ms: request.start_at_ms,
        });
        self.record_command(command_id.clone(), hash);
        sink.emit_event(IvrEvent::PlaybackStarted {
            command_id,
            prompt_id,
            egress_leg,
        });
        Ok(IvrCommandResult { replayed: false })
    }

    pub fn start_gather<S: IvrSink>(
        &mut self,
        request: IvrGatherRequest,
        sink: &mut S,
    ) -> Result<IvrCommandResult, IvrError> {
        validate_command_id(&request.command_id)?;
        validate_gather(&request, self.config.max_gather_digits)?;
        let hash = gather_hash(&request);
        if self.command_replayed(&request.command_id, hash)? {
            self.stats.command_replays = self.stats.command_replays.saturating_add(1);
            return Ok(IvrCommandResult { replayed: true });
        }
        if self.gather.is_some() {
            return Err(IvrError::GatherBusy);
        }
        if !sink.reserve_terminal_event() {
            return Err(IvrError::TerminalEventCapacityExhausted);
        }
        let command_id = request.command_id.clone();
        let deadline_ms = request
            .start_at_ms
            .saturating_add(request.first_digit_timeout_ms);
        self.gather = Some(GatherState {
            request,
            digits: String::with_capacity(self.config.max_gather_digits),
            deadline_ms,
        });
        self.record_command(command_id.clone(), hash);
        sink.emit_event(IvrEvent::GatherStarted { command_id });
        Ok(IvrCommandResult { replayed: false })
    }

    pub fn stop_playback<S: IvrSink>(
        &mut self,
        command_id: Arc<str>,
        target_command_id: &str,
        sink: &mut S,
    ) -> Result<IvrCommandResult, IvrError> {
        validate_command_id(&command_id)?;
        validate_command_id(target_command_id)?;
        let hash = stop_hash(b"playback", target_command_id);
        if self.command_replayed(&command_id, hash)? {
            self.stats.command_replays = self.stats.command_replays.saturating_add(1);
            return Ok(IvrCommandResult { replayed: true });
        }
        let Some(playback) = self.playback.take() else {
            return Err(IvrError::PlaybackNotActive);
        };
        if playback.command_id.as_ref() != target_command_id {
            self.playback = Some(playback);
            return Err(IvrError::TargetCommandConflict);
        }
        self.record_command(command_id, hash);
        emit_playback_stopped(playback, PlaybackStopReason::Explicit, sink);
        Ok(IvrCommandResult { replayed: false })
    }

    pub fn stop_gather<S: IvrSink>(
        &mut self,
        command_id: Arc<str>,
        target_command_id: &str,
        sink: &mut S,
    ) -> Result<IvrCommandResult, IvrError> {
        validate_command_id(&command_id)?;
        validate_command_id(target_command_id)?;
        let hash = stop_hash(b"gather", target_command_id);
        if self.command_replayed(&command_id, hash)? {
            self.stats.command_replays = self.stats.command_replays.saturating_add(1);
            return Ok(IvrCommandResult { replayed: true });
        }
        let Some(gather) = self.gather.take() else {
            return Err(IvrError::GatherNotActive);
        };
        if gather.request.command_id.as_ref() != target_command_id {
            self.gather = Some(gather);
            return Err(IvrError::TargetCommandConflict);
        }
        self.record_command(command_id, hash);
        emit_gather_completed(gather, GatherCompletionReason::ExplicitStop, sink);
        Ok(IvrCommandResult { replayed: false })
    }

    pub fn observe_digit<S: IvrSink>(
        &mut self,
        input: IvrDigitInput,
        sink: &mut S,
    ) -> Result<IvrDigitResult, IvrError> {
        validate_event_id(&input.event_id)?;
        if !is_digit(input.digit) {
            return Err(IvrError::InvalidDigit);
        }
        if let Some(existing) = self
            .digits
            .iter()
            .find(|record| record.event_id == input.event_id)
        {
            if existing.source != input.source || existing.digit != input.digit {
                return Err(IvrError::DigitEventConflict);
            }
            self.stats.digit_replays = self.stats.digit_replays.saturating_add(1);
            let mut result = existing.result;
            result.replayed = true;
            return Ok(result);
        }

        if self
            .gather
            .as_ref()
            .is_some_and(|gather| input.occurred_at_ms >= gather.deadline_ms)
        {
            let gather = self.gather.take().expect("checked active IVR gather");
            emit_gather_completed(gather, GatherCompletionReason::Timeout, sink);
        }
        let mut result = IvrDigitResult::default();
        if self
            .playback
            .as_ref()
            .is_some_and(|playback| playback.barge_in)
        {
            let playback = self.playback.take().expect("checked active IVR playback");
            emit_playback_stopped(playback, PlaybackStopReason::BargeIn, sink);
            result.playback_barged_in = true;
        }
        let Some(gather) = self.gather.as_mut() else {
            self.record_digit(input, result);
            return Ok(result);
        };
        result.accepted = true;
        self.stats.digits_accepted = self.stats.digits_accepted.saturating_add(1);

        if gather.request.terminator == Some(input.digit) {
            if gather.digits.chars().count() >= gather.request.minimum_digits {
                let gather = self.gather.take().expect("checked active IVR gather");
                emit_gather_completed(gather, GatherCompletionReason::Terminator, sink);
                result.gather_completed = true;
            } else {
                gather.deadline_ms = input
                    .occurred_at_ms
                    .saturating_add(gather.request.inter_digit_timeout_ms);
            }
            self.record_digit(input, result);
            return Ok(result);
        }

        gather.digits.push(input.digit);
        if gather.digits.chars().count() >= gather.request.maximum_digits {
            let gather = self.gather.take().expect("checked active IVR gather");
            emit_gather_completed(gather, GatherCompletionReason::MaximumDigits, sink);
            result.gather_completed = true;
        } else {
            gather.deadline_ms = input
                .occurred_at_ms
                .saturating_add(gather.request.inter_digit_timeout_ms);
        }
        self.record_digit(input, result);
        Ok(result)
    }

    pub fn tick<S: IvrSink>(&mut self, now_ms: u64, sink: &mut S) {
        if let Some(mut playback) = self.playback.take() {
            if now_ms >= playback.next_due_ms {
                let remaining = playback
                    .prompt
                    .frame_count()
                    .saturating_sub(playback.frame_index);
                let late_intervals =
                    now_ms.saturating_sub(playback.next_due_ms) / u64::from(PACKETIZATION_MS);
                let skipped = (late_intervals as usize).min(remaining.saturating_sub(1));
                playback.frame_index = playback.frame_index.saturating_add(skipped);
                self.stats.late_playback_frames_skipped = self
                    .stats
                    .late_playback_frames_skipped
                    .saturating_add(skipped as u64);
                let frame = playback
                    .prompt
                    .frame(playback.frame_index)
                    .expect("bounded IVR frame index");
                if sink.emit_pcm(IvrPcmFrame {
                    egress_leg: playback.egress_leg,
                    marker: playback.emitted_frames == 0,
                    samples: frame,
                }) {
                    playback.frame_index += 1;
                    playback.emitted_frames += 1;
                    self.stats.playback_frames_emitted =
                        self.stats.playback_frames_emitted.saturating_add(1);
                    playback.next_due_ms = playback
                        .next_due_ms
                        .saturating_add((skipped as u64 + 1) * u64::from(PACKETIZATION_MS));
                    if playback.frame_index >= playback.prompt.frame_count() {
                        sink.emit_event(IvrEvent::PlaybackCompleted {
                            command_id: playback.command_id,
                            prompt_id: playback.prompt.id.clone(),
                        });
                    } else {
                        self.playback = Some(playback);
                    }
                } else {
                    self.stats.playback_backpressure =
                        self.stats.playback_backpressure.saturating_add(1);
                    playback.next_due_ms = now_ms.saturating_add(u64::from(PACKETIZATION_MS));
                    self.playback = Some(playback);
                }
            } else {
                self.playback = Some(playback);
            }
        }

        if self
            .gather
            .as_ref()
            .is_some_and(|gather| now_ms >= gather.deadline_ms)
        {
            let gather = self.gather.take().expect("checked active IVR gather");
            emit_gather_completed(gather, GatherCompletionReason::Timeout, sink);
        }
    }

    pub fn cancel_for_session_removal<S: IvrSink>(&mut self, sink: &mut S) {
        if let Some(playback) = self.playback.take() {
            emit_playback_stopped(playback, PlaybackStopReason::SessionRemoved, sink);
        }
        if let Some(gather) = self.gather.take() {
            emit_gather_completed(gather, GatherCompletionReason::SessionRemoved, sink);
        }
    }

    pub fn has_active_playback(&self) -> bool {
        self.playback.is_some()
    }

    pub fn active_playback_egress(&self) -> Option<ProcessingLeg> {
        self.playback.as_ref().map(|state| state.egress_leg)
    }

    pub fn has_active_gather(&self) -> bool {
        self.gather.is_some()
    }

    pub fn next_wakeup_ms(&self) -> Option<u64> {
        [
            self.playback.as_ref().map(|state| state.next_due_ms),
            self.gather.as_ref().map(|state| state.deadline_ms),
        ]
        .into_iter()
        .flatten()
        .min()
    }

    pub fn stats(&self) -> IvrSessionStats {
        self.stats
    }

    fn command_replayed(&self, command_id: &str, payload_hash: [u8; 32]) -> Result<bool, IvrError> {
        let Some(existing) = self
            .commands
            .iter()
            .find(|record| record.command_id.as_ref() == command_id)
        else {
            return Ok(false);
        };
        if existing.payload_hash == payload_hash {
            Ok(true)
        } else {
            Err(IvrError::CommandConflict)
        }
    }

    fn record_command(&mut self, command_id: Arc<str>, payload_hash: [u8; 32]) {
        self.commands.push_back(CommandRecord {
            command_id,
            payload_hash,
        });
        if self.commands.len() > self.config.max_command_history {
            self.commands.pop_front();
        }
    }

    fn record_digit(&mut self, input: IvrDigitInput, result: IvrDigitResult) {
        self.digits.push_back(DigitRecord {
            event_id: input.event_id,
            source: input.source,
            digit: input.digit,
            result,
        });
        if self.digits.len() > self.config.max_digit_history {
            self.digits.pop_front();
        }
    }
}

fn emit_playback_stopped<S: IvrSink>(
    playback: PlaybackState,
    reason: PlaybackStopReason,
    sink: &mut S,
) {
    sink.emit_event(IvrEvent::PlaybackStopped {
        command_id: playback.command_id,
        prompt_id: playback.prompt.id.clone(),
        reason,
    });
}

fn emit_gather_completed<S: IvrSink>(
    gather: GatherState,
    reason: GatherCompletionReason,
    sink: &mut S,
) {
    let minimum_satisfied = gather.digits.chars().count() >= gather.request.minimum_digits;
    sink.emit_event(IvrEvent::GatherCompleted {
        command_id: gather.request.command_id,
        digits: Arc::from(gather.digits),
        reason,
        minimum_satisfied,
    });
}

fn validate_cache_config(config: IvrPromptCacheConfig) -> Result<(), PromptCacheError> {
    if config.max_prompts == 0 || config.max_prompts > MAX_CACHE_PROMPTS {
        return Err(PromptCacheError::InvalidConfiguration {
            field: "max_prompts",
        });
    }
    if config.max_frames_per_prompt == 0 {
        return Err(PromptCacheError::InvalidConfiguration {
            field: "max_frames_per_prompt",
        });
    }
    if config.max_total_pcm_samples < SAMPLES_PER_FRAME {
        return Err(PromptCacheError::InvalidConfiguration {
            field: "max_total_pcm_samples",
        });
    }
    config
        .max_frames_per_prompt
        .checked_mul(SAMPLES_PER_FRAME)
        .ok_or(PromptCacheError::InvalidConfiguration {
            field: "max_frames_per_prompt",
        })?;
    Ok(())
}

fn validate_prompt_id(prompt_id: &str) -> Result<(), PromptCacheError> {
    if !valid_identifier(prompt_id, MAX_PROMPT_ID_BYTES) {
        return Err(PromptCacheError::InvalidPromptId);
    }
    Ok(())
}

fn validate_command_id(command_id: &str) -> Result<(), IvrError> {
    if !valid_identifier(command_id, MAX_COMMAND_ID_BYTES) {
        return Err(IvrError::InvalidCommandId);
    }
    Ok(())
}

fn validate_event_id(event_id: &str) -> Result<(), IvrError> {
    if !valid_identifier(event_id, MAX_COMMAND_ID_BYTES) {
        return Err(IvrError::InvalidDigitEventId);
    }
    Ok(())
}

fn valid_identifier(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum_bytes
        && !value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_whitespace())
}

fn validate_gather(request: &IvrGatherRequest, session_limit: usize) -> Result<(), IvrError> {
    if request.maximum_digits == 0
        || request.maximum_digits > session_limit
        || request.minimum_digits > request.maximum_digits
        || request.first_digit_timeout_ms == 0
        || request.inter_digit_timeout_ms == 0
        || request.terminator.is_some_and(|digit| !is_digit(digit))
    {
        return Err(IvrError::InvalidGather);
    }
    Ok(())
}

fn is_digit(digit: char) -> bool {
    matches!(digit, '0'..='9' | '*' | '#' | 'A'..='D')
}

fn pcm_fingerprint(sample_rate_hz: u32, samples: &[i16]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(sample_rate_hz.to_be_bytes());
    hasher.update((samples.len() as u64).to_be_bytes());
    for sample in samples {
        hasher.update(sample.to_le_bytes());
    }
    hasher.finalize().into()
}

fn playback_hash(request: &IvrPlaybackRequest) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"playback");
    hasher.update((request.prompt.id.len() as u64).to_be_bytes());
    hasher.update(request.prompt.id.as_bytes());
    hasher.update(request.prompt.fingerprint);
    hasher.update([match request.egress_leg {
        ProcessingLeg::A => 0,
        ProcessingLeg::B => 1,
    }]);
    hasher.update([u8::from(request.barge_in)]);
    hasher.finalize().into()
}

fn gather_hash(request: &IvrGatherRequest) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"gather");
    hasher.update((request.minimum_digits as u64).to_be_bytes());
    hasher.update((request.maximum_digits as u64).to_be_bytes());
    hasher.update((request.terminator.unwrap_or('\0') as u32).to_be_bytes());
    hasher.update(request.first_digit_timeout_ms.to_be_bytes());
    hasher.update(request.inter_digit_timeout_ms.to_be_bytes());
    hasher.finalize().into()
}

fn stop_hash(kind: &[u8], target_command_id: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"stop");
    hasher.update(kind);
    hasher.update(target_command_id.as_bytes());
    hasher.finalize().into()
}
