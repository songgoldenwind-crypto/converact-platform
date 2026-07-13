# iveKit Voice Foundation M2 Voice Core and RustPBX Implementation Plan

> **For agentic workers:** Use the project `executing-plans` skill with Inline Execution. Do not invoke `using-superpowers`. Track every checkbox, use TDD for each behavior, and review each commit before continuing.

**Goal:** Deliver a standalone PostgreSQL-backed Voice Core that manages provider profiles and telephony desired state, creates and controls calls through durable commands, reconciles RustPBX events/CDRs, and creates LiveKit SIP bridges without importing OPC legacy Voice, IVR, call-center, SQLite, `db.ts`, or harness code.

**Architecture:** Voice Core remains inside the iveKit control-plane process as a deep module. PostgreSQL is the only production authority; RustPBX and LiveKit SIP remain independent data-plane processes behind provider ports. Every non-idempotent external operation is persisted before execution, RWI timeouts become `uncertain` and are reconciled, inbound provider traffic resolves tenant from a signed deployment-profile binding, and public DTOs expose only redacted addresses.

**Tech Stack:** TypeScript, Node.js 23, PostgreSQL 16, `pg`, `ws`, `livekit-server-sdk@2.15.4`, Node test runner, Prometheus metrics, existing iveKit Bearer auth/RLS/event infrastructure.

---

## Scope Boundaries

M2 includes:

- deployment profiles, secret refs, capability snapshots, and preflight;
- trunk, DID, extension, route, policy, and consent desired-state APIs;
- call creation/query/action APIs and the approved call state machine;
- durable call/configuration commands, retry, lease recovery, and reconciliation;
- RustPBX Management HTTP, HTTP Router, CDR/event, RWI v1, and Step IVR protocol adapters;
- LiveKit SIP outbound participant/transfer bridge adapter;
- controlled provider acceptance and real PostgreSQL acceptance.

M2 does not claim:

- execution of the 25 IVR nodes, flow publishing, simulation, or session recovery; M3 owns those behaviors;
- ACD, agent presence, queues, callbacks, or supervisor policy; M4 owns those behaviors;
- WebPhone/IVR Designer/Queue Monitor UI and final SDK surface; M5 owns them;
- real carrier/PSTN or real RustPBX/LiveKit client evidence when credentials and clients are absent; those remain `not_run` until M6.

The Step IVR adapter in M2 validates/normalizes RustPBX envelopes and maps portable `IvrAction` values to provider actions. The production Step IVR endpoint is enabled only when the M3 executor is injected; it must return `capability_unavailable`, never a fake success, before then.

## Locked Upstream Contracts

- RustPBX HTTP/API baseline: `https://github.com/restsend/rustpbx/blob/main/docs/api_integration_guide.md`.
- RustPBX RWI v1 baseline: `https://github.com/restsend/rustpbx/blob/main/docs/rwi.md`.
- RWI endpoint is `/rwi/v1`; auth uses `Authorization: Bearer`; commands use `action`, `action_id`, and `params`; completion is asynchronous through `command_completed`/`command_failed`.
- RustPBX RWI implementation status is capability data, not a promise. Preflight must not advertise known partial/stub functions as fully available.
- LiveKit SIP uses the pinned server SDK `SipClient.createSipParticipant`, `transferSipParticipant`, and trunk/dispatch APIs available in `2.15.4`.
- Runtime behavior is bound to the stored provider version/config hash and capability snapshot, not to documentation wording or a floating container tag.

## File Map

**Create under `src/agent-runtime/ivekit/voice/`:**

- `state-machine.ts`: pure call transition reducer and provider-event precedence.
- `errors.ts`: stable internal Voice error codes and retry classification.
- `canonical.ts`: canonical JSON/hash utilities and safe provider payload projection.
- `address-protector.ts`: AES-256-GCM address encryption and keyed HMAC lookup.
- `secret-resolver.ts`: allowlisted `env://NAME` secret-ref resolver.
- `provider-registry.ts`: adapter factory keyed by stored deployment profile.
- `deployment-profile-service.ts`: profile CRUD and capability snapshot orchestration.
- `configuration-service.ts`: trunk/DID/extension/route/policy/consent desired state.
- `call-service.ts`: idempotent call creation, query, and action command creation.
- `provider-event-service.ts`: webhook dedupe, normalization, and state convergence.
- `recording-service.ts`: CDR/recording projection and retention metadata updates.
- `http.ts`: stable `/api/ivekit/voice/*` routes.
- `webhook-auth.ts`: profile-bound provider signature/service-key verification.
- `preflight.ts`: deployment/runtime Voice preflight report.
- `metrics.ts`: bounded-label Voice metrics.
- `postgres/configuration-store.ts`: profiles, snapshots, trunks, DIDs, extensions, routes, policies, consents.
- `postgres/call-store.ts`: calls and participants.
- `postgres/command-store.ts`: call and configuration commands.
- `postgres/provider-event-store.ts`: provider event inbox and claims.
- `postgres/recording-store.ts`: recordings and LiveKit bridge mappings.
- `workers/command-worker.ts`: due call/configuration command execution.
- `workers/provider-event-worker.ts`: due provider event projection.
- `workers/reconciliation-worker.ts`: `uncertain` command reconciliation.
- `adapters/controlled-provider.ts`: deterministic acceptance provider.
- `adapters/rustpbx-management.ts`: bounded Management/AMI HTTP client.
- `adapters/rustpbx-routing.ts`: HTTP Router request/response normalization.
- `adapters/rustpbx-rwi.ts`: RWI v1 connection, correlation, events, and command mapping.
- `adapters/rustpbx-events.ts`: RustPBX RWI/CDR/event normalization.
- `adapters/livekit-sip.ts`: LiveKit SIP bridge implementation.

**Create under `src/agent-runtime/ivekit/ivr/adapters/`:**

- `rustpbx-step-ivr.ts`: Step IVR envelope validation and portable action mapping.

**Create migration and scripts:**

- `src/migrations/048_ivekit_voice_operations.sql`: durable configuration commands and worker/profile lookup functions.
- `scripts/ivekit-voice-preflight.ts`: secret-safe CLI report.
- `scripts/ivekit-controlled-voice-provider.ts`: controlled HTTP/RWI provider for acceptance.
- `scripts/render-rustpbx-config.ts`: validated RustPBX TOML renderer; rejects SQLite and missing production secrets.

**Create deployment surfaces:**

- `infra/ivekit/docker-compose.voice.yml`: optional standalone Voice data plane with PostgreSQL-backed RustPBX.
- `infra/k8s/templates/rustpbx-deployment.yaml`: opt-in RustPBX Deployment, Service, and disruption policy.
- `test/ivekit-voice-deployment.test.ts`: immutable image, database isolation, secret, port, and render gates.

**Modify composition/delivery:**

