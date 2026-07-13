# iveKit Voice Foundation M3 IVR Runtime Implementation Plan

**Goal:** Deliver a standalone PostgreSQL-backed IVR runtime for iveKit that can validate, publish, roll back, simulate, execute, recover, and audit all 25 approved IVR node types, with a production RustPBX Step IVR exchange and no runtime dependency on OPC legacy IVR, call-center, SQLite, or `db.ts`.

**Architecture:** IVR is a deep module inside the iveKit control plane. A deterministic graph compiler owns validation, dependency extraction, canonical hashing, and pure routing. PostgreSQL owns drafts, immutable releases, sessions, append-only steps, provider sequence state, and durable pending actions. External effects are invoked only through ports after a pending action has been committed; workers use leases, idempotency keys, retries, and explicit `uncertain` reconciliation. RustPBX Step IVR is a provider adapter over the same session service, not a second executor.

**Technology:** TypeScript, Node.js 23, PostgreSQL 16, `pg`, the existing iveKit HTTP/auth/RLS/event infrastructure, RustPBX Step IVR, Node test runner, and existing standalone Compose/Helm/delivery tooling.

---

## 1. Locked Scope

M3 includes:

- editable flow drafts with optimistic revision control;
- canonical graph normalization and SHA-256 hashing;
- structural, reachability, dependency, secret, capability, and policy validation;
- immutable versions, publication, and rollback-as-new-version;
- durable sessions pinned to one published version;
- append-only step history and deterministic event advancement;
- durable external actions, worker leases, retry, cancellation, and uncertainty;
- execution semantics for all 25 approved nodes;
- deterministic simulation with virtual ports and clock;
- RustPBX Step IVR webhook, sequence/replay protection, and action mapping;
- audio asset, time group, region group, ring group, and settings APIs;
- IVR events, bounded metrics, readiness/preflight, SDK, Compose, Helm, and delivery surfaces;
- static, unit, HTTP, controlled-provider, standalone-build, and real PostgreSQL evidence.

M3 does not claim:

- full ACD queue assignment, agent presence, callbacks, or supervisor controls; M4 supplies `IvrQueuePort` and may make queue nodes executable;
- real ASR/TTS/LLM/knowledge provider quality; M3 exposes ports and controlled providers and fails explicitly when a required adapter is absent;
- an IVR visual designer or WebPhone; M5 owns the UI, while M3 provides stable graph and simulation APIs;
- real carrier, real PSTN, or browser evidence without server credentials; M6 records those cases as `not_run`, never simulated success.

## 2. Non-Negotiable Boundaries

- Production authority is PostgreSQL. No SQLite fallback, runtime DDL, local JSON state, or dual write.
- `src/agent-runtime/ivekit/ivr/**` must not import `src/agent-runtime/ivr/**`, `src/agent-runtime/call-center/**`, `src/db.ts`, or a legacy VoiceStore.
- The shared graph contract remains under `src/agent-runtime/ivekit/ivr/graph-types.ts`; `shared/ivr/**` may re-export or consume it for designer compatibility.
- IVR never imports LiveKit or RustPBX SDK internals directly. Provider-specific behavior remains behind ports/adapters.
- Tenant comes from authenticated/request context or verified deployment-profile binding, never from an untrusted webhook body.
- Published graph JSON and session-step history are immutable.
- Session execution always binds `flow_id + flow_version`; a draft or later release cannot mutate an active call.
- An external side effect is persisted before it is invoked. A timeout is `uncertain`, not `succeeded` or blindly retried.
- Missing adapter/capability is `capability_unavailable`; no node may silently return success.
- Graph JSON must not contain bearer tokens, Authorization values, private keys, passwords, secret values, or unmasked phone-number credentials.

## 3. Domain Contracts

### 3.1 Flow lifecycle

