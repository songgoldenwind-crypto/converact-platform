# Rust Server Runtime Cell Migration Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with TDD, exact-file
> staging and review checkpoints. Subagents are optional and require explicit
> user authorization.

**Goal:** Migrate every Converact-owned online server runtime to a multi-region,
Cell-based Rust architecture without losing functionality or creating a second
writable Authority.

**Architecture:** One Cargo Workspace builds multiple binaries separated by
fault domain. Each Authority moves as a vertical slice through contract freeze,
shadow/replay, one fenced writer generation, drain, active-zero and TypeScript
runtime deletion. Global routing never enters Call/media/Agent hot paths.

**Tech stack:** Rust 1.94+, Tokio, Axum, Serde, SQLx/PostgreSQL, async-nats
JetStream, OpenTelemetry, rustls, JSON Schema/OpenAPI, Node/TypeScript only for
compatibility and verification, Python only for HF/GPU inference.

---

## 1. Plan rules

- Work from `/Users/songjinfeng/Projects/converact-worktrees/platform`.
- Preserve all existing commits and the historical dirty G03 evidence README.
- Never reset, rebase, clean, discard, use `git add .`/`git add -A` or stage an
  unrelated hunk.
- Do not contact or change running servers, containers, databases or ports.
- Do not run load/performance campaigns in this migration phase.
- Every runtime change starts with a failing test and ends with focused plus
  affected-suite verification.
- One commit changes one production behavior or one reviewable contract slice.
- No legacy runtime is deleted until active-zero and rollback-window expiry are
  evidenced.

## 2. Program checkpoints

### Checkpoint D0 — architecture and binding contracts

**Create:**

- `docs/architecture/2026-08-14-rust-server-runtime-cell-migration-r1.md`
- `docs/plans/2026-08-14-rust-server-runtime-cell-migration-r1.md`
- `architecture-foundation/rust-migration/server-runtime-migration-contract-v1.json`
- `architecture-foundation/rust-migration/server-runtime-migration-contract-v1.schema.json`
- `architecture-foundation/rust-migration/runtime-inventory-v1.json`
- `architecture-foundation/rust-migration/traceability-v1.json`
- `goals/rust-migration/PROGRAM-RULES.md`
- `goals/rust-migration/manifest.json`
- `goals/rust-migration/manifest.schema.json`
- `goals/rust-migration/goal-rm01-server-runtime-cell-migration.md`
- `goals/rust-migration/rm01-contract.test.mjs`

**Verification:**

```bash
node --test goals/rust-migration/rm01-contract.test.mjs
npm run typecheck
git diff --check
```

Expected: all RM01 contracts pass, repository typecheck exits zero and only
exact RM01 files are staged.

**Commit:** `docs(rust): freeze server runtime migration`

### Checkpoint R0 — bootstrap the Rust workspace

**Create:**

- `server-rs/Cargo.toml`
- `server-rs/Cargo.lock`
- `server-rs/rust-toolchain.toml`
- `server-rs/crates/kernel-ids/Cargo.toml`
- `server-rs/crates/kernel-ids/src/lib.rs`
- `server-rs/crates/contracts/Cargo.toml`
- `server-rs/crates/contracts/src/lib.rs`
- `server-rs/crates/config/Cargo.toml`
- `server-rs/crates/config/src/lib.rs`
- `server-rs/crates/observability/Cargo.toml`
- `server-rs/crates/observability/src/lib.rs`
- `server-rs/crates/testkit/Cargo.toml`
- `server-rs/crates/testkit/src/lib.rs`
- `server-rs/apps/converact-api/Cargo.toml`
- `server-rs/apps/converact-api/src/main.rs`

**Tests first:**

- reject oversized or malformed tenant/Cell/owner identifiers;
- preserve canonical JSON/hash vectors from the TypeScript contracts;
- reject unknown configuration fields and secret values in debug output;
- prove bounded startup/shutdown and `/live` without a database;
- prove `/ready` fails closed until required dependencies are admitted.

**Commands:**

```bash
cargo test --locked --manifest-path server-rs/Cargo.toml
cargo clippy --locked --manifest-path server-rs/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path server-rs/Cargo.toml --all -- --check
```

Expected: all tests pass; clippy and formatting exit zero.

**Commit:** `feat(rust): bootstrap server runtime workspace`

### Checkpoint R1 — freeze and replay the first vertical slice

The first slice is platform runtime identity/readiness because it has no
business effect writer and exercises HTTP, configuration, dependency state,
tenant/Cell identity, telemetry and graceful shutdown without taking Call or
Agent Authority.

**Create/modify:**

- `server-rs/crates/runtime-health/src/lib.rs`
- `server-rs/crates/contracts/src/health.rs`
- `server-rs/apps/converact-api/src/http.rs`
- `server-rs/tests/contract-replay/health.rs`
- `test/converact-rust-runtime-health-contract.test.ts`
- `architecture-foundation/rust-migration/evidence/r0-health/`

**Tests first:**

