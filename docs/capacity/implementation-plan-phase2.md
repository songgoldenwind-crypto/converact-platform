# iveKit Capacity Runtime Phase 2 Implementation Plan

**Status:** Code complete; physical and production acceptance `not_run`
**Goal:** Turn the approved Cell architecture into runtime code while every unavailable physical-environment result remains `not_run`.

## 1. Runtime Slices

### Slice A: Cell placement and admission

- Versioned, signed and expiring placement snapshots.
- Region/Zone/Cell filtering and weighted rendezvous top-two selection.
- Atomic multi-dimensional reservation with idempotency and TTL.
- Node/Cell drain and admission rejection.
- Decimal-string owner epoch generation and stale-epoch fencing.
- No synchronous business PostgreSQL query in placement selection.

### Slice B: Durable load-run orchestrator

- PostgreSQL run, phase, shard lease, worker heartbeat and evidence state.
- Monotonic lease epochs and stale-worker rejection.
- NATS subjects carry commands and low-frequency state, never packet/message/frame traffic.
- Restart-safe phase barriers and bounded worker takeover.

### Slice C: Component capacity probes

- Shared probe contract for iveKit Edge, Tinode, RustPBX, LiveKit and RustDesk.
- Component-specific health, capacity, drain and evidence adapters.
- Missing endpoints return `not_run`; they never return a synthetic capacity pass.

### Slice D: Media generator scheduling

- RTP media twin session plans and packet-quality evidence contract.
- LiveKit multi-room, screen, TURN and Egress worker plans.
- RustDesk hbbs/hbbr synthetic fleet plans and Windows correctness-lane separation.

### Slice E: Verified scaling campaign finalization

- Compile every curve point from the complete workload ratio instead of scaling one protocol in isolation.
- Bind profile, hardware, configuration, failure reserve, fork manifest, SUT and generator release by exact SHA-256 identity.
- Reload only terminal database records and verified S3 run evidence, then replay ramp, bracket, binary search and final repeats.
- Controlled evidence may test the verifier but always returns `capacity_claim=none`.

### Slice F: MIX-100K platform release gate

- Persist a unique role identity for each component curve and require all nine contract roles.
- Reload and independently recompute every component, Cell, and shared-data curve.
- Bind the exact 100,000-interaction endpoint run to the Cell hardware, configuration, failure reserve, fork, SUT, and generator identity.
- Issue `platform_pass` only for a fully passed production campaign; endpoint success never overrides a failed efficiency curve.

## 2. First Vertical Slice

Files:

```text
src/agent-runtime/ivekit/placement/
  types.ts
  owner-epoch.ts
  snapshot.ts
  admission.ts
  placement-service.ts
  index.ts
```

Tests:

```text
test/ivekit-cell-owner-epoch.test.ts
test/ivekit-cell-snapshot.test.ts
test/ivekit-cell-admission.test.ts
test/ivekit-cell-placement.test.ts
```

Completion gates:

1. Tampered, expired or non-monotonic snapshots fail closed.
2. Reservation checks all dimensions before changing any reserved value.
3. An idempotency replay returns the original reservation without double charging.
4. A draining Cell rejects new reservations but preserves active owner traffic.
5. Placement attempts at most two Cells.
6. A stale owner epoch cannot execute a command or overwrite current state.
7. Local tests and repository TypeScript validation pass.

## 3. Persistence Boundary

The first slice is a deterministic domain module. The next slice persists its state through explicit ports:

```text
Placement domain
  -> snapshot source port
  -> admission RPC port
  -> owner journal port
  -> PostgreSQL projection
  -> NATS distribution
```

The domain module must not import PostgreSQL, NATS, HTTP or component clients. This keeps placement decisions testable and prevents infrastructure dependencies from entering the realtime path.

## 4. Truth Boundary

Code-level outcomes:

- `controlled_pass`: deterministic domain and protocol behavior passed locally.
- `not_run`: a real component, media path, Windows endpoint or multi-node environment was not executed.
- `failed`: a real executed path violated its contract.

No Phase 2 code may create `C_hard`, `C_safe`, Cell-10K or MIX-100K values without a qualified generator and immutable evidence bundle.

## 5. Implemented Runtime

