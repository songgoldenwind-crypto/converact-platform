# Converact Fabric Capacity Harness Phase 1 Implementation Plan

**Status:** Controlled implementation complete; real capacity execution not run
**Goal:** Establish a deterministic, auditable load-control and evidence toolchain before claiming any single-node or 100K result.
**Related:** [`README.md`](README.md), [`../adr/ccaas-5-distributed-load-generation.md`](../adr/ccaas-5-distributed-load-generation.md), [`../adr/ccaas-6-single-node-density-and-scaling-efficiency.md`](../adr/ccaas-6-single-node-density-and-scaling-efficiency.md)

## 1. Scope

Phase 1 implements the benchmark control plane. It does not claim that a protocol or production environment has passed merely because the control-plane tests pass.

Included:

1. Compile a versioned workload profile into an immutable run manifest.
2. Produce deterministic interaction, connection, shard and evidence identifiers.
3. Partition every profile category into non-overlapping, complete shard ranges.
4. Fence shard workers with monotonically increasing lease epochs.
5. Qualify generator fleets before accepting system-under-test evidence.
6. Validate client, server and independent-observer totals.
7. Calculate single-node hard/safe capacity and 1/2/4/8 scaling efficiency.
8. Add controlled Converact Fabric event WebSocket, Tinode and SIP generator adapters without placing packet or message traffic through the orchestrator.
9. Preserve `not_run` for real media, PSTN, Windows, TURN, Egress and Provider validation until the required environment exists.

Excluded from this phase:

- Declaring MIX-100K passed.
- Replacing real RTP/WebRTC/RustDesk traffic with mocks.
- Running 10K or 100K traffic from one unqualified laptop process.
- Adding capacity coordination to Converact Fabric request hot paths.

## 1.1 Implementation Record

Completed on 2026-07-16:

- deterministic profile compiler and immutable manifest SHA binding;
- interaction/connection shard coverage, required-protocol validation and runtime lease fencing;
- generator qualification and three-plane evidence validation;
- Converact Fabric Event WebSocket and Tinode controlled real-socket generators;
- SIPp capacity process planner, runner, statistics parser and watchdog classification;
- single-unit ramp/binary-search frontier and measured 1/2/4/8 curve runner;
- manifest compile/validate CLI and intentionally non-runnable config template;
- 35 focused automated tests plus repository TypeScript validation.

Still `not_run`:

- SIPp real process on this workstation because no SIPp binary is installed;
- RustPBX SIP/RTP/recording single-node frontier;
- Tinode and Converact Fabric Edge calibrated single-node frontier against deployed services;
- LiveKit multi-room, TURN and Egress generator/runtime frontier;
- RustDesk synthetic hbbs/hbbr fleet and real Windows correctness lane;
- component 1/2/4/8, Cell-10K and MIX-100K physical multi-node execution.

The implementation status above describes harness code, not a capacity pass.

## 2. Deliverables

### 2.1 Control-plane library

Location: `scripts/capacity/`

| Module | Responsibility |
| --- | --- |
| `canonical-json.ts` | Stable serialization and SHA-256 binding for profiles, manifests and evidence. |
| `profile-compiler.ts` | Profile validation, deterministic shard planning and immutable manifest creation. |
| `shard-lease.ts` | Lease grant, renew, takeover and stale-worker fencing. |
| `generator-qualification.ts` | Enforce 150% fleet capacity and 70% per-worker utilization gates. |
| `evidence-validator.ts` | Reconcile assigned, created, active, closed and observed totals; reject incomplete or conflicting evidence. |
| `scaling-curve.ts` | Derive `C_hard`, `C_safe`, aggregate linearity and segment marginal efficiency. |
| `frontier-runner.ts` | Step-ramp and binary-search orchestration over a real probe adapter. |

### 2.2 Controlled generators

Each adapter receives a manifest shard and connects directly to the target endpoint. It returns telemetry and compact evidence; it never returns a synthetic pass when the endpoint is absent.

| Adapter | Initial coverage |
| --- | --- |
| Converact Fabric event WS | Connect, authorize, consume, slow-consumer class, resume cursor, reconnect and sequence journal. |
| Tinode | Connect, login, subscribe, publish, receipt, typing/presence, reconnect and deterministic message journal. |
| SIP | SIPp scenario assignment, CPS/concurrency limits, process watchdog telemetry and result parsing. |

LiveKit media, RTP media twin and RustDesk synthetic fleet follow the same contracts after this control-plane slice is stable.

