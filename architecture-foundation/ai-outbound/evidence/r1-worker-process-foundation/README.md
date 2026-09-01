# AI outbound R1 Worker process foundation evidence

> Date: 2026-09-01
>
> Status: `passed_local_process_contracts / binary_and_concrete_claim_execution_not_run`

## Proven scope

- process-facing internal routes require exactly one valid platform bearer and derive tenant scope
  only from the verified signed identity;
- malformed or missing credentials fail closed before repository access;
- viewer identities may inspect bounded resources but cannot request reconciliation;
- liveness and readiness remain public, while readiness continues to reject new work when a
  required dependency is unavailable;
- the Worker HTTP lifecycle serves a real local socket, marks the shared shutdown token as draining
  before graceful shutdown and enforces a fixed drain deadline;
- one claim cycle checks shutdown and admission before claiming, caps the returned batch and runs
  no more concurrent claim tasks than the frozen Worker configuration allows;
- an already-claimed batch drains after admission, and task failures are counted without creating
  an unbounded replacement-task fan-out.

## Precise verification

Rust `1.94.1` with `--locked`:

```text
voice-agent-worker claim supervisor: 2 passed
voice-agent-worker authenticated HTTP boundary: 3 passed
voice-agent-worker HTTP resource contracts: 5 passed
voice-agent-worker real local-socket lifecycle: 1 passed
scoped Clippy with -D warnings: passed
package rustfmt and git diff checks: passed
```

The local-socket test used only an ephemeral loopback port and immediately shut the process down.
No Docker, remote server, deployed service, broad regression or performance test was used.

## Source checkpoints

- `b5f5d5554caded71e73e7ca1da656305fe6199ca` — authenticated, tenant-derived HTTP routes;
- `66328a20fca190b7dd686b7790fc0809ec9f6814` — bounded HTTP serve/drain lifecycle;
- `1a8fc23c4ae250b247bdfbe10c7cb2fbb4edbcc3` — fixed-concurrency claim supervisor.

## Explicitly not proved

- an executable `main` composition root and runtime configuration loading;
- PostgreSQL-backed claim source and concrete claimed-Attempt executor;
- production RS256/JWKS refresh lifecycle and route-specific capability authorization;
- reconciliation request claiming, settlement and crash recovery;
- real Active Call/RustPBX, SIP/PSTN, Speech/model, recording or human handoff;
- server deployment, production, performance, capacity and long-run behavior.
