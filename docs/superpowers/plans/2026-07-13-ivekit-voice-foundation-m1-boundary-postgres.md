# iveKit Voice Foundation M1 Boundary and PostgreSQL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project `executing-plans` skill with Inline Execution. Do not invoke `using-superpowers`. Track every checkbox and review each commit before moving on.

**Goal:** Establish standalone-owned Voice/IVR domain contracts and PostgreSQL authority tables that are tenant-isolated, legacy-independent, checksummed, and included in the iveKit delivery graph.

**Architecture:** New code lives under `src/agent-runtime/ivekit/voice` and `src/agent-runtime/ivekit/ivr`; it may reuse `shared/ivr` graph types but may not import legacy OPC voice, call-center, IVR, SQLite, harness, or `db.ts`. New `ivekit_voice_*` and `ivekit_ivr_*` tables are additive migrations before standalone runtime security migration `090`; old tables remain migration sources only and are not read by the new runtime.

**Tech Stack:** TypeScript, Node test runner, PostgreSQL 16 SQL, existing `PgQueryable`/RLS helpers, iveKit standalone source graph and build-context tooling.

---

## File Map

**Create**

- `src/agent-runtime/ivekit/voice/types.ts`: stable Voice Core domain types with no provider or persistence imports.
- `src/agent-runtime/ivekit/voice/ports.ts`: repository, provider, clock, encryption, event, compliance, and media bridge ports.
- `src/agent-runtime/ivekit/voice/index.ts`: public Voice M1 exports.
- `src/agent-runtime/ivekit/ivr/graph-types.ts`: canonical provider-neutral IVR graph contract.
- `src/agent-runtime/ivekit/ivr/types.ts`: standalone IVR flow/session/action types based on the canonical graph contract.
- `src/agent-runtime/ivekit/ivr/ports.ts`: IVR repository and side-effect ports.
- `src/agent-runtime/ivekit/ivr/index.ts`: public IVR M1 exports.
- `src/migrations/046_ivekit_voice_foundation.sql`: Voice Core authority tables, indexes, constraints, and FORCE RLS.
- `src/migrations/047_ivekit_ivr_foundation.sql`: IVR authority tables, indexes, constraints, and FORCE RLS.
- `scripts/verify-ivekit-postgres.sh`: portable local/server PostgreSQL fresh+upgrade test harness.
- `test/ivekit-voice-foundation-boundary.test.ts`: source and import direction gate.
- `test/ivekit-voice-foundation-migration.test.ts`: static DDL ownership and safety gate.

**Modify**

- `services/ivekit-service/source-policy.json`: add Voice/IVR library entrypoints and migrations before `090`.
- `test/ivekit-standalone-source-graph.test.ts`: prove the new namespaces are in the standalone graph and legacy namespaces remain out.
- `test/ivekit-standalone-migrations.test.ts`: prove migration order and no legacy schema inclusion.
- `test/ivekit-standalone-postgres.test.ts`: require the new tables in fresh/upgrade databases and exercise cross-tenant RLS.

**Do not modify in M1**

- `src/agent-runtime/voice/voice-store.ts`
- `src/agent-runtime/ivr/**`
- `src/agent-runtime/call-center/**`
- `src/db.ts`
- `src/db-migrations/ivr-runtime-schema.ts`
- HTTP routes, SDK, Provider adapters, workers, Compose, or Helm; these start in M2/M3.

---

### Task 1: Lock the standalone boundary with a failing test

**Files:**
- Create: `test/ivekit-voice-foundation-boundary.test.ts`

- [x] **Step 1: Write the failing boundary test**

