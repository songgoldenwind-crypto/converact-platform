# iveKit V3 Multimodal Intelligence and Translation Implementation Plan

> **Status:** Ready for implementation on `codex/ivekit-v3-multimodal-translation`.

**Goal:** Productize reusable OCR, ASR, AI anti-circumvention review, human review, and translation behind the standalone iveKit PostgreSQL/API/SDK boundary so OPC, LED, and future hosts can use the same capability without importing call-center source.

**Architecture:** Extend the existing attachment-processing, quality-review, policy-finding, tenant-event, and reference-client foundations. Add a deployment-owned provider registry, tenant-owned intelligence policy, known-recording materialization, and a durable translation state machine. Provider credentials remain environment secrets; tenant data, jobs, results, evidence, and review state remain in PostgreSQL under forced RLS.

**Tech Stack:** TypeScript, Node.js, PostgreSQL with forced RLS, React/Vite, `@opc/ivekit-sdk`, Node test runner, Playwright, Docker Compose, Kubernetes manifests, deterministic controlled HTTP provider.

**Design:** `docs/superpowers/specs/2026-07-13-ivekit-v3-multimodal-translation-design.md`

**Baseline:** `830400254bbc9b3bfaa4fa32f43a6d0500383d94`

---

## Stable Rules

1. PostgreSQL is the only business database. V3 adds no SQLite runtime or fallback.
2. OPC, LED, and other products integrate only through `/api/ivekit/*`, durable events, and `@opc/ivekit-sdk`.
3. No V3 source may import `src/agent-runtime/call-center/`, IVR, campaigns, frontend, or archived lead-acquisition code.
4. Provider profile JSON contains metadata and environment-variable references only. Tokens and provider response bodies never enter API responses, events, logs, evidence packs, or browser storage.
5. Third-party processing is fail-closed unless the tenant policy explicitly allows it and selects that profile.
6. OCR/ASR/quality/translation work is durable, leased, retryable, idempotent, source-hash aware, and tenant-scoped.
7. A provider result is not a human decision. AI findings remain advisory until the existing review transition records an authorized human action.
8. Callers cannot submit arbitrary storage URLs or filesystem paths. Recording import resolves an existing tenant-owned media or remote-evidence ID.
9. Existing V1/V2 APIs, events, SDK methods, workers, and standalone packaging remain backward compatible.
10. Real vendor accuracy, quota, compliance, and production latency remain `not_run` until a provider is selected; the deterministic provider proves protocol and failure behavior only.

## Verification Discipline

For every implementation task:

1. Add or extend the named test first and run it to observe the intended failure.
2. Implement the smallest production change that satisfies the contract.
3. Run the focused test, affected iveKit suites, and `npm run typecheck` before committing.
4. Keep generated evidence and credentials out of Git.
5. Use one focused commit per task or tightly coupled task pair.

---

## M7.1 Provider Registry and Tenant Policy

### Task 1: Add the V3 PostgreSQL schema and migration contracts

**Files:**
- Create: `src/migrations/043_ivekit_intelligence_translation.sql`
- Modify: `services/ivekit-service/source-policy.json`
- Modify: `services/ivekit-service/migrations/090_ivekit_runtime_security.sql`
- Modify: `src/postgres-migrations.ts`
- Test: `test/ivekit-intelligence-migration.test.ts`
- Test: `test/ivekit-standalone-migrations.test.ts`
- Test: `test/postgres-migrations-checksum.test.ts`
- Test: `test/ivekit-runtime-role.test.ts`

**Steps:**

1. Add failing migration assertions for the policy, source-link, and translation-job tables, translation result extensions, checks, unique identities, due-job indexes, forced RLS, and runtime DML rights.
2. Create `collaboration_intelligence_policies`, `collaboration_intelligence_source_links`, and `collaboration_translation_jobs` with explicit enums/checks and bounded defaults.
3. Extend `collaboration_message_translations` additively and backfill legacy rows without deleting history.
4. Enable and force RLS on each new tenant table using the existing `opc_current_tenant()` policy convention.
5. Add migration 043 before runtime security in the standalone manifest and grant only the DML/sequences required by `opc_runtime`.
6. Verify fresh migration, upgrade migration, checksum ordering, runtime-role denial of schema mutation, and cross-tenant isolation against real PostgreSQL.