- `src/agent-runtime/ivekit/voice/types.ts`
- `src/agent-runtime/ivekit/voice/ports.ts`
- `src/agent-runtime/ivekit/voice/index.ts`
- `src/agent-runtime/ivekit/application.ts`
- `src/agent-runtime/ivekit/http-server.ts`
- `src/ivekit-server.ts`
- `services/ivekit-service/source-policy.json`
- `services/ivekit-service/env.example`
- `infra/env.example`
- `infra/docker-compose.production.yml`
- `infra/ivekit/docker-compose.yml`
- `infra/ivekit/init-postgres-runtime-role.sh`
- `infra/k8s/templates/opc-deployment.yaml`
- `infra/k8s/templates/secrets.yaml`
- `infra/k8s/values.yaml`
- `config/rustpbx.docker.toml`
- `package.json`
- `test/ivekit-standalone-migrations.test.ts`
- `test/ivekit-standalone-postgres.test.ts`
- `test/ivekit-standalone-source-graph.test.ts`
- `test/ivekit-delivery-bundle.test.ts`

---

### Task 1: Lock Voice domain types and state machine

**Files:**
- Create: `test/ivekit-voice-state-machine.test.ts`
- Create: `src/agent-runtime/ivekit/voice/state-machine.ts`
- Create: `src/agent-runtime/ivekit/voice/errors.ts`
- Modify: `src/agent-runtime/ivekit/voice/types.ts`
- Modify: `src/agent-runtime/ivekit/voice/index.ts`

- [x] **Step 1: Write failing transition-table tests**

Cover every allowed edge and representative rejected edges:

```typescript
assert.equal(transitionVoiceCall('planned', 'queue').state, 'queued');
assert.equal(transitionVoiceCall('queued', 'dial').state, 'dialing');
assert.equal(transitionVoiceCall('dialing', 'ring').state, 'ringing');
assert.equal(transitionVoiceCall('ringing', 'answer').state, 'active');
assert.equal(transitionVoiceCall('active', 'hold').state, 'held');
assert.equal(transitionVoiceCall('held', 'resume').state, 'active');
assert.equal(transitionVoiceCall('active', 'transfer').state, 'transferring');
assert.equal(transitionVoiceCall('transferring', 'complete').state, 'completed');
assert.throws(() => transitionVoiceCall('completed', 'answer'), /terminal_call_state/);
assert.throws(() => transitionVoiceCall('planned', 'hold'), /invalid_call_transition/);
```

Also prove duplicate provider states are no-ops, late `ringing` cannot revive `active`/terminal calls, CDR can enrich but not revive a terminal call, and timestamps are set only on the first matching transition.

- [x] **Step 2: Run the test and verify missing exports fail**

Run:

```bash
node --import tsx --test test/ivekit-voice-state-machine.test.ts
```

Expected: FAIL because `state-machine.ts` does not exist.

- [x] **Step 3: Add complete public domain records**

Add records for `VoiceDeploymentProfile`, `VoiceCapabilitySnapshot`, `VoiceSipTrunk`, `VoiceDid`, `VoiceExtension`, `VoiceRoute`, `VoiceRouteVersion`, `VoiceParticipant`, `VoiceProviderEvent`, `VoiceRecording`, `VoiceConsent`, `VoicePolicy`, `VoiceLiveKitBridge`, and `VoiceConfigurationCommand`. All records use snake_case fields matching PostgreSQL; address-bearing public records expose only `VoiceAddressProjection`.

Define the transition input as a closed union:

```typescript
export type VoiceCallTransition =
  | 'queue' | 'dial' | 'ring' | 'answer' | 'hold' | 'resume'
  | 'transfer' | 'complete' | 'cancel' | 'miss' | 'reject'
  | 'fail' | 'timeout';
```

- [x] **Step 4: Implement the pure reducer**

`transitionVoiceCall` returns `{ state, ringing_at?, answered_at?, ended_at? }` and throws `VoiceError` with stable codes. `mergeProviderCallState` maps RustPBX/LiveKit states into reducer transitions with precedence instead of directly assigning database states.

- [x] **Step 5: Run state-machine and boundary tests**

```bash
node --import tsx --test test/ivekit-voice-state-machine.test.ts test/ivekit-voice-foundation-boundary.test.ts
```

Expected: PASS; source graph still contains no legacy Voice/IVR/call-center runtime.

- [x] **Step 6: Commit**

```bash
git add test/ivekit-voice-state-machine.test.ts src/agent-runtime/ivekit/voice
git commit -m "feat(ivekit): define voice core state machine"
```

---

### Task 2: Add durable configuration operations and secure worker discovery

**Files:**
- Create: `src/migrations/048_ivekit_voice_operations.sql`
- Create: `test/ivekit-voice-operations-migration.test.ts`
- Modify: `services/ivekit-service/source-policy.json`
- Modify: `test/ivekit-standalone-migrations.test.ts`
- Modify: `test/ivekit-standalone-postgres.test.ts`

- [ ] **Step 1: Write failing migration assertions**

Require one new authority table:

```text
ivekit_voice_configuration_commands
```

Required columns are `tenant_id`, `profile_id`, `resource_type`, `resource_id`, `operation`, `state`, `idempotency_key`, `payload_hash`, `payload`, `attempt_count`, `max_attempts`, `next_attempt_at`, `lease_until`, `worker_id`, `provider_command_id`, `result`, `error_code`, `error_message`, and timestamps. Require unique `(tenant_id,idempotency_key)`, bounded attempts, due index, tenant FK, ENABLE/FORCE RLS, and tenant policy.

Require `opc_worker_tenant_ids` branches for `voice_command`, `voice_configuration`, and `voice_provider_event`. Require a `SECURITY DEFINER` function `opc_ivekit_voice_profile_context(profile_id)` that returns only `tenant_id`, `profile_id`, `adapter`, and `secret_refs`; set `search_path`, revoke PUBLIC, and grant only `opc_runtime` when that role exists.

- [ ] **Step 2: Observe the red test**

```bash
node --import tsx --test test/ivekit-voice-operations-migration.test.ts
```

Expected: FAIL because migration 048 is absent.

- [ ] **Step 3: Implement migration 048 and policy order**

Place 048 after 047 and before standalone 090. The profile lookup function must select by globally unique profile `id`, expose no base URL/config/secret value, and return zero rows for archived profiles. Preserve all existing worker queue branches when replacing `opc_worker_tenant_ids`.

- [ ] **Step 4: Extend real PostgreSQL acceptance**

Prove:

- tenant A cannot see/claim tenant B configuration commands;
- two workers cannot claim the same row (`FOR UPDATE SKIP LOCKED`);
- expired `processing` leases are reclaimable;
- profile lookup returns the correct tenant without enabling RLS bypass;
- runtime role still has `NOSUPERUSER`, `NOBYPASSRLS`, no schema CREATE, and no migration-ledger access;
- fresh/upgrade migration reruns remain checksum-idempotent.