```text
draft revision N
  -> validate
  -> publish version V (immutable graph/hash/dependency snapshot)
  -> update current_published_version = V

rollback(version X)
  -> validate historical graph against current policy/capabilities
  -> publish version V+1 with rollback metadata
  -> never update/delete version X
```

Saving a draft uses `expected_revision`. Publishing uses both `expected_draft_revision` and an idempotency key. Replaying the same key and payload returns the existing version; changing the payload returns `idempotency_conflict`.

### 3.2 Session lifecycle

```text
running -> waiting -> running
running|waiting -> completed|failed|cancelled
terminal -> terminal only
```

Every accepted event has a monotonically increasing `event_sequence`. Every returned provider action has a monotonically increasing `action_revision`. Exact duplicate sequence pairs replay the last action without appending a step or invoking a port. Gaps, stale events, and mismatched revisions return `event_sequence_conflict`.

### 3.3 Step lifecycle

One completed graph node appends exactly one immutable step at `step_index`. The step stores a secret-safe action/result summary, selected branch, duration, and stable error code. Session update and step append occur in one transaction with optimistic session revision.

### 3.4 Pending action lifecycle

```text
pending -> processing -> succeeded
                     -> retry_wait -> processing
                     -> uncertain -> reconciliation -> succeeded|failed
                     -> failed
pending|retry_wait -> cancelled
```

`(tenant_id,idempotency_key)` and `(tenant_id,session_id,step_index)` are unique. A worker must own an unexpired lease to complete or release an action. Expired processing leases are reclaimable. Non-idempotent provider operations are not automatically replayed from `uncertain` unless the port exposes a safe reconciliation result.

## 4. Graph Compiler and Publication Gate

The compiler returns a typed report:

```typescript
interface IvrCompilationReport {
  normalized_graph: IvrFlowGraph;
  graph_hash: string;
  errors: IvrValidationIssue[];
  warnings: IvrValidationIssue[];
  dependencies: IvrDependencyManifest;
  reachable_node_ids: string[];
  terminal_node_ids: string[];
}
```

Publication is blocked by:

- malformed graph envelope, unknown node type, duplicate node/edge id, invalid position, or oversized graph;
- zero/multiple start nodes or entry not pointing to start;
- edge source/target missing, duplicate outgoing handle, missing required branch, or invalid dynamic menu handle;
- no reachable terminal, unreachable mandatory dependency, or a reachable closed cycle with no terminal/error exit;
- invalid variable/shortcut names, duplicate variables, shortcut collision configured as blocking, or excessive subflow depth;
- missing/disabled/unauthorized audio, time group, region group, ring group, queue, subflow, webhook ref, knowledge profile, AI profile, media binding, or voice target;
- recursive subflow cycle or a referenced flow version that is not published;
- provider/module capability absent for a reachable node and no explicit fallback edge;
- raw URL where a webhook ref is required, Authorization/header secret, private key, password/token-like field, or unsafe interpolation;
- HTTP method/body/response mapping outside policy, timeout above tenant settings, or unbounded response capture;
- `max_steps`, graph size, branch count, or execution-policy limits exceeded.

Warnings include unreachable optional nodes, missing recommended failure branches, menu/global shortcut shadowing, unused variables, and a terminal transfer node without an observable failure route.

Dependency manifests contain IDs and immutable revisions/checksums only, not credentials:

- `audio_assets`, `time_groups`, `region_groups`, `ring_groups`, `queues`, `subflows`;
- `webhook_refs`, `knowledge_profiles`, `ai_profiles`, `media_capabilities`;
- `voice_capabilities` and `provider_profile_ids`;
- compiler/schema version and validation-policy revision.

## 5. Node Execution Matrix

