# AI outbound R1 Acoustic Emotion Provider evidence

> Date: 2026-09-01
>
> Status: `passed_local_contract / media_tap_not_run / real_model_not_run /
> multimodal_fusion_not_run / production_not_run`

## Proven scope

- Rust `AudioEvidenceWindow` accepts only exact-authority final customer evidence and bounded
  normalized PCM S16 mono 16 kHz;
- time span, transcript coverage and sample count are checked before hashing or inference;
- window identity binds customer track, exact transcript payload, PCM digest and call-relative
  timing without exposing samples or transcript in diagnostics;
- `AcousticEmotionClassifierProvider` binds Release/Catalog/model/feature extractor/label map/
  calibration/sample contract/deadline into one immutable artifact revision;
- serving revision drift, timeout and invalid catalog output fail closed;
- the resulting raw `AcousticModel` observation references both transcript and audio-window evidence
  and owns no business or communication action authority.

## Focused verification

Rust `1.94.1` with `--locked` ran only affected contracts:

```text
converact-contracts / canonical_json: 7 passed
converact-voice-agent-worker / acoustic_emotion_classifier: 3 passed
scoped Clippy: passed with -D warnings
```

The tests first failed because the opaque-byte digest, PCM window and Acoustic Provider did not
exist.

## Explicitly not proved

- real PCM tap/resampling from RustPBX, voice-media-rs, Active Call or LiveKit;
- durable audio-window/PCM storage and recording correlation;
- real acoustic model accuracy, calibration, multilingual/noise robustness or quality gates;
- multimodal fusion, physical PostgreSQL, production, fleet, capacity or performance.

No server, container, deployed service or remote repository was changed.