```typescript
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  analyzeIveKitStandaloneSourceGraph,
  assertIveKitStandaloneBoundary,
  readIveKitStandaloneSourcePolicy
} from '../scripts/ivekit-standalone-source-graph.js';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('Voice Foundation source graph owns new modules and excludes OPC legacy runtime', () => {
  const policy = readIveKitStandaloneSourcePolicy(repoRoot);
  const graph = analyzeIveKitStandaloneSourceGraph({
    repoRoot,
    entrypoints: policy.entrypoints
  });

  assert.doesNotThrow(() => assertIveKitStandaloneBoundary(graph, policy.forbidden_prefixes));
  for (const required of [
    'src/agent-runtime/ivekit/voice/types.ts',
    'src/agent-runtime/ivekit/voice/ports.ts',
    'src/agent-runtime/ivekit/voice/index.ts',
    'src/agent-runtime/ivekit/ivr/types.ts',
    'src/agent-runtime/ivekit/ivr/ports.ts',
    'src/agent-runtime/ivekit/ivr/index.ts',
    'src/agent-runtime/ivekit/ivr/graph-types.ts'
  ]) assert.equal(graph.files.includes(required), true, required);

  for (const forbidden of [
    'src/agent-runtime/voice/voice-store.ts',
    'src/db.ts',
    'src/db-migrations/ivr-runtime-schema.ts'
  ]) assert.equal(graph.files.includes(forbidden), false, forbidden);
  assert.equal(graph.files.some((path) => path.startsWith('src/agent-runtime/ivr/')), false);
  assert.equal(graph.files.some((path) => path.startsWith('src/agent-runtime/call-center/')), false);
});

test('Voice Foundation public files do not import forbidden runtime modules', () => {
  const files = [
    'src/agent-runtime/ivekit/voice/types.ts',
    'src/agent-runtime/ivekit/voice/ports.ts',
    'src/agent-runtime/ivekit/voice/index.ts',
    'src/agent-runtime/ivekit/ivr/types.ts',
    'src/agent-runtime/ivekit/ivr/ports.ts',
    'src/agent-runtime/ivekit/ivr/index.ts'
  ];
  const forbidden = [
    '/agent-runtime/voice/',
    '/agent-runtime/ivr/',
    '/agent-runtime/call-center/',
    '/db.js',
    '/db-compat.js',
    '/db-migrations/',
    'harness'
  ];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const token of forbidden) assert.doesNotMatch(source, new RegExp(token), `${file}: ${token}`);
  }
});
```

- [x] **Step 2: Run the test and verify it fails for missing modules**

Run:

```bash
node --import tsx --test test/ivekit-voice-foundation-boundary.test.ts
```

Expected: FAIL because the six new source files and policy entrypoints do not exist.

- [x] **Step 3: Commit the red test only**

```bash
git add test/ivekit-voice-foundation-boundary.test.ts
git commit -m "test(ivekit): define voice foundation boundary"
```

---

### Task 2: Add provider-neutral Voice and IVR contracts

**Files:**
- Create: `src/agent-runtime/ivekit/voice/types.ts`
- Create: `src/agent-runtime/ivekit/voice/ports.ts`
- Create: `src/agent-runtime/ivekit/voice/index.ts`
- Create: `src/agent-runtime/ivekit/ivr/types.ts`
- Create: `src/agent-runtime/ivekit/ivr/ports.ts`
- Create: `src/agent-runtime/ivekit/ivr/index.ts`

- [x] **Step 1: Define Voice Core types**

`voice/types.ts` must export these exact unions and records:

```typescript
export type VoiceDirection = 'inbound' | 'outbound';
export type VoiceCallState =
  | 'planned' | 'queued' | 'dialing' | 'ringing' | 'active'
  | 'held' | 'transferring' | 'completed' | 'cancelled'
  | 'missed' | 'rejected' | 'failed' | 'timed_out';
export type VoiceCommandState =
  | 'pending' | 'processing' | 'retry_wait' | 'succeeded'
  | 'failed' | 'cancelled' | 'uncertain';
export type VoiceCommandKind =
  | 'originate' | 'answer' | 'hangup' | 'dtmf' | 'hold' | 'resume'
  | 'blind_transfer' | 'warm_transfer' | 'conference' | 'park' | 'pickup'
  | 'recording_start' | 'recording_pause' | 'recording_resume' | 'recording_stop'
  | 'livekit_bridge_create';
export type VoiceCapability =
  | 'management_http' | 'json_rpc_routing' | 'step_ivr' | 'rwi'
  | 'webrtc_extension' | 'recording' | 'sipflow' | 'queue' | 'postgres_backend';
export interface VoiceBusinessRef { type: string; id: string; }
export interface VoiceAddressProjection { kind: 'e164' | 'extension' | 'sip_uri'; redacted: string; hmac: string; }
export interface VoiceCall {
  id: string;
  tenant_id: string;
  business_ref: VoiceBusinessRef;
  provider_profile_id: string;
  provider_call_id: string;
  provider_dialog_id: string;
  media_call_id: string;
  direction: VoiceDirection;
  state: VoiceCallState;
  from: VoiceAddressProjection;
  to: VoiceAddressProjection;
  ringing_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  termination_reason: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface VoiceProviderCapabilities {
  profile_id: string;
  provider: string;
  provider_version: string;
  capabilities: Readonly<Record<VoiceCapability, boolean>>;
  checked_at: string;
  config_hash: string;
}
export interface VoiceCallCommand {
  id: string;
  tenant_id: string;
  call_id: string;
  kind: VoiceCommandKind;
  state: VoiceCommandState;
  idempotency_key: string;
  payload_hash: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  provider_command_id: string;
  result: Record<string, unknown>;
  error_code: string;
  created_at: string;
  updated_at: string;
}
```