| Node | Deterministic result | External action / wait | Branches |
| --- | --- | --- | --- |
| `start` | initialize declared variables and call context | none | `out` |
| `set_var` | evaluate bounded template/expression and update context | none | `out` |
| `condition` | compare typed operands using allowlisted operators | none | `true`, `false` |
| `time_condition` | evaluate immutable time-group snapshot with injected clock | none | `true`, `false` |
| `play` | build prompt from published audio/TTS/variable ref | call-control play | `out`, optional `error` |
| `menu` | build prompt and DTMF collection policy | collect event | `digit_*`, `timeout`, `invalid`, `max_retries` |
| `collect` | normalize/validate digits or speech result and assign variable | collect event | `out`, `timeout`, `invalid` |
| `flush_audio` | clear queued audio intent | call-control flush | `out`, optional `error` |
| `queue` | enqueue generic call identity | queue port | `out`, `timeout`, `at_capacity`, `error` |
| `http` | build allowlisted request from ref and bounded mappings | webhook port | `success`, `fail`, `timeout` |
| `webhook` | emit one bounded business event request | webhook port | `success`, `fail`, `timeout` |
| `transfer` | resolve authorized voice target | call-control transfer | terminal on success; `failed`/`error` if configured |
| `sip` | resolve approved SIP target without graph credentials | call-control transfer | terminal on success; explicit failure edge if configured |
| `voicemail` | play greeting then start bounded recording | recording/call control | terminal on success; optional `error` |
| `disconnect` | set termination reason | call-control hangup | terminal |
| `recording` | apply consent/policy and start/pause/resume/stop | recording port | `out`, optional `skipped`/`error` |
| `compliance` | evaluate disclosure/consent policy | optional prompt/collect/recording | `out`, `acknowledged`, `declined`, `timeout`, `error` |
| `intent` | normalize intent score/keyword result | AI port when non-keyword | `high`, `low`, `continue`, optional `error` |
| `knowledge_qa` | map answer/citations/confidence into variables | knowledge port | `found`, `not_found`, optional `error` |
| `ai_dialogue` | bounded multi-turn response with tool calls disabled by default | realtime AI port | `out`, `timeout`, `error` |
| `avatar_switch` | validate participant authorization and avatar ref | media port | `success`, `declined`, `error` |
| `video_play` | validate media call and asset ref | media port | `out`, `skipped`, `error` |
| `screen_share` | require participant grant | media port | `out`, `denied`, `error` |
| `visual_menu` | publish bounded visual choices and await selection | media/collect event | `digit_*`, `timeout`, `invalid` |
| `subflow` | push immutable caller frame and child version; pop on completion | flow repository | `out`, `error` |

All data-dependent branches use exact handles. The executor never falls back to the first `out` edge when an expected handle is absent.

## 6. PostgreSQL Increment

Create `050_ivekit_ivr_runtime.sql`; do not edit released migration 047 for new runtime behavior.

Required additions:

- add `publication_key`, `publication_payload_hash`, and release metadata needed for idempotent publish/rollback;
- add provider profile/session binding, `last_event_sequence`, `last_action_revision`, `last_action`, and safe provider metadata to sessions;
- add an event-result/input summary and trace fields where required without weakening immutable history;
- add pending-action claim/release/reconciliation support and worker discovery kind `ivr_pending_action`;
- add stable indexes for provider session lookup, published flow lookup, session listing, and due actions;
- add `SECURITY DEFINER` lookup only where unauthenticated provider webhook resolution cannot safely use normal tenant context; expose tenant/profile IDs and secret refs only;
- retain ENABLE/FORCE RLS for every table and grant runtime DML without migration-ledger/schema privileges;
- preserve fresh install, upgrade install, checksum ledger, and repeated migration behavior.

Transactions:

- flow publish locks the flow, verifies draft revision, inserts version, and advances the published pointer atomically;
- session start locks/reads the published version and inserts the initial session atomically;
- session advance locks the session, verifies sequence/revision, appends one step or pending action, and updates the session atomically;
- pending-action completion locks the action and session, records the immutable step, advances the session, and emits post-commit events.

## 7. Module Layout

