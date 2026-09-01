# Active Call realtime event parity R1 implementation plan

> **Status:** `controlled_adapter_and_resumable_source_contract_passed /
> durable_worker_consumer_and_physical_store_passed / live_process_not_run / production_not_run`

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

## Follow-on resumable-source checkpoint

The exact-source overlay now offers a separate platform-only semantic event journal when a request
supplies numeric `Last-Event-ID`. It assigns contiguous SSE IDs, replays retained events, preserves
the legacy stream when the header is absent, and returns `410 Gone` instead of silently accepting
evicted, ahead-of-head or recorder-lag coverage. Retention is bounded by count and bytes and remains
process-local. The matching Rust adapter validates the cursor on every resumed event.

## Follow-on durable Worker checkpoint

The Rust Worker now loads its durable cursor and complete bounded pending suffix before opening an
SSE connection. It stores each canonical event payload and cursor before projection, applies pending
events in order after restart, sends the last received cursor on resume, and advances the applied
cursor only after the processor returns successfully. The concrete transcript processor is
replay-idempotent: a crash after its durable turn commit but before cursor acknowledgement replays
the transcript receipt and skips model work. Any future effectful event processor must provide the
same stable idempotency contract.

Clean EOF and recoverable stream errors query `/list`: an active session requests a supervisor-
scheduled reconnect, while a disappeared session enters durable reconciliation. HTTP `410`, missing
event IDs and cursor coverage loss enter the same fail-closed reconciliation boundary. A terminal
event completes only after its projection is acknowledged. Neither the consumer nor Store creates
an unbounded retry task or sleeps internally.

Migration `136_converact_active_call_event_inbox.sql` adds a generation-fenced cursor head and
bounded inbox. PostgreSQL functions serialize append, exact replay, ordered acknowledgement and
reconciliation under one session-row lock. Direct runtime mutation is withheld; the runtime role
receives tenant-filtered reads and `SECURITY DEFINER` transition functions that recheck
`opc_current_tenant()`. The migration and transitions passed an ephemeral PostgreSQL 14.18 smoke
test as `opc_runtime`, including an RLS visibility check and rejected cross-tenant mutation.

The running pinned Active Call process, a real SIP/PSTN call, real ASR/model traffic, Active Call
process-crash behavior, capacity, long-call retention and production eligibility remain `not_run`.
