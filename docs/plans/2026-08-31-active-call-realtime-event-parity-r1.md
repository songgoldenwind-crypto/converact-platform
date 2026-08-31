# Active Call realtime event parity R1 implementation plan

> **Status:** `controlled_adapter_contract_passed / live_runtime_not_run / production_not_run`

**Goal:** Preserve the pinned Active Call runtime's existing VAD, turn, barge-in, DTMF and call-state
signals behind the Converact Rust adapter without reimplementing speech algorithms or granting Active
Call Campaign, Call, media, workflow or result authority.

**Architecture:** Extend only the private upstream mirror and fail-closed mapper in
`converact-active-call-adapter`. Events retain the existing validated Converact authority envelope
and execution generation. Real-time control signals remain transient; durable observations contain
no TTS subtitle, Play URL, utterance text or raw DTMF in `Debug` output.

## Frozen behavior

1. Accept the exact pinned `0.3.83` wire shapes for `speaking`, `eou`, `interruption`, `dtmf`, `hold`
   and `inactivity`; all other newly encountered event tags continue to fail closed.
2. `speaking` maps speech start, filler classification and optional bounded confidence. It does not
   run a second VAD or infer business intent.
3. `eou` maps only the completed flag and timing boundary. Optional upstream utterance text and TTS
   interrupt text are deliberately not copied into this control event.
4. `interruption` maps timing only and validates elapsed time does not exceed total playback time.
   Upstream subtitle and `playId` are deliberately excluded because they may contain prompt text,
   file URLs or credentials.
5. `dtmf` accepts exactly one of `0-9`, `*`, `#`, `A-D`, exposes it through an explicit accessor and
   redacts it from `Debug`. It remains transient so raw keypad sequences do not enter durable
   projections accidentally.
6. `hold` and `inactivity` are normalized observations only. RustPBX remains the telephone
   Call/Leg authority and Converact policy decides any follow-up action.
7. Speech start, EOU and DTMF are transient; playback interruption, hold and inactivity are durable
   observations. Every event carries the existing generation fence.
8. Malformed identifier, timestamp, confidence, DTMF or playback timing fails with a stable
   low-cardinality adapter code and never includes content.

## TDD sequence

1. Add exact-source JSON fixtures and failing mapping tests for all six events, durability,
   generation and DTMF redaction.
2. Add invalid DTMF, impossible playback timing and unknown-event rejection tests.
3. Extend the private upstream enum and mapper with the smallest bounded types and validators.
4. Run only `converact-active-call-adapter --test mapping`, its existing command/client tests, scoped
   formatting and Clippy. Do not run Docker, server, performance or broad regression tests.
5. Record local contract evidence. Real Active Call process, audio, VAD quality, barge-in latency,
   SIP/PSTN, RustPBX, physical database and production remain `not_run`.

## Completion boundary

R1 is locally complete at adapter-contract level: the exact wire fixtures map with the frozen
safety rules and the existing command/client behavior remains green. This is not evidence that a
real customer can interrupt a deployed call; the pinned Active Call process and RustPBX path still
require separate live evidence.

## Follow-on output-control checkpoint

The same adapter now encodes the exact `pause`, `resume` and non-graceful `interrupt` commands used
to silence and later resume Agent output during AI/human ownership changes. Fade-out is bounded to
two seconds. The safe command enum deliberately exposes no hangup, REFER or bridge operation, so
telephone control stays behind RustPBX. Live command delivery and handoff behavior remain
`not_run`.
