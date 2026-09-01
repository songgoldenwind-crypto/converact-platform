# AI outbound R1 durable Active Call event consumer evidence

> Date: 2026-09-01
>
> Status: `passed_local_contract / physical_postgresql_passed /
> live_active_call_not_run / production_not_run`

## Proven scope

- the Worker loads a generation-fenced durable cursor and complete bounded pending suffix before
  opening a new Active Call SSE connection;
- each accepted semantic event is canonical-hashed and appended before projection, then
  acknowledged strictly in cursor order only after processing succeeds;
- Worker restart drains pending events first, including a pending terminal event, without opening
  another source connection;
- processor failure leaves the exact event pending; the concrete transcript/understanding path is
  replay-idempotent through its stable source event and transcript identities;
- clean EOF queries the Active Call session: an active session returns a reconnect outcome and a
  disappeared session enters durable `session_disappeared` reconciliation;
- HTTP `410 Gone` enters durable `coverage_gap` reconciliation without invoking projections;
- command frames remain outside the semantic cursor, terminal projection completes the inbox, and
  durable cursors are bounded to PostgreSQL `BIGINT`;
- migration 136 stores full non-trace authority, one head per interaction generation and at most
  1,024 pending events; append/replay/apply/reconcile are database-clocked atomic functions;
- once reconciliation wins the session-row fence, both a later append and a pending-event
  acknowledgement are rejected;
- the runtime role has read-only RLS table access plus narrowly granted transition functions. An
  ephemeral PostgreSQL 14.18 run proved append, pending replay, ordered apply, terminal completion,
  reconciliation, tenant visibility and rejected cross-tenant mutation.

The generic processor contract is at-least-once. A future processor that adds effects beyond the
current replay-safe transcript coordinator must bind them to the event cursor/digest through its own
durable effect oracle before it can be attached here.

## Precise verification

Rust `1.94.1` with `--locked`:

```text
cargo test --locked -p converact-voice-agent-worker --test active_call_event_consumer
9 passed, 0 failed

cargo test --locked -p converact-postgres-store --test active_call_event_inbox_contract
3 passed, 0 failed

cargo clippy --locked -p converact-postgres-store --lib \
  --test active_call_event_inbox_contract -- -D warnings
passed

cargo clippy --locked -p converact-voice-agent-worker --lib \
  --test active_call_event_consumer -- -D warnings
passed

sqlite3 :memory: < src/schema.sql
passed

ephemeral PostgreSQL 14.18: apply migration 136, then exercise the transition functions,
reconciliation write fence and RLS as opc_runtime
passed

git diff --check
passed
```

No broad regression suite, Docker, remote server, deployed process or performance test was used.
The temporary PostgreSQL process was stopped and its exact temporary directory was moved to the
system Trash after each run.

## Explicitly not proved

- a running pinned Active Call process and live SSE reconnect;
- behavior after the Active Call source process loses its process-local journal;
- real SIP/PSTN audio, ASR transcript, Intent/Emotion model or customer outcome;
- production migration runner, rolling deployment, multi-node race or disaster recovery;
- capacity, performance, long-call retention and production eligibility.
