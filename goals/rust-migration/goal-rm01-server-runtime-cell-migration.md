# RM01 — Converact Server Runtime Rust Cell Migration

| Field | Value |
| --- | --- |
| Goal ID | `RM01` |
| Authority | Existing domain Authorities remain unchanged; migration route owns only implementation generation/fencing |
| Entry | User-approved Rust-first, multi-region Cell architecture; frozen RM01 D0 commit |
| Completion | Every current Converact-owned online server runtime is Rust or an approved Python model executor; legacy writers active-zero and removed |
| Production claim | Forbidden until separate exact qualification |

## 1. Binding objective

Execute the complete architecture and implementation plan in:

- `docs/architecture/2026-08-14-rust-server-runtime-cell-migration-r1.md`;
- `docs/plans/2026-08-14-rust-server-runtime-cell-migration-r1.md`;
- `architecture-foundation/rust-migration/server-runtime-migration-contract-v1.json`;
- `architecture-foundation/rust-migration/runtime-inventory-v1.json`;
- `architecture-foundation/rust-migration/traceability-v1.json`.

Migrate all current Converact-owned online server runtime to the frozen Rust
Cell architecture. Do not narrow completion to a workspace skeleton, line
count, first vertical slice, partial route migration or compiling binary.

## 2. Required outcomes

1. Establish one pinned Cargo Workspace that builds multiple fault-isolated
   server binaries with shared deep domain crates and no vendor types in
   domain interfaces.
2. Implement bounded identifiers, configuration, error taxonomy,
   observability, tenant/auth, PostgreSQL, event/outbox, idempotency and testkit
   foundations.
3. Implement the durable idempotent AuthorityRoute prepare/commit/abort/query/
   reconcile/drain/active-zero state machine with PostgreSQL writer fencing.
4. Freeze and replay every current API, event, database, identity, consent,
   audit, retention, clock, error and metrics contract before moving its
   writer.
5. Migrate platform foundation, placement/admission, communication
   coordination, recording/CDR/billing/notification workers, Engage/contact
   center, Action/workflow/connectors, Agent Runtime/Speech boundary,
   realtime/WebSocket and remaining owned online services by vertical slice.
6. Keep Unified RustPBX, RTPengine, LiveKit, voice-media-rs and third-party
   Authorities intact. Absorb no second SIP, RTP, Room, Call or Agent runtime.
7. Keep Python limited to HF/GPU model execution behind the Rust Speech
   Gateway and remove business database/effect credentials from model workers.
8. Make all new self-owned online server behavior in the existing G04-G17
   program Rust-first so TypeScript runtime debt cannot grow.
9. Prove node/worker fault fencing, rolling compatibility, bounded
   backpressure, optional-service isolation, drain, rollback and recovery for
   every migrated slice.
10. Route new work to Rust, drain old generations, reconcile unknown effects,
    prove active-zero and delete TypeScript/self-owned Go/Python runtime routes,
    deployments and source not covered by an explicit exemption.

## 3. Required artifacts

- Current runtime reachability and ownership inventory, updated at every
  deletion checkpoint.
- Closed migration contract/schema and requirement traceability.
- Cargo Workspace dependency/feature/license/native-source policy.
- Cell, partition, owner-epoch, generation and route schemas.
- API/event/database/canonical-hash cross-runtime corpus for every slice.
- Threat/failure review covering tenant escape, stale writer, confused deputy,
  duplicate effect, split brain, queue exhaustion, clock, rolling schema,
  model worker compromise and optional-service failure.
- Per-slice TDD plan, RED/GREEN logs, exact source manifests and evidence.
- Drain, rollback, query/reconcile, active-zero and deletion ledger.
- Final runtime reachability scan and independent review.

## 4. Execution checkpoints

### D0 — freeze

Validate and commit only the RM01 architecture, plan, machine contracts,
inventory, traceability, program rules, manifest and tests. No production
runtime change is allowed in D0.

### R0 — Rust workspace and compatible health slice

Create `server-rs/` with pinned toolchain/lockfile and the minimum shared
crates. Implement bounded runtime identity, `/live`, fail-closed `/ready`,
dependency states, telemetry and graceful shutdown. Prove current semantic
compatibility. Do not route production traffic.

### R1 — migration routing and durable foundation

Implement AuthorityRoute state/fencing, tenant/auth, PostgreSQL, event/outbox,
idempotency and migration tooling. All mutation CLIs default to dry-run and
require exact route/generation confirmation.

### R2 — Cell placement and communication coordination

Migrate placement/admission then communication coordination around existing
RustPBX/media/LiveKit Authorities. Preserve one writer and Human Communication
continuity.

### R3 — durable platform domains

Migrate recording/CDR/billing/notification, Engage/contact-center and
Action/workflow/connectors as independent vertical aggregates.