| Slice | Code status | Runtime status |
| --- | --- | --- |
| Cell placement/admission | controlled code pass | multi-Cell RPC and failure injection `not_run` |
| PostgreSQL orchestrator | controlled code pass | real PostgreSQL restart/takeover `not_run` |
| NATS JetStream outbox/consumer | controlled code pass | clustered JetStream redelivery `not_run` |
| Generator worker runtime | controlled code pass | real fleet images, S3 and multi-host takeover `not_run` |
| Run controller/finalizer | controlled code pass | real multi-host controller takeover and physical evidence submission `not_run` |
| Component probes | controlled code pass | deployed component metrics collection `not_run` |
| RTP media twin | process/evidence contract pass | pinned binary build and real RTP `not_run` |
| LiveKit generator | process/evidence contract pass | multi-room/TURN/Egress execution `not_run` |
| RustDesk synthetic fleet | process/evidence contract pass | native synthetic binary and Windows lane `not_run` |
| Scaling campaign finalizer | controlled code pass | physical single-node frontier and 1/2/4/8 curves `not_run` |
| Platform campaign finalizer | controlled code pass | nine role curves, Cell/shared-data curves and 100K endpoint physical evidence `not_run` |

### 5.1 Placement

`src/agent-runtime/ivekit/placement/` implements:

- HMAC-signed immutable placement snapshots with version, expiry and grace handling.
- HMAC-signed minimal placement tokens.
- tenant home-region resolution, stale-capacity filtering and weighted rendezvous top-two selection.
- atomic multi-dimensional Cell/node reservation, TTL, activation, close and drain.
- decimal-string owner epoch composition and stale/future epoch rejection.
- overloaded degraded Cells remain visible in signed snapshots for diagnosis but cannot pass
  request-specific safe-capacity admission.

The placement domain imports no PostgreSQL, NATS, HTTP or component SDK. Business PostgreSQL is
not queried in the interaction hot path.

### 5.2 Durable orchestrator

Migration `077_ivekit_capacity_orchestrator.sql` owns:

- `ivekit_capacity_load_runs`
- `ivekit_capacity_load_phases`
- `ivekit_capacity_load_shards`
- `ivekit_capacity_load_workers`
- `ivekit_capacity_evidence`
- `ivekit_capacity_command_outbox`

PostgreSQL is authoritative. A shard assignment and its command outbox row are committed in one
statement. Dispatcher and shard leases use `FOR UPDATE SKIP LOCKED`, monotonic BIGINT epochs and
strict owner/expiry conditions. TypeScript transports epochs as decimal strings.

Phase start is fenced by `start_not_before`. Worker registration is accepted only when its immutable
`release_id` matches the run manifest's `generator_release_id`; future worker timestamps are clamped
to bounded database clock skew.

NATS subject:

```text
ivekit.capacity.command.<fleet_id>.<worker_id>
```

JetStream carries only bounded commands. RTP packets, WebRTC frames, Tinode messages and RustDesk
frames never pass through NATS.

`FencedCapacityCommandHandler` renews the PostgreSQL shard lease before and throughout generator
execution. The first transition from `leased` to `running` atomically claims generator execution;
redelivered commands with the same lease epoch do not start a second generator. A generator result
is persisted with a canonical SHA-256 checkpoint before evidence upload. If S3 upload, verification,
or final shard completion fails, redelivery resumes from `result_ready` without replaying protocol
traffic. Migration `082_ivekit_capacity_worker_checkpoints.sql` upgrades databases that already ran
migration 077. A renewal failure aborts the executor through `AbortSignal`. Malformed or misrouted
commands are terminated; retryable execution failures are negatively acknowledged for redelivery.

Existing JetStream streams and consumers must match the configured subject, WorkQueue retention,
file storage, max age, explicit ACK, ACK wait, max delivery and max pending limits. The dispatcher
refuses to start before migration 077 exists.

### 5.3 Evidence truth gates

- A completed shard must bind verified evidence.
- A completed phase may contain only completed shards.
- A passed run may contain only completed phases and verified evidence.
- A passed run must bind a verified, run-scoped `run_evidence_manifest` whose stored SHA-256 equals
  `evidence_manifest_sha256`.
- Failed, rejected and `not_run` evidence can never be converted into `passed`.
- Publish failure releases the outbox dispatch lease for bounded retry.
- A published command whose database mark is unconfirmed keeps its dispatch lease; it is not
  released early and becomes retryable only after lease expiry.
