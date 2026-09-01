# Final Transcript Understanding Processor R1 implementation plan

> Date: 2026-09-01
>
> Scope: durable final transcript window → recover → resolve → complete turn → persist

## Goal

Compose the existing Rust understanding modules into one bounded runtime path for each newly
appended current final customer transcript, while preventing replay/historical inputs from invoking
models again.

## Frozen contract

- The transcript append boundary supplies `appended_current`, `replayed_current` or `historical`
  before model invocation.
- Replay and historical dispositions return immediately: no understanding-head read, classifier or
  append call occurs.
- `appended_current` requires a bounded durable-sequence history ending at the exact customer final.
- One consistent four-head snapshot is restored. The next turn is `max(Intent, Emotion) + 1` and
  overflow fails closed.
- Intent runs through Safety/Fast/Contextual; Emotion runs through Text Classifier and explicit
  text-only fusion; both advance from the recovered states.
- Customer State/Dialogue and raw evidence/four heads are prepared deterministically and persisted
  through one `UnderstandingDurabilityPort` append.
- The processor has no Tool, Handoff, Telephony or Media action port.

## Minimal TDD proof

1. Start from a valid all-empty recovered graph.
2. Process a Store-ordered final customer segment through Safety Intent and text Emotion.
3. Observe one recovery, one text model call and one complete-batch append.
4. Reprocess as replay and historical; prove recovery/model/append counters do not change.
5. Run only Worker recovery/processor tests and scoped Clippy.

## Explicit exclusions

- mapping the concrete PostgreSQL transcript append receipt into the disposition;
- loading the bounded typed transcript history from PostgreSQL;
- real Active Call SSE consumer and real model adapters;
- acoustic/multimodal Emotion, physical PostgreSQL, production, capacity or performance.
