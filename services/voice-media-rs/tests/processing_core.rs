use audio_codec::{create_decoder, create_encoder, CodecType};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};
use std::thread;
use voice_media_rs::capacity::{CapacityError, CodecPairCapacity};
use voice_media_rs::codec::{AudioCodec, CodecPair};
use voice_media_rs::frame::RtpAudioFrame;
use voice_media_rs::jitter::{BoundedJitterBuffer, JitterPop, JitterPush};
use voice_media_rs::pipeline::{Concealment, PipelineConfig, ProcessingPipeline};

fn pair(source: AudioCodec, target: AudioCodec) -> CodecPair {
    CodecPair::new(source, target).expect("supported codec pair")
}

fn frame(sequence: u16, timestamp: u32, payload: Vec<u8>) -> RtpAudioFrame {
    RtpAudioFrame {
        sequence,
        timestamp,
        payload_type: 0,
        marker: false,
        payload: payload.into(),
    }
}

fn sine(sample_rate: usize, samples: usize) -> Vec<i16> {
    (0..samples)
        .map(|index| {
            let phase = 2.0 * std::f64::consts::PI * 440.0 * index as f64 / sample_rate as f64;
            (phase.sin() * 8_000.0) as i16
        })
        .collect()
}

fn encode(codec: CodecType, pcm: &[i16]) -> Vec<u8> {
    create_encoder(codec).encode(pcm)
}

fn codec_type(codec: AudioCodec) -> CodecType {
    match codec {
        AudioCodec::Pcmu => CodecType::PCMU,
        AudioCodec::Pcma => CodecType::PCMA,
        AudioCodec::Opus => CodecType::Opus,
    }
}

#[test]
fn codec_registry_is_fixed_and_unknown_codecs_fail_closed() {
    assert_eq!(
        AudioCodec::try_from("PCMU").expect("PCMU"),
        AudioCodec::Pcmu
    );
    assert_eq!(
        AudioCodec::try_from("opus").expect("Opus"),
        AudioCodec::Opus
    );
    assert!(AudioCodec::try_from("G729").is_err());

    assert_eq!(AudioCodec::Pcmu.label(), "PCMU");
    assert_eq!(AudioCodec::Pcmu.sample_rate(), 8_000);
    assert_eq!(AudioCodec::Opus.sample_rate(), 48_000);
    assert_eq!(AudioCodec::Opus.clock_rate(), 48_000);
    assert_eq!(AudioCodec::Opus.payload_type(), 111);

    assert_eq!(CodecPair::ALL.len(), 6);
    assert_eq!(
        pair(AudioCodec::Pcmu, AudioCodec::Opus).label(),
        "PCMU_TO_OPUS"
    );
    assert!(CodecPair::new(AudioCodec::Pcmu, AudioCodec::Pcmu).is_err());
}

#[test]
fn codec_pair_slots_exhaust_and_release_without_cross_pair_borrowing() {
    let capacity = CodecPairCapacity::uniform(1);
    let pcmu_to_opus = pair(AudioCodec::Pcmu, AudioCodec::Opus);
    let opus_to_pcmu = pair(AudioCodec::Opus, AudioCodec::Pcmu);

    let permit = capacity
        .try_acquire(pcmu_to_opus)
        .expect("first pair permit");
    assert_eq!(
        capacity
            .try_acquire(pcmu_to_opus)
            .expect_err("pair must be exhausted"),
        CapacityError::Exhausted {
            pair: pcmu_to_opus,
            limit: 1,
        }
    );

    let independent = capacity
        .try_acquire(opus_to_pcmu)
        .expect("reverse pair has independent capacity");
    assert_eq!(capacity.snapshot(pcmu_to_opus).used, 1);
    assert_eq!(capacity.snapshot(pcmu_to_opus).rejected, 1);
    assert_eq!(capacity.snapshot(opus_to_pcmu).used, 1);

    drop(permit);
    assert_eq!(capacity.snapshot(pcmu_to_opus).used, 0);
    drop(independent);
}