- Evidence `run_id/phase_id/shard_id` relationships are also enforced by PostgreSQL foreign keys.
- Run Controller reads the durable current phase, so workers are not redeployed between ramp,
  steady, burst, fault, and endurance phases.
- Run evidence uses `<phase_id>/<shard_id>` identity; repeated execution of the same workload shard
  in different phases cannot overwrite or satisfy another phase.
- A curve result is derived from immutable run references. The finalizer reloads the database row and
  S3 object, verifies both SHA-256 identities, and rejects an omitted, reordered, invented or extra probe.
- Curve comparison requires exact profile, hardware, configuration, failure reserve, fork manifest,
  SUT release and generator release identity. A controlled campaign can never produce a capacity claim.
- Platform finalization reloads terminal scaling evidence, recomputes every curve from frontier
  repetitions, requires every component role exactly once, and checks the endpoint by verified run
  evidence. Only all-passed production evidence can create `platform_pass`.
- Finalizer derives expected phases/shards/fleets/external dependencies from the immutable manifest,
  validates generator/SUT/independent counts, uploads a run-scoped manifest, then calls the fenced
  finalization barrier.

## 6. Component Probe Contract

`scripts/capacity/probes/` collects real health and Prometheus responses for:

- iveKit Edge
- Tinode
- RustPBX
- LiveKit
- RustDesk

Each component has an explicit dimension allowlist. Safe capacities are configuration inputs bound
to `profile_id` and `profile_sha256`; probes never derive or invent them. Missing endpoints return
`not_run`. Attempted endpoints that fail, omit required metrics or exceed response limits return
`failed`.

Raw response bodies are not projected into placement state. Evidence stores only status, byte
count, capture time and SHA-256. Responses are streamed with byte limits even when
`Content-Length` is absent, and malformed Prometheus labels are discarded rather than projected as
unlabelled capacity.

### 6.1 Component node admission and source hooks

Migration `083_ivekit_cell_admission_reservations.sql` persists every Cell reservation before a
successful reserve/activate/close response. Writes are fenced by the current PostgreSQL Cell lease,
and admission restart restores active/reserved capacity plus the current owner sequence.

Migration `084_ivekit_cell_lease_topology.sql` adds a canonical topology SHA-256 to the Cell lease.
The hash covers profiles, interaction kinds, Cell dimensions and stable component-node identities,
endpoints, states, capabilities and dimensions. Array and map ordering do not change it. An active
lease may be renewed only by the same owner and the same topology; a changed topology waits for
release or expiry, then receives a new lease epoch. Recovery fails closed if a durable reservation
still names a node removed by the new topology.

`scripts/ivekit-component-node-admission.ts` runs beside LiveKit, Tinode, RustDesk or RustPBX. The
Cell sends a draining lease, replays non-terminal checkpoints, then sends a recovery-complete
lease. A restarted agent rejects a ready heartbeat until this replay completes. One failed node is
marked offline without draining unrelated nodes; loss of the authoritative PostgreSQL ledger
drains the entire Cell.

`integrations/component-hook-go/` and `integrations/component-hook-rs/` provide the source-level
guard for the upstream forks. Open, periodic refresh and close may call the local agent.
Per-command owner checks read only the in-process epoch/lease cache. RTP packets, WebRTC forwarding,
RustDesk frames and Tinode fanout never call the agent.

`integrations/livekit-v1.13.3/` specializes the Go guard for LiveKit rooms. Signed participant
metadata supplies interaction, reservation, node and owner epoch. The first join opens the owner;
subsequent joins, signals and administrative mutations use the local room registry. Refresh is
bounded to batches of 64 and isolates stale rooms. `infra/ivekit/livekit/apply-overlay.mjs` is tied
to `v1.13.3@8f6a9cb8b735549f0c5770df8ea70ac51f860ecb` and fails on source drift. It
also replaces LiveKit's generated internal node ID with `IVEKIT_COMPONENT_NODE_ID` before
Prometheus, SignalClient and Router initialization, so Redis room routing, iveKit placement and the
local sidecar use the same stable StatefulSet ordinal.