**Focused gate:**

```bash
node --import tsx --test test/ivekit-intelligence-migration.test.ts test/ivekit-standalone-migrations.test.ts test/postgres-migrations-checksum.test.ts test/ivekit-runtime-role.test.ts
npm run typecheck
```

**Commit:** `feat(ivekit): add V3 intelligence schema`

### Task 2: Build a secret-safe provider profile registry

**Files:**
- Create: `src/agent-runtime/collaboration/intelligence-provider-registry.ts`
- Create: `src/agent-runtime/collaboration/provider-safety.ts`
- Modify: `src/agent-runtime/collaboration/ocr-provider.ts`
- Modify: `src/agent-runtime/collaboration/asr-provider.ts`
- Modify: `src/agent-runtime/collaboration/quality-review.ts`
- Modify: `src/agent-runtime/collaboration/index.ts`
- Test: `test/ivekit-intelligence-provider-registry.test.ts`
- Test: `test/collaboration-attachment-processing.test.ts`
- Test: `test/collaboration-policy-finding.test.ts`

**Steps:**

1. Add failing tests for valid self-hosted and third-party profiles, duplicate IDs, capability mismatch, embedded credentials, secret query parameters, unsafe HTTP hosts, missing token refs, and recursive redaction.
2. Parse `OPC_IVEKIT_PROVIDER_PROFILES_JSON` into immutable metadata and callable profile resolvers.
3. Resolve a token only from the trusted `token_env` name at invocation time; never place it on serializable profile objects.
4. Convert legacy OCR/ASR/quality variables into deterministic default profiles while preserving V2 behavior.
5. Centralize bounded metadata, safe error, provider request ID, and URL/source-ref sanitization used by all provider adapters.
6. Preserve existing adapter interfaces while adding profile ID and capability metadata needed by durable jobs.

**Focused gate:**

```bash
node --import tsx --test test/ivekit-intelligence-provider-registry.test.ts test/collaboration-attachment-processing.test.ts test/collaboration-policy-finding.test.ts
npm run typecheck
```

**Commit:** `feat(ivekit): add intelligence provider registry`

### Task 3: Add tenant policy store, authorization, and effective capabilities

**Files:**
- Create: `src/agent-runtime/collaboration/intelligence-policy-store.ts`
- Create: `src/agent-runtime/ivekit/intelligence-http.ts`
- Modify: `src/agent-runtime/ivekit/http-server.ts`
- Modify: `src/agent-runtime/ivekit/index.ts`
- Modify: `src/db-pg-tenant.ts`
- Test: `test/ivekit-intelligence-policy.test.ts`
- Test: `test/ivekit-standalone-http.test.ts`
- Test: `test/db-pg-tenant.test.ts`

**Steps:**

1. Add failing store tests for conservative defaults, versioned update, stale-version conflict, actor audit, profile/capability validation, third-party gating, target-language normalization, and cross-tenant isolation.
2. Implement policy read/update with owner/admin/system authorization and immutable policy-update tenant events.
3. Add `/api/ivekit/intelligence/` to the standalone allowlist and route composition.
4. Implement capabilities, policy GET/PUT, and provider-summary endpoints with public/admin projections.
5. Ensure tenant resolution recognizes the new routes and no request body can override an authenticated tenant.
6. Keep missing-policy behavior compatible for configured V2 OCR/ASR/quality while disabling automatic translation and implicit third-party selection.

**Focused gate:**

```bash
node --import tsx --test test/ivekit-intelligence-policy.test.ts test/ivekit-standalone-http.test.ts test/db-pg-tenant.test.ts
npm run typecheck
```

**Commit:** `feat(ivekit): add tenant intelligence policy`

### Task 4: Add bounded provider health and intelligence preflight

**Files:**
- Create: `src/agent-runtime/collaboration/intelligence-provider-health.ts`
- Create: `scripts/ivekit-intelligence-preflight.ts`
- Modify: `src/agent-runtime/ivekit/intelligence-http.ts`
- Modify: `package.json`
- Test: `test/ivekit-intelligence-provider-health.test.ts`
- Test: `test/ivekit-intelligence-preflight.test.ts`

**Steps:**

