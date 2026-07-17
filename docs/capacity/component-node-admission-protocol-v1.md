# iveKit Component Node Admission Protocol v1

Status: implementation contract  
Scope: LiveKit Server, Tinode Server, RustDesk Server, RustPBX and future Cell-owned data-plane nodes  
Public API: no; this is an iveKit-internal fork protocol

## 1. Decision

Each Cell keeps the authoritative reservation ledger in PostgreSQL. Each component node runs a
small node-admission agent beside the upstream process. The Cell pushes reservation state to the
selected node before acknowledging placement. The upstream fork contains only a thin hook which:

1. authorizes a new room, topic, call or relay ownership transition against the local agent;
2. caches the accepted owner epoch and a short-lived node lease in process memory;
3. rejects stale owner epochs and new ownership while draining;
4. never performs HTTP, PostgreSQL, NATS or Redis work in RTP, WebRTC packet, RustDesk frame or
   Tinode fanout loops.

The protocol does not replace the upstream wire protocols. Native LiveKit, Tinode and RustDesk
clients remain compatible.

## 2. Rejected Alternatives

### Full implementation in every fork

This duplicates Cell lease, state-machine, authentication, metrics and recovery logic in Go and
Rust. The copies would drift and make upgrades harder.

### Reverse proxy only

A proxy can route the first connection but cannot fence a stale room owner, topic actor or relay
after the connection is established. It also cannot provide deterministic drain and recovery.

## 3. Node Identity

An agent has one immutable identity:

- `component`: `rustpbx`, `livekit`, `tinode` or `rustdesk`;
- `region_id`, `zone_id`, `cell_id`;
- `node_id`;
- `profile_ids`;
- supported `interaction_kinds`.

The process starts in `draining`. It becomes `accepting` only after receiving a current Cell lease
heartbeat. A heartbeat with a lower Cell lease epoch is rejected. A higher epoch atomically fences
all lower-epoch attempts.

## 4. Reservation State

The node stores bounded reservation checkpoints:

- reservation and interaction identity;
- exact component, Cell and node identity;
- owner epoch;
- required capacity;
- `reserved`, `active`, `expired` or `closed`;
- expiry and update timestamps.

State is monotonic:

```text
reserved -> active -> closed
reserved -> expired -> closed
```

Duplicate delivery is idempotent only when identity, owner epoch and capacity match. A conflicting
replay fails closed.

## 5. Internal HTTP Contract

Mutation and diagnostic-state endpoints require a constant-time bearer-token check and bounded JSON
bodies. `/livez`, `/readyz` and label-bounded `/metrics` are intended for the private cluster
network and never expose tenant, interaction or reservation identifiers.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/livez` | Process liveness only |
| `GET` | `/readyz` | Current Cell lease is fresh and node is accepting/degraded |
| `GET` | `/metrics` | Label-bounded aggregate reservation and capacity metrics |
| `GET` | `/v1/state` | Identity, lease, drain state, reservation counts and capacity |
| `POST` | `/v1/lease` | Apply a monotonic Cell lease heartbeat |
| `POST` | `/v1/drain` | Stop new ownership without terminating active sessions |
| `PUT` | `/v1/reservations/{id}` | Apply an idempotent reservation checkpoint |
| `POST` | `/v1/authorize` | Authorize `open`, `mutate` or `close` for exact interaction/epoch |

`open` accepts `reserved` or `active` checkpoints that existed before drain. `mutate` requires
`active`. `close` remains available during drain and for terminal cleanup. Every response includes
the current Cell lease epoch and a monotonically increasing node state sequence.

Every lease heartbeat carries `recovery_complete`. A fresh agent rejects
`recovery_complete=true` with `component_node_recovery_required`. The Cell then sends a draining
heartbeat with `recovery_complete=false`, replays the node's non-terminal checkpoints, and sends
the desired lease with `recovery_complete=true`. Readiness remains false while recovery is pending.

## 6. Source Hook Rules

### LiveKit

Authorize before creating a room owner. Cache owner epoch in room state. Moderation, Egress
ownership and room rebuild commands require the same epoch. Packet forwarding does not call the
agent.

### Tinode

Authorize before assigning a topic actor. Cache owner epoch in topic state. Publish, edit and
delete compare the command epoch and cached node lease in memory. Fanout does not call the agent.

### RustDesk

Authorize before establishing a relay/control session. Cache epoch in relay state. Clipboard,
file transfer, control and recording commands require the cached epoch. Frame relay does not call
the agent.

### RustPBX

The existing signed route snapshot and inbound admission patch remain the primary path. The node
agent contract is the target for converging call owner epoch, drain and capacity behavior.

## 7. Failure Behavior

- No fresh node lease: reject new ownership and mutation; allow bounded close cleanup.
- Cell leader changes: higher lease epoch fences lower owner epochs immediately.
- Node agent unavailable at placement time: do not acknowledge the reservation.
- Agent restart: reject a ready lease, start draining, recover cached non-terminal checkpoints from
  the Cell synchronizer, then accept a recovery-complete lease.
- Cell admission restart: recover PostgreSQL reservation checkpoints before serving.
- Capacity or identity mismatch: fail closed and emit a bounded audit/metric reason.

## 8. Performance Contract

- No network or database call in packet/frame/fanout loops.
- Reservation and authorization lookup is O(1).
- Expiry uses a deadline heap, not a full-map scan.
- State and metrics responses are bounded; reservation bodies are never listed without an
  explicit diagnostic build.
- The node agent is not counted as successful Cell-10K evidence until the real upstream fork,
  binary, hardware and generator evidence are attached.

## 9. Acceptance

Controlled tests must prove:

- exact identity and interaction-kind fencing;
- monotonic Cell lease and owner epoch behavior;
- idempotent checkpoint replay and conflict rejection;
- drain semantics;
- expiry and terminal cleanup;
- bounded request/response sizes and constant-time authentication;
- no component hot-path contract requires a remote call.

Real LiveKit, Tinode, RustDesk and RustPBX source-hook builds, multi-node failover and Cell-10K
benchmarks remain `not_run` until those binaries and environments are available.
