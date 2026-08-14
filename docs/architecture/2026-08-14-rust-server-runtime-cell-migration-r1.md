# Converact Rust Server Runtime Cell Migration R1

Status: proposed production architecture approved for implementation on 2026-08-14

Canonical source baseline: `43fcbefacbdae679090caed704c05ddc761f0361`

## 1. Decision

All Converact-owned online server runtime will converge on Rust. The migration
uses vertical Authority slices and a multi-region Cell architecture. It does
not use a big-bang rewrite and does not create a second writable Authority.

The final language boundary is:

| Runtime | Final policy |
| --- | --- |
| Converact API, realtime, workers, communication coordination, Agent Runtime, workflow/action, connectors and owned edge agents | Rust required |
| Browser and desktop presentation code | TypeScript allowed |
| Public SDKs, contract generators, repository verification and test tooling | TypeScript allowed |
| Hugging Face/GPU model loading and inference | Python allowed only behind the Rust Speech Runtime Gateway |
| LiveKit, Kamailio, RTPengine, Tinode, PostgreSQL, NATS and other third-party infrastructure | retain upstream implementation language |
| Temporary TypeScript compatibility runtime | allowed only while an exact migration slice has not reached active-zero and deletion gates |

This document freezes the target architecture. Implementation remains
incremental so that every production behavior has a tested rollback path.

## 2. Current state

At the frozen baseline the repository contains approximately 1,977 tracked
TypeScript files and 175 tracked Rust files. `src/` contains about 247,000
lines of TypeScript server source. `src/agent-runtime` accounts for about
226,800 lines. The largest current Converact runtime domains include:

| Current source domain | Approximate TypeScript lines | Disposition |
| --- | ---: | --- |
| `src/agent-runtime/converact/voice` | 47,441 | migrate coordination and contracts; preserve Unified RustPBX Authority |
| `src/agent-runtime/converact/placement` | 11,141 | migrate to Rust Cell placement/admission |
| `src/agent-runtime/converact/media-control` | 10,692 | migrate control/orchestration; RTPengine and voice-media remain execution backends |
| `src/agent-runtime/converact/notifications` | 7,484 | migrate delivery ledger and workers |
| `src/agent-runtime/converact/ivr` | 6,839 | migrate business execution; media execution stays behind Media Engine contracts |
| `src/agent-runtime/converact/contact-center` | 6,458 | migrate by Engagement/Interaction Authority slice |
| `src/agent-runtime/converact/recordings` | 4,507 | migrate recording intent, manifest and reconciliation without coupling upload to calls |
| `src/agent-runtime/converact/operations` | 4,436 | migrate backup, restore and operational workers after durable foundation |
| `src/agent-runtime/converact/platform-foundation` | 3,547 | migrate first as reusable Rust foundation |

The current Rust implementation is concentrated in patched RustPBX,
`services/voice-media-rs`, native component hooks and exact-source codec work.
The current Node entrypoints combine HTTP, WebSocket, PostgreSQL, placement,
media hooks and background lifecycle in the same process. This is the primary
fault-domain and migration boundary to remove.

These counts are an inventory baseline, not an acceptance metric. Completion
is defined by runtime reachability, writer ownership and deletion gates, not by
percentage of lines translated.

## 3. Goals and non-goals

### 3.1 Goals

1. Support massive horizontal growth by adding replicas and Cells without
   changing domain interfaces or storage ownership.
2. Survive process, node and availability-zone faults within the documented
   recovery boundary.
3. Keep established Human Communication independent from AI, recording,
   connector, object-storage and control-plane failure.
4. Preserve every existing externally observable API, event, durable effect,
   tenant/security and data-retention behavior unless a separately approved
   versioned contract replaces it.
5. Move every Converact-owned online server writer to Rust, drain its legacy
   TypeScript generation and delete the TypeScript runtime path.
6. Make all new server-side development Rust-first immediately so migration
   debt cannot grow.
7. Keep current, target and production-eligible states separate. Claims require
   exact-source evidence.

### 3.2 Non-goals

- Rewriting third-party products in Rust.
- Translating files line by line or preserving accidental internal module
  boundaries.
- Building one giant Rust process.
- Splitting every crate into a network microservice.
- Running performance/load campaigns before functional and Agent-native
  closure; structural boundedness remains mandatory.