1. Add failing tests for healthy, degraded, timeout, 401/403, 429, 5xx, oversized body, invalid endpoint, and response/log secret leakage.
2. Probe only configured health endpoints with bounded timeout, redirects disabled, and no response-body persistence.
3. Return profile ID, capability, mode, coarse status, HTTP class, latency, and checked time only.
4. Implement admin/system health endpoint with bounded profile selection and concurrency.
5. Build preflight checks for PostgreSQL, object storage, profile syntax, secret references, policy-safe defaults, and worker lease/timeout budgets.
6. Recursively scan preflight JSON for configured secret values and fail if a secret appears.

**Focused gate:**

```bash
node --import tsx --test test/ivekit-intelligence-provider-health.test.ts test/ivekit-intelligence-preflight.test.ts
npm run typecheck
```

**Commit:** `feat(ivekit): add provider health preflight`

---

## M7.2 OCR, ASR, and Recording Productization

### Task 5: Route attachment work through tenant policy and opaque source refs

**Files:**
- Modify: `src/agent-runtime/collaboration/attachment-text-provider.ts`
- Modify: `src/agent-runtime/collaboration/attachment-processing.ts`
- Modify: `src/agent-runtime/collaboration/attachment-processing-worker.ts`
- Modify: `src/agent-runtime/collaboration/ocr-provider.ts`
- Modify: `src/agent-runtime/collaboration/asr-provider.ts`
- Modify: `src/agent-runtime/ivekit/application.ts`
- Test: `test/collaboration-attachment-processing.test.ts`
- Test: `test/ivekit-application.test.ts`

**Steps:**

1. Add failing tests proving image selects OCR, audio/video/screen recording select ASR, file selects no processor, disabled policy cancels/skips work explicitly, and selected profile is retained on the claim.
2. Resolve effective tenant policy and provider profile before claim execution without putting credentials in the job row.
3. Replace provider `storage_url` metadata with `ivekit://attachment/<attachment_id>` while continuing to stream the resolved bytes.
4. Bound filename, content type, byte count, extracted text, confidence, language, request ID, metadata, and errors.
5. Preserve lease recovery and idempotency when policy or active profile changes after a claim.
6. Auto-enqueue quality and configured translations only after extraction is durably committed.

**Focused gate:**

```bash
node --import tsx --test test/collaboration-attachment-processing.test.ts test/ivekit-application.test.ts
npm run typecheck
```

**Commit:** `feat(ivekit): productize OCR and ASR routing`

### Task 6: Materialize known media and remote recordings safely

**Files:**
- Create: `src/agent-runtime/collaboration/intelligence-source-service.ts`
- Modify: `src/agent-runtime/ivekit/intelligence-http.ts`
- Modify: `src/agent-runtime/livekit/recording-service.ts`
- Modify: `src/agent-runtime/collaboration/remote-assistance-store.ts`
- Modify: `src/agent-runtime/collaboration/collaboration-store.ts`
- Test: `test/ivekit-intelligence-source.test.ts`
- Test: `test/livekit-recording-retention-export.test.ts`
- Test: `test/collaboration-remote-assistance.test.ts`

**Steps:**

1. Add failing tests for media recording import, remote evidence import, idempotent replay, wrong tenant, wrong business ref/session, unfinished/deleted source, unsupported MIME type, missing object, and arbitrary URL rejection.
2. Resolve sources through existing stores by stable ID and verify tenant, session/business binding, lifecycle state, object ownership, checksum, and retention.
3. Create one system message, one `screen_recording` attachment, one source-link row, and one ASR job transactionally.
4. Implement source create/get/retry routes using `Idempotency-Key`; never accept `storage_url`, local path, or credentials.
5. Publish source-created/processed events containing IDs and status only.
6. Ensure retries reuse the same source link and attachment instead of duplicating chat history.

**Focused gate:**

```bash
node --import tsx --test test/ivekit-intelligence-source.test.ts test/livekit-recording-retention-export.test.ts test/collaboration-remote-assistance.test.ts
npm run typecheck
```

**Commit:** `feat(ivekit): ingest recording intelligence sources`

---

## M7.3 AI Quality and Human Review

### Task 7: Make quality review policy-aware and bound provider output

