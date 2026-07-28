use std::sync::Arc;
use voice_media_rs::ivr::{
    DigitSource, GatherCompletionReason, IvrCommandResult, IvrDigitInput, IvrError, IvrEvent,
    IvrGatherRequest, IvrPcmFrame, IvrPlaybackRequest, IvrPromptCache, IvrPromptCacheConfig,
    IvrSession, IvrSessionConfig, IvrSink, PlaybackStopReason, PromptCacheError,
};
use voice_media_rs::rtp::ProcessingLeg;

fn sine(sample_rate: usize, samples: usize) -> Vec<i16> {
    (0..samples)
        .map(|index| {
            let phase = 2.0 * std::f64::consts::PI * 440.0 * index as f64 / sample_rate as f64;
            (phase.sin() * 8_000.0) as i16
        })
        .collect()
}

fn prompt_cache(max_prompts: usize) -> IvrPromptCache {
    IvrPromptCache::new(IvrPromptCacheConfig {
        max_prompts,
        max_frames_per_prompt: 8,
        max_total_pcm_samples: 8 * 960,
    })
    .expect("prompt cache")
}

fn ivr_session() -> IvrSession {
    IvrSession::new(IvrSessionConfig {
        max_command_history: 16,
        max_digit_history: 16,
        max_gather_digits: 8,
    })
    .expect("IVR session")
}

#[derive(Default)]
struct CaptureSink {
    frames: Vec<(ProcessingLeg, bool, Vec<i16>)>,
    events: Vec<IvrEvent>,
    accept_frames: bool,
}

impl CaptureSink {
    fn accepting() -> Self {
        Self {
            accept_frames: true,
            ..Self::default()
        }
    }
}

impl IvrSink for CaptureSink {
    fn emit_pcm(&mut self, frame: IvrPcmFrame<'_>) -> bool {
        if self.accept_frames {
            self.frames
                .push((frame.egress_leg, frame.marker, frame.samples.to_vec()));
            true
        } else {
            false
        }
    }

    fn emit_event(&mut self, event: IvrEvent) {
        self.events.push(event);
    }
}

#[test]
fn prompt_cache_resamples_frames_and_fails_closed_at_every_limit() {
    let cache = prompt_cache(1);
    let source = sine(8_000, 320);
    let prompt = cache
        .insert_pcm("welcome", 8_000, &source)
        .expect("insert prompt");
    assert_eq!(prompt.sample_rate_hz(), 48_000);
    assert_eq!(prompt.packetization_ms(), 20);
    assert_eq!(prompt.frame_count(), 2);
    assert_eq!(prompt.frame(0).expect("frame").len(), 960);
    assert_eq!(prompt.frame(1).expect("frame").len(), 960);

    let replay = cache
        .insert_pcm("welcome", 8_000, &source)
        .expect("idempotent prompt");
    assert!(Arc::ptr_eq(&prompt, &replay));
    assert_eq!(
        cache
            .insert_pcm("welcome", 8_000, &sine(8_000, 160))
            .expect_err("same id with another body"),
        PromptCacheError::PromptConflict
    );
    assert_eq!(
        cache
            .insert_pcm("other", 8_000, &source)
            .expect_err("prompt count ceiling"),
        PromptCacheError::PromptCapacityExhausted { limit: 1 }
    );
    let frame_limited = prompt_cache(2);
    assert_eq!(
        frame_limited
            .insert_pcm("too-long", 48_000, &sine(48_000, 9 * 960))
            .expect_err("per-prompt frame ceiling"),
        PromptCacheError::PromptFrameCapacityExhausted { limit: 8 }
    );
    let pcm_limited = IvrPromptCache::new(IvrPromptCacheConfig {
        max_prompts: 3,
        max_frames_per_prompt: 8,
        max_total_pcm_samples: 2 * 960,
    })
    .expect("PCM-limited cache");
    pcm_limited
        .insert_pcm("one-frame", 48_000, &sine(48_000, 960))
        .expect("first prompt");
    assert_eq!(
        pcm_limited
            .insert_pcm("two-frames", 48_000, &sine(48_000, 2 * 960))
            .expect_err("global PCM ceiling"),
        PromptCacheError::PcmCapacityExhausted { limit: 2 * 960 }
    );
    assert_eq!(cache.stats().prompt_count, 1);
    assert_eq!(cache.stats().total_pcm_samples, 1_920);
    assert_eq!(
        cache
            .remove("welcome")
            .expect_err("retained prompt must stay accounted"),
        PromptCacheError::PromptInUse
    );
    drop(replay);
    drop(prompt);
    assert!(cache.remove("welcome").expect("remove"));
    assert!(!cache.remove("welcome").expect("idempotent remove"));
}