- Changing running server deployments without a later Goal and explicit user
  authorization.

## 4. Target topology

### 4.1 Global and regional planes

```text
                         Global Control Plane
            tenant home, Cell directory, release/config metadata
              never in a Call, RTP, WebRTC or Agent turn hot path
                                  |
                +-----------------+-----------------+
                |                                   |
             Region A                            Region B
        +-------+-------+                   +-------+-------+
        | Cell A1       |                   | Cell B1       |
        | Cell A2       |                   | Cell B2       |
        | Cell A3 ...   |                   | Cell B3 ...   |
        +---------------+                   +---------------+
```

Global state contains only placement and release metadata needed to locate a
tenant or create new work. It never synchronously decides an active Call,
media packet, Agent turn, Action attempt or recording write.

Regions accept new work independently. Cross-region replication is
asynchronous and version/fence aware. An active object has one home Cell and
one writable owner generation; active-active ingress does not mean active-
active writes to the same object.

### 4.2 Cell contents

Each Cell is a complete, bounded and independently scalable unit:

```text
Cell
|-- converact-api replicas
|-- converact-realtime replicas
|-- converact-worker replicas
|-- converact-communication replicas
|-- converact-agent-runtime replicas
|-- Unified RustPBX pool
|-- RTPengine ordinary-media pool
|-- LiveKit/TURN AV pool
|-- voice-media-rs decoded-media pool
|-- converact-speech-gateway replicas
|-- HF/GPU model executor pool
|-- connector/edge worker pools
|-- PostgreSQL HA
|-- NATS JetStream
|-- bounded cache
`-- object storage boundary
```

Cells do not share a synchronous database. Capacity expands by scaling a
specific resource pool inside the Cell or adding another Cell. Ordinary voice,
decoded media, AV, Agent, Speech/GPU, recording and connector work have
separate admission budgets and evidence profiles.

## 5. Process and fault-domain boundaries

| Process | Owns | Must not do |
| --- | --- | --- |
| `converact-api` | synchronous API, authentication enforcement, queries and short commands | long jobs, media, model inference, unbounded fan-out |
| `converact-realtime` | WebSocket/event delivery and realtime signaling projections | business truth, Call ownership, durable action execution |
| `converact-worker` | outbox/inbox, workflow, Action, reconciliation, scheduled durable work | RTP/media work or user-facing long-held sockets |
| `converact-communication` | Interaction, CommunicationSession, BridgeIntent and backend coordination | SIP Call/Room/media backend Authority |
| `converact-agent-runtime` | AgentRun, Task, ContextRevision, Policy, Handoff and Evaluation coordination | direct external effects or model-provider business truth |
| `converact-speech-gateway` | Speech generation, mode selection, bounded streaming, consent/disclosure enforcement and model admission | business Agent/Interaction/Action Authority |
| `hf-model-executor` | exact model loading and inference | business database credentials or external Action permission |
| Unified RustPBX | Native Call, Leg, business Dialog, routing, CDR facts and Media Plan | Room/SFU or Global Control authority |
| `voice-media-rs` | decoded-media execution | Call routing, billing decisions or Agent state |

One Cargo Workspace may build multiple binaries. Crate reuse is an in-process
code boundary; a network boundary exists only for resource isolation,
independent scaling or a distinct upstream Authority.

## 6. Authority and write ownership

The Authority table in `goals/PROGRAM-RULES.md` remains binding. Migration
adds no new business Authority. For each migrated aggregate:

```text
AuthorityRoute {
  authority_kind,
  partition_key,
  cell_id,
  implementation: typescript | rust,
  owner_epoch,
  generation,
  schema_revision,
  state: shadow | prepare | committed | draining | active_zero | retired
}
```

The route is migration coordination metadata, not business truth. A command
must present the exact route generation and writer lease. PostgreSQL fencing
rejects stale writers. TypeScript and Rust may read the same immutable snapshot
for comparison, but only the committed writer may mutate state, publish an
authoritative event or invoke an external effect.

Dual execution is allowed only for pure, side-effect-free calculations whose
outputs are compared by hash. Database dual-write, duplicate event publish,
duplicate CDR, duplicate billing and duplicate external Action are forbidden.

## 7. Target Cargo Workspace

```text
server-rs/
|-- Cargo.toml
|-- Cargo.lock
|-- rust-toolchain.toml
|-- apps/
|   |-- converact-api/
|   |-- converact-realtime/
|   |-- converact-worker/
|   |-- converact-communication/
|   |-- converact-agent-runtime/
|   |-- converact-speech-gateway/
|   |-- converact-provider-gateway/
|   `-- converact-rustdesk-edge/
|-- crates/
|   |-- kernel-ids/
|   |-- contracts/
|   |-- config/
|   |-- tenant-auth/
|   |-- observability/
|   |-- postgres-store/
|   |-- event-log/
|   |-- idempotency/
|   |-- migration-routing/
|   |-- engage-domain/
|   |-- interaction-domain/
|   |-- communication-domain/
|   |-- agent-domain/
|   |-- action-domain/
|   |-- recording-domain/
|   `-- testkit/
`-- tests/
    |-- contract-replay/
    |-- cross-runtime-golden/
    `-- fault-injection/