**Files:**
- Modify: `src/agent-runtime/collaboration/quality-review.ts`
- Modify: `src/agent-runtime/collaboration/quality-review-worker.ts`
- Modify: `src/agent-runtime/collaboration/policy-scan.ts`
- Modify: `src/agent-runtime/ivekit/application.ts`
- Test: `test/collaboration-policy-finding.test.ts`
- Test: `test/ivekit-application.test.ts`

**Steps:**

1. Add failing tests for disabled policy, selected profile, third-party denial, input-hash drift, bounded source aggregation, excessive finding count, invalid severity/confidence, oversized rationale, unsafe metadata, timeout, and retry classes.
2. Resolve policy/profile before quality claims and persist the selected profile identity without credentials.
3. Send only bounded message text, current OCR/ASR text, rule summaries, and opaque evidence references.
4. Cap provider findings and normalize all fields through shared provider safety utilities.
5. Preserve advisory semantics and existing immutable human transition rules.
6. Keep a provider change from mutating an already claimed job's audit identity.

**Focused gate:**

```bash
node --import tsx --test test/collaboration-policy-finding.test.ts test/ivekit-application.test.ts
npm run typecheck
```

**Commit:** `feat(ivekit): harden AI quality review`

### Task 8: Add a tenant-wide operational review queue

**Files:**
- Modify: `src/agent-runtime/collaboration/policy-finding-store.ts`
- Modify: `src/agent-runtime/ivekit/intelligence-http.ts`
- Modify: `src/agent-runtime/ivekit/types.ts`
- Test: `test/ivekit-intelligence-review-queue.test.ts`
- Test: `test/collaboration-policy-finding.test.ts`

**Steps:**

1. Add failing tests for cursor pagination, status/severity/source/session/date filters, stable ordering, deleted message visibility, participant denial, reviewer/admin access, and cross-tenant isolation.
2. Query the existing finding authority rather than copying findings into a second table.
3. Return bounded evidence summaries and current review state without matched raw secret-bearing content.
4. Reuse the existing authorized review transition and immutable audit trail.
5. Add `GET /api/ivekit/intelligence/findings` and preserve session-scoped finding routes.
6. Emit only invalidation-safe IDs/status in review events.

**Focused gate:**

```bash
node --import tsx --test test/ivekit-intelligence-review-queue.test.ts test/collaboration-policy-finding.test.ts
npm run typecheck
```

**Commit:** `feat(ivekit): add tenant finding queue`

---

## M7.4 Durable Translation

### Task 9: Define and implement the translation provider contract

**Files:**
- Create: `src/agent-runtime/collaboration/translation-provider.ts`
- Modify: `src/agent-runtime/collaboration/intelligence-provider-registry.ts`
- Modify: `src/agent-runtime/collaboration/provider-safety.ts`
- Modify: `.env.example`
- Test: `test/ivekit-translation-provider.test.ts`
- Test: `test/ivekit-intelligence-provider-registry.test.ts`

**Steps:**

1. Add failing tests for self-hosted/third-party requests, legacy translation variables, bearer token resolution, source-ref format, language validation, timeout, 429/5xx retryability, 4xx terminal failure, invalid JSON, and oversized output.
2. Implement the bounded HTTP JSON contract for source text, source language, target language, and opaque source ref.
3. Normalize translated text, detected language, confidence, provider request ID, and safe metadata.
4. Never include tenant text in errors, events, logs, or health output.
5. Add a legacy default translation profile without enabling automatic translation.
6. Reuse registry transport and safety rules instead of introducing a second configuration system.

**Focused gate:**

```bash
node --import tsx --test test/ivekit-translation-provider.test.ts test/ivekit-intelligence-provider-registry.test.ts
npm run typecheck
```

**Commit:** `feat(ivekit): add translation provider contract`

### Task 10: Build the durable translation service and worker

**Files:**
- Create: `src/agent-runtime/collaboration/translation-service.ts`
- Create: `src/agent-runtime/collaboration/translation-worker.ts`
- Modify: `src/agent-runtime/collaboration/collaboration-store.ts`
- Modify: `src/agent-runtime/collaboration/message-state-store.ts`
- Modify: `src/agent-runtime/collaboration/index.ts`
- Test: `test/ivekit-translation-service.test.ts`
- Test: `test/collaboration-message-state.test.ts`

**Steps:**

