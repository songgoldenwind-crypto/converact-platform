# Text-only Emotion Turn Runtime R1 implementation plan

> Date: 2026-09-01
>
> Scope: raw text observation → explicit text-only fusion → Emotion checkpoint

## Goal

Close the functional text-emotion turn without pretending that acoustic evidence or multimodal
fusion exists. Preserve the raw Provider observation so downstream storage can commit it beside the
authoritative Emotion checkpoint.

## Frozen contract

- Raw `EmotionObservation` has a closed versioned wire codec and revalidates its canonical hash.
- `TextEmotionTurnRuntime` accepts exactly `TextClassifier` evidence from the configured Release
  Emotion Catalog.
- The runtime wraps the calibrated top-k unchanged in `text-only-emotion-fusion-v1`; it does not
  invent audio features or combine incomparable scores.
- Fusion ID is content-addressed by the raw observation, strategy revision and turn.
- The shared Emotion state machine advances once and closes an `EmotionCheckpoint`.
- The result retains raw contributors and can encode them only as record-only
  `emotion_observation` evidence. It owns no business action authority.

## Minimal TDD proof

1. Prove raw observation round-trip and hash-drift rejection.
2. Prove one text observation creates one confirmed text-only checkpoint.
3. Prove raw evidence is record-only and cannot advance the Emotion head.
4. Run only Emotion Core, Text Provider/runtime and scoped Clippy.

## Explicit exclusions

- PCM/media-tap audio window and Acoustic Provider;
- multimodal fusion algorithm, model calibration and quality;
- four-domain atomic turn write, physical PostgreSQL and process composition;
- production, fleet, capacity or performance qualification.