- [ ] **Step 5: Run static and real PostgreSQL tests**

```bash
node --import tsx --test test/ivekit-voice-operations-migration.test.ts test/ivekit-standalone-migrations.test.ts
sh scripts/verify-ivekit-postgres.sh
```

Expected: all static tests and fresh/upgrade PostgreSQL cases pass.

- [ ] **Step 6: Commit**

```bash
git add src/migrations/048_ivekit_voice_operations.sql services/ivekit-service/source-policy.json test/ivekit-voice-operations-migration.test.ts test/ivekit-standalone-migrations.test.ts test/ivekit-standalone-postgres.test.ts
git commit -m "feat(ivekit): add durable voice configuration operations"
```

---

### Task 3: Protect addresses, secrets, and provider payloads

**Files:**
- Create: `src/agent-runtime/ivekit/voice/address-protector.ts`
- Create: `src/agent-runtime/ivekit/voice/secret-resolver.ts`
- Create: `src/agent-runtime/ivekit/voice/canonical.ts`
- Create: `test/ivekit-voice-security.test.ts`

- [ ] **Step 1: Write failing security tests**

Test an E.164, extension, and SIP URI round trip; tenant A ciphertext must not decrypt under tenant B. The encrypted envelope must be `v1.<nonce>.<tag>.<ciphertext>` and contain no plaintext. HMAC must be 64 lowercase hex characters and stable for the same tenant/normalized address. Redaction examples:

```text
+8613800138000 -> +86******8000
1001 -> **01
sip:alice@example.test -> sip:a***@example.test
```

Reject keys that are not base64-encoded 32-byte values. Resolve only `env://UPPER_SNAKE_CASE`; reject missing variables, direct secret strings, nested objects, and names outside the allowlist. Safe payload projection must remove SDP/body, Authorization, cookies, passwords, tokens, raw phone fields, and recursively bound depth/string/array sizes.

- [ ] **Step 2: Observe failures**

```bash
node --import tsx --test test/ivekit-voice-security.test.ts
```

Expected: FAIL because the security modules do not exist.

- [ ] **Step 3: Implement cryptographic protection**

Use HKDF-SHA256 to derive per-tenant encryption and HMAC keys from separate 32-byte roots. Use AES-256-GCM with tenant id and address kind as authenticated data. Normalize E.164, extension, and SIP URI before HMAC. Do not log values or include clear addresses in thrown errors.

- [ ] **Step 4: Implement secret refs and canonical hashing**

`EnvVoiceSecretResolver.resolve(ref, purpose)` returns a string only for allowed env refs. `canonicalVoicePayloadHash` recursively sorts object keys and hashes canonical JSON. `safeVoiceProviderPayload` returns a bounded redacted object used by event persistence and diagnostics.

- [ ] **Step 5: Run security and type checks**

```bash
node --import tsx --test test/ivekit-voice-security.test.ts
npm run typecheck
```

Expected: PASS with no secret/plain-address assertion failure.

- [ ] **Step 6: Commit**

```bash
git add src/agent-runtime/ivekit/voice/address-protector.ts src/agent-runtime/ivekit/voice/secret-resolver.ts src/agent-runtime/ivekit/voice/canonical.ts test/ivekit-voice-security.test.ts
git commit -m "feat(ivekit): protect voice addresses and provider secrets"
```

---

### Task 4: Implement PostgreSQL Voice stores

**Files:**
- Create: `src/agent-runtime/ivekit/voice/postgres/configuration-store.ts`
- Create: `src/agent-runtime/ivekit/voice/postgres/call-store.ts`
- Create: `src/agent-runtime/ivekit/voice/postgres/command-store.ts`
- Create: `src/agent-runtime/ivekit/voice/postgres/provider-event-store.ts`
- Create: `src/agent-runtime/ivekit/voice/postgres/recording-store.ts`
- Create: `test/ivekit-voice-postgres-stores.test.ts`
- Modify: `src/agent-runtime/ivekit/voice/ports.ts`

- [ ] **Step 1: Write failing store contract tests with a recording `PgQueryable`**

Assert parameterized SQL and decoding for every store. Explicitly test optimistic updates use `WHERE tenant_id=$1 AND id=$2 AND revision=$expected`, idempotent inserts use `ON CONFLICT ... DO NOTHING` then reload, cursor ordering is `(created_at,id)`, and no query selects clear address columns into public DTOs.

- [ ] **Step 2: Define complete repository ports**

Add focused interfaces rather than one broad store:

```typescript
export interface VoiceConfigurationRepository {
  getProfile(tenantId: string, id: string, options?: { for_update?: boolean }): Promise<VoiceDeploymentProfile | null>;
  listProfiles(input: VoiceListInput): Promise<VoicePage<VoiceDeploymentProfile>>;
  insertProfile(input: VoiceDeploymentProfile): Promise<VoiceDeploymentProfile>;
  updateProfile(input: VoiceDeploymentProfile, expectedRevision: number): Promise<VoiceDeploymentProfile>;
  insertCapabilitySnapshot(input: VoiceCapabilitySnapshot): Promise<VoiceCapabilitySnapshot>;
  getLatestCapabilitySnapshot(tenantId: string, profileId: string): Promise<VoiceCapabilitySnapshot | null>;
}
```

Define analogous explicit ports for desired-state resources, calls/participants, call/configuration commands, provider events, recordings, and bridges. Claim methods take worker id, now, lease, and bounded limit; completion methods require the current worker id so stale workers cannot commit.

- [ ] **Step 3: Implement configuration and call stores**

Use `withPgTransaction` for compound writes. Return typed DTOs with JSONB/arrays/timestamps decoded. A missing optimistic update row throws `revision_conflict`; a tenant mismatch remains indistinguishable from not found.

- [ ] **Step 4: Implement command/event/recording stores**

Use one SQL claim statement per queue with `FOR UPDATE SKIP LOCKED`. Reclaim rows whose lease expired. `complete` and `release` update only rows owned by the current worker. Event insert deduplicates both external event id and canonical hash and returns `{ event, replayed }`.

- [ ] **Step 5: Run store tests and real PostgreSQL probes**

```bash
node --import tsx --test test/ivekit-voice-postgres-stores.test.ts
sh scripts/verify-ivekit-postgres.sh
```

Expected: store tests pass; real PostgreSQL proves claims, revisions, unique idempotency, and RLS.

- [ ] **Step 6: Commit**

```bash
git add src/agent-runtime/ivekit/voice/ports.ts src/agent-runtime/ivekit/voice/postgres test/ivekit-voice-postgres-stores.test.ts test/ivekit-standalone-postgres.test.ts
git commit -m "feat(ivekit): add voice postgres repositories"
```