1. Add failing tests for message and attachment sources, empty/unready extraction, stable source hash, idempotent replay, payload conflict, lease claim, transient retry, exhausted failure, lease expiry recovery, cancellation, and concurrent workers.
2. Add current/history translation result reads and stop using the legacy write-only store method as the public workflow.
3. Compute source identity from the authorized current message body or current extracted text; never trust caller-supplied source text.
4. Store immutable result versions by source hash and return only results current for the visible source unless history is explicitly authorized.
5. Cancel unfinished jobs and hide normal results when a source message is deleted; create a new version after edits or changed OCR/ASR.
6. Implement a bounded poll worker with independent enable, batch, interval, lease, attempts, and graceful stop controls.

**Focused gate:**

```bash
node --import tsx --test test/ivekit-translation-service.test.ts test/collaboration-message-state.test.ts
npm run typecheck
```

**Commit:** `feat(ivekit): add durable translation jobs`

### Task 11: Expose translation HTTP APIs and durable events

**Files:**
- Modify: `src/agent-runtime/ivekit/chat-http.ts`
- Modify: `src/agent-runtime/ivekit/application.ts`
- Modify: `src/agent-runtime/ivekit/tenant-event-store.ts`
- Modify: `src/agent-runtime/ivekit/types.ts`
- Test: `test/ivekit-translation-http.test.ts`
- Test: `test/ivekit-tenant-event-replay.test.ts`
- Test: `test/ivekit-application.test.ts`

**Steps:**

1. Add failing route tests for message/attachment list/request, retry, system worker trigger, membership/role checks, idempotency, invalid language, deleted source, and cross-tenant 404 behavior.
2. Add current/history query semantics and retry only for retryable terminal jobs.
3. Start/stop the translation worker in iveKit application composition and wire extraction completion to policy-driven auto-enqueue.
4. Append queued/completed/failed tenant events after durable state changes.
5. Keep event payloads text-free and rely on authorized resource refetch for content.
6. Verify restart/replay convergence and no duplicate result on repeated events.

**Focused gate:**

```bash
node --import tsx --test test/ivekit-translation-http.test.ts test/ivekit-tenant-event-replay.test.ts test/ivekit-application.test.ts
npm run typecheck
```

**Commit:** `feat(ivekit): expose translation workflow`

---

## M7.5 SDK and Reference Client

### Task 12: Add typed intelligence and translation SDK surfaces

**Files:**
- Create: `sdk/ivekit/src/intelligence-types.ts`
- Modify: `sdk/ivekit/src/chat-types.ts`
- Modify: `sdk/ivekit/src/http-sdk.ts`
- Modify: `sdk/ivekit/src/index.ts`
- Modify: `sdk/ivekit/README.md`
- Test: `test/ivekit-intelligence-sdk.test.ts`
- Test: `test/ivekit-http-sdk.test.ts`
- Test: `test/ivekit-sdk-package.test.ts`

**Steps:**

1. Add failing SDK transport tests for policy, profiles, health, source import/status/retry, review queue, and message/attachment translation methods.
2. Define named DTOs for policy, effective capabilities, profile summary, health, source link, translation job/result, pagination, and filters.
3. Add an `intelligence` SDK domain and additive `chat` translation methods without changing V2 signatures.
4. Require caller-supplied `Idempotency-Key` for work-creating SDK calls and normalize error responses.
5. Keep server implementation imports and Node-only dependencies out of the browser package.
6. Build and dry-pack the SDK, then inspect package contents.

**Focused gate:**

```bash
node --import tsx --test test/ivekit-intelligence-sdk.test.ts test/ivekit-http-sdk.test.ts test/ivekit-sdk-package.test.ts
npm run build:ivekit-sdk
npm run pack:ivekit-sdk
```

**Commit:** `feat(ivekit-sdk): add intelligence APIs`

### Task 13: Add inline message and attachment translation UX

**Files:**
- Create: `clients/ivekit-reference/src/chat/translation-view-model.ts`
- Create: `clients/ivekit-reference/src/chat/translation-panel.tsx`
- Modify: `clients/ivekit-reference/src/chat/message-timeline.tsx`
- Modify: `clients/ivekit-reference/src/chat/types.ts`
- Modify: `clients/ivekit-reference/src/chat/chat-reducer.ts`
- Modify: `clients/ivekit-reference/src/chat/use-chat-session.ts`
- Modify: `clients/ivekit-reference/src/styles.css`
- Test: `clients/ivekit-reference/src/chat/translation-view-model.test.ts`
- Test: `clients/ivekit-reference/src/chat/translation-panel.test.tsx`
- Test: `clients/ivekit-reference/src/chat/message-timeline.test.tsx`