#[test]
fn playback_is_timed_idempotent_and_never_advances_on_sink_backpressure() {
    let cache = prompt_cache(2);
    let prompt = cache
        .insert_pcm("two-frames", 48_000, &sine(48_000, 1_920))
        .expect("prompt");
    let mut session = ivr_session();
    let request = IvrPlaybackRequest {
        command_id: Arc::from("play-1"),
        prompt,
        egress_leg: ProcessingLeg::B,
        barge_in: true,
        start_at_ms: 100,
    };
    let mut sink = CaptureSink::default();
    assert_eq!(
        session
            .start_playback(request.clone(), &mut sink)
            .expect("start"),
        IvrCommandResult { replayed: false }
    );
    assert_eq!(
        session.start_playback(request, &mut sink).expect("replay"),
        IvrCommandResult { replayed: true }
    );

    session.tick(100, &mut sink);
    assert!(sink.frames.is_empty(), "backpressure must retain the frame");
    sink.accept_frames = true;
    session.tick(119, &mut sink);
    assert!(sink.frames.is_empty());
    session.tick(120, &mut sink);
    assert_eq!(sink.frames.len(), 1);
    assert!(sink.frames[0].1);
    session.tick(139, &mut sink);
    assert_eq!(sink.frames.len(), 1);
    session.tick(140, &mut sink);
    assert_eq!(sink.frames.len(), 2);
    assert!(sink.events.iter().any(|event| matches!(
        event,
        IvrEvent::PlaybackCompleted { command_id, .. } if command_id.as_ref() == "play-1"
    )));
    assert!(!session.has_active_playback());
}

#[test]
fn playback_command_identity_includes_the_business_prompt_id() {
    let cache = prompt_cache(2);
    let samples = sine(48_000, 1_920);
    let first = cache
        .insert_pcm("prompt-a", 48_000, &samples)
        .expect("first prompt");
    let second = cache
        .insert_pcm("prompt-b", 48_000, &samples)
        .expect("second prompt");
    let mut session = ivr_session();
    let mut sink = CaptureSink::accepting();
    session
        .start_playback(
            IvrPlaybackRequest {
                command_id: Arc::from("same-command"),
                prompt: first,
                egress_leg: ProcessingLeg::A,
                barge_in: false,
                start_at_ms: 0,
            },
            &mut sink,
        )
        .expect("first playback");
    assert_eq!(
        session
            .start_playback(
                IvrPlaybackRequest {
                    command_id: Arc::from("same-command"),
                    prompt: second,
                    egress_leg: ProcessingLeg::A,
                    barge_in: false,
                    start_at_ms: 1,
                },
                &mut sink,
            )
            .expect_err("another prompt id must conflict"),
        IvrError::CommandConflict
    );
}

