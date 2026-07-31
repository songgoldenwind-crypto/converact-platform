# iveKit Voice Media Control Goal 1 Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with test-driven development. The approved parent design is `docs/design/communication-foundation-vos5000-parity-performance-plan.md`.

**Goal:** Build the versioned, fenced, idempotent RustPBX-to-media-node control plane required by Goal 1 without coupling established RTP forwarding to control-plane availability.

**Architecture:** RustPBX owns the logical call graph. A dedicated media-control agent owns wire-level media session lifecycle on one media node, while the existing component-node admission service remains the authority for reservation and owner-epoch authorization. The agent talks to an injected transport port so Goal 1 can use a deterministic simulator and Goal 2 can replace it with the pinned rtpengine fork.

**Tech Stack:** TypeScript, Node.js HTTP/HTTPS, JSON Schema 2020-12, OpenAPI 3.1, Prometheus text format, Node test runner.

---

## Boundaries

- `placement/component-node-admission.ts` remains the node-capacity and owner-epoch authority.
- `media-control/protocol.ts` defines versioned wire contracts and validation.
- `media-control/agent.ts` owns session state, command idempotency, command_sequence fencing, expiry, and reconciliation.
- `media-control/transport.ts` is the narrow fast-path adapter contract.
- `media-control/simulator.ts` is a deterministic transport implementation with before-apply and after-apply failure injection.
- `media-control/metrics.ts` exposes only bounded labels: action, result, and session state.
- `media-control/http.ts` exposes the internal API with bearer-token authentication in development and mandatory mTLS plus token in production.
- `media-control/client.ts` is the RustPBX-side client with bounded requests, timeouts, and explicit uncertain outcomes.
- The media-control-to-component-node admission link also requires mTLS plus
  bearer authentication in production.
- Goal 2 supplies the rtpengine implementation of `MediaTransportPort`; Goal 1 must not depend on an unsupported rtpengine action.

## Protocol Invariants

1. `protocol_version` is exactly `ivekit.media-control.v1`.
2. Every command carries `command_id`, an irreversible `tenant_id` handle,
   `call_id`, `leg_id`, `cell_id`, `owner_node_id`, `owner_epoch`,
   `media_reservation_id`, `command_sequence`, `idempotency_key`,
   `expires_at`, and a verified canonical `payload_hash`.
3. Admission authorization runs before every first execution. Cleanup remains possible after lease expiry, but cannot be performed by a stale owner.
4. A repeated `command_id` with the same canonical payload returns
   `replayed` without another transport side effect.
5. A repeated `command_id` with a different payload is rejected as `command_payload_conflict`.
6. The same owner epoch accepts only the next command_sequence. A higher authorized epoch starts a new command_sequence at one and fences all older owners.
7. A transport timeout is `unknown`, never success or failure. Reconciliation first queries the transport command journal and safely replays only when the transport proves the command was not observed.
8. Prepared sessions expire and release transport resources. Committed sessions never expire merely because the control-plane lease or agent is unavailable.
9. Agent and simulator state are bounded by reservation, command-journal, and
   terminal-retention limits.
10. Metrics never label tenant, interaction, reservation, call, command, IP address, or SDP.
11. Wire results are exactly `committed`, `replayed`, `rejected_capacity`,
    `rejected_epoch`, `terminal_error`, or `unknown`.

The v1 action vocabulary is:

`offer`, `answer`, `update`, `delete`, `query`, `block_media`,
`unblock_media`, `start_forward`, `stop_forward`,
`start_recording_fork`, `stop_recording_fork`, `play_media`, `stop_media`,
`inject_dtmf`, `subscribe_quality`, and `drain_node`.

Goal 1 validates this complete vocabulary and implements the deterministic
session lifecycle. Actions that require real rtpengine media behavior are not
claimed as physically implemented until Goal 2.

### Task 1: Versioned Protocol And Schema

**Files:**
- Create: `src/agent-runtime/ivekit/media-control/protocol.ts`
- Create: `docs/capacity/schemas/voice-media-control-v1.schema.json`
- Create: `test/ivekit-voice-media-control-protocol.test.ts`