**Steps:**

1. Add failing component/reducer tests for language menu, pending/processing/retry/succeeded/failed/cancelled states, current-vs-stale source hash, attachment readiness, retry visibility, and original-text preservation.
2. Add a compact language menu to message actions and extraction controls to eligible attachments.
3. Render translation beneath original content; never replace or silently mutate the source.
4. Reconcile HTTP snapshots and tenant-event invalidations through the existing convergence path.
5. Keep controls stable at mobile widths and prevent long translated words from overflowing.
6. Verify no provider profile secret, token, source URL, or raw error body reaches DOM/storage.

**Focused gate:**

```bash
npm --prefix clients/ivekit-reference test
npm --prefix clients/ivekit-reference run build
```

**Commit:** `feat(ivekit-client): add translation workspace`

### Task 14: Add the tenant review queue and recording-source UI

**Files:**
- Create: `clients/ivekit-reference/src/chat/review-queue.tsx`
- Create: `clients/ivekit-reference/src/chat/intelligence-source-panel.tsx`
- Modify: `clients/ivekit-reference/src/chat/finding-panel.tsx`
- Modify: `clients/ivekit-reference/src/app.tsx`
- Modify: `clients/ivekit-reference/src/navigation.ts`
- Modify: `clients/ivekit-reference/src/styles.css`
- Test: `clients/ivekit-reference/src/chat/review-queue.test.tsx`
- Test: `clients/ivekit-reference/src/chat/intelligence-source-panel.test.tsx`
- Test: `clients/ivekit-reference/src/navigation.test.ts`

**Steps:**

1. Add failing UI tests for queue pagination/filtering, review transition, denied roles, stale finding refresh, recording import, processing status, retryable failure, and terminal failure.
2. Add an operational review view using the tenant queue while retaining the session-local drawer.
3. Use filters appropriate for repeated review work: status, severity, source, session, and date.
4. Add recording-source import/status to the quality workspace using stable media/evidence IDs only.
5. Make policy-disabled, provider-unavailable, retry-wait, failed, and succeeded states explicit.
6. Preserve keyboard navigation, labels, focus state, and dense work-focused layout.

**Focused gate:**

```bash
npm --prefix clients/ivekit-reference test
npm --prefix clients/ivekit-reference run build
```

**Commit:** `feat(ivekit-client): add intelligence review queue`

### Task 15: Add controlled browser acceptance for V3 workflows

**Files:**
- Create: `clients/ivekit-reference/e2e/controlled-intelligence-server.ts`
- Create: `clients/ivekit-reference/e2e/intelligence.spec.ts`
- Modify: `clients/ivekit-reference/playwright.config.ts`
- Modify: `package.json`
- Test: `test/ivekit-intelligence-client-acceptance.test.ts`

**Steps:**

1. Cover message translation, attachment OCR/ASR translation, stale-result invalidation, retry convergence, recording import, tenant review filtering, and human transition.
2. Cover disconnect/reconnect and durable event replay without duplicate UI rows or lost terminal state.
3. Cover unauthorized roles, cross-tenant denial, policy-disabled behavior, and provider-unavailable behavior.
4. Inspect DOM, local/session storage, bundle text, request URLs, and controlled artifacts for credentials and raw storage URLs.
5. Capture 320px, 390px, tablet, and desktop states and assert no overlap, clipping, or unreachable action.
6. Label controlled-provider/browser results accurately; do not claim vendor quality.

**Focused gate:**

```bash
npm run test:e2e:ivekit
node --import tsx --test test/ivekit-intelligence-client-acceptance.test.ts
```

**Commit:** `test(ivekit): add V3 browser acceptance`

---

## M7.6 Standalone Deployment and Delivery

### Task 16: Integrate V3 into standalone source, workers, and configuration