- [x] **Step 2: Define Voice ports**

`voice/ports.ts` must use only `voice/types.ts` and define:

```typescript
import type {
  VoiceCall, VoiceCallCommand, VoiceCommandKind,
  VoiceProviderCapabilities
} from './types.js';

export interface VoiceClock { now(): Date; }
export interface VoiceAddressProtector {
  protect(tenantId: string, value: string, kind: 'e164' | 'extension' | 'sip_uri'): Promise<{
    ciphertext: string; hmac: string; redacted: string;
  }>;
  reveal(tenantId: string, ciphertext: string): Promise<string>;
}
export interface VoiceCallRepository {
  get(tenantId: string, callId: string, options?: { for_update?: boolean }): Promise<VoiceCall | null>;
  insert(call: VoiceCall): Promise<VoiceCall>;
  update(call: VoiceCall, expectedRevision: number): Promise<VoiceCall>;
}
export interface VoiceCommandRepository {
  findByIdempotencyKey(tenantId: string, key: string): Promise<VoiceCallCommand | null>;
  insert(command: VoiceCallCommand): Promise<VoiceCallCommand>;
  claimDue(input: { worker_id: string; now: Date; lease_ms: number; limit: number }): Promise<VoiceCallCommand[]>;
  complete(input: { tenant_id: string; command_id: string; state: VoiceCallCommand['state']; result?: Record<string, unknown>; error_code?: string }): Promise<VoiceCallCommand>;
}
export interface VoiceProviderPort {
  preflight(): Promise<VoiceProviderCapabilities>;
  execute(input: { call: VoiceCall; command: VoiceCallCommand; clear_address?: string }): Promise<{
    provider_command_id: string; provider_call_id?: string; accepted: boolean;
  }>;
  reconcile(input: { call: VoiceCall; command: VoiceCallCommand }): Promise<{
    state: 'pending' | 'succeeded' | 'failed' | 'unknown';
    provider_state?: string;
  }>;
}
export interface VoiceCompliancePort {
  authorize(input: { tenant_id: string; call_id: string; command: VoiceCommandKind; actor_identity: string }): Promise<{ allowed: boolean; reason: string; evidence_ref: string }>;
}
export interface VoiceMediaBridgePort {
  create(input: { tenant_id: string; call_id: string; business_ref: { type: string; id: string }; idempotency_key: string }): Promise<{ media_call_id: string; room_name: string; sip_participant_id: string }>;
}
export interface VoiceEventPort {
  publish(tenantId: string, type: string, data: unknown): void | Promise<void>;
}
```

- [x] **Step 3: Define IVR types without importing the legacy executor**

`ivr/types.ts` imports only the iveKit-owned `./graph-types.ts` and exports:

```typescript
export type {
  GlobalShortcut, IvrEdge, IvrFlowGraph, IvrNodeBase, IvrNodeType, IvrVariable
} from './graph-types.js';
import type { IvrFlowGraph } from './graph-types.js';

export type IvrSessionState = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type IvrPendingActionState =
  | 'pending' | 'processing' | 'retry_wait' | 'succeeded'
  | 'failed' | 'cancelled' | 'uncertain';
export interface IvrFlowVersion {
  id: string;
  tenant_id: string;
  flow_id: string;
  version: number;
  schema_version: number;
  graph: IvrFlowGraph;
  graph_hash: string;
  dependencies: Record<string, unknown>;
  published_by: string;
  published_at: string;
}
export interface IvrSession {
  id: string;
  tenant_id: string;
  call_id: string;
  flow_id: string;
  flow_version: number;
  state: IvrSessionState;
  current_node_id: string;
  context: Record<string, unknown>;
  step_count: number;
  revision: number;
  waiting_reason: string;
  termination_reason: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
export interface IvrAction {
  kind: 'play' | 'collect' | 'queue' | 'transfer' | 'record' | 'webhook' | 'media' | 'hangup' | 'wait';
  node_id: string;
  payload: Record<string, unknown>;
}
```