Create under `src/agent-runtime/ivekit/ivr/`:

- `errors.ts`: stable IVR error codes and retryability;
- `canonical.ts`: normalized graph JSON, canonical hash, bounded safe projection;
- `validation.ts`: complete structural/security/reachability validation;
- `dependencies.ts`: manifest extraction and injectable dependency resolution;
- `expression.ts`: bounded variable/template/condition evaluation;
- `flow-service.ts`: draft CRUD, validation, publish, rollback;
- `executor.ts`: pure node planning and branch reduction;
- `session-service.ts`: durable start/advance/replay/cancel lifecycle;
- `simulation.ts`: virtual ports/clock and bounded trace;
- `http.ts`: stable `/api/ivekit/ivr/*` routes;
- `metrics.ts`: bounded-label compiler/session/action metrics;
- `preflight.ts`: PostgreSQL/schema/provider capability readiness;
- `runtime.ts`: production composition and worker config;
- `postgres/flow-store.ts`, `session-store.ts`, `resource-store.ts`, `unit-of-work.ts`;
- `workers/pending-action-worker.ts`, `reconciliation-worker.ts`;
- `adapters/rustpbx-step-ivr.ts` extension plus a provider-session service;
- `adapters/controlled-ivr-provider.ts` for deterministic acceptance.

Modify:

- `application.ts` to start/stop IVR workers only when IVR runtime is enabled;
- `http-server.ts` to route `/api/ivekit/ivr/` and use the stable error envelope;
- `index.ts` and iveKit public exports;
- standalone source policy, migration manifest, runtime role, Compose, Helm, env examples, delivery bundle, SDK, docs, and scripts.

## 8. HTTP and Event Contracts

Stable endpoints:

- `GET|POST /api/ivekit/ivr/flows`
- `GET|PATCH /api/ivekit/ivr/flows/:id`
- `GET /api/ivekit/ivr/flows/:id/versions`
- `POST /api/ivekit/ivr/flows/:id/validate`
- `POST /api/ivekit/ivr/flows/:id/publish`
- `POST /api/ivekit/ivr/flows/:id/rollback`
- `POST /api/ivekit/ivr/simulations`
- `GET|POST /api/ivekit/ivr/sessions`
- `GET /api/ivekit/ivr/sessions/:id`
- `POST /api/ivekit/ivr/sessions/:id/advance`
- `POST /api/ivekit/ivr/provider-webhooks/rustpbx/:profileId/step`
- `GET|POST|PATCH` resource endpoints for audio assets, time groups, region groups, ring groups, and settings.

Mutation rules:

- create/publish/rollback/session start and externally effective operations require `Idempotency-Key`;
- draft/resource updates require `revision` and return `409 revision_conflict` when stale;
- list responses are `{items,next_cursor}` with bounded limits;
- API error shape is `{error:{code,message,retryable,request_id,details}}`;
- provider webhook auth is profile-bound and checked before tenant context is installed;
- response DTOs contain no secret ref values, Authorization headers, full SIP credentials, or raw provider payloads.

Events:

- `ivr.flow.published`, `ivr.flow.rolled_back`;
- `ivr.session.started`, `ivr.session.step_completed`, `ivr.session.waiting`;
- `ivr.session.completed`, `ivr.session.failed`, `ivr.session.cancelled`;
- `ivr.pending_action.updated`.

Event payloads contain stable IDs, version, node type, coarse state, duration, and error code only. They exclude variable values by default because variables may contain caller input.

## 9. Implementation Sequence

### Task 1: Graph compiler contract

- [ ] Add failing tests for canonical normalization/hash stability.
- [ ] Add failing tests for duplicate IDs/handles, invalid references, reachability, closed cycles, variables, shortcuts, graph limits, and secret scanning.
- [ ] Add failing dependency-manifest tests covering all 25 node types.
- [ ] Implement `canonical.ts`, `validation.ts`, and `dependencies.ts`.
- [ ] Keep shared designer validation compatible while making the iveKit publication report authoritative.
- [ ] Run graph tests, standalone boundary tests, source-graph tests, and typecheck.
- [ ] Commit `feat(ivekit): compile and validate ivr graphs`.