**Files:**
- Modify: `services/ivekit-service/source-policy.json`
- Modify: `services/ivekit-service/package.json`
- Modify: `services/ivekit-service/package-lock.json`
- Modify: `services/ivekit-service/env.example`
- Modify: `infra/ivekit/env.example`
- Modify: `.env.example`
- Modify: `src/ivekit-server.ts`
- Modify: `src/agent-runtime/ivekit/application.ts`
- Test: `test/ivekit-standalone-source-graph.test.ts`
- Test: `test/ivekit-standalone-build-context.test.ts`
- Test: `test/ivekit-server-entrypoint.test.ts`
- Test: `test/ivekit-application.test.ts`

**Steps:**

1. Add source-graph failures for missing V3 files and forbidden call-center/frontend dependencies.
2. Include every new runtime module and migration in standalone generation with deterministic lock/package output.
3. Document provider profiles, token refs, translation worker, health, and preflight environment variables with conservative defaults.
4. Start each worker independently and stop in reverse order without leaving timers or claims active.
5. Preserve startup behavior when V3 profiles and policy are absent.
6. Verify the generated context compiles without the OPC monolith tree.

**Focused gate:**

```bash
npm run test:ivekit:foundation
npm run test:ivekit:standalone-context
npm run verify:ivekit:standalone-context
npm run typecheck
```

**Commit:** `feat(ivekit): integrate V3 standalone runtime`

### Task 17: Add Compose, Kubernetes, controlled provider, and operations docs

**Files:**
- Create: `scripts/ivekit-controlled-provider.ts`
- Modify: `infra/ivekit/docker-compose.yml`
- Modify: `infra/docker-compose.production.yml`
- Modify: `infra/k8s/values.yaml`
- Modify: `infra/k8s/templates/opc-deployment.yaml`
- Modify: `infra/k8s/templates/secrets.yaml`
- Modify: `infra/ivekit/README.md`
- Modify: `services/ivekit-service/README.md`
- Modify: `docs/ivekit-openapi.md`
- Modify: `docs/ivekit-led-integration-guide.md`
- Create: `docs/ivekit-v3-intelligence-operations.md`
- Test: `test/ivekit-controlled-provider.test.ts`
- Test: `test/ivekit-v3-deployment.test.ts`

**Steps:**

1. Build a deterministic HTTP provider with OCR/ASR/quality/translation/health endpoints and selectable timeout, transient failure, terminal failure, invalid JSON, and oversized output behavior.
2. Add worker/profile/secret-ref configuration to standalone and production Compose and Kubernetes without putting example secret values in public ConfigMaps.
3. Verify Compose rendering and Helm template output for enabled/disabled workers and self-hosted/third-party profiles.
4. Document APIs, provider contracts, RBAC, tenant policy, retry/recovery, metrics, alerts, upgrade, rollback, and vendor acceptance limits.
5. Include an LED integration flow that uses only SDK/API contracts.
6. Add secret scans for rendered configuration and controlled-provider evidence.

**Focused gate:**

```bash
node --import tsx --test test/ivekit-controlled-provider.test.ts test/ivekit-v3-deployment.test.ts
COMPOSE_DISABLE_ENV_FILE=1 docker compose --env-file infra/ivekit/env.example -f infra/ivekit/docker-compose.yml config --quiet
npm run typecheck
```

**Commit:** `feat(ivekit): ship V3 deployment surfaces`

### Task 18: Extend delivery bundles and acceptance metadata

**Files:**
- Modify: `scripts/ivekit-delivery-bundle.ts`
- Modify: `test/ivekit-delivery-bundle.test.ts`
- Modify: `docs/ivekit-client-delivery-v1-roadmap.md`
- Modify: `docs/iveKit视频IM通用能力详细设计.md`
- Create: `docs/ivekit-v3-completion-audit.md`

**Steps:**

1. Add V3 source, migration, SDK/client, provider examples, preflight, runbook, acceptance report, and known-not-run fields to the bundle manifest.
2. Bind source commit, image digest, migration checksums, SDK/package hashes, client hash, SBOM, and acceptance evidence with SHA-256.
3. Reject missing, symlinked, out-of-root, placeholder, stale, duplicate, or secret-bearing artifacts.
4. State controlled-provider success separately from real-vendor `not_run` results.
5. Record exact upgrade and rollback order and retained additive schema.
6. Update the detailed capability document so another LED team can identify implemented, configurable, and not-run surfaces without reading source.

**Focused gate:**

```bash
node --import tsx --test test/ivekit-delivery-bundle.test.ts
npm run ivekit:delivery-bundle -- --help
```

