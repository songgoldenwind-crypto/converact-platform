# AI outbound R1 Transcript Understanding Source evidence

> Date: 2026-09-01
>
> Status: `passed_local_contract / physical_postgres_not_run / real_models_not_run /
> production_not_run`

## Proven scope

- PostgreSQL append/replay plus current/historical outcomes have one exhaustive mapping into the
  final-transcript understanding processor dispositions;
- replayed-current and both historical outcomes skip the history port entirely;
- only newly appended current input loads one 1–32 segment typed history window;
- the SQL query is fenced by tenant, Interaction, Attempt, Release, execution generation and
  current sequence, and is bounded before execution;
- stored rows are reconstructed into domain `TranscriptSegment` values and canonical hash/order/
  authority/exact-current-anchor drift fails closed;
- adapter failures expose one redacted low-cardinality history error.

## Focused verification

Rust `1.94.1` with `--locked` ran only affected contracts:

```text
converact-conversation-result-store / query + postgres_contract: 6 passed
converact-postgres-store / conversation_result_store_contract: 4 passed
converact-voice-agent-worker / active_call_understanding_postgres: 3 passed
scoped Clippy: passed with -D warnings
```

The tests first failed because the typed history limit/window, SQL loader, receipt mapper and
history skip gate did not exist.

## Explicitly not proved

- physical PostgreSQL query execution, `EXPLAIN`, transaction isolation or failure injection;
- real Active Call SSE/process lifecycle and real model quality;
- crash/restart, two-node race, production, fleet, capacity or performance qualification.

No server, container, deployed service or remote repository was changed.
