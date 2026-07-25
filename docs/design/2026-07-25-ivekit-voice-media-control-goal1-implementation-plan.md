# iveKit Voice Media Control Goal 1 Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with test-driven development. The approved parent design is `docs/design/communication-foundation-vos5000-parity-performance-plan.md`.

**Goal:** Build the versioned, fenced, idempotent RustPBX-to-media-node control plane required by Goal 1 without coupling established RTP forwarding to control-plane availability.

**Architecture:** RustPBX owns the logical call graph. A dedicated media-control agent owns wire-level media session lifecycle on one media node, while the existing component-node admission service remains the authority for reservation and owner-epoch authorization. The agent talks to an injected transport port so Goal 1 can use a deterministic simulator and Goal 2 can replace it with the pinned rtpengine fork.

**Tech Stack:** TypeScript, Node.js HTTP/HTTPS, JSON Schema 2020-12, OpenAPI 3.1, Prometheus text format, Node test runner.

---

## Boundaries

- `placement/component-node-admission.ts` remains the node-capacity and owner-epoch authority.
- `media-control/protocol.ts` defines versioned wire contracts and validation.
- `media-control/agent.ts` owns session state, command idempotency, sequence fencing, expiry, and reconciliation.
- `media-control/transport.ts` is the narrow fast-path adapter contract.
- `media-control/simulator.ts` is a deterministic transport implementation with before-apply and after-apply failure injection.
- `media-control/metrics.ts` exposes only bounded labels: action, result, and session state.
- `media-control/http.ts` exposes the internal API with bearer-token authentication in development and mandatory mTLS plus token in production.
- `media-control/client.ts` is the RustPBX-side client with bounded requests, timeouts, and explicit uncertain outcomes.
- Goal 2 supplies the rtpengine implementation of `MediaTransportPort`; Goal 1 must not depend on an unsupported rtpengine action.

## Protocol Invariants

1. `protocol_version` is exactly `ivekit.media-control.v1`.
2. Every mutating command carries `command_id`, `reservation_id`, `interaction_id`, `owner_epoch`, `sequence`, `lease_expires_at`, and a canonical payload hash.
3. Admission authorization runs before every first execution. Cleanup remains possible after lease expiry, but cannot be performed by a stale owner.
4. A repeated `command_id` with the same canonical payload returns the recorded result without another transport side effect.
5. A repeated `command_id` with a different payload is rejected as `command_payload_conflict`.
6. The same owner epoch accepts only the next sequence. A higher authorized epoch starts a new sequence at one and fences all older owners.
7. A transport timeout is `unknown`, never success or failure. Reconciliation first queries the transport command journal and safely replays only when the transport proves the command was not observed.
8. Prepared sessions expire and release transport resources. Committed sessions never expire merely because the control-plane lease or agent is unavailable.
9. Agent state is bounded by `max_reservations`, `max_commands_per_reservation`, and terminal retention.
10. Metrics never label tenant, interaction, reservation, call, command, IP address, or SDP.

### Task 1: Versioned Protocol And Schema

**Files:**
- Create: `src/agent-runtime/ivekit/media-control/protocol.ts`
- Create: `docs/capacity/schemas/voice-media-control-v1.schema.json`
- Create: `test/ivekit-voice-media-control-protocol.test.ts`

- [ ] Write tests that validate prepare, commit, cancel, close, query, and reconcile envelopes against the JSON Schema.
- [ ] Assert malformed protocol versions, owner epochs, sequences, timestamps, identifiers, payload hashes, SDP sizes, and unexpected fields are rejected.
- [ ] Define these public types:

```typescript
export type MediaControlAction = 'prepare' | 'commit' | 'cancel' | 'close';
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
  reservation_id: string;
  interaction_id: string;
  owner_epoch: string;
  sequence: number;
  lease_expires_at: string;
  payload: Record<string, unknown>;
}
```

- [ ] Canonicalize and hash commands inside the module; never trust a caller-provided hash.
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

- [ ] Write failing tests for prepare, commit, cancel, close, prepared-session expiry, owner takeover, stale epoch rejection, sequence gaps, command replay, command payload conflict, and capacity exhaustion.
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
    reservation_id: string;
    interaction_id: string;
    owner_epoch: string;
    operation: 'open' | 'mutate' | 'close';
  }, now: Date): Promise<void>;
}
```

- [ ] Store a bounded command journal per reservation. Record the canonical command hash and the exact public result.
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

- [ ] Expose `POST /v1/commands`, `POST /v1/reconcile`, `GET /v1/sessions/:reservation_id`, `GET /livez`, `GET /readyz`, and `GET /metrics`.
- [ ] Bound request body, response body, identifier, SDP, header, and timeout sizes.
- [ ] Require a bearer token on every non-health endpoint.
- [ ] Refuse production startup unless TLS is enabled, client certificates are required, and a CA is configured.
- [ ] Map deterministic domain errors to stable HTTP statuses and retryability.
- [ ] Make network timeout and connection loss return `state: unknown`; never silently retry with a new command ID.
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

- [ ] Map RustPBX call graph operations to prepare/commit/cancel/close commands while preserving command IDs across retries.
- [ ] Keep RustPBX logical SDP intent separate from the transport-returned effective SDP.
- [ ] Require reconciliation before issuing a later sequence when the preceding command is unknown.
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
- Create: `infra/ivekit/media-control/entrypoint.ts`
- Create: `infra/ivekit/media-control/compose.yaml`
- Create: `infra/ivekit/media-control/README.md`
- Modify: `package.json`
- Create: `test/ivekit-voice-media-control-deployment.test.ts`
- Create: `test/ivekit-voice-media-control-acceptance.test.ts`

- [ ] Build a non-root, read-only image with deterministic configuration and health checks.
- [ ] Add Compose wiring on the OPC private network only; do not alter LED manifests or public routes.
- [ ] Add `test:ivekit:voice-media-goal1` containing every Goal 1 contract and acceptance test.
- [ ] Run type checking and the full Goal 1 suite.
- [ ] Deploy the exact commit to `/opt/opc-ivekit-led/source`, leaving all LED containers and files unchanged.
- [ ] Exercise stale epochs, replay, prepare/commit/cancel/expiry, before-apply uncertainty, after-apply uncertainty, agent restart, and control-plane outage.
- [ ] Record exact commit, image digest, configuration hash, timestamps, outcomes, and `not_run` external dependencies in the capacity evidence bundle.

Final commands:

```bash
npm run typecheck
npm run test:ivekit:voice-media-goal1
git diff --check
```

Expected: all commands exit zero. This proves Goal 1 only; it does not claim Goal 2 rtpengine forwarding or final physical capacity.