---

### Task 5: Implement deployment profile and capability negotiation

**Files:**
- Create: `src/agent-runtime/ivekit/voice/provider-registry.ts`
- Create: `src/agent-runtime/ivekit/voice/deployment-profile-service.ts`
- Create: `src/agent-runtime/ivekit/voice/adapters/controlled-provider.ts`
- Create: `test/ivekit-voice-capabilities.test.ts`
- Modify: `src/agent-runtime/ivekit/voice/ports.ts`

- [ ] **Step 1: Write failing capability tests**

Prove profile creation stores secret refs but not resolved values, revision conflicts return `revision_conflict`, disabled/archived profiles cannot execute commands, and preflight writes an immutable snapshot containing provider version, exact config hash, status, error code, and all nine booleans.

The controlled provider must support profiles that deliberately report each capability combination and failures `auth_failed`, `connection_failed`, `protocol_mismatch`, and `capability_unavailable`.

- [ ] **Step 2: Extend provider ports**

Keep `VoiceProviderPort` for call commands and add:

```typescript
export interface VoiceProviderAdapter extends VoiceProviderPort {
  management: VoiceManagementPort;
  normalizeEvent(input: unknown): VoiceNormalizedProviderEvent;
  close(): Promise<void>;
}

export interface VoiceProviderFactory {
  create(profile: VoiceDeploymentProfile): Promise<VoiceProviderAdapter>;
}
```

`VoiceManagementPort` exposes `preflight`, `applyTrunk`, `testTrunk`, `applyExtension`, `applyRoute`, `lookupDialog`, and `lookupRecording`; each returns a provider ref/revision plus safe diagnostics.

- [ ] **Step 3: Implement the registry and profile service**

Register `controlled`, `rustpbx`, and `livekit_sip` factories explicitly. Unknown adapters are rejected. Compute config hash from non-secret profile config plus secret-ref names, never resolved secret values. Persist failed snapshots as `failed`/`not_available` rather than losing diagnostics.

- [ ] **Step 4: Implement the controlled adapter**

It must be deterministic, use supplied clock, expose no network, honor command idempotency, and retain enough command/provider state to exercise success, retry, timeout/unknown, duplicate event, and reconciliation paths.

- [ ] **Step 5: Run tests**

```bash
node --import tsx --test test/ivekit-voice-capabilities.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent-runtime/ivekit/voice/provider-registry.ts src/agent-runtime/ivekit/voice/deployment-profile-service.ts src/agent-runtime/ivekit/voice/adapters/controlled-provider.ts src/agent-runtime/ivekit/voice/ports.ts test/ivekit-voice-capabilities.test.ts
git commit -m "feat(ivekit): negotiate voice provider capabilities"
```

---

### Task 6: Implement RustPBX Management and HTTP Router adapters

**Files:**
- Create: `src/agent-runtime/ivekit/voice/adapters/rustpbx-management.ts`
- Create: `src/agent-runtime/ivekit/voice/adapters/rustpbx-routing.ts`
- Create: `test/ivekit-rustpbx-management.test.ts`
- Create: `test/ivekit-rustpbx-routing.test.ts`

- [ ] **Step 1: Write failing bounded-HTTP tests**

Use a loopback `http.Server` and verify:

- base URL requires `http`/`https`; production requires HTTPS unless explicitly marked an internal service URL;
- request timeout and response byte limits are enforced;
- Authorization/service-key values never appear in errors;
- 401/403 are terminal `auth_failed`, 404 capability probes are `not_available`, 408/429/5xx/reset are retryable, malformed JSON is `protocol_mismatch`;
- health/version, AMI health/dialog/SipFlow, trunk apply/test, extension apply, route evaluate/reload map to configured endpoints;
- profile-configured paths must start with `/` and cannot contain credentials or traversal.

- [ ] **Step 2: Implement Management HTTP transport**

Use `fetch` with `AbortSignal.timeout`, manual bounded text parsing, `redirect: 'error'`, and headers resolved from secret refs. Do not use console session-cookie login. A profile that lacks a service-token-compatible management endpoint reports `management_http=false` instead of claiming CRUD support.

- [ ] **Step 3: Implement strict Router normalization**

Accept RustPBX fields `call_id`, `from`, `to`, `source_addr`, `direction`, `method`, `uri`, and headers, but discard SDP/body and unsafe headers before persistence. Return only:

```typescript
type RustPbxRouterResponse =
  | { action: 'forward'; targets: string[]; strategy: 'parallel' | 'sequential'; record: boolean; timeout: number; headers: Record<string, string> }
  | { action: 'reject' | 'abort' | 'spam' | 'not_handled'; code?: number; reason?: string };
```

Portable route decisions `forward_sip`, `start_ivr`, `enqueue`, `bridge_livekit`, and `voicemail` must map explicitly or return a capability error; do not invent an unsupported RustPBX action.

- [ ] **Step 4: Run adapter tests**

```bash
node --import tsx --test test/ivekit-rustpbx-management.test.ts test/ivekit-rustpbx-routing.test.ts
```

Expected: PASS, including timeout/oversize/secret-redaction cases.

- [ ] **Step 5: Commit**

```bash
git add src/agent-runtime/ivekit/voice/adapters/rustpbx-management.ts src/agent-runtime/ivekit/voice/adapters/rustpbx-routing.ts test/ivekit-rustpbx-management.test.ts test/ivekit-rustpbx-routing.test.ts
git commit -m "feat(ivekit): add rustpbx management and routing adapters"
```

---

### Task 7: Implement RustPBX RWI v1 and Step IVR protocol adapters

**Files:**
- Create: `src/agent-runtime/ivekit/voice/adapters/rustpbx-rwi.ts`
- Create: `src/agent-runtime/ivekit/ivr/adapters/rustpbx-step-ivr.ts`
- Create: `test/ivekit-rustpbx-rwi.test.ts`
- Create: `test/ivekit-rustpbx-step-ivr.test.ts`

- [ ] **Step 1: Write failing RWI protocol tests**

Run a loopback `WebSocketServer` and assert:

- connection path is `/rwi/v1` and token is sent in the Authorization header, not query string;
- durable command id is used as `action_id`;
- `command_completed`/`command_failed` correlate once and duplicate/unknown action ids become safe events;
- command timeout returns `uncertain`, closes no unrelated command, and does not retry originate;
- reconnect resubscribes configured contexts and does not revive after shutdown;
- max message bytes, JSON object shape, and heartbeat timeout are enforced;
- `call.originate/answer/hangup/hold/unhold/transfer`, recording, conference, and DTMF map exactly;
- park/pickup or any unavailable command fails `capability_unavailable`.

- [ ] **Step 2: Implement the RWI client**