**Commit:** `docs(ivekit): add V3 delivery contract`

---

## M7.7 Completion Audit and Server Acceptance

### Task 19: Run local full gates and direct security review

**Files:**
- Modify as findings require: V3 files only
- Update: `docs/ivekit-v3-completion-audit.md`

**Steps:**

1. Run all focused V3 suites, full repository tests, typecheck, sidecar checks, SDK build/pack, reference-client tests/build/E2E, standalone source/context, Compose, and delivery tests.
2. Run migration and RLS tests against real PostgreSQL, including fresh install, V2-to-V3 upgrade, runtime role, lease recovery, concurrency, and cross-tenant cases.
3. Exercise every controlled provider success/failure class and inspect persisted rows/events/errors for source text, tokens, URLs, and response bodies.
4. Review policy authorization, profile selection, SSRF boundaries, source import, object ownership, deletion, idempotency conflicts, retry races, and human-review authority directly.
5. Fix each Critical or Important finding with a failing regression test before changing implementation.
6. Record exact commands, counts, commit, environment, and any honest `not_run` items in the audit.

**Full local gate:**

```bash
npm run typecheck
npm test
npm run check:sidecars
npm run verify:ivekit:foundation
npm run verify:ivekit:standalone-context
npm run build:ivekit-sdk
npm run pack:ivekit-sdk
npm --prefix clients/ivekit-reference test
npm --prefix clients/ivekit-reference run build
npm run test:e2e:ivekit
npm run test:ivekit:delivery
```

**Commit:** `test(ivekit): complete V3 local audit`

### Task 20: Run isolated server acceptance and publish the clean branch

**Files:**
- Create/update: server-side acceptance artifacts outside Git
- Update: `docs/ivekit-v3-completion-audit.md`

**Steps:**

1. Push `codex/ivekit-v3-multimodal-translation` and verify the remote commit exactly matches the local reviewed commit.
2. Upload a commit-bound delivery archive to an isolated directory on `root@64.225.122.227`; do not modify unrelated services.
3. Start a fresh PostgreSQL database, controlled provider, object storage, iveKit service/workers, and reference client from the delivery artifact.
4. Run migration/RLS, provider protocol, durable retry/restart, translation, recording import, review queue, event replay, SDK, browser, secret scan, and standalone acceptance.
5. Restart iveKit during claimed attachment/quality/translation work and verify lease expiry converges without duplicate terminal results.
6. Produce checksum-bound logs/reports, update the completion audit, rebuild the final delivery artifact, and verify archive SHA-256 and image digest.
7. Push the final audit commit and verify `git status --short`, local HEAD, remote HEAD, delivery manifest commit, and server artifact commit all agree.
8. Mark the active V3 goal complete only after every Definition of Done item is evidenced and remaining vendor checks are accurately `not_run`.

**Commit:** `docs(ivekit): finalize V3 acceptance evidence`

---

## Definition of Done

1. OCR, ASR, quality review, and translation can use an allowed self-hosted or third-party profile without exposing credentials.
2. Tenant policy controls enablement, automation, selected profile, third-party permission, confidence thresholds, and translation targets under forced RLS.
3. Image, audio, video, screen recording, LiveKit recording, and remote recording evidence enter durable processing through authorized stable IDs.
4. Attachment, quality, and translation jobs recover from restart, obey leases, deduplicate retries, retain source/profile identity, and expose honest terminal state.
5. AI findings remain advisory, and authorized reviewers can work a tenant queue with immutable transitions and audit.
6. Message and attachment translations are source-hash aware, durable, queryable through API/SDK/UI, and invalidated safely after edit/deletion.
7. Provider health and preflight are bounded, SSRF-aware, and secret-safe.
8. Existing V2 APIs/events/SDK/client behavior has no regression, and standalone source remains free of call-center/IVR/frontend dependencies.
9. Migration, runtime role, Compose, Kubernetes, SDK package, reference client, delivery bundle, upgrade, and rollback surfaces include V3.
10. Focused, full repository, real PostgreSQL, controlled provider, browser, restart-recovery, and isolated server gates pass with evidence.
11. Real vendor accuracy, compliance, quota, and latency remain clearly marked `not_run` until provider selection and credentials are supplied.