`integrations/tinode-v0.25.3/` specializes the same guard for Tinode group topics. iveKit persists
the Cell reservation before provider mutation, connects topic creation to the selected owner
endpoint, and stores interaction, reservation, node and epoch under ROOT-only
`desc.trusted.ivekit_placement`. The exact-release overlay aligns Tinode `cluster_self` with
`IVEKIT_COMPONENT_NODE_ID`, opens the owner after topic load/create but before actor startup,
locally fences publish and metadata mutations, and hard-deletes a topic newly persisted by the
same failed initialization when owner open is rejected. Refresh is bounded to batches of 64.
Fanout, serialization and persistence loops do not call the agent.

`src/agent-runtime/ivekit/placement/rustdesk-owner-binding.ts` adds a bounded per-owner broker for
RustDesk's two-process server shape. The existing gateway session flow prepares one target binding
on the selected ordinal. hbbs atomically claims that binding when it receives `RequestRelay` and
records the client-generated relay UUID; hbbr resolves the UUID, opens the component-node owner
before pairing, and caches the lease locally. Ambiguous simultaneous pending bindings for one
target fail closed. Claimed bindings are checkpointed to the ordinal's persistent volume and
expire automatically if pairing never completes.

`infra/ivekit/rustdesk-server/` is pinned to
`1.1.15@9bae9f2f39d92c4b4ba2e28e089da5071897b22e`. Its overlay leaves the opaque
relay byte-copy branches unchanged. RustDesk's existing three-second timer performs only an
in-process owner assertion so a stale lease terminates the exact relay without a network call.
`infra/capacity/kubernetes/rustdesk-statefulset.yaml` colocates hbbs, hbbr, the binding broker and
the component-node sidecar under one stable ordinal. Public ID/relay endpoints are mapped by
placement per ordinal; a random load-balanced Service is not treated as an owner.

The pinned RustPBX patch queue now embeds the Rust guard, opens the inbound owner after exact
admission, refreshes the short lease asynchronously, and checks every tracked RWI call ID. iveKit
places `reservation_id`, `interaction_id` and `owner_epoch` in the internal top-level
`ivekit_owners` envelope rather than the public command payload. Park/pickup resolves both legs and
rejects cross-node bridge attempts before provider mutation. Helm and Compose wiring is opt-in and
co-locates the sidecar on `127.0.0.1:3210`; legacy deployments remain disabled by default.

The exact patch queue has been applied to RustPBX commit
`6c49ee76baa54fdbf8f98020cc9bee158c7c15de`, and locked offline Cargo metadata resolves with the
local component hook. A full RustPBX binary build and real SIP/RTP integration are still
`not_run`; patch application and metadata resolution must not be reported as compile evidence.

## 7. Generator Contracts

### 7.1 RTP media twin

The RTP worker consumes the SIP-created session manifest and binds codec, payload type, clock,
packetization, direction count, duration and packet rate. Evidence separates generator under-rate
or host saturation from SUT packet loss, jitter, duplicates, ordering and stale-epoch behavior.

### 7.2 LiveKit

The LiveKit worker contract extends the official load-test approach for many small rooms. It
requires actual connected rooms/participants, encoded audio/video packets, measured bitrate,
screen tracks, forced TURN participants, TrackEgress and RoomComposite Egress results.

The owner overlay is a separate correctness layer below that load contract. It patches room
creation, participant signal and administrative mutation boundaries but does not add HTTP or
database work to RTP/RTCP forwarding. It also aligns the internal Redis router node identity with
the selected iveKit component node before server initialization. The local registry and
exact-anchor transformation tests pass. Application to the real upstream source, Go 1.26
compilation, custom image digest and multi-node media acceptance remain `not_run`.

### 7.3 Tinode

The Tinode generator exercises real hello, login, topic subscribe, publish, receipt, presence,
typing and reconnect behavior. The owner overlay is a separate correctness layer: native wire
compatibility and ringhash routing remain intact, while iveKit-managed topic masters are bound to
one stable Cell owner. The three-node StatefulSet separates the headless cluster service from the
client service and shares each ordinal identity with its local component-node sidecar.

Local registry, WebSocket protocol and exact-anchor transformation tests pass. Application to the
real `v0.25.3@22a7c18...` source tree, Go 1.26 compilation, immutable image digest, three-node
failure/reconnect, native-client convergence and capacity execution remain `not_run`.