```

Existing `voice-media-rs` and patched upstream RustPBX remain independently
qualified sources while their final workspace placement is migrated. They are
not copied into a second implementation.

Crates are split by stable responsibility, not by every database table.
Domain crates expose commands, queries and events without Axum, SQLx, NATS or
vendor SDK types. Adapters depend inward on those interfaces.

## 8. Contracts and compatibility

Before a slice moves, the repository freezes:

- HTTP request/response/status/header/OpenAPI behavior;
- WebSocket and event subject/payload/ordering behavior;
- tenant, identity, consent, authorization and audit behavior;
- database schema, constraints, RLS expectations and transaction boundaries;
- idempotency key, EffectReceipt, unknown/query/reconcile semantics;
- clock domain, deadline and retry behavior;
- metrics names/labels and error code mapping;
- version negotiation and rollback window.

Rust contracts use bounded `serde` types with closed unknown-field policy at
authority boundaries. Identifiers, canonical hashes and cross-runtime golden
vectors must be byte-identical. SQL migrations remain additive during rolling
compatibility. A schema is removed only after every old reader and writer is
active-zero.

## 9. Data and event architecture

1. Each aggregate key contains tenant and Cell placement identity where
   required; no global scan is needed to route a command.
2. PostgreSQL is the durable state and fencing authority inside a Cell.
3. Outbox rows commit atomically with aggregate state. JetStream delivery is
   at-least-once; consumers use inbox/idempotency and query/reconcile.
4. Cache loss affects latency, not truth. Cache cannot grant ownership or
   convert unknown into success.
5. Object storage holds large immutable payloads; relational state holds
   manifests, hashes, retention and authorization.
6. Cross-region projections preserve source Cell, source generation, sequence,
   schema and provenance. They are read-only until a fenced takeover commits.
7. No media packet, audio frame or model token is persisted through the
   generic business event log.

## 10. Concurrency, boundedness and performance invariants

Functional development comes first, but the following structural constraints
are mandatory from the first Rust commit:

- bounded channels, pools, retries, batches and fan-out;
- partition-local actors or sharded maps, never a global hot lock;
- O(1) ownership and route lookup on hot paths;
- no task-per-RTP-packet, database-per-frame or HTTP-per-token design;
- cancellation-safe transactions and explicit shutdown/drain;
- monotonic deadlines separated from wall-clock audit timestamps;
- admission before expensive allocation or external calls;
- bulkheads for ordinary voice, AV, decoded media, AI/GPU, recording and
  connector work;
- low-cardinality metrics and bounded diagnostic payloads;
- unsafe/FFI/native code behind separately reviewed crates and supply-chain
  gates.

These invariants prevent a later architecture rewrite. They are not evidence
that a capacity target has already passed. G08 and later platform campaigns
remain responsible for same-source qualification.

## 11. High availability and disaster behavior

| Failure | Required target behavior |
| --- | --- |
| one process | supervisor restart; lease expires or is fenced; unrelated partitions continue |
| one node | new work placed elsewhere; eligible durable work recovered by higher owner epoch |
| one availability zone | quorum services remain available; new work avoids failed zone |
| one Cell | other Cells accept new work; eligible state is reconciled before takeover |
| Global Control Plane | established Cell work continues from cached signed placement/config revisions |
| AI/Speech/GPU | Human communication continues; affected AI capability degrades explicitly |
| recording/object storage | calls continue; bounded local spool/manifest reports degradation |
| connector/provider | attempt becomes bounded failed or unknown; query/reconcile prevents blind replay |
| entire Region | other Region accepts new work and recovers durable state according to RPO/RTO profile |

A complete physical Region loss cannot guarantee uninterrupted in-flight
RTP/WebRTC. The honest target is new-call failover, WebRTC reconnect, SIP
re-establishment where supported, durable business recovery and no duplicate
effects. Zero-interruption claims remain forbidden without direct evidence.

## 12. Migration state machine

Every vertical slice follows one durable idempotent process:

```text
inventory
  -> contract_frozen
  -> rust_shadow_read
  -> rust_pure_replay_equal
  -> prepare_writer_fence
  -> commit_new_generation
  -> route_new_work_to_rust
  -> drain_typescript_generation
  -> reconcile_unknown
  -> active_zero
  -> delete_typescript_runtime
  -> retire_compatibility_schema
