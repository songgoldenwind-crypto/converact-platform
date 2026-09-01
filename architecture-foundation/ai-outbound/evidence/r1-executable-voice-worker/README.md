# AI outbound R1 executable Voice Worker evidence

> Date: 2026-09-01
>
> Status: `passed_active_execution_seam / executable_sync_runtime /
> external_runtime_not_run`

## Proven scope

- `converact-voice-agent-worker` now has a real Rust `main` composition root;
- one process owns the authenticated loopback HTTP boundary, periodic readiness projection,
  bounded PostgreSQL Attempt claim loop and graceful drain signal;
- the composition uses the concrete PostgreSQL claim/repository/compliance adapters, compiled
  Active Call Release artifacts, Active Call Channel Agent, RustPBX RWI client and telephony port;
- configuration is a closed, versioned, bounded, non-secret JSON document and rejects unknown
  fields, inline database credentials, public plaintext binding and unsupported secret sources;
- platform RS256 keys are loaded from one immutable, no-symlink, bounded regular file;
- the RustPBX bearer is loaded from an owner-only `file://` source, rejects symlinks and unsafe
  permissions, and is zeroized on invalid or completed in-memory handling;
- the current database mode accepts only one explicit local Unix socket, no inline password and
  `sslmode=disable`; TCP is rejected instead of silently downgrading transport;
- admission now requires durable-store, Active Call reservation and RustPBX control readiness;
- loss of the stateful RustPBX connection marks readiness false and terminates the process for an
  external supervisor restart; stateless Active Call and PostgreSQL probes may recover in place;
- shared shutdown wakes HTTP and an idle claim loop promptly, while an already-owned claim batch is
  drained before process completion.
- Core orchestration now exposes separate `start_one_attempt` and `finalize_active_attempt`
  stages, so the next runtime slice can supervise a real multi-minute conversation without
  pretending it is terminal immediately after conversation start;
- the first durable `conversing` transition atomically stores the exact `CallId` and Channel Agent
  Session under the Attempt revision, generation, owner, token and lease-expiry fences;
- an isolated PostgreSQL 14.18 execution proved the state, revision, disclosure and both external
  authority identities in one physical transition.

The current executable still invokes the synchronous compatibility path. Long-lived Active Call
SSE supervision, lease renewal/reclaim and terminal-event resumption are the next runtime slice and
remain `not_run` here.

## Precise verification

Rust `1.94.1` with `--locked`:

```text
executable binary cargo check: passed
Worker runtime/config/bootstrap/lifecycle/process/claim/tracer contracts: 17 passed
RustPBX client and secure-secret contracts: 6 passed
scoped Clippy with -D warnings: passed
package rustfmt and exact-slice diff checks: passed
Core active/terminal orchestration contracts: 12 passed
Lease and active-binding Store contracts: 5 passed
Worker compatibility contracts: 6 passed
Physical PostgreSQL 14.18 active-binding transition: 1 passed
```

Tests used only temporary owner-controlled files, fake loopback WebSocket endpoints and local
in-memory/contract fixtures. No Docker, remote server, deployed service, broad regression or
performance command was used.

## Source checkpoints

- `1c088ada819ec5d357d1370f593087ff00c9b94b` — bounded continuous claim loop;
- `5cf13f92d9a3835ca210737b45d0f3c935e917ec` — closed runtime configuration;
- `cf7ac293bdd3a49d85b16cd2b6788cea74d1715b` — secure RustPBX bearer source;
- `f70f475d9c4bba9915ec802882ca13a6d949a38e` — startup authorities and readiness lifecycle;
- `ddc01eb74ae6c9e63815dd4ed5029caa133b804a` — executable Worker composition.
- `8f11033b632751ef02067df1ddf55f15d08286ff` — split active/terminal orchestration and physical
  durable Call/Session binding.

## Explicitly not proved

- launch against a real PostgreSQL schema, Active Call process and RustPBX RWI endpoint together;
- executable long-lived SSE supervision, lease renewal/reclaim and restart resume;
- one real SIP/PSTN AI conversation from Campaign claim through terminal durable completion;
- production remote PostgreSQL TLS, internal HTTP mTLS or non-loopback placement;
- rotating/fetched JWKS lifecycle and RustPBX connection re-establishment without process restart;
- campaign operator workflow, recording, finalization, quality and human-handoff end-to-end flow;
- remote server, production, performance, capacity and long-run behavior.