Keep connection lifecycle separate from command correlation. Use bounded exponential reconnect with jitter, one pending promise per action id, and a `close()` that rejects pending commands and cancels reconnection. Preflight sends `session.list_calls` and derives supported command groups from the stored provider version/matrix plus successful protocol probe.

- [ ] **Step 3: Write and implement Step IVR normalization tests**

Validate profile id, provider session id, monotonic event sequence, action revision, event type, DTMF digit, and bounded metadata. Map portable actions:

```text
play -> prompt
collect -> collect_dtmf or dtmf_menu
queue -> queue
transfer -> transfer
record -> record
hangup -> hangup or play_and_hangup
wait -> wait
```

Reject unsupported `webhook`/`media` actions at this adapter boundary unless the IVR executor resolves them first. Duplicate event sequence must replay the same action revision; out-of-order sequence returns `event_sequence_conflict`.

- [ ] **Step 4: Run tests**

```bash
node --import tsx --test test/ivekit-rustpbx-rwi.test.ts test/ivekit-rustpbx-step-ivr.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent-runtime/ivekit/voice/adapters/rustpbx-rwi.ts src/agent-runtime/ivekit/ivr/adapters/rustpbx-step-ivr.ts test/ivekit-rustpbx-rwi.test.ts test/ivekit-rustpbx-step-ivr.test.ts
git commit -m "feat(ivekit): add rustpbx rwi and step ivr adapters"
```

---

### Task 8: Implement desired-state services and durable configuration worker

**Files:**
- Create: `src/agent-runtime/ivekit/voice/configuration-service.ts`
- Create: `src/agent-runtime/ivekit/voice/workers/command-worker.ts`
- Create: `test/ivekit-voice-configuration-service.test.ts`
- Create: `test/ivekit-voice-command-worker.test.ts`

- [ ] **Step 1: Write failing desired-state service tests**

Cover profile/trunk/DID/extension/route/policy/consent create/list/get/update. Require revision on every mutable update, normalized/unique DID HMAC, secret refs instead of credentials, route canonical hash/version immutability, and immutable tenant events for admin changes.

For `apply`/`test`/`preflight`, same idempotency key plus same payload returns the existing operation; same key with another hash returns `idempotency_conflict`.

- [ ] **Step 2: Implement configuration services**

Validate bounded names, codec/transport/direction, generic identity, E.164, route schema, and secret refs before writing. Route publish creates an immutable version and a configuration command in one transaction. Do not call providers from the request transaction.

- [ ] **Step 3: Write failing configuration worker tests**

Prove one active batch at a time, bounded batch/lease config, capability gate before execution, success/failure/retry transitions, stale completion rejection, shutdown waiting for active work, and expired-lease recovery. Provider timeouts on an operation with no safe lookup become `uncertain`, not automatic success.

- [ ] **Step 4: Implement the shared command worker**

The worker claims call and configuration queues independently, resolves tenant-scoped profile/adapter, and executes outside the claim transaction. Retry delays are deterministic by attempt plus bounded jitter. `originate`, route apply, and trunk apply are never blindly repeated after an ambiguous acceptance; they enter reconciliation.

- [ ] **Step 5: Run tests**

```bash
node --import tsx --test test/ivekit-voice-configuration-service.test.ts test/ivekit-voice-command-worker.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent-runtime/ivekit/voice/configuration-service.ts src/agent-runtime/ivekit/voice/workers/command-worker.ts test/ivekit-voice-configuration-service.test.ts test/ivekit-voice-command-worker.test.ts
git commit -m "feat(ivekit): apply voice desired state durably"
```

---

### Task 9: Implement call service, compliance gate, command execution, and reconciliation

**Files:**
- Create: `src/agent-runtime/ivekit/voice/call-service.ts`
- Create: `src/agent-runtime/ivekit/voice/workers/reconciliation-worker.ts`
- Create: `test/ivekit-voice-call-service.test.ts`
- Create: `test/ivekit-voice-reconciliation.test.ts`

- [ ] **Step 1: Write failing call creation tests**

An outbound call requires profile, from/to address, business reference, actor, and idempotency key. Verify addresses are protected before persistence, response contains only redacted values, profile/capability/policy/compliance are checked, and call plus `originate` command are committed atomically. Replayed requests return the same call; changed payload conflicts.

Inbound creation uses provider event id/call id as idempotency source and cannot trust a provider-supplied tenant header.

- [ ] **Step 2: Write failing action tests**

Cover answer, hangup, DTMF, hold/resume, blind/warm transfer, conference, park/pickup, recording start/pause/resume/stop, and LiveKit bridge. Validate call state and capability before enqueuing. External side effects are never executed inline. Recording actions require policy/consent evidence; outbound originate uses `VoiceCompliancePort`.

- [ ] **Step 3: Implement `VoiceCallService`**

Use store transactions and state-machine projections. Reveal clear addresses only inside the worker immediately before adapter execution; do not persist them in command payload/result or events. Publish `voice.call.created` and `voice.call.command_updated` only after commit.

- [ ] **Step 4: Implement reconciliation**

Claim only due `uncertain` commands. `succeeded` updates provider refs and legal call state, `failed` records terminal error, `pending` schedules another reconcile, and `unknown` remains uncertain until max reconcile age then fails `provider_result_unknown`. Originate is never resubmitted during reconcile.

- [ ] **Step 5: Run tests**

```bash
node --import tsx --test test/ivekit-voice-call-service.test.ts test/ivekit-voice-reconciliation.test.ts
```

Expected: PASS, including consent denial and unknown originate behavior.

- [ ] **Step 6: Commit**

```bash
git add src/agent-runtime/ivekit/voice/call-service.ts src/agent-runtime/ivekit/voice/workers/reconciliation-worker.ts test/ivekit-voice-call-service.test.ts test/ivekit-voice-reconciliation.test.ts
git commit -m "feat(ivekit): execute and reconcile voice calls"
```

---

### Task 10: Ingest RustPBX events, Router requests, CDRs, and recordings

**Files:**
- Create: `src/agent-runtime/ivekit/voice/adapters/rustpbx-events.ts`
- Create: `src/agent-runtime/ivekit/voice/provider-event-service.ts`
- Create: `src/agent-runtime/ivekit/voice/recording-service.ts`
- Create: `src/agent-runtime/ivekit/voice/workers/provider-event-worker.ts`
- Create: `src/agent-runtime/ivekit/voice/webhook-auth.ts`
- Create: `test/ivekit-rustpbx-events.test.ts`
- Create: `test/ivekit-voice-provider-events.test.ts`

- [ ] **Step 1: Write failing webhook/auth tests**

Support either a profile-bound service key (`X-PBX-Key`) or preferred HMAC headers `X-IveKit-Timestamp` and `X-IveKit-Signature` over `<timestamp>.<raw-body>`. Enforce five-minute skew, constant-time comparison, body byte limit, and no secret in errors. Resolve tenant only through `opc_ivekit_voice_profile_context`; ignore `X-Tenant-Id` and payload tenant fields.

