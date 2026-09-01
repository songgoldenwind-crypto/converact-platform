# Multimodal Emotion Fusion R1 implementation plan

> Date: 2026-09-01
>
> Scope: text observation + acoustic observation → fused Emotion checkpoint

## Goal

Combine independently calibrated text and acoustic evidence deterministically while making modal
disagreement reduce confidence instead of creating a false high-confidence customer state.

## Frozen contract

- Exactly one `TextClassifier` observation and one `AcousticModel` observation are accepted.
- Both contributors must bind the same Release/Catalog/authority/turn; text must have transcript
  evidence and no audio evidence, while acoustic must reference transcript and audio-window evidence.
- Release policy assigns positive text/acoustic weights totaling exactly 10,000 basis points, a
  positive candidate floor and top-k between 1 and 5; its content-addressed revision enters fusion
  identity.
- For each label, a missing modality contributes zero. Confidence is the sum of calibrated modality
  confidence × modality weight divided by 10,000. Intensity uses the same weights and deterministic
  nearest-integer rounding.
- Candidates below the floor are removed; remaining candidates sort by confidence, intensity and
  code before top-k truncation.
- One fused result advances the previous `EmotionState` exactly once and retains both raw
  contributors for durable evidence.
- Fusion has no Handoff, Tool, Telephony or Media action port.

## Minimal TDD proof

1. Agreeing high-confidence text/acoustic evidence becomes one confirmed state with two raw records.
2. Conflicting high-confidence labels are diluted and cannot become false confirmed state.
3. Invalid weight totals and turn/source drift fail closed without mutating previous state.
4. Re-run text-emotion compatibility and scoped Clippy only.

## Explicit exclusions

- actual media tap and real text/acoustic model runtimes;
- missing-acoustic fallback policy and final-transcript processor integration;
- model calibration/quality evaluation, physical PostgreSQL, production, capacity or performance.