#[test]
fn codec_pair_permits_survive_repeated_acquire_release() {
    let capacity = CodecPairCapacity::uniform(1);
    let codec_pair = pair(AudioCodec::Pcma, AudioCodec::Opus);

    for _ in 0..10_000 {
        let permit = capacity.try_acquire(codec_pair).expect("permit");
        assert_eq!(capacity.snapshot(codec_pair).used, 1);
        drop(permit);
    }

    let snapshot = capacity.snapshot(codec_pair);
    assert_eq!(snapshot.used, 0);
    assert_eq!(snapshot.rejected, 0);
}

#[test]
fn codec_pair_slots_remain_bounded_under_concurrent_admission() {
    let capacity = Arc::new(CodecPairCapacity::uniform(4));
    let codec_pair = pair(AudioCodec::Pcmu, AudioCodec::Opus);
    let attempted = Arc::new(Barrier::new(17));
    let release = Arc::new(Barrier::new(17));
    let accepted = Arc::new(AtomicUsize::new(0));
    let mut workers = Vec::new();

    for _ in 0..16 {
        let capacity = Arc::clone(&capacity);
        let attempted = Arc::clone(&attempted);
        let release = Arc::clone(&release);
        let accepted = Arc::clone(&accepted);
        workers.push(thread::spawn(move || {
            let permit = capacity.try_acquire(codec_pair).ok();
            if permit.is_some() {
                accepted.fetch_add(1, Ordering::Relaxed);
            }
            attempted.wait();
            release.wait();
            drop(permit);
        }));
    }

    attempted.wait();
    assert_eq!(accepted.load(Ordering::Relaxed), 4);
    assert_eq!(capacity.snapshot(codec_pair).used, 4);
    assert_eq!(capacity.snapshot(codec_pair).rejected, 12);
    release.wait();
    for worker in workers {
        worker.join().expect("capacity worker");
    }
    assert_eq!(capacity.snapshot(codec_pair).used, 0);
}

#[test]
fn jitter_buffer_reorders_suppresses_duplicates_and_emits_bounded_gap() {
    let mut jitter = BoundedJitterBuffer::new(4, 2).expect("jitter buffer");

    assert_eq!(
        jitter.push(frame(10, 1_600, vec![10])),
        JitterPush::Accepted
    );
    assert!(matches!(
        jitter.pop(),
        JitterPop::Frame(RtpAudioFrame { sequence: 10, .. })
    ));

    assert_eq!(
        jitter.push(frame(12, 1_920, vec![12])),
        JitterPush::Accepted
    );
    assert_eq!(
        jitter.push(frame(12, 1_920, vec![12])),
        JitterPush::Duplicate
    );
    assert_eq!(jitter.pop(), JitterPop::Waiting);

    assert_eq!(
        jitter.push(frame(13, 2_080, vec![13])),
        JitterPush::Accepted
    );
    assert_eq!(jitter.pop(), JitterPop::Gap { sequence: 11 });
    assert!(matches!(
        jitter.pop(),
        JitterPop::Frame(RtpAudioFrame { sequence: 12, .. })
    ));
    assert!(matches!(
        jitter.pop(),
        JitterPop::Frame(RtpAudioFrame { sequence: 13, .. })
    ));
    assert_eq!(jitter.push(frame(11, 1_760, vec![11])), JitterPush::Late);

    let stats = jitter.stats();
    assert_eq!(stats.accepted, 3);
    assert_eq!(stats.duplicate, 1);
    assert_eq!(stats.late, 1);
    assert_eq!(stats.gaps, 1);
    assert!(jitter.len() <= jitter.capacity());
}