- [ ] **Step 2: Write failing normalization/dedupe tests**

Normalize RWI call events, HTTP event webhooks, Router INVITE requests, and multipart/JSON CDR metadata. Persist only safe summaries. Duplicate external ids or canonical hashes replay; malformed/unsupported events fail before state mutation; event insertion happens before projection.

- [ ] **Step 3: Implement event convergence**

Map `call.incoming/ringing/answered/hold/hangup/no_answer/busy/transfer` through the state machine. Late/duplicate events remain no-ops. CDR can fill duration, termination reason, recording/provider refs, and ended timestamp without reviving terminal state. Recording rows require consent/policy, object/evidence ref, checksum, and retention timestamp.

- [ ] **Step 4: Implement the provider event worker**

Claim tenant queues using the security-definer worker function, apply events inside tenant transactions, mark processed only after projection commit, retry transient store/provider lookup failures, and dead-end malformed events with a coarse code.

- [ ] **Step 5: Implement Router decision service**

Find tenant/profile from the verified webhook path, DID by keyed HMAC, and published route by immutable version. Return `reject` when no verified mapping exists. Route actions that require M3/M4 dependencies return configured RustPBX fallback or a deterministic reject; never claim an IVR/queue was started when it was not.

- [ ] **Step 6: Run tests**

```bash
node --import tsx --test test/ivekit-rustpbx-events.test.ts test/ivekit-voice-provider-events.test.ts
```

Expected: PASS for duplicate, out-of-order, timeout, CDR, recording, and cross-tenant cases.

- [ ] **Step 7: Commit**

```bash
git add src/agent-runtime/ivekit/voice/adapters/rustpbx-events.ts src/agent-runtime/ivekit/voice/provider-event-service.ts src/agent-runtime/ivekit/voice/recording-service.ts src/agent-runtime/ivekit/voice/workers/provider-event-worker.ts src/agent-runtime/ivekit/voice/webhook-auth.ts test/ivekit-rustpbx-events.test.ts test/ivekit-voice-provider-events.test.ts
git commit -m "feat(ivekit): converge rustpbx events and cdrs"
```

---

### Task 11: Implement LiveKit SIP bridge adapter

**Files:**
- Create: `src/agent-runtime/ivekit/voice/adapters/livekit-sip.ts`
- Create: `test/ivekit-livekit-sip-adapter.test.ts`
- Modify: `src/agent-runtime/ivekit/voice/ports.ts`

- [ ] **Step 1: Write failing adapter tests with a fake `SipClient`**

Verify preflight lists/validates the configured trunk without returning API secrets; bridge creation uses `createSipParticipant(trunkId, number, roomName, options)` with stable participant identity/metadata; replay returns the existing bridge; transfer uses `transferSipParticipant`; SDK timeout/error is classified and sanitized; no clear number enters bridge metadata or logs.

- [ ] **Step 2: Refine the media bridge port**

The adapter input must include resolved SIP trunk provider ref, clear destination only for the call duration, room name/media call id, participant identity, and idempotency key. The result contains provider participant id and safe provider state. Core code may depend only on the port, not `livekit-server-sdk`.

- [ ] **Step 3: Implement `LiveKitSipBridgeAdapter`**

Construct `SipClient` from resolved secret refs. Create/reuse an `ivekit_media_calls` voice/pstn bridge through the existing Media Core service before dialing. Persist bridge `pending` before the SDK call, then `active`/`failed`; ambiguous SDK timeout becomes `uncertain` command and is reconciled from room participant state/webhooks.

- [ ] **Step 4: Run tests**

```bash
node --import tsx --test test/ivekit-livekit-sip-adapter.test.ts test/ivekit-media-call-lifecycle.test.ts
```

Expected: PASS without regression to Media Core.

- [ ] **Step 5: Commit**

```bash
git add src/agent-runtime/ivekit/voice/adapters/livekit-sip.ts src/agent-runtime/ivekit/voice/ports.ts test/ivekit-livekit-sip-adapter.test.ts
git commit -m "feat(ivekit): bridge voice calls through livekit sip"
```

---

### Task 12: Expose stable Voice HTTP APIs and provider webhook context

**Files:**
- Create: `src/agent-runtime/ivekit/voice/http.ts`
- Create: `test/ivekit-voice-http.test.ts`
- Modify: `src/agent-runtime/ivekit/http-server.ts`
- Modify: `src/db-pg-tenant.ts`

- [ ] **Step 1: Write failing route-composition tests**

Add `voice` to `IveKitRouteAdapters`, `/api/ivekit/voice/` to the allowlist, and dispatch Voice before legacy collaboration. Verify Bearer tenant is authoritative, body/query tenant is ignored/rejected, system role cannot silently cross tenant without the normal request context, and provider webhooks use the verified profile context.

- [ ] **Step 2: Write failing stable API tests**

Cover:

- capabilities and deployment profile CRUD/preflight;
- trunk CRUD/apply/test, DID CRUD, extension CRUD/session, route CRUD/validate/publish;
- call list/create/get/actions/events/recordings/LiveKit bridge;
- policy get/patch, consent list/create, recording list;
- Router/events/CDR provider webhooks.

Every list returns `{ items, next_cursor }`; mutable writes require revision; side-effect POSTs require `Idempotency-Key`; accepted commands return 202; conflicts use stable error codes; addresses are redacted.

- [ ] **Step 3: Implement HTTP input/output helpers**

Use one `VoiceHttpContext` built from existing auth. Define bounded body/string/number/limit/cursor helpers locally or reuse existing generic helpers only when their contract matches exactly. Return errors as:

```json
{"error":{"code":"revision_conflict","message":"voice resource revision changed","retryable":false,"request_id":"...","details":{}}}
```

No error details may contain secret refs' values, full phone numbers, SIP authorization, SDP, or raw provider body.

- [ ] **Step 4: Implement async provider webhook tenant resolution**

Before opening the request RLS transaction, call the restricted profile-context function, verify service key/signature, and then set `app.current_tenant`. The route re-verifies the profile id/context before mutation. Unverified webhook requests never run with bypass and return 401/404 without revealing whether a profile exists.

- [ ] **Step 5: Run HTTP and server tests**

```bash
node --import tsx --test test/ivekit-voice-http.test.ts test/ivekit-standalone-http.test.ts test/ivekit-server-entrypoint.test.ts
```

Expected: PASS; non-iveKit OPC Voice/call-center routes remain absent from the standalone server.

- [ ] **Step 6: Commit**

```bash
git add src/agent-runtime/ivekit/voice/http.ts src/agent-runtime/ivekit/http-server.ts src/db-pg-tenant.ts test/ivekit-voice-http.test.ts
git commit -m "feat(ivekit): expose standalone voice api"
```