- replay the current `/live`, `/ready`, build/source and dependency-state
  responses byte/semantic-equivalently;
- reject readiness when a mandatory dependency is unknown, stale or draining;
- keep liveness independent from PostgreSQL/NATS/object storage;
- return bounded stable error codes without secret/config leakage;
- cancel all child tasks inside the shutdown deadline.

**Commit:** `feat(rust): add compatible runtime health slice`

### Checkpoint R2 — migration routing and writer fencing

**Create:**

- additive PostgreSQL migration for `authority_migration_route` and lease rows;
- `server-rs/crates/migration-routing/`;
- Rust and TypeScript read-only compatibility clients;
- route state-machine, owner-epoch and generation golden tests;
- rollback/drain/active-zero CLI with dry-run default.

**Required behavior:**

- route lookup is tenant/partition keyed and bounded;
- prepare does not change the writer;
- commit atomically increments generation and installs one writer;
- stale writer mutation fails in PostgreSQL, not only in application memory;
- abort/query/reconcile are idempotent;
- rollback creates a new generation;
- commands cannot target `active_zero` or `retired` generations;
- the CLI cannot mutate without an explicit exact route and confirmation flag.

**Commit sequence:**

1. `test(rust): freeze migration route state machine`
2. `feat(rust): add fenced migration route store`
3. `feat(rust): add dry-run drain reconciler`

### Checkpoint R3 — shared durable platform foundation

**Create crates:** `tenant-auth`, `postgres-store`, `event-log`, `idempotency`,
`audit`, and `outbox-worker`.

**Tests first:** tenant isolation, RLS, token issuer/audience/scope, mTLS peer
identity, transaction timeout, pool deadline, outbox atomicity, duplicate and
reorder, unknown/query/reconcile, stale owner, rolling schema and clock jumps.

No production route changes until exact current TypeScript behavior has a
golden/differential corpus.

### Checkpoint R4 — Cell placement and admission

Migrate placement, component ownership and admission as one vertical slice.
Use stable tenant/Interaction/Call partition keys, owner epoch and bounded
capacity reservations. The Global Control Plane publishes signed placement
metadata; established Cell work survives its outage.

Acceptance requires node loss, lease expiry, stale owner rejection, drain,
Cell unavailability and no global scan. Performance remains `not_run`.

### Checkpoint R5 — communication coordination

Migrate Interaction/CommunicationSession/BridgeIntent, media-control journals,
CDR convergence, recording manifests and notification workers around existing
RustPBX/RTPengine/LiveKit/voice-media Authorities. Do not reimplement SIP, RTP
or SFU inside the platform workspace.

Each sub-slice requires exact writer fencing, crash recovery, duplicate event
handling and Human Communication continuity when optional services fail.

### Checkpoint R6 — Engage and contact-center domains

Migrate Tenant-facing Engagement/Interaction/contact-center APIs and workers by
aggregate. Freeze OpenAPI, event, database and authorization behavior before
each writer flip. Long-lived objects remain on their starting generation.

### Checkpoint R7 — Action, workflow and connectors

Migrate durable workflow, Action Authority, provider gateway and connector
workers. An external timeout is Unknown, never success or blind retry. MCP,
REST and SDK remain adapters and cannot write Action truth directly.

### Checkpoint R8 — Agent Runtime and Speech boundary

Migrate AgentRun, Task, ContextRevision, Policy, Handoff, Evaluation and
delivery coordination to Rust. Build `converact-speech-gateway` in Rust. Python
HF executors receive only bounded model requests and return observations; they
have no business database or Action credentials.

### Checkpoint R9 — realtime and remaining owned services

Migrate WebSocket/event fan-out, owned edge agents, Provider Gateway and every
remaining online Node/self-owned Go/Python entrypoint. Keep browser, SDK,
contract/test tooling and explicit HF inference exemptions.

### Checkpoint R10 — deletion and closure

Run a repository/deployment reachability scan. For every migrated slice:

1. route new work to Rust;
2. drain old TypeScript generations;
3. reconcile unknown effects;
4. prove active-zero;
5. expire rollback window;
6. delete runtime route, image, deployment and server source;
7. retain only required compatibility schema until all readers are retired.

Final evidence must cover functional parity, security, recovery, failure
isolation, rolling upgrade, provider exit and exact production topology. Load
and capacity evidence runs only in the later qualification Goal.

## 3. Traceability and stop gates

- Any API/event/data/security behavior without a frozen current corpus remains
  `not_run`; do not migrate its writer.
- Any slice requiring durable dual-write is rejected and redesigned.
- Any global hot lock, unbounded queue, global scan or synchronous cross-region
  dependency blocks the slice.
- Any optional AI/recording/connector failure that interrupts established Human
  Communication blocks the slice.
- Any stale writer accepted after generation change blocks deletion.
- Any undeclared Node/self-owned Go/Python online runtime blocks RM01 completion.

## 4. Completion

RM01 completes only at Checkpoint R10. Intermediate commits are development
checkpoints, not permission to claim the migration, HA, capacity or production
eligibility complete.