- [x] Validate all 16 commands and reconcile envelopes against JSON Schema.
- [ ] Assert malformed protocol versions, owner epochs, sequences, timestamps, identifiers, payload hashes, SDP sizes, and unexpected fields are rejected.
- [ ] Define these public types:

```typescript
export type MediaControlAction =
  | 'offer'
  | 'answer'
  | 'update'
  | 'delete'
  | 'query'
  | 'block_media'
  | 'unblock_media'
  | 'start_forward'
  | 'stop_forward'
  | 'start_recording_fork'
  | 'stop_recording_fork'
  | 'play_media'
  | 'stop_media'
  | 'inject_dtmf'
  | 'subscribe_quality'
  | 'drain_node';
export type MediaSessionState =
  | 'prepared'
  | 'committed'
  | 'cancelled'
  | 'closed'
  | 'expired';

export interface MediaControlCommand {
  protocol_version: 'ivekit.media-control.v1';
  action: MediaControlAction;
  command_id: string;
  tenant_id: string;
  call_id: string;
  leg_id: string;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
  media_reservation_id: string;
  command_sequence: number;
  idempotency_key: string;
  expires_at: string;
  payload: Record<string, unknown>;
  payload_hash: string;
}
```

- [x] Recompute and verify caller-provided payload hashes before execution.
- [ ] Run:

```bash
node --import tsx --test test/ivekit-voice-media-control-protocol.test.ts
```

Expected: all protocol tests pass.

### Task 2: Deterministic Agent And Transport Simulator

**Files:**
- Create: `src/agent-runtime/ivekit/media-control/transport.ts`
- Create: `src/agent-runtime/ivekit/media-control/agent.ts`
- Create: `src/agent-runtime/ivekit/media-control/simulator.ts`
- Create: `test/ivekit-voice-media-control-agent.test.ts`

- [x] Test offer, answer, delete, prepared-session expiry, owner takeover,
  stale epoch rejection, sequence gaps, replay, payload conflict, unknown
  reconciliation, restart reconstruction, and capacity exhaustion.
- [ ] Define the transport boundary:

```typescript
export interface MediaTransportPort {
  execute(command: MediaTransportCommand): Promise<MediaTransportOutcome>;
  queryCommand(commandId: string): Promise<MediaTransportQuery>;
  releaseSession(transportSessionId: string, reason: string): Promise<void>;
}
```

- [ ] Inject an authorization port compatible with component-node admission:

```typescript
export interface MediaControlAuthorityPort {
  authorize(input: {
    media_reservation_id: string;
    call_id: string;
    owner_epoch: string;
    operation: 'open' | 'mutate' | 'close';
  }, now: Date): Promise<void>;
}
```

- [x] Store a bounded command journal per reservation and bounded simulator
  session/command maps.
- [ ] Implement `reconcile()` so an after-apply timeout converges by querying the transport journal and a before-apply timeout replays the same idempotent transport command.
- [ ] Implement a simulator whose packet-forwarding state lives in the transport, not in the control agent. Prove committed forwarding continues while authorization and agent calls are unavailable.
- [ ] Run:

```bash
node --import tsx --test test/ivekit-voice-media-control-agent.test.ts
```

Expected: all lifecycle, fencing, idempotency, reconciliation, and media-independence tests pass.

### Task 3: Bounded State And Metrics

**Files:**
- Create: `src/agent-runtime/ivekit/media-control/metrics.ts`
- Modify: `src/agent-runtime/ivekit/media-control/agent.ts`
- Modify: `test/ivekit-voice-media-control-agent.test.ts`
- Create: `test/ivekit-voice-media-control-capacity.test.ts`

- [ ] Maintain counters by fixed action/result enums and gauges by fixed session-state enums.
- [ ] Add `sweep(now)` for prepared lease expiry and terminal-record eviction.
- [ ] Reject new reservations at `max_reservations`; allow idempotent replay and cleanup at the bound.
- [ ] Cap command history per reservation and evict only finalized command entries; never evict an unresolved command.
- [ ] Construct 100,000 lightweight reservations in the capacity test and prove the configured bound rejects reservation 100,001 without state growth.
- [ ] Scan rendered metrics and fail if any tenant, call, interaction, reservation, command, SDP, or endpoint value appears.
- [ ] Run:

```bash
node --import tsx --test \
  test/ivekit-voice-media-control-agent.test.ts \
  test/ivekit-voice-media-control-capacity.test.ts
```

Expected: bounded-state and label-cardinality tests pass.

### Task 4: Authenticated Internal HTTP API

**Files:**
- Create: `src/agent-runtime/ivekit/media-control/http.ts`
- Create: `src/agent-runtime/ivekit/media-control/client.ts`
- Create: `test/ivekit-voice-media-control-http.test.ts`

- [ ] Expose `POST /v1/commands`, `POST /v1/reconcile`, `GET /v1/sessions/:media_reservation_id`, `GET /livez`, `GET /readyz`, and `GET /metrics`.
- [ ] Bound request body, response body, identifier, SDP, header, and timeout sizes.
- [ ] Require a bearer token on every non-health endpoint.
- [ ] Refuse production startup unless TLS is enabled, client certificates are required, and a CA is configured.
- [ ] Map deterministic domain errors to stable HTTP statuses and retryability.
- [x] Make network timeout and connection loss return
  `result_class: unknown`; never silently retry with a new command ID.
- [ ] Run:

```bash
node --import tsx --test test/ivekit-voice-media-control-http.test.ts
```

Expected: authentication, mTLS policy, limits, lifecycle, and uncertainty tests pass.

### Task 5: RustPBX Adapter, OpenAPI, And SDK

**Files:**
- Create: `src/agent-runtime/ivekit/voice/adapters/media-control.ts`
- Create: `docs/api/ivekit-media-control-v1.openapi.yaml`
- Create: `src/agent-runtime/ivekit/media-control/index.ts`
- Modify: `src/agent-runtime/ivekit/voice/index.ts`
- Create: `test/ivekit-rustpbx-media-control-adapter.test.ts`
- Create: `test/ivekit-voice-media-control-openapi.test.ts`

- [x] Map the current RustPBX adapter operations to offer/answer/delete while
  preserving command IDs across retries.
- [ ] Keep RustPBX logical SDP intent separate from the transport-returned effective SDP.
- [ ] Require reconciliation before issuing a later command_sequence when the preceding command is unknown.
- [ ] Publish every request, response, error code, security requirement, and size bound in OpenAPI.
- [ ] Export a stable internal SDK surface without exporting simulator-only controls.
- [ ] Run:

```bash
node --import tsx --test \
  test/ivekit-rustpbx-media-control-adapter.test.ts \
  test/ivekit-voice-media-control-openapi.test.ts
```

Expected: adapter and contract tests pass.

### Task 6: Deployment And Goal 1 Acceptance

**Files:**
- Create: `infra/ivekit/media-control/Dockerfile`
- Create: `infra/ivekit/media-control/README.md`
- Modify: `infra/ivekit/docker-compose.voice.yml`
- Create: `scripts/ivekit-media-control-agent.ts`
- Modify: `package.json`
- Create: `test/ivekit-voice-media-control-deployment.test.ts`
- Create: `test/ivekit-voice-media-control-acceptance.test.ts`

- [x] Build a non-root, read-only image with deterministic configuration,
  health checks, and an OCI source-revision label.
- [x] Add Compose wiring on the OPC private network only; do not alter LED manifests or public routes.
- [x] Add `test:ivekit:voice-media-goal1` containing every Goal 1 contract and acceptance test.
- [x] Exercise stale epochs, replay, offer/answer/delete/expiry, before-apply
  uncertainty, after-apply uncertainty, agent reconstruction, and
  control-plane outage under the controlled transport.
- [x] Inspect deployment identity from a clean Git checkout, a healthy running
  container, its immutable image digest and source label, and the rendered
  configuration. Injected test identity is explicitly non-deployment evidence.
- [ ] Deploy the exact committed source to the server and generate
  `docker-runtime` identity evidence, leaving LED files and containers
  unchanged.

Final commands:

```bash
npm run typecheck
npm run test:ivekit:voice-media-goal1
git diff --check
```

Expected: all commands exit zero. The controlled report status is
`controlled_passed`; it does not claim rtpengine wire forwarding, physical
media quality/capacity, RustPBX runtime wiring, or process/container restart
persistence. Those remain explicit Goal 2/3 release gates.