---

### Task 13: Wire workers, metrics, preflight, and deployment surfaces

**Files:**
- Create: `src/agent-runtime/ivekit/voice/preflight.ts`
- Create: `src/agent-runtime/ivekit/voice/metrics.ts`
- Create: `scripts/ivekit-voice-preflight.ts`
- Create: `scripts/render-rustpbx-config.ts`
- Create: `infra/ivekit/docker-compose.voice.yml`
- Create: `infra/k8s/templates/rustpbx-deployment.yaml`
- Create: `test/ivekit-voice-application.test.ts`
- Create: `test/ivekit-voice-preflight.test.ts`
- Create: `test/ivekit-voice-deployment.test.ts`
- Modify: `src/agent-runtime/ivekit/application.ts`
- Modify: `src/ivekit-server.ts`
- Modify: `services/ivekit-service/env.example`
- Modify: `infra/env.example`
- Modify: `infra/docker-compose.production.yml`
- Modify: `infra/ivekit/docker-compose.yml`
- Modify: `infra/ivekit/init-postgres-runtime-role.sh`
- Modify: `infra/k8s/templates/opc-deployment.yaml`
- Modify: `infra/k8s/templates/secrets.yaml`
- Modify: `infra/k8s/values.yaml`
- Modify: `config/rustpbx.docker.toml`
- Modify: `package.json`

- [ ] **Step 1: Write failing worker lifecycle tests**

Add injectable starts for command, event, and reconciliation workers. Verify all start only when Voice worker config is enabled and PostgreSQL exists, stop in reverse order, wait for active batches, aggregate stop failures, and do not affect existing Media/IM/Intelligence workers.

- [ ] **Step 2: Implement bounded worker config**

Declare and validate:

```text
OPC_IVEKIT_VOICE_WORKERS_ENABLED
OPC_IVEKIT_VOICE_COMMAND_INTERVAL_MS
OPC_IVEKIT_VOICE_COMMAND_BATCH_SIZE
OPC_IVEKIT_VOICE_COMMAND_LEASE_MS
OPC_IVEKIT_VOICE_COMMAND_MAX_ATTEMPTS
OPC_IVEKIT_VOICE_COMMAND_RETRY_DELAYS_MS
OPC_IVEKIT_VOICE_EVENT_INTERVAL_MS
OPC_IVEKIT_VOICE_EVENT_BATCH_SIZE
OPC_IVEKIT_VOICE_EVENT_LEASE_MS
OPC_IVEKIT_VOICE_RECONCILIATION_INTERVAL_MS
OPC_IVEKIT_VOICE_RECONCILIATION_MAX_AGE_MS
OPC_IVEKIT_VOICE_ADDRESS_KEY
OPC_IVEKIT_VOICE_ADDRESS_HMAC_KEY
```

Lease must exceed the provider timeout budget. Disabled Voice must not require address keys or provider profiles.

- [ ] **Step 3: Add metrics with bounded labels**

Record calls by adapter/direction/state, command totals/duration by adapter/kind/result/error code, uncertain/reconciliation totals, event lag by adapter/type, bridge results, and preflight results. Do not label tenant id, call id, business reference, profile id, flow id, or phone number.

- [ ] **Step 4: Implement preflight CLI**

Report PostgreSQL migration presence, runtime role, address-key validity, worker lease budgets, enabled profiles, capability snapshot age/config hash, endpoint schemes, secret-ref resolution status, and LiveKit/RustPBX configuration. Output only booleans, coarse status, safe URL origin/path, and error codes. Add `npm run ivekit:voice-preflight`.

- [ ] **Step 5: Write failing deployment contract tests**

Prove that every production-capable RustPBX surface uses an explicit immutable image reference, never `latest`; uses a dedicated PostgreSQL database named `rustpbx` and a least-privilege `rustpbx_app` role, never SQLite and never `opc_runtime`; mounts generated configuration without committed webhook/RWI tokens; exposes SIP/RTP intentionally while keeping Management/RWI internal by default; and does not give the OPC process RustPBX database credentials.

For Helm, cover enable/disable, image reference, PostgreSQL DSN secret binding, SIP/RTP services, internal Management/RWI endpoints, resources, health checks, and PodDisruptionBudget. For Compose, render both the core file and optional Voice overlay and assert service dependencies, health gates, networks, volumes, profiles, and port ranges.

- [ ] **Step 6: Implement PostgreSQL-only RustPBX deployment**

Extend the standalone PostgreSQL bootstrap with an idempotent `rustpbx_app` role and separate `rustpbx` database. The RustPBX data plane owns that database; iveKit migrations, `opc_admin`, and `opc_runtime` must not own or read it. Production compose must bootstrap the same database/role isolation rather than relying on a local file volume.

Replace the static development TOML with a generated production configuration. `render-rustpbx-config.ts` must validate required secrets, reject `sqlite:`/`sqlite3:` DSNs, reject invalid or overlapping RTP port ranges, reject floating production image refs, and write no secret to stdout. Do not assume TOML environment interpolation. The checked-in TOML may contain only non-secret development structure and explicit placeholders that cannot start production successfully.

Add `infra/ivekit/docker-compose.voice.yml` as an optional overlay/profile. RustPBX receives only its database credential, RWI/webhook service keys, SIP/RTP config, and storage configuration. OPC receives only adapter endpoints and `env://` secret refs, never `RUSTPBX_DB_PASSWORD`. Keep Management HTTP and RWI on the internal network; expose public SIP/RTP only through explicit configuration.

Add an opt-in Helm RustPBX workload with immutable image configuration, generated config Secret/ConfigMap, separate database credential Secret, SIP and RTP service settings, readiness/liveness checks, resources, security context, and disruption budget. Defaults stay disabled until all required values are supplied.

- [ ] **Step 7: Run application, preflight, and deployment tests**

```bash
node --import tsx --test test/ivekit-voice-application.test.ts test/ivekit-voice-preflight.test.ts test/ivekit-voice-deployment.test.ts test/ivekit-application.test.ts
npm run typecheck
COMPOSE_DISABLE_ENV_FILE=1 docker compose --env-file infra/env.example -f infra/docker-compose.production.yml config --quiet
COMPOSE_DISABLE_ENV_FILE=1 docker compose --env-file infra/ivekit/env.example -f infra/ivekit/docker-compose.yml -f infra/ivekit/docker-compose.voice.yml config --quiet
```

Expected: PASS; rendered deployment contains no SQLite DSN, no floating RustPBX image, no committed service token, and no RustPBX database credential in the OPC container.

- [ ] **Step 8: Commit**