#[test]
fn explicit_stop_commands_are_target_fenced_conflict_safe_and_idempotent() {
    let cache = prompt_cache(2);
    let prompt = cache
        .insert_pcm("stop", 48_000, &sine(48_000, 1_920))
        .expect("prompt");
    let mut session = ivr_session();
    let mut sink = CaptureSink::accepting();
    session
        .start_playback(
            IvrPlaybackRequest {
                command_id: Arc::from("play-stop"),
                prompt,
                egress_leg: ProcessingLeg::A,
                barge_in: false,
                start_at_ms: 0,
            },
            &mut sink,
        )
        .expect("playback");
    session
        .start_gather(
            IvrGatherRequest {
                command_id: Arc::from("gather-stop"),
                minimum_digits: 1,
                maximum_digits: 4,
                terminator: Some('#'),
                first_digit_timeout_ms: 2_000,
                inter_digit_timeout_ms: 1_000,
                start_at_ms: 0,
            },
            &mut sink,
        )
        .expect("gather");

    assert_eq!(
        session
            .stop_playback(Arc::from("stop-wrong"), "another-playback", &mut sink)
            .expect_err("wrong playback target"),
        IvrError::TargetCommandConflict
    );
    assert!(session.has_active_playback());
    assert_eq!(
        session
            .stop_playback(Arc::from("stop-playback"), "play-stop", &mut sink)
            .expect("stop playback"),
        IvrCommandResult { replayed: false }
    );
    assert_eq!(
        session
            .stop_playback(Arc::from("stop-playback"), "play-stop", &mut sink)
            .expect("replay stop playback"),
        IvrCommandResult { replayed: true }
    );
    assert_eq!(
        session
            .stop_playback(Arc::from("stop-playback"), "different", &mut sink)
            .expect_err("same command id with another target"),
        IvrError::CommandConflict
    );

    assert_eq!(
        session
            .stop_gather(Arc::from("stop-gather"), "gather-stop", &mut sink)
            .expect("stop gather"),
        IvrCommandResult { replayed: false }
    );
    assert_eq!(
        session
            .stop_gather(Arc::from("stop-gather"), "gather-stop", &mut sink)
            .expect("replay stop gather"),
        IvrCommandResult { replayed: true }
    );
    assert!(sink.events.iter().any(|event| matches!(
        event,
        IvrEvent::PlaybackStopped {
            reason: PlaybackStopReason::Explicit,
            ..
        }
    )));
    assert!(sink.events.iter().any(|event| matches!(
        event,
        IvrEvent::GatherCompleted {
            reason: GatherCompletionReason::ExplicitStop,
            ..
        }
    )));
}

#[test]
fn rfc4733_barge_in_and_sip_info_share_one_bounded_gather_state_machine() {
    let cache = prompt_cache(2);
    let prompt = cache
        .insert_pcm("long", 48_000, &sine(48_000, 3_840))
        .expect("prompt");
    let mut session = ivr_session();
    let mut sink = CaptureSink::accepting();
    session
        .start_playback(
            IvrPlaybackRequest {
                command_id: Arc::from("play-barge"),
                prompt,
                egress_leg: ProcessingLeg::A,
                barge_in: true,
                start_at_ms: 0,
            },
            &mut sink,
        )
        .expect("playback");
    session
        .start_gather(
            IvrGatherRequest {
                command_id: Arc::from("gather-1"),
                minimum_digits: 1,
                maximum_digits: 4,
                terminator: Some('#'),
                first_digit_timeout_ms: 2_000,
                inter_digit_timeout_ms: 1_000,
                start_at_ms: 0,
            },
            &mut sink,
        )
        .expect("gather");
    session.tick(0, &mut sink);

    let first = session
        .observe_digit(
            IvrDigitInput {
                event_id: Arc::from("rtp-5"),
                source: DigitSource::Rfc4733,
                digit: '5',
                occurred_at_ms: 100,
            },
            &mut sink,
        )
        .expect("RTP digit");
    assert!(first.accepted);
    assert!(first.playback_barged_in);
    assert!(!first.gather_completed);
    assert!(!session.has_active_playback());
    assert!(sink.events.iter().any(|event| matches!(
        event,
        IvrEvent::PlaybackStopped {
            reason: PlaybackStopReason::BargeIn,
            ..
        }
    )));

    let replay = session
        .observe_digit(
            IvrDigitInput {
                event_id: Arc::from("rtp-5"),
                source: DigitSource::Rfc4733,
                digit: '5',
                occurred_at_ms: 100,
            },
            &mut sink,
        )
        .expect("replayed RTP digit");
    assert!(replay.replayed);
    assert!(replay.accepted);
    assert!(replay.playback_barged_in);
    assert!(!replay.gather_completed);

    let terminator = session
        .observe_digit(
            IvrDigitInput {
                event_id: Arc::from("sip-info-hash"),
                source: DigitSource::SipInfo,
                digit: '#',
                occurred_at_ms: 200,
            },
            &mut sink,
        )
        .expect("SIP INFO digit");
    assert!(terminator.gather_completed);
    assert!(sink.events.iter().any(|event| matches!(
        event,
        IvrEvent::GatherCompleted {
            command_id,
            digits,
            reason: GatherCompletionReason::Terminator,
            minimum_satisfied: true,
            ..
        } if command_id.as_ref() == "gather-1" && digits.as_ref() == "5"
    )));
}