- [x] **Step 4: Define IVR ports**

`ivr/ports.ts` must define repositories and side effects without concrete imports:

```typescript
import type { IvrAction, IvrFlowVersion, IvrSession } from './types.js';

export interface IvrFlowRepository {
  getPublished(tenantId: string, flowId: string, version?: number): Promise<IvrFlowVersion | null>;
}
export interface IvrSessionRepository {
  get(tenantId: string, sessionId: string, options?: { for_update?: boolean }): Promise<IvrSession | null>;
  insert(session: IvrSession): Promise<IvrSession>;
  update(session: IvrSession, expectedRevision: number): Promise<IvrSession>;
  appendStep(input: { tenant_id: string; session_id: string; step_index: number; node_id: string; action: IvrAction; branch_taken: string; duration_ms: number; error_code: string }): Promise<void>;
}
export interface IvrCallControlPort { execute(tenantId: string, callId: string, action: IvrAction, idempotencyKey: string): Promise<Record<string, unknown>>; }
export interface IvrQueuePort { enqueue(input: { tenant_id: string; call_id: string; queue_id: string; priority: number; idempotency_key: string }): Promise<{ queue_entry_id: string; position: number | null }> }
export interface IvrKnowledgePort { query(input: { tenant_id: string; profile_id: string; text: string; language: string }): Promise<{ answer: string; citations: unknown[]; confidence: number }> }
export interface IvrRealtimeAiPort { respond(input: { tenant_id: string; call_id: string; profile_id: string; text: string; context: Record<string, unknown> }): Promise<{ text: string; intent: string; tool_calls: unknown[] }> }
export interface IvrRecordingPort { execute(tenantId: string, callId: string, action: IvrAction, idempotencyKey: string): Promise<Record<string, unknown>>; }
export interface IvrMediaPort { execute(tenantId: string, callId: string, action: IvrAction, idempotencyKey: string): Promise<Record<string, unknown>>; }
export interface IvrWebhookPort { request(input: { tenant_id: string; url_ref: string; method: string; body: unknown; timeout_ms: number; idempotency_key: string }): Promise<{ status: number; body: unknown }> }
export interface IvrClock { now(): Date; }
```

- [x] **Step 5: Add public exports**

Each `index.ts` exports `./types.js` and `./ports.js` only.

- [x] **Step 6: Keep the boundary test failing only on source policy**

Run the Task 1 test. Expected: source files exist and import scan passes; graph-required assertions still fail because policy entrypoints have not been updated.

- [x] **Step 7: Commit the contracts**

```bash
git add src/agent-runtime/ivekit/voice src/agent-runtime/ivekit/ivr
git commit -m "feat(ivekit): define standalone voice and ivr ports"
```

---

### Task 3: Specify and create the Voice PostgreSQL authority schema

**Files:**
- Create: `test/ivekit-voice-foundation-migration.test.ts`
- Create: `src/migrations/046_ivekit_voice_foundation.sql`

- [x] **Step 1: Write a failing static migration test**

The test reads migration `046` and asserts the exact table set below, `tenant_id` foreign keys, JSONB use, FORCE RLS, encrypted address fields, command leases, and absence of legacy fields:

```typescript
const voiceTables = [
  'ivekit_voice_deployment_profiles',
  'ivekit_voice_capability_snapshots',
  'ivekit_voice_sip_trunks',
  'ivekit_voice_dids',
  'ivekit_voice_extensions',
  'ivekit_voice_routes',
  'ivekit_voice_route_versions',
  'ivekit_voice_calls',
  'ivekit_voice_call_participants',
  'ivekit_voice_call_commands',
  'ivekit_voice_provider_events',
  'ivekit_voice_livekit_bridges',
  'ivekit_voice_recordings',
  'ivekit_voice_consents',
  'ivekit_voice_policies',
  'ivekit_voice_webrtc_sessions'
].sort();
```