```bash
git add src/agent-runtime/ivekit/application.ts src/agent-runtime/ivekit/voice/preflight.ts src/agent-runtime/ivekit/voice/metrics.ts src/ivekit-server.ts scripts/ivekit-voice-preflight.ts scripts/render-rustpbx-config.ts services/ivekit-service/env.example infra/env.example infra/docker-compose.production.yml infra/ivekit/docker-compose.yml infra/ivekit/docker-compose.voice.yml infra/ivekit/init-postgres-runtime-role.sh infra/k8s/templates/opc-deployment.yaml infra/k8s/templates/rustpbx-deployment.yaml infra/k8s/templates/secrets.yaml infra/k8s/values.yaml config/rustpbx.docker.toml package.json test/ivekit-voice-application.test.ts test/ivekit-voice-preflight.test.ts test/ivekit-voice-deployment.test.ts
git commit -m "feat(ivekit): operate standalone voice workers"
```

---

### Task 14: Add controlled Voice provider acceptance and delivery gates

**Files:**
- Create: `scripts/ivekit-controlled-voice-provider.ts`
- Create: `test/ivekit-controlled-voice-provider.test.ts`
- Create: `test/ivekit-voice-controlled-acceptance.test.ts`
- Modify: `services/ivekit-service/source-policy.json`
- Modify: `test/ivekit-standalone-source-graph.test.ts`
- Modify: `test/ivekit-delivery-bundle.test.ts`
- Modify: `package.json`
- Modify: `docs/ivekit-voice-foundation-v1-design.md`
- Modify: `docs/iveKit视频IM通用能力详细设计.md`

- [ ] **Step 1: Build a controlled RustPBX-compatible provider**

Expose loopback HTTP health/AMI/management/Router/CDR endpoints and RWI `/rwi/v1`. Support deterministic profiles for success, retryable 503, delayed/timeout, async success after timeout, duplicate events, out-of-order events, malformed response, auth failure, and declared capability absence. Mark all evidence `controlled`; do not call it real RustPBX evidence.

- [ ] **Step 2: Write end-to-end controlled acceptance**

Against real PostgreSQL and the controlled provider, execute:

1. create profile and preflight;
2. create/apply trunk, DID, extension, and route;
3. originate call and converge dialing/ringing/active/completed;
4. issue hold/resume/transfer/recording commands;
5. force timeout to uncertain and reconcile without duplicate originate;
6. replay duplicate/out-of-order provider events;
7. ingest CDR/recording metadata;
8. create a LiveKit SIP bridge through an injected controlled `SipClient`;
9. restart workers and recover expired leases;
10. prove tenant B cannot read or mutate tenant A resources.

- [ ] **Step 3: Include the complete source graph and delivery artifacts**

Standalone context must include every new M2 source, migration 048, preflight/config-render CLI source, optional Voice Compose overlay, Helm RustPBX workload, and runtime dependency already declared. It must still exclude `src/agent-runtime/voice`, legacy `src/agent-runtime/ivr`, `src/agent-runtime/call-center`, `src/db.ts`, SQLite runtime DDL, and OPC harness. Delivery migration count and hashes must include 048. Delivery tests must reject floating RustPBX images, SQLite DSNs, committed service tokens, and accidental RustPBX database credentials in the OPC service.

- [ ] **Step 4: Update detailed design status**

Record implemented/controlled/not-run boundaries, the new configuration command table, exact RustPBX RWI baseline and known partial capabilities, all API paths implemented in M2, environment variables, and M3/M4 remaining work. Do not mark real RustPBX/PSTN/LiveKit SIP acceptance passed.

- [ ] **Step 5: Run M2 focused acceptance**

```bash
node --import tsx --test \
  test/ivekit-voice-*.test.ts \
  test/ivekit-rustpbx-*.test.ts \
  test/ivekit-livekit-sip-adapter.test.ts \
  test/ivekit-controlled-voice-provider.test.ts \
  test/ivekit-voice-deployment.test.ts
sh scripts/verify-ivekit-postgres.sh
npm run typecheck
```

Expected: all implemented/controlled cases pass; real-provider cases remain explicitly not run.

- [ ] **Step 6: Build and verify standalone delivery**

```bash
npm run ivekit:standalone:context
npm run verify:ivekit:standalone-context
npm run test:ivekit:delivery
npm_config_cache=/private/tmp/ivekit-voice-npm-cache npm run pack:ivekit-sdk
```

Expected: standalone compile/entrypoint/checksums pass and delivery contains migration 048 plus M2 Voice sources.

- [ ] **Step 7: Run full repository regression**

```bash
npm test
```

Expected: zero failures; environment-gated cases may be explicitly skipped.

- [ ] **Step 8: Commit and push M2**

```bash
git add scripts/ivekit-controlled-voice-provider.ts test/ivekit-controlled-voice-provider.test.ts test/ivekit-voice-controlled-acceptance.test.ts services/ivekit-service/source-policy.json test/ivekit-standalone-source-graph.test.ts test/ivekit-delivery-bundle.test.ts test/ivekit-voice-deployment.test.ts package.json docs/ivekit-voice-foundation-v1-design.md docs/iveKit视频IM通用能力详细设计.md
git commit -m "feat(ivekit): complete voice core rustpbx m2"
git push origin codex/ivekit-v4-voice-foundation
git ls-remote origin refs/heads/codex/ivekit-v4-voice-foundation
```

Expected: remote branch head equals local HEAD.

---

## M2 Exit Evidence

M2 is complete only when all conditions below are evidenced:

1. Stable Voice APIs operate solely on `ivekit_voice_*` PostgreSQL authority tables under request-scoped FORCE RLS.
2. Provider profiles store only non-secret config and secret refs; preflight creates immutable config-hash-bound capability snapshots.
3. Outbound/inbound calls converge through one tested state machine and return no plaintext address.
4. Call and configuration side effects are durable, idempotent, leased, retryable, restart-safe, and stale-worker-safe.
5. Ambiguous originate/transfer/recording/bridge outcomes become `uncertain` and reconciliation never blindly repeats originate.
6. RustPBX HTTP Router, Management/AMI, RWI v1, event/CDR, and Step IVR protocol contracts pass controlled failure-matrix tests.
7. LiveKit SIP bridge uses the pinned SDK through a port and persists bridge state before provider execution.
8. Provider webhook tenant context comes from verified deployment-profile binding, never request tenant headers.
9. Real PostgreSQL proves RLS, claims, optimistic revisions, upgrade preservation, runtime least privilege, and migration idempotency.
10. Compose and Helm provide an opt-in PostgreSQL-only RustPBX data plane with immutable image references, generated secret-safe configuration, dedicated database ownership, bounded public SIP/RTP, and internal Management/RWI access.
11. Standalone build context, delivery bundle, typecheck, focused acceptance, and full repository suite pass; real carrier/client evidence remains honestly `not_run` until configured.

M2 completion does not complete the active Voice Foundation V1 goal. Continue directly to M3 IVR Runtime after pushing M2.
