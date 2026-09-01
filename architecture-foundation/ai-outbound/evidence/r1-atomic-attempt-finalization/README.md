# AI outbound R1 atomic Attempt finalization evidence

> Date: 2026-09-01
>
> Status: `passed_local_contract_and_physical_postgresql / process_composition_not_run`

## Proven scope

- the Worker cannot publish a terminal Attempt through its read/reconciliation repository;
- `TerminalAttemptCommit` accepts only a completed, disclosed aggregate and freezes Campaign,
  Agent Release, Call and channel-agent session identities;
- the exact lease-scoped PostgreSQL Attempt adapter is the sole atomic completion port;
- the transaction fences tenant, Attempt, execution generation, lease owner, lease token, expiry,
  source revision, source state, Campaign and Release before writing;
- terminal Attempt state, Call/session bindings, lease release, deterministic post-call job and
  immutable enqueue receipt commit together;
- exact completion replay returns success without requiring the expired lease to mutate again;
- finalization persistence failure rolls back both the terminal Attempt update and job insert;
- PostgreSQL commit or rollback uncertainty is `outcome_unknown`, while stale leases are rejected;
- physical testing found and fixed an existing integer-millisecond parameter mismatch in the
  finalization job and receipt timestamp inserts.

## Precise verification

Rust `1.94.1` with `--locked`:

```text
converact-ai-outbound-core: 44 passed
converact-ai-outbound-store: 19 passed, 3 external PostgreSQL cases ignored
converact-post-call-finalization-store: 5 passed
converact-postgres-store focused atomic-completion/unit contracts: 7 passed
converact-voice-agent-worker tracer bullet: 5 passed
scoped Clippy with -D warnings: passed
scoped rustfmt and git diff checks: passed
```

One ignored integration test was then run explicitly against a disposable local PostgreSQL 14.18
cluster with focused migrations 124, 128, 129, 131 and 132. It passed `1/1`, covering successful
commit, exact replay and forced receipt-table failure with full transaction rollback. The database
process was stopped after the test.

No Docker, remote server, deployed service, broad regression or performance test was used.

## Explicitly not proved

- concrete PostgreSQL Release/Campaign/Attempt inspection and reconciliation repository;
- bounded multi-tenant claim loop and runnable authenticated Worker process;
- process crash between external Call observation and atomic completion;
- non-superuser production RLS role and rolling deployment;
- real Active Call/RustPBX, SIP/PSTN, Speech/model, recording or human handoff;
- server deployment, production, performance, capacity and long-run behavior.
