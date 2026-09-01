# Acoustic Emotion Provider R1 implementation plan

> Date: 2026-09-01
>
> Scope: normalized customer PCM window → acoustic Emotion observation

## Goal

Add a provider-neutral Rust acoustic-emotion boundary without pretending transcript text is acoustic
evidence and without adding any Telephony, Media, Handoff or Tool authority.

## Frozen contract

- One `AudioEvidenceWindow` belongs to an exact final customer transcript segment and authority.
- Input is normalized PCM S16 mono at 16 kHz; the first contract accepts 200–15,000 ms and requires
  exactly 16 samples per millisecond.
- The window must cover the transcript segment offsets, bind the exact customer track, transcript
  payload hash and PCM byte digest, and receive a content-addressed ID.
- PCM samples and transcript text never appear in `Debug` or errors.
- One immutable acoustic artifact binds Agent Release, Emotion Catalog, model, feature extractor,
  label map, calibration, sample format, maximum window/candidates and inference deadline.
- Serving must echo the exact artifact revision. Timeout, drift, unknown labels, invalid intensity,
  oversized output and authority mismatch fail closed.
- Output is raw `AcousticModel` evidence referencing both the transcript segment and audio window;
  it cannot advance Emotion State without an explicit fusion runtime.

## Minimal TDD proof

1. Verify raw byte SHA-256 against a known vector.
2. Build a 1-second aligned customer PCM window and reject non-customer, misaligned and oversized
   variants before inference.
3. Invoke one fake acoustic classifier and verify exact Release/Catalog/evidence bindings.
4. Fail closed on artifact drift, timeout and unknown catalog labels.
5. Run only Contracts, Acoustic Provider and scoped Clippy.

## Explicit exclusions

- the actual RustPBX/voice-media-rs/Active Call PCM tap and resampler;
- durable audio-window metadata or raw PCM storage;
- a real acoustic model runtime, model quality/calibration evidence and language/noise evaluation;
- text+acoustic fusion, production, capacity or performance.