### 7.4 RustDesk

The RustDesk worker contract requires the native protocol driver, hbbs registration/rendezvous and
hbbr relay handshake evidence. Office/high-motion traces and file fixtures are SHA-bound. Synthetic
protocol evidence is explicitly separated from the real Windows correctness lane.

All protocol workers use the shared JSON process contract. Binary version and SHA-256 are mandatory;
credentials and protocol keys are supplied through protected bundle files, not command arguments.
Result JSON is a bounded regular file, cancellation kills the external process, and plan-bound
evaluators derive expected sessions, rooms, tracks, relay sessions and transfers from the executed
immutable plan instead of accepting caller-supplied expectations.

## 8. Deployment

`infra/capacity/` contains:

- controlled local Compose with one JetStream node, dispatcher, and opt-in generic worker;
- a non-root dispatcher image;
- a two-replica Kubernetes dispatcher template and PodDisruptionBudget;
- a two-replica fenced Controller plus retryable run, scaling and platform finalizer Jobs;
- a two-replica active/standby Cell admission deployment, PostgreSQL lease
  takeover, readiness-only Service routing and PodDisruptionBudget;
- a LiveKit StatefulSet template whose fork process, internal Redis router identity and local
  component-node sidecar share the stable ordinal Pod identity, plus a PodDisruptionBudget;
- a three-node Tinode StatefulSet whose `cluster_self`, ringhash membership and local
  component-node sidecar share stable ordinal identities, with separate cluster/client Services
  and a PodDisruptionBudget retaining two nodes;
- a per-fleet StatefulSet worker template with stable worker identity and S3 evidence;
- a component-node sidecar template plus Cell-to-node lease/checkpoint synchronization;
- bounded environment examples.

The node topology authority is exactly one of explicit nodes or component node pools. Pool mode
uses stable ordinal IDs (`<prefix>-0`, `<prefix>-1`, ...), deterministic endpoints and exact
aggregate capacity equality with the Cell vector. The admission runtime and capacity projector
compile the same authority, so scaling cannot silently create different routing and observation
node sets.

The standby admission process keeps `/livez` available but returns `503` from
`/readyz` and every admission endpoint. It retries only the explicit retryable
`cell_lease_unavailable` outcome. After takeover it increments the Cell lease
epoch, restores the PostgreSQL reservation ledger, replays component-node
checkpoints and becomes ready only after a fresh capacity projection. The
standby projector checks local admission state before probing components, so
standby replicas do not double the LiveKit, Tinode, RustDesk or RustPBX metrics
load.

The local NATS topology is not production evidence. Production requires external PostgreSQL and
clustered JetStream in independent failure domains.

## 9. Deferred Server Acceptance

When the server environment is available, execute in this order:

1. Apply migrations 077, 082, 083, 084, 091 and 092 to a disposable PostgreSQL database.
2. Start three-node JetStream and two dispatcher replicas.
3. Verify outbox redelivery during dispatcher kill/restart.
4. Verify worker lease expiry, takeover and stale-worker completion rejection.
5. Apply the Go/Rust hooks to pinned upstream source trees. For LiveKit and Tinode, run each exact
   overlay with Go 1.26, compile the upstream service, build an immutable image and record its
   digest/SBOM.
6. Deploy two Cell admission replicas, kill the active owner and prove bounded
   lease takeover, incremented epoch, topology hash equality, ledger recovery and zero standby
   routing. Repeat with a deliberately mismatched standby topology and prove it cannot renew or
   reuse the active epoch.
7. Kill and restart each sidecar and component process while proving owner checkpoint replay.
8. Deploy all five component probes and capture real metric evidence.
9. Build and SHA-pin RTP, LiveKit and RustDesk generator binaries.
10. Qualify each generator fleet against a sink with 150% aggregate headroom.
11. Run single-node frontiers before any Cell-10K attempt.
12. Run each required component 1/2/4/8 curve plus Cell/shared-data 1/2/4/8/10 curves and preserve raw evidence.
13. Run the exact MIX-100K endpoint, then execute the platform finalizer against all eleven curves and the endpoint run.
14. Run real Windows, TURN, Egress, storage and PSTN lanes where available.

Until those steps run, every physical capacity, Cell-10K and MIX-100K result remains `not_run`.