#[test]
fn gather_timeout_and_late_playback_skip_are_bounded() {
    let cache = prompt_cache(2);
    let prompt = cache
        .insert_pcm("four", 48_000, &sine(48_000, 3_840))
        .expect("prompt");
    let mut session = ivr_session();
    let mut sink = CaptureSink::accepting();
    session
        .start_playback(
            IvrPlaybackRequest {
                command_id: Arc::from("play-late"),
                prompt,
                egress_leg: ProcessingLeg::B,
                barge_in: false,
                start_at_ms: 0,
            },
            &mut sink,
        )
        .expect("playback");
    session
        .start_gather(
            IvrGatherRequest {
                command_id: Arc::from("gather-timeout"),
                minimum_digits: 1,
                maximum_digits: 4,
                terminator: None,
                first_digit_timeout_ms: 100,
                inter_digit_timeout_ms: 50,
                start_at_ms: 0,
            },
            &mut sink,
        )
        .expect("gather");

    session.tick(60, &mut sink);
    assert_eq!(sink.frames.len(), 1, "late tick must not burst frames");
    assert_eq!(session.stats().late_playback_frames_skipped, 3);
    session.tick(100, &mut sink);
    assert!(sink.events.iter().any(|event| matches!(
        event,
        IvrEvent::GatherCompleted {
            reason: GatherCompletionReason::Timeout,
            minimum_satisfied: false,
            ..
        }
    )));
}

#[test]
fn a_digit_at_or_after_the_deadline_times_out_gather_before_processing() {
    let mut session = ivr_session();
    let mut sink = CaptureSink::accepting();
    session
        .start_gather(
            IvrGatherRequest {
                command_id: Arc::from("gather-deadline"),
                minimum_digits: 1,
                maximum_digits: 4,
                terminator: None,
                first_digit_timeout_ms: 100,
                inter_digit_timeout_ms: 50,
                start_at_ms: 0,
            },
            &mut sink,
        )
        .expect("gather");
    let late = session
        .observe_digit(
            IvrDigitInput {
                event_id: Arc::from("late-digit"),
                source: DigitSource::SipInfo,
                digit: '5',
                occurred_at_ms: 100,
            },
            &mut sink,
        )
        .expect("late digit");
    assert!(!late.accepted);
    assert!(!late.gather_completed);
    assert!(!session.has_active_gather());
    assert!(sink.events.iter().any(|event| matches!(
        event,
        IvrEvent::GatherCompleted {
            command_id,
            digits,
            reason: GatherCompletionReason::Timeout,
            minimum_satisfied: false,
        } if command_id.as_ref() == "gather-deadline" && digits.is_empty()
    )));
}

#[test]
fn inter_digit_timeout_is_rebased_only_by_an_accepted_digit() {
    let mut session = ivr_session();
    let mut sink = CaptureSink::accepting();
    session
        .start_gather(
            IvrGatherRequest {
                command_id: Arc::from("gather-inter-digit"),
                minimum_digits: 2,
                maximum_digits: 4,
                terminator: None,
                first_digit_timeout_ms: 100,
                inter_digit_timeout_ms: 50,
                start_at_ms: 0,
            },
            &mut sink,
        )
        .expect("gather");
    let first = session
        .observe_digit(
            IvrDigitInput {
                event_id: Arc::from("first-digit"),
                source: DigitSource::SipInfo,
                digit: '4',
                occurred_at_ms: 20,
            },
            &mut sink,
        )
        .expect("first digit");
    assert!(first.accepted);
    session.tick(69, &mut sink);
    assert!(session.has_active_gather());
    session.tick(70, &mut sink);
    assert!(!session.has_active_gather());
    assert!(sink.events.iter().any(|event| matches!(
        event,
        IvrEvent::GatherCompleted {
            command_id,
            digits,
            reason: GatherCompletionReason::Timeout,
            minimum_satisfied: false,
        } if command_id.as_ref() == "gather-inter-digit" && digits.as_ref() == "4"
    )));
}