### Task 2: Runtime migration and PostgreSQL stores

- [ ] Write migration 050 static tests first.
- [ ] Add provider sequence, publication idempotency, worker claim, RLS, indexes, and runtime grants.
- [ ] Implement flow/session/resource stores and transaction unit of work.
- [ ] Prove tenant isolation, immutable versions/steps, optimistic revisions, lease exclusion/recovery, and fresh/upgrade reruns in real PostgreSQL.
- [ ] Commit `feat(ivekit): persist durable ivr runtime`.

### Task 3: Draft, publish, and rollback service

- [ ] Test create/list/get/update with optimistic draft revision.
- [ ] Test validation reports against injectable dependency/capability resolver.
- [ ] Test publish idempotency, canonical hash, immutable version, and atomic pointer update.
- [ ] Test rollback creates a new version and revalidates current dependencies.
- [ ] Emit flow events only after transaction commit.
- [ ] Commit `feat(ivekit): publish versioned ivr flows`.

### Task 4: Pure executor core

- [ ] Define closed executor input/event/output unions.
- [ ] Implement exact-edge routing, max-step guard, terminal convergence, context bounds, and trace-safe summaries.
- [ ] Implement pure nodes: `start`, `set_var`, `condition`, `time_condition`, and `subflow` frame transitions.
- [ ] Test deterministic results, expression limits, branch misses, cycles, and subflow depth.
- [ ] Commit `feat(ivekit): execute deterministic ivr nodes`.

### Task 5: Durable session lifecycle

- [ ] Test session start pinned to published version.
- [ ] Test event sequence/action revision advance, exact replay, stale/gap rejection, and concurrent revision conflict.
- [ ] Test atomic step append/session update and terminal immutability.
- [ ] Test cancellation and process-restart recovery.
- [ ] Commit `feat(ivekit): add durable ivr sessions`.

### Task 6: Interaction and telephony nodes

- [ ] Implement/test `play`, `menu`, `collect`, `visual_menu`, and `flush_audio` planning and event reduction.
- [ ] Implement/test `transfer`, `sip`, `disconnect`, `voicemail`, and `recording` through ports.
- [ ] Implement menu retries/global shortcuts, DTMF normalization, timeout/invalid routing, consent guard, and explicit capability errors.
- [ ] Commit `feat(ivekit): execute ivr interaction and telephony nodes`.

### Task 7: Durable external-action worker

- [ ] Persist action before port call and claim with `FOR UPDATE SKIP LOCKED`.
- [ ] Implement bounded exponential retry and lease recovery.
- [ ] Implement uncertain reconciliation contract; never auto-replay unsafe actions.
- [ ] Complete action, append step, and resume session atomically.
- [ ] Test duplicate workers, lease loss, timeout, crash-after-provider-call, and cancellation.
- [ ] Commit `feat(ivekit): recover ivr external actions`.

### Task 8: Integration, AI, compliance, and media nodes

- [ ] Implement/test `http`, `webhook`, `queue`, `intent`, `knowledge_qa`, `ai_dialogue`, and `compliance`.
- [ ] Implement/test `avatar_switch`, `video_play`, and `screen_share` through `IvrMediaPort`.
- [ ] Enforce webhook allowlist/ref, bounded response mapping, profile capabilities, and explicit fallback branches.
- [ ] Test absent adapters and changed runtime capability as non-success outcomes.
- [ ] Commit `feat(ivekit): execute advanced ivr nodes`.

### Task 9: Simulator and RustPBX Step IVR