#[test]
fn jitter_buffer_turns_burst_loss_into_a_bounded_number_of_gaps() {
    let mut jitter = BoundedJitterBuffer::new(8, 2).expect("jitter buffer");
    jitter.push(frame(10, 1_600, vec![10]));
    assert!(matches!(jitter.pop(), JitterPop::Frame(_)));

    jitter.push(frame(15, 2_400, vec![15]));
    assert_eq!(jitter.pop(), JitterPop::Gap { sequence: 11 });
    assert_eq!(jitter.pop(), JitterPop::Gap { sequence: 12 });
    assert_eq!(jitter.pop(), JitterPop::Gap { sequence: 13 });
    assert_eq!(jitter.pop(), JitterPop::Waiting);

    jitter.push(frame(16, 2_560, vec![16]));
    assert_eq!(jitter.pop(), JitterPop::Gap { sequence: 14 });
    assert!(matches!(
        jitter.pop(),
        JitterPop::Frame(RtpAudioFrame { sequence: 15, .. })
    ));
    assert!(matches!(
        jitter.pop(),
        JitterPop::Frame(RtpAudioFrame { sequence: 16, .. })
    ));
    assert_eq!(jitter.stats().gaps, 4);
    assert!(jitter.len() <= jitter.capacity());
}

#[test]
fn jitter_buffer_handles_sequence_wrap_and_rejects_far_ahead_packets() {
    let mut jitter = BoundedJitterBuffer::new(4, 2).expect("jitter buffer");

    assert_eq!(
        jitter.push(frame(u16::MAX, u32::MAX - 159, vec![1])),
        JitterPush::Accepted
    );
    assert!(matches!(
        jitter.pop(),
        JitterPop::Frame(RtpAudioFrame {
            sequence: u16::MAX,
            ..
        })
    ));
    assert_eq!(jitter.push(frame(0, 0, vec![2])), JitterPush::Accepted);
    assert!(matches!(
        jitter.pop(),
        JitterPop::Frame(RtpAudioFrame { sequence: 0, .. })
    ));
    assert_eq!(
        jitter.push(frame(8, 1_280, vec![8])),
        JitterPush::TooFarAhead { distance: 7 }
    );
    assert_eq!(jitter.stats().too_far_ahead, 1);
}

#[test]
fn all_six_goal4_codec_pairs_produce_decodable_audio() {
    for codec_pair in CodecPair::ALL {
        let source = codec_pair.source();
        let target = codec_pair.target();
        let pcm = sine(source.sample_rate() as usize, source.samples_per_packet(20));
        let input = frame(1, 0, encode(codec_type(source), &pcm));
        let mut pipeline = ProcessingPipeline::new(PipelineConfig {
            pair: codec_pair,
            packetization_ms: 20,
            target_payload_type: target.payload_type(),
            initial_output_sequence: 10,
            initial_output_timestamp: 20,
            max_conceal_frames: 2,
        })
        .expect("supported pipeline");

        let output = pipeline
            .process(&input)
            .unwrap_or_else(|error| panic!("{} failed: {error}", codec_pair.label()));
        assert_eq!(output.frame.payload_type, target.payload_type());
        assert!(
            !output.frame.payload.is_empty(),
            "{} produced an empty payload",
            codec_pair.label()
        );
        let decoded = create_decoder(codec_type(target)).decode(&output.frame.payload);
        assert_eq!(
            decoded.len(),
            target.samples_per_packet(20),
            "{} decoded sample count",
            codec_pair.label()
        );
    }
}

