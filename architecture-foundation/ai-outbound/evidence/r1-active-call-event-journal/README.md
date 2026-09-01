# AI outbound R1 Active Call resumable event evidence

## Scope

This record covers the bounded process-local semantic event journal added by the controlled Active
Call overlay and the matching Converact Rust adapter cursor contract. It does not prove a deployed
process, real call, transcript quality, cross-process replay or Worker restart recovery.

The overlay was applied twice to a temporary shared clone of the exact pinned source
`active-call@6224d948cc0941ac48b4a5426477aeaf639c2e98`; both applications independently accepted
the frozen commit/tree and the second application made no conflicting overlay file.

## Proved behavior

- Requests without `Last-Event-ID` preserve the upstream unnumbered event/command route.
- A platform Worker request with numeric `Last-Event-ID` uses a separate contiguous semantic-event
  sequence and receives an SSE `id` on every returned event.
- The journal records only the bounded platform subset: `mediaReady`, `asrFinal`, `interruption`,
  `hold`, `inactivity`, `functionCall` and `hangup`.
- Retention is bounded to 1,024 events, 4 MiB and 64 KiB per event per platform session.
- Eviction, an ahead-of-head cursor, recorder lag, serialization failure or an oversized semantic
  event becomes an explicit coverage gap. Initial replay returns HTTP `410 Gone`; live lag closes
  the stream so the Worker must reconnect from its last durably accepted cursor.
- The adapter sends `Last-Event-ID`, requires contiguous numeric event IDs after resume, and maps
  HTTP `410` and in-stream missing/jumped cursors to `ClientFailureKind::CoverageGap`.

## Precise verification

The following narrow checks were run on 2026-09-01 with Rust `1.94.1`:

```text
node --test infra/converact/active-call/apply-overlay.test.mjs
4 passed, 0 failed

cargo test --locked -p converact-active-call-adapter --test client
14 passed, 0 failed

cargo test --locked --lib platform_event_journal::tests
4 passed, 0 failed, 258 filtered out

cargo test --locked --lib converact_reservation_tests
3 passed, 0 failed, 259 filtered out

rustfmt --edition 2024 --check infra/converact/active-call/platform-event-journal.rs
passed
```

The two Active Call Rust commands ran only inside an isolated overlay clone. A temporary
`Cargo.lock` was generated there and was not copied into either the pinned source checkout or the
Converact repository. No server, container or deployed program was changed.

## Explicitly not proved

- Worker SSE reconnect, cursor persistence and terminal reconciliation;
- behavior after an Active Call process crash, because the journal is intentionally process-local;
- a real SIP/PSTN call or real ASR event stream;
- production capacity, memory pressure, latency or long-call retention adequacy;
- model invocation, intent/emotion accuracy or customer outcome;
- production eligibility.
