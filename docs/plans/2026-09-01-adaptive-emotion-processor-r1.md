# Adaptive Emotion Processor R1 implementation plan

> Date: 2026-09-01
>
> Scope: final customer transcript + optional exact PCM window → one atomic understanding turn

## Goal

Connect text and acoustic emotion evidence to the authoritative final-transcript processor without
allowing an optional model, recorder or audio-window delay to interrupt a live call.

## Frozen contract

- One final customer transcript remains the turn anchor. Any supplied audio window must bind its
  exact authority and `TranscriptSegmentId` before either emotion model is invoked.
- A successful acoustic observation and text observation must cite the same transcript segment,
  Catalog and turn. The conservative Release-bound fusion advances Emotion State once.
- Release policy has two closed modes: require multimodal evidence, or fall back to text only when
  the audio window is missing or acoustic serving is unavailable/timed out.
- Artifact drift, invalid classifier output, Catalog/authority drift and evidence mismatch never
  fall back. They fail understanding without acquiring Telephony, Media, Tool or Handoff authority.
- Every text-only path has a distinct stable `fusion_revision`: configured text-only, missing-audio
  fallback, acoustic-unavailable fallback or acoustic-timeout fallback. The durable checkpoint
  therefore records why one modality was absent.
- Replay and historical transcript receipts return before recovery or model invocation.
- Intent resolution, emotion resolution, Customer State and Dialogue continue to enter one fenced
  durable turn batch with all raw Provider observations used by the decision.

## Minimal TDD proof

1. Missing audio, acoustic unavailable and acoustic timeout preserve text evidence with distinct
   durable fallback revisions; require-multimodal rejects missing evidence.
2. Valid text and acoustic evidence produce two raw emotion records and one fusion in the complete
   atomic turn.
3. Same-turn observations citing different transcript segments fail closed.
4. Re-run only text/acoustic/fusion/understanding Worker tests and scoped Clippy.

## Explicit exclusions

- actual Active Call/RustPBX media tap, resampler and audio-window durability;
- real text/acoustic model binaries, model pool, quality calibration and tenant rollout;
- physical PostgreSQL, process composition, restart/two-node tests and production;
- performance, capacity and broad regression testing.