#[test]
fn pipeline_transcodes_g711_and_opus_in_both_directions() {
    let input_pcm = sine(8_000, 160);
    let input = frame(40, 3_200, encode(CodecType::PCMU, &input_pcm));
    let mut to_opus = ProcessingPipeline::new(PipelineConfig {
        pair: pair(AudioCodec::Pcmu, AudioCodec::Opus),
        packetization_ms: 20,
        target_payload_type: 111,
        initial_output_sequence: 2_000,
        initial_output_timestamp: 48_000,
        max_conceal_frames: 2,
    })
    .expect("PCMU to Opus pipeline");

    let opus = to_opus.process(&input).expect("Opus output");
    assert_eq!(opus.frame.sequence, 2_000);
    assert_eq!(opus.frame.timestamp, 48_000);
    assert_eq!(opus.frame.payload_type, 111);
    assert!(!opus.frame.payload.is_empty());
    assert_eq!(opus.concealment, Concealment::None);

    let mut to_pcmu = ProcessingPipeline::new(PipelineConfig {
        pair: pair(AudioCodec::Opus, AudioCodec::Pcmu),
        packetization_ms: 20,
        target_payload_type: 0,
        initial_output_sequence: 3_000,
        initial_output_timestamp: 8_000,
        max_conceal_frames: 2,
    })
    .expect("Opus to PCMU pipeline");
    let pcmu = to_pcmu.process(&opus.frame).expect("PCMU output");
    assert_eq!(pcmu.frame.payload_type, 0);
    assert_eq!(pcmu.frame.payload.len(), 160);

    let decoded = create_decoder(CodecType::PCMU).decode(&pcmu.frame.payload);
    let rms = (decoded
        .iter()
        .map(|sample| f64::from(*sample).powi(2))
        .sum::<f64>()
        / decoded.len() as f64)
        .sqrt();
    assert!(rms > 100.0, "round-trip signal RMS was {rms}");

    let pcma_input = frame(41, 3_360, encode(CodecType::PCMA, &input_pcm));
    let mut pcma_to_opus = ProcessingPipeline::new(PipelineConfig {
        pair: pair(AudioCodec::Pcma, AudioCodec::Opus),
        packetization_ms: 20,
        target_payload_type: 111,
        initial_output_sequence: 4_000,
        initial_output_timestamp: 96_000,
        max_conceal_frames: 2,
    })
    .expect("PCMA to Opus pipeline");
    assert!(!pcma_to_opus
        .process(&pcma_input)
        .expect("Opus output")
        .frame
        .payload
        .is_empty());
}

#[test]
fn pipeline_rewrites_sequence_and_timestamp_across_wrap() {
    let pcm = sine(48_000, 960);
    let opus_payload = encode(CodecType::Opus, &pcm);
    let mut pipeline = ProcessingPipeline::new(PipelineConfig {
        pair: pair(AudioCodec::Opus, AudioCodec::Pcmu),
        packetization_ms: 20,
        target_payload_type: 0,
        initial_output_sequence: u16::MAX,
        initial_output_timestamp: u32::MAX - 79,
        max_conceal_frames: 2,
    })
    .expect("pipeline");

    let first = pipeline
        .process(&frame(u16::MAX, u32::MAX - 959, opus_payload.clone()))
        .expect("first frame");
    let second = pipeline
        .process(&frame(0, 0, opus_payload))
        .expect("wrapped frame");

    assert_eq!(first.frame.sequence, u16::MAX);
    assert_eq!(second.frame.sequence, 0);
    assert_eq!(
        second.frame.timestamp.wrapping_sub(first.frame.timestamp),
        160
    );
    assert_eq!(second.frame.timestamp, 80);
}

#[test]
fn pipeline_uses_bounded_plc_then_emits_silence() {
    let pcm = sine(8_000, 160);
    let mut pipeline = ProcessingPipeline::new(PipelineConfig {
        pair: pair(AudioCodec::Pcmu, AudioCodec::Pcma),
        packetization_ms: 20,
        target_payload_type: 8,
        initial_output_sequence: 100,
        initial_output_timestamp: 1_000,
        max_conceal_frames: 2,
    })
    .expect("pipeline");
    let real = pipeline
        .process(&frame(7, 700, encode(CodecType::PCMU, &pcm)))
        .expect("real frame");
    let plc_one = pipeline.conceal().expect("first conceal");
    let plc_two = pipeline.conceal().expect("second conceal");
    let silence = pipeline.conceal().expect("bounded silence");

    assert_eq!(plc_one.concealment, Concealment::DecayedPrevious { run: 1 });
    assert_eq!(plc_two.concealment, Concealment::DecayedPrevious { run: 2 });
    assert_eq!(silence.concealment, Concealment::Silence { run: 3 });
    assert_eq!(plc_one.frame.sequence, real.frame.sequence.wrapping_add(1));
    assert_eq!(
        plc_one.frame.timestamp.wrapping_sub(real.frame.timestamp),
        160
    );

    let mut decoder = create_decoder(CodecType::PCMA);
    let plc_pcm = decoder.decode(&plc_one.frame.payload);
    let silence_pcm = decoder.decode(&silence.frame.payload);
    assert!(plc_pcm.iter().any(|sample| *sample != 0));
    assert!(silence_pcm.iter().all(|sample| sample.abs() <= 8));
}