For every table, assert `ALTER TABLE <name> ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and a tenant policy. Assert no `lead_id`, `customer_id`, `campaign_id`, `workspace_id`, `sqlite`, `voice_call_sessions`, or `ivr_flows` tokens.

- [x] **Step 2: Run the test and verify missing migration failure**

Run:

```bash
node --import tsx --test test/ivekit-voice-foundation-migration.test.ts
```

Expected: FAIL with `ENOENT` for migration `046`.

- [x] **Step 3: Create migration 046**

Use PostgreSQL-native types and implement all sixteen tables. Required invariants:

- Every table has `tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE` and a composite `UNIQUE (tenant_id, id)` where another tenant-scoped table references it.
- Profiles store adapter/config JSONB and secret refs, never secret values.
- DID and call addresses store `*_ciphertext`, 64-character `*_hmac`, and `*_redacted`; no plaintext number column.
- Route versions and published IVR-style payloads are immutable rows identified by SHA-256.
- Calls have the state check from the approved design and nullable `media_call_id` referencing `(tenant_id,id)` in `ivekit_media_calls`.
- Commands have a unique `(tenant_id,idempotency_key)`, 64-character payload hash, attempt/max-attempt checks, `next_attempt_at`, `lease_until`, worker id, provider command id, JSONB result, and `uncertain` state.
- Provider events have unique `(tenant_id,profile_id,external_event_id)` when external id is non-empty plus canonical hash deduplication.
- Recordings use object/evidence refs, consent id, retention timestamp, and lifecycle status; no raw storage credential.
- WebRTC sessions store token hash and expiry but no SDP, ICE password, or access token.
- Add indexes for business reference, provider call id, call state, due commands, event processing, recording retention, route lookup, DID HMAC, and extension identity.
- Apply ENABLE/FORCE RLS and `tenant_isolation` policy to all tables.
- Add a `SECURITY INVOKER` trigger function and `BEFORE UPDATE OR DELETE` trigger that rejects mutation of `ivekit_voice_route_versions` with SQLSTATE `55000`.

- [x] **Step 4: Run static migration test**

Expected: PASS.

- [x] **Step 5: Commit Voice DDL**

```bash
git add test/ivekit-voice-foundation-migration.test.ts src/migrations/046_ivekit_voice_foundation.sql
git commit -m "feat(ivekit): add voice foundation postgres schema"
```

---

### Task 4: Specify and create the IVR PostgreSQL authority schema

**Files:**
- Modify: `test/ivekit-voice-foundation-migration.test.ts`
- Create: `src/migrations/047_ivekit_ivr_foundation.sql`

- [x] **Step 1: Add a failing exact-table IVR migration test**

Assert this exact table set:

```typescript
const ivrTables = [
  'ivekit_ivr_flows',
  'ivekit_ivr_flow_versions',
  'ivekit_ivr_sessions',
  'ivekit_ivr_session_steps',
  'ivekit_ivr_pending_actions',
  'ivekit_ivr_audio_assets',
  'ivekit_ivr_time_groups',
  'ivekit_ivr_region_groups',
  'ivekit_ivr_ring_groups',
  'ivekit_ivr_settings'
].sort();
```

Also assert JSONB graph/context/action columns, immutable version uniqueness, session revision, pending-action lease fields, object-storage refs, exact 25-node schema ownership through `shared/ivr`, FORCE RLS, and no legacy table/import tokens.

- [x] **Step 2: Run and observe missing 047 failure**

Run the migration test. Expected: Voice assertions pass and IVR migration read fails.

- [x] **Step 3: Create migration 047**

Required invariants:

- Flows own draft graph/revision and current published version; published versions store immutable graph JSONB, graph hash, schema version, dependencies JSONB, publisher, and timestamp.
- Sessions reference tenant-scoped voice calls and flow versions, bind the version at start, store JSONB context, revision, waiting/termination reasons, and terminal timestamp.
- Steps are immutable and unique by `(tenant_id,session_id,step_index)`.
- Pending actions use unique `(tenant_id,idempotency_key)`, payload hash, state/attempt/lease/provider refs, and JSONB result.
- Audio assets store object ref or TTS source metadata, checksum, language, duration, visibility, and status; no provider credential.
- Time/region/ring groups and settings use JSONB, revision, status checks, and generic participant identities rather than seat foreign keys.
- Apply exact tenant FKs, indexes, ENABLE/FORCE RLS, and tenant policies to all ten tables.
- Add a `SECURITY INVOKER` trigger function and `BEFORE UPDATE OR DELETE` trigger that rejects mutation of `ivekit_ivr_flow_versions` with SQLSTATE `55000`.

- [x] **Step 4: Run migration test**

Expected: PASS for both 046 and 047.

- [x] **Step 5: Commit IVR DDL**

```bash
git add test/ivekit-voice-foundation-migration.test.ts src/migrations/047_ivekit_ivr_foundation.sql
git commit -m "feat(ivekit): add ivr foundation postgres schema"
```

---

### Task 5: Include M1 modules and migrations in the standalone delivery graph

**Files:**
- Modify: `services/ivekit-service/source-policy.json`
- Modify: `test/ivekit-standalone-source-graph.test.ts`
- Modify: `test/ivekit-standalone-migrations.test.ts`

- [x] **Step 1: Update failing source-graph expectations**

The policy entrypoint list must become:

```json
[
  "src/ivekit-server.ts",
  "src/ivekit-migrate.ts",
  "src/ivekit-init-runtime-role.ts",
  "src/ivekit-intelligence-preflight.ts",
  "src/agent-runtime/ivekit/voice/index.ts",
  "src/agent-runtime/ivekit/ivr/index.ts"
]
```

Update source graph tests to expect these entrypoints and all six M1 public files, while retaining every existing forbidden-prefix assertion.

- [x] **Step 2: Update failing migration-order expectations**

Assert `046_ivekit_voice_foundation.sql` and `047_ivekit_ivr_foundation.sql` occur in that order after `045_translation_worker_routing.sql` and before `090_ivekit_runtime_security.sql`. Keep explicit exclusions for `005_full_schema.sql`, `007_ivr_runtime_tables.sql`, `023_ivr_tenant_rls.sql`, and legacy runtime security migrations.

- [x] **Step 3: Run tests and observe policy failures**

```bash
node --import tsx --test test/ivekit-voice-foundation-boundary.test.ts test/ivekit-standalone-source-graph.test.ts test/ivekit-standalone-migrations.test.ts
```

Expected: FAIL until the policy is updated.

- [x] **Step 4: Update source policy**

Add the two library entrypoints. Add migrations `046` and `047` immediately before standalone `090`. Do not relax any forbidden prefix.

- [x] **Step 5: Regenerate the standalone service lock only if package graph changed**

Run:

```bash
node --import tsx scripts/generate-ivekit-service-lock.ts
```

Expected: no dependency addition because M1 contracts import only repository-local types. If lock output changes for another reason, inspect and reject unrelated churn.

- [x] **Step 6: Run source graph, migration, and context tests**

```bash
node --import tsx --test test/ivekit-voice-foundation-boundary.test.ts test/ivekit-voice-foundation-migration.test.ts test/ivekit-standalone-source-graph.test.ts test/ivekit-standalone-migrations.test.ts test/ivekit-standalone-build-context.test.ts
```

Expected: PASS and standalone context contains the new source and SQL, no legacy Voice/IVR runtime.

- [x] **Step 7: Commit delivery graph changes**

```bash
git add services/ivekit-service/source-policy.json services/ivekit-service/package-lock.json test/ivekit-standalone-source-graph.test.ts test/ivekit-standalone-migrations.test.ts
git commit -m "build(ivekit): package voice foundation m1"
```

---

### Task 6: Prove real PostgreSQL fresh, upgrade, RLS, and runtime-role behavior

**Files:**
- Create: `scripts/verify-ivekit-postgres.sh`
- Modify: `test/ivekit-standalone-postgres.test.ts`

- [x] **Step 1: Extend fresh migration required-table assertions**

Add all 26 new Voice/IVR tables to required tables. Keep old `voice_call_sessions`, `ivr_flows`, `ivr_sessions`, `audio_library`, `leads`, and `campaigns` forbidden.

- [x] **Step 2: Add tenant-isolation fixtures**

Insert two tenants through the admin role, then use `withPgTenant(runtime, tenantA, ...)` and `withPgTenant(runtime, tenantB, ...)` to create one deployment profile, call, IVR flow/version/session each. Assert each runtime transaction sees only its tenant rows and cannot insert a row with the other tenant id.

- [x] **Step 3: Add constraint and immutability probes**

Inside tenant A transaction assert rejection for:

- plaintext/invalid 63-character address HMAC;
- duplicate call idempotency key;
- command `attempt_count > max_attempts`;
- published flow version duplicate `(tenant_id,flow_id,version)`;
- session referencing a Voice call from tenant B;
- UPDATE and DELETE of a published route version;
- UPDATE and DELETE of a published IVR flow version.

- [x] **Step 4: Extend upgrade checks with a V3-shaped migration directory**

Create a temporary migration directory by copying `src/migrations/*.sql` except `046_ivekit_voice_foundation.sql` and `047_ivekit_ivr_foundation.sql`. Use it to initialize the upgrade database, seed OPC/Media/IM/Remote/Intelligence rows, then apply the standalone context containing 046/047. Assert all 26 tables are added, seeded row counts and content hashes stay unchanged, and a second standalone migration run leaves one ledger row per version.

- [x] **Step 5: Run controlled test without PostgreSQL URLs**

```bash
node --import tsx --test test/ivekit-standalone-postgres.test.ts
```

Expected locally: test file loads and PostgreSQL cases are explicitly SKIP when URLs are absent, with no failure.

- [x] **Step 6: Add and run a repository-owned PostgreSQL harness**

Create `scripts/verify-ivekit-postgres.sh` from the proven V3 harness. It must use `mktemp`, choose an isolated port, initialize PostgreSQL as `opc_admin`, create fresh/upgrade databases, export the five `OPC_IVEKIT_*` URLs/password variables, run `test/ivekit-standalone-postgres.test.ts`, stop PostgreSQL in a trap, print the server log on failure, and remove only its marker-owned temporary directory.

Run:

```bash
sh scripts/verify-ivekit-postgres.sh
```

Expected: fresh and upgrade cases PASS, RLS gap query returns `[]`, immutable triggers reject UPDATE/DELETE, runtime role remains `NOSUPERUSER/NOBYPASSRLS` with no schema CREATE and no migration-ledger access.

- [x] **Step 7: Commit PostgreSQL acceptance coverage**

```bash
git add scripts/verify-ivekit-postgres.sh test/ivekit-standalone-postgres.test.ts
git commit -m "test(ivekit): verify voice ivr postgres isolation"
```

---

### Task 7: M1 regression and delivery verification

**Files:**
- Modify only files needed to fix failures introduced by Tasks 1-6.

- [x] **Step 1: Run focused M1 suite**

```bash
node --import tsx --test test/ivekit-voice-foundation-boundary.test.ts test/ivekit-voice-foundation-migration.test.ts test/ivekit-standalone-source-graph.test.ts test/ivekit-standalone-migrations.test.ts test/ivekit-standalone-build-context.test.ts test/ivekit-standalone-http.test.ts
```

Expected: all pass.

- [x] **Step 2: Run typecheck and standalone foundation verification**

```bash
npm run typecheck
npm run verify:ivekit:foundation
```

Expected: exit 0; SDK packaging remains unchanged.

- [x] **Step 3: Run full repository tests**

```bash
npm test
```

Expected: no new failure; environment-gated cases may remain explicitly skipped.

- [x] **Step 4: Build and verify standalone context**

```bash
npm run ivekit:standalone:context
npm run verify:ivekit:standalone-context
```

Expected: manifest includes both new entrypoints and migrations, source commit is full length, checksums verify, and no legacy IVR/call-center path exists.

- [x] **Step 5: Inspect final diff and commit any test-only fixes**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and no untracked generated context. Commit only scoped corrections with `fix(ivekit): complete voice foundation m1 gates` when needed.

- [ ] **Step 6: Push the branch**

```bash
git push origin codex/ivekit-v4-voice-foundation
```

Expected: remote branch head equals local HEAD.

---

## M1 Exit Evidence

M1 is complete only when all of the following are evidenced:

1. New Voice/IVR contracts compile and their source graph excludes all legacy OPC runtime paths.
2. Standalone context contains exactly the approved new entrypoints and migrations.
3. Static DDL tests prove 16 Voice and 10 IVR authority tables, PostgreSQL types, encrypted address storage, idempotency, lease fields, and FORCE RLS.
4. Real PostgreSQL fresh/upgrade tests prove table creation, cross-tenant denial, runtime-role least privilege, checksum stability, and idempotent rerun.
5. Existing Media/IM/Remote/Intelligence tests and full repository suite show no regression.
6. The branch is pushed with every commit traceable to one task above.

M1 does not claim Voice API, RustPBX control, IVR execution, WebPhone, or Contact Center functionality. Those remain required in M2-M6 and the active Goal remains open.