- [ ] Implement virtual clock, scripted provider events, deterministic action results, and bounded trace.
- [ ] Extend RustPBX adapter tests for all executable provider actions and explicit unsupported actions.
- [ ] Implement profile-authenticated Step IVR webhook and provider-session binding.
- [ ] Prove exact duplicate webhook replay does not duplicate a step/action.
- [ ] Add controlled RustPBX IVR acceptance from session start through terminal hangup.
- [ ] Commit `feat(ivekit): integrate rustpbx step ivr runtime`.

### Task 10: HTTP, resources, events, and metrics

- [ ] Register every stable IVR endpoint and `/api/ivekit/ivr/` allowlist entry.
- [ ] Add resource CRUD with revisions and reference protection.
- [ ] Add stable error envelopes, RBAC, cursor limits, request limits, and post-commit events.
- [ ] Add bounded metrics for compile result, step type/outcome, action state, lease recovery, and provider errors.
- [ ] Add application worker lifecycle and graceful stop tests.
- [ ] Commit `feat(ivekit): expose ivr runtime api`.

### Task 11: Standalone delivery and SDK

- [ ] Add IVR runtime/preflight env schema and compiled entrypoint where required.
- [ ] Add Compose and Helm enablement, worker settings, secrets, readiness, and resource limits.
- [ ] Add SDK clients for flows, versions, simulation, sessions, and resources.
- [ ] Update standalone source policy, migration/delivery manifests, bundle docs, and integration design.
- [ ] Prove SDK dry-pack and standalone build context contain no forbidden source.
- [ ] Commit `feat(ivekit): deliver standalone ivr runtime`.

### Task 12: Final M3 evidence

- [ ] Run all focused IVR, Voice, boundary, HTTP, SDK, delivery, and migration tests.
- [ ] Run real PostgreSQL fresh and upgrade harnesses.
- [ ] Run controlled provider end-to-end recovery and replay cases.
- [ ] Run standalone build-context verification, typecheck, full `npm test`, Compose config checks, Helm render checks, and `git diff --check`.
- [ ] Record real RustPBX/PSTN cases as pass/fail/not_run with reasons.
- [ ] Review the final diff for legacy imports, secret leakage, false capability claims, and documentation drift.
- [ ] Commit and push M3 only after all available evidence is green.

## 10. Verification Commands

Focused commands will grow as files are added; the final gate includes:

```bash
node --import tsx --test test/ivekit-ivr-*.test.ts
node --import tsx --test test/ivekit-voice-*.test.ts
node --import tsx --test test/ivekit-standalone-*.test.ts
sh scripts/verify-ivekit-postgres.sh
npm run verify:ivekit:standalone-context
npm run typecheck
npm test
COMPOSE_DISABLE_ENV_FILE=1 docker compose --env-file infra/env.example \
  -f infra/docker-compose.production.yml config --quiet
COMPOSE_DISABLE_ENV_FILE=1 docker compose --env-file services/ivekit-service/env.example \
  -f services/ivekit-service/docker-compose.yml \
  -f services/ivekit-service/docker-compose.voice.yml config --quiet
helm template opc infra/k8s --set ivekit.enabled=true --set rustpbx.enabled=true >/dev/null
git diff --check
```

## 11. M3 Completion Definition

M3 is complete only when:

1. all 25 node types compile and have tested success, failure, timeout/capability, and branch semantics appropriate to the node;
2. drafts, immutable publish, rollback-as-new-version, dependency snapshots, and canonical hashes work under PostgreSQL/RLS;
3. sessions survive restart, exact provider retries replay safely, and concurrent advances cannot duplicate steps or effects;
4. external effects are durable and recoverable, with unsafe uncertain operations never blindly repeated;
5. the RustPBX Step IVR endpoint is authenticated, tenant-bound, sequence-safe, and uses the common executor;
6. stable APIs, events, metrics, SDK, Compose, Helm, source boundary, and delivery bundle are present;
7. all locally available verification is green and every unavailable real environment case is explicitly `not_run`.

