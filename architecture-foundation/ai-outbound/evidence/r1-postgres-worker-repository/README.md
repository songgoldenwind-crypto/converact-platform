# AI outbound R1 PostgreSQL Worker repository evidence

> Date: 2026-09-01
>
> Status: `passed_local_contract_and_physical_postgresql / runnable_process_not_run`

## Proven scope

- the Rust Worker now has one concrete tenant-scoped PostgreSQL adapter for bounded Agent Release,
  Campaign and Attempt inspection;
- persisted Agent Releases are parsed into domain identifiers and states, and every immutable
  execution-component digest is revalidated before it can enter the Worker resource model;
- completed Attempts fail closed when the authoritative post-call finalization job is missing;
- Attempts without scheduled finalization expose `not_scheduled` instead of inventing progress;
- operator reconciliation writes a content-free durable request keyed by tenant and idempotency
  key, with exact replay and same-key/different-Attempt conflict behavior;
- reconciliation requests are tenant-isolated, append-only at this stage and contain no customer
  destination, transcript, audio, prompt or Provider payload;
- the HTTP boundary maps idempotency conflicts to `409` and other sanitized repository failures to
  `503`;
- the concrete repository is inert until called, is `Send + Sync`, and redacts PostgreSQL connection
  material from `Debug` output;
- migration 138 and the SQLite development mirror add the same bounded reconciliation identity.

## Precise verification

Rust `1.94.1` with `--locked`:

```text
converact-ai-outbound-core Agent Release contracts: 4 passed
converact-postgres-store Worker repository contracts: 2 passed
converact-voice-agent-worker PostgreSQL adapter contract: 1 passed
converact-voice-agent-worker HTTP contracts: 5 passed
scoped Clippy with -D warnings: passed
workspace rustfmt check: passed
git diff check: passed
SQLite in-memory schema load: passed
```

One ignored integration test was run explicitly against a disposable local PostgreSQL 14.18
database. It passed `1/1` and covered release, Campaign and completed-Attempt loads; finalization
progress; reconciliation creation, exact replay, missing Attempt and idempotency conflict; and the
previous terminal-Attempt atomic commit/rollback cases. The database process was stopped after the
test.

The migration checksum suite passed `10/10` after migration 138 was added.

No Docker, remote server, deployed service, broad regression or performance test was used.

## Explicitly not proved

- runnable binary composition, authenticated production middleware and bounded claim loop;
- reconciliation request claiming, settlement and crash recovery;
- non-superuser production RLS role and rolling deployment;
- real Active Call/RustPBX, SIP/PSTN, Speech/model, recording or human handoff;
- server deployment, production, performance, capacity and long-run behavior.