```

Abort before writer commit leaves TypeScript authoritative. Abort after commit
requires a new fenced generation; it never silently re-enables the stale
writer. Long-lived Calls, Rooms, AgentRuns and workflows remain on their
starting generation until terminal or an explicit prepare/commit handoff.

## 13. Migration order

The order minimizes dependency inversion and prevents new TypeScript debt:

1. Rust workspace, contract types, configuration, errors, telemetry, testkit
   and deterministic cross-runtime replay.
2. Migration routing/fencing, additive schema, writer lease and drain tooling.
3. Platform foundation: tenant/identity verification, audit/event/outbox and
   readiness, preserving current security semantics.
4. Cell placement/admission and component ownership.
5. Communication coordination projections and workers around the already-Rust
   RustPBX/media core.
6. Recording/CDR/billing/notification durable workers.
7. Engagement/Interaction/contact-center vertical aggregates and APIs.
8. Durable Workflow/Action/connectors and provider gateways.
9. Agent Runtime, Context, Policy, Handoff and Evaluation.
10. Realtime/WebSocket and remaining Node entrypoints.
11. Owned edge agents and operational CLIs that run as services.
12. Repository scan, traffic proof, active-zero and removal of Node/Python/Go
    online runtime not explicitly exempted by this document.

New G04-G17 server behavior is implemented in Rust directly. A future Goal
may use TypeScript only for the allowed non-runtime categories or an explicitly
time-bounded compatibility adapter with a deletion gate.

## 14. Verification strategy

Each slice requires, in order:

1. frozen current behavior and threat review;
2. failing Rust contract/domain tests;
3. minimal implementation;
4. cross-runtime golden and differential replay;
5. physical PostgreSQL/NATS/HTTP dependency tests where applicable;
6. crash, timeout, duplicate, reorder, stale owner and unknown tests;
7. shadow comparison with no authoritative side effects;
8. canary writer generation, rollback rehearsal and drain;
9. active-zero and source/runtime deletion proof;
10. independent review.

Performance campaigns are deferred until the relevant functional surface is
complete, but no slice may introduce an unbounded queue, global hot lock,
linear global scan or synchronous cross-region dependency.

## 15. Completion definition

The Rust migration is complete only when all of the following are proved:

- every Converact-owned online server entrypoint resolves to a Rust binary or
  an explicitly approved Python model executor;
- no TypeScript or self-owned Go/Python online service remains reachable;
- all migrated Authority routes are Rust, retired or explicitly external;
- old writer generations are active-zero and stale writes fail closed;
- API/event/data/security/retention compatibility suites pass;
- failure isolation and rolling upgrade/recovery suites pass;
- repository and deployment scans find no undeclared online runtime;
- TypeScript remains only in allowed frontend/SDK/contract/test categories;
- current, target and production eligibility are evidence-backed;
- the final exact commit receives independent review.

Line-count reduction alone, a compiling workspace, partial route migration or
an upstream benchmark cannot satisfy completion.

## 16. Locked decisions

1. Architecture is multi-region and Cell-based from the first foundation.
2. Active state has one Cell, one owner generation and one writer.
3. Rust is mandatory for owned online runtime; Python is model execution only.
4. Migration is vertical and fenced; big-bang replacement and durable dual-
   write are rejected.
5. One Cargo Workspace builds multiple fault-isolated binaries.
6. Functional completeness precedes final capacity optimization, while
   boundedness is mandatory throughout.
7. Running servers are outside this Goal until separately authorized.