## 3. Data Contracts

### 3.1 Immutable run manifest

The compiler binds:

- exact profile bytes through canonical SHA-256;
- fork manifest SHA-256;
- SUT and generator release identifiers;
- deterministic seed and run epoch;
- shard ranges and fleet assignment;
- phase timing and target load;
- evidence prefix and environment prerequisites.

Changing any bound field must change the manifest hash. Runtime lease state is separate from the immutable manifest.

### 3.2 Shard invariants

For every interaction and connection category:

```text
union(shard ordinal ranges) = [0, expected_count)
intersection(shard ordinal ranges) = empty
sum(expected_count) = profile count
```

Only the highest active lease epoch may emit new actions. A worker with a stale epoch is fenced even if it reconnects.

### 3.3 Generator qualification

A fleet is qualified only when:

```text
sum(worker safe capacity) >= target * 1.50
assigned worker load <= worker safe capacity * 0.70
worker calibration matches protocol, release and hardware class
CPU, event-loop/scheduler, file descriptor and NIC gates pass
```

Failure status is `invalid_generator_capacity`; it cannot be converted into a SUT failure or pass.

### 3.4 Evidence outcome

Allowed outcomes:

- `passed`: all required traffic was generated, observed and reconciled.
- `failed`: generator qualified, but the SUT or SLO failed.
- `invalid_generator_capacity`: traffic source was not capable of producing the target reliably.
- `not_run`: required endpoint, media path or environment was not executed.

## 4. Test-Driven Sequence

### Task 1: Deterministic compiler

Tests first:

- same profile/options produce byte-identical manifest content and hash;
- a changed profile, release or seed changes the hash;
- category totals, disjoint ranges and fleet assignment are exact;
- invalid totals and unsupported categories fail closed.

Verification:

```bash
node --import tsx --test test/converact-capacity-profile-compiler.test.ts
```

### Task 2: Lease fencing

Tests first:

- first grant starts at epoch 1;
- renew preserves epoch and owner;
- unexpired lease cannot be stolen;
- takeover after expiry increments epoch;
- stale worker actions are rejected.

Verification:

```bash
node --import tsx --test test/converact-capacity-shard-lease.test.ts
```

### Task 3: Qualification and evidence

Tests first:

- fleet below 150% fails qualification;
- a worker above 70% assignment fails qualification;
- server/client/observer count mismatch fails evidence;
- missing real environment produces `not_run`, never `passed`;
- qualified and reconciled controlled evidence passes.

Verification:

```bash
node --import tsx --test test/converact-capacity-evidence.test.ts
```

### Task 4: Density and scaling calculations

Tests first:

- safe capacity reserves 20% headroom and never exceeds hard capacity;
- final frontier uses the minimum of at least three successful repeats;
- `L(n)` and `M(a,b)` match ADR formulas;
- 4-node and 8-node threshold failures remain failures even when total concurrency exceeds 100K;
- profile, hardware or configuration drift invalidates curve comparison.

Verification:

```bash
node --import tsx --test test/converact-capacity-scaling.test.ts
```

### Task 5: Controlled protocol adapters

Tests use local controlled protocol servers and parser fixtures. They prove adapter behavior, not production capacity. Real environment runs write separate evidence bundles.

Verification:

```bash
node --import tsx --test test/converact-capacity-event-ws-generator.test.ts test/converact-capacity-tinode-generator.test.ts test/converact-capacity-sip-generator.test.ts
```

## 5. Completion Gates

Phase 1 is complete when:

1. All control-plane tests and TypeScript type checking pass.
2. A Cell-10K manifest can be compiled and independently validated.
3. Duplicate, missing and stale shard activity is rejected.
4. Under-powered generators cannot yield a benchmark pass.
5. Scaling calculations enforce the ADR-CCAAS-6 thresholds.
6. Controlled protocol adapters emit truthful controlled evidence.
7. Every unexecuted real dependency remains explicitly `not_run`.
8. No production capacity number is published without an immutable evidence bundle.

## 6. Follow-On Order

After Phase 1:

1. Calibrate generator workers and run Converact Fabric event WS/Tinode/SIP single-node frontiers.
2. Add RTP media twin and RustPBX packet/recording evidence.
3. Add LiveKit multi-room/TURN/Egress fleet, forking upstream load tools where necessary.
4. Add RustDesk rendezvous/relay synthetic fleet and Windows correctness lane.
5. Run component 1/2/4/8 curves, then Cell curves, then MIX-100K endpoint validation.