### R4 — Agent, Speech boundary and realtime

Migrate Agent Runtime, Context/Policy/Handoff/Evaluation, Rust Speech Gateway,
WebSocket/event delivery and remaining owned online entrypoints. Python remains
model-only.

### R5 — closure

Move all new work, drain legacy generations, reconcile, prove active-zero,
delete legacy runtime and complete final scans/reviews. Performance and
production qualification remain separate Goals.

## 5. TDD and evidence gates

For each runtime behavior:

1. capture current behavior and exact source;
2. write a Rust failing test and cross-runtime golden/differential test;
3. implement the minimum bounded behavior;
4. run focused, crate, workspace and affected repository suites;
5. inject duplicate, reorder, timeout, cancellation, panic, stale owner,
   dependency loss and unknown outcomes;
6. prove no unauthorized side effect in shadow mode;
7. commit one production behavior at a time;
8. keep physical/server/performance evidence `not_run` until actually run.

No test may borrow upstream, mock, bridge-excluded, different-hardware or
different-source performance claims. No code path may add an unbounded queue,
global hot lock, linear global scan, synchronous cross-region dependency,
per-packet database/HTTP/NATS or avoidable task/allocation.

## 6. Acceptance gates

RM01 is complete only when:

- the final reachability inventory finds no undeclared owned non-Rust online
  server process;
- every AuthorityRoute is Rust, retired or explicitly external;
- stale TypeScript/self-owned Go/Python writers fail durable fencing;
- every legacy generation is active-zero before deletion;
- API/event/data/security/retention contracts pass on the final exact source;
- Human Communication survives failure of AI, Speech, recording, connectors,
  object storage and the Global Control Plane within the frozen boundary;
- process/node/AZ recovery and rolling compatibility are directly evidenced;
- the final exact diff passes independent Authority, security, fault,
  maintainability and complexity review;
- no performance or production claim is promoted without its separate Goal.

## 7. Stop gates and non-goals

Stop the affected slice if it requires durable dual-write, a second Authority,
an unfenced writer, synchronous global hot-path state, unbounded work, hidden
feature loss, optional-service coupling to Human Communication or an
unreviewed unsafe/native dependency. Redesign the slice; do not lower the gate.

Do not rewrite LiveKit, Kamailio, RTPengine, Tinode or storage/message products.
Do not replace full SIP/media stacks as part of language migration. Do not
change running servers or run local Docker/performance campaigns in RM01.

## 8. Repository protection

Work only in the canonical repository and current branch. Preserve all
existing commits and dirty/untracked work. Never reset, rebase, clean, discard,
use `git add .`/`git add -A`, stage unrelated changes or push without explicit
permission. The historical G03 dirty evidence README remains untouched and
unstaged.

## 9. create_goal summary

Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/rust-migration/goal-rm01-server-runtime-cell-migration.md`
and its RM01 manifest identity. The summary exists only because create_goal has
a length limit. Anything unproved remains `not_run`.

Continue the canonical repository and current branch from the exact D0 commit.
Preserve every existing commit and user dirty/untracked file; never reset,
rebase, clean, discard, use `git add .`/`git add -A`, stage unrelated work or
push without explicit permission. Keep the historical G03 evidence README
untouched and unstaged. Do not start G04 automatically.

Migrate every Converact-owned online server runtime to the approved
multi-region Cell-based Rust architecture. Use one Cargo Workspace and multiple
fault-isolated binaries. Keep one Cell, one owner generation and one writer per
active object; migrate by contract freeze, shadow/pure replay, fenced writer
commit, new-work routing, drain, query/reconcile, active-zero and legacy
deletion. Durable dual-write, second Authorities, global hot locks/scans,
unbounded work, synchronous cross-region hot-path dependencies and optional
AI/recording/connector/storage failure affecting established Human
Communication are forbidden.

Keep TypeScript only for frontend/SDK/contracts/tests and time-bounded
compatibility with deletion gates. Keep Python only for HF/GPU model execution
behind the Rust Speech Gateway. Retain third-party LiveKit, Kamailio,
RTPengine, Tinode, PostgreSQL, NATS and storage implementations. All new owned
online server behavior is Rust-first. Preserve existing API/event/data/
security/retention semantics unless a separately approved versioned contract
replaces them.

Develop with TDD and narrow commits through workspace/foundation, migration
routing/fencing, Cell placement, communication coordination, durable platform
domains, Action/workflow/connectors, Agent/Speech/realtime and final deletion.
Current, target and production eligibility remain separate. No running-server
changes, local Docker, load/performance campaigns or production claims are
authorized. Continue autonomously through all offline functional work and stop
only at an unavoidable external Gate after recording every remaining item.
