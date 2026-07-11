# iveKit Standalone Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing iveKit media, chat, and RustDesk capabilities independently runnable and consumable through a publishable TypeScript SDK without changing the existing `/api/ivekit/*` contracts.

**Architecture:** Add an iveKit-only process entrypoint and a small HTTP server interface that reuse the existing LiveKit, Tinode, PostgreSQL/RLS, object-storage, and RustDesk implementations. Move client-side HTTP code to `@opc/ivekit-sdk`, while keeping compatibility re-exports in `src/agent-runtime/ivekit/`. Keep the existing `infra/ivekit` Compose service name for upgrade compatibility, but run the new iveKit-only process and provide the `ivekit-api` network alias.

**Tech Stack:** TypeScript, Node.js HTTP server and test runner, PostgreSQL/RLS, Redis/WebSocket, LiveKit Server SDK, Tinode, RustDesk OSS, Docker Compose, npm package tooling.

---

## Scope And Invariants

This is milestone 1 of the active **iveKit client and independent delivery V1** goal. IM product UX, LiveKit call UX, and real RustDesk desktop acceptance each receive a separate implementation plan after this foundation passes.

The following invariants are mandatory:

1. Existing OPC startup through `src/server.ts` and `npm start` remains compatible.
2. Existing `/api/ivekit/media/*`, `/api/ivekit/chat/*`, `/api/ivekit/rustdesk/*`, `/api/opc/rustdesk/*`, and `/remote/rustdesk/launch` behavior remains compatible.
3. The standalone process does not start call-center runtime, NATS, IVR migration helpers, outbound dialer, or unrelated OPC routes.
4. PostgreSQL remains the only production database. No SQLite runtime fallback is added.
5. Tenant request context and FORCE RLS stay active on both OPC and standalone entrypoints.
6. SDK callers never import from `src/agent-runtime/*` after this milestone.
7. SDK packaging contains no server implementation, database code, secrets, or environment files.
8. `infra/ivekit/docker-compose.yml` remains an in-place upgrade for the already deployed stack.

## File Map

### New Modules

| File | Responsibility |
| --- | --- |
| `src/agent-runtime/ivekit/application.ts` | Start and stop iveKit background workers behind one lifecycle interface. |
| `src/agent-runtime/ivekit/http-server.ts` | Parse requests, establish tenant/RLS context, and dispatch only approved iveKit routes. |
| `src/agent-runtime/ivekit/media-hooks.ts` | Bind recording evidence, generic audit, deletion, and standalone retention policy without importing call-center. |
| `src/ivekit-server.ts` | Production iveKit-only process entrypoint. |
| `sdk/ivekit/package.json` | Publishable `@opc/ivekit-sdk` package metadata. |
| `sdk/ivekit/tsconfig.json` | SDK-only TypeScript build configuration. |
| `sdk/ivekit/src/http-sdk.ts` | Existing authenticated Media/Chat JSON and binary client, moved without contract drift. |
| `sdk/ivekit/src/rustdesk-http-client.ts` | Existing typed RustDesk device/session/audit client. |
| `sdk/ivekit/src/rustdesk-led-sdk.ts` | Existing high-level LED RustDesk workflow client. |
| `sdk/ivekit/src/types.ts` | Browser-safe public DTOs replacing server-internal collaboration type imports. |
| `sdk/ivekit/src/index.ts` | Public SDK interface and factory. |
| `sdk/ivekit/README.md` | Installation, authentication, compatibility, and minimal LED flow. |
| `test/ivekit-standalone-http.test.ts` | Standalone route allowlist, binary upload, auth, and RLS contract. |
| `test/ivekit-media-hooks.test.ts` | Standalone recording evidence, audit, deletion, and retention contract. |
| `test/ivekit-application.test.ts` | Worker lifecycle and callback contract. |
| `test/ivekit-sdk-package.test.ts` | SDK exports, package contents, and compatibility re-export contract. |

### Modified Modules

| File | Change |
| --- | --- |
| `src/server.ts` | Replace duplicated iveKit worker startup/shutdown with `startIveKitApplication()`. |
| `src/agent-runtime/ivekit/index.ts` | Export standalone application/server interfaces and preserve SDK exports. |
| `src/agent-runtime/ivekit/http-sdk.ts` | Become a compatibility re-export from `sdk/ivekit`. |
| `src/agent-runtime/ivekit/rustdesk-http-client.ts` | Become a compatibility re-export from `sdk/ivekit`. |
| `src/agent-runtime/ivekit/rustdesk-led-sdk.ts` | Become a compatibility re-export from `sdk/ivekit`. |
| `infra/ivekit/docker-compose.yml` | Run `start:ivekit`, add `ivekit-api` alias, retain the `opc` service key. |
| `infra/ivekit/env.example` | Document standalone-only runtime settings. |
| `infra/ivekit/README.md` | Document process isolation, upgrade behavior, and SDK usage. |
| `package.json` | Add standalone start, SDK build, SDK pack, and foundation verification commands. |
| `Dockerfile` | Copy the SDK source needed by compatibility imports and SDK build checks. |
| `docs/ivekit-led-integration-guide.md` | Point LED developers to the package and standalone process. |

## Task 1: Freeze The Standalone HTTP Interface

**Files:**
- Create: `test/ivekit-standalone-http.test.ts`
- Create: `src/agent-runtime/ivekit/http-server.ts`
- Create: `src/agent-runtime/ivekit/media-hooks.ts`
- Create: `test/ivekit-media-hooks.test.ts`
- Modify: `src/agent-runtime/ivekit/index.ts`

- [x] **Step 1: Write the failing route-allowlist test**

Create a real Node HTTP server with in-memory route adapters. The test must prove that approved paths are dispatched and unrelated OPC paths return 404.

```typescript
test('standalone iveKit server exposes only approved routes', async () => {
  const calls: string[] = [];
  const server = createIveKitHttpServer({
    db: createDatabase(':memory:'),
    pg: null,
    routes: {
      media: async (_db, _method, path) => {
        calls.push(path);
        return path === '/api/ivekit/media/capabilities' ? { data: { media: true } } : undefined;
      },
      chat: async () => undefined,
      collaboration: async () => undefined
    }
  });

  const baseUrl = await listenForTest(server);
  assert.equal((await fetch(`${baseUrl}/api/ivekit/media/capabilities`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/call-center/dashboard`)).status, 404);
  assert.deepEqual(calls, ['/api/ivekit/media/capabilities']);
  await closeForTest(server);
});
```

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
node --import tsx --test test/ivekit-standalone-http.test.ts
```

Expected: FAIL because `createIveKitHttpServer` does not exist.

- [x] **Step 3: Define the deep server interface**

Add this public interface to `http-server.ts`:

```typescript
export interface IveKitHttpServerInput {
  db: unknown;
  pg: PgQueryable | null;
  routes?: Partial<IveKitRouteAdapters>;
  mediaOptions?: RouteIveKitMediaApiOptions;
}

export function createIveKitHttpServer(input: IveKitHttpServerInput): Server;
```

`IveKitRouteAdapters` has exactly three internal adapters: `media`, `chat`, and `collaboration`. Defaults are `routeIveKitMediaApi`, `routeIveKitChatApi`, and `routeCollaborationApi`. The external interface does not expose every route function parameter.

- [x] **Step 4: Implement request parsing and the explicit allowlist**

Allow only:

```typescript
const allowedPrefixes = [
  '/api/ivekit/media/',
  '/api/ivekit/chat/',
  '/api/ivekit/rustdesk/',
  '/api/opc/rustdesk/'
];

const allowedExactPaths = new Set([
  '/health',
  '/metrics',
  '/remote/rustdesk/launch'
]);
```

The implementation must:

1. Parse bounded binary bodies for iveKit attachment upload.
2. Preserve raw LiveKit webhook bodies.
3. Resolve tenant context with `resolvePgTenantContextForRequest()`.
4. Enter `runWithPgTenantContextAsync()` and `withPgRequestContext()` before route dispatch.
5. Dispatch media, then chat, then collaboration.
6. Return the same JSON, HTML, binary, and structured error shapes as `src/http.ts`.
7. Return 404 without constructing the OPC harness for every non-allowlisted route.

The production default `mediaOptions` comes from `createIveKitMediaHooks({ db, pg })`. That module may import `media-recording-evidence.ts`, but it must not import anything under `agent-runtime/call-center/`. It writes recording audit rows through the generic audit table contract and resolves standalone retention from `OPC_RECORDING_RETENTION_DAYS` only when configured; otherwise the recording service retains its existing default.

- [x] **Step 5: Add auth, binary, HTML, and RLS tests**

Add focused tests for:

```typescript
test('standalone iveKit server preserves attachment bytes and limits');
test('standalone iveKit server preserves LiveKit webhook raw body');
test('standalone iveKit server renders the RustDesk launch page');
test('standalone iveKit server enters the tenant PostgreSQL context');
test('standalone iveKit server returns structured non-500 and opaque 500 errors');
test('standalone media hooks create and delete recording evidence');
test('standalone media hooks write tenant-scoped recording audit');
test('standalone media hooks reject invalid retention configuration');
```

- [x] **Step 6: Run focused tests and typecheck**

```bash
node --import tsx --test test/ivekit-standalone-http.test.ts test/ivekit-media-hooks.test.ts
npm run typecheck
```

Expected: all standalone tests pass and TypeScript reports zero errors.

- [x] **Step 7: Commit**

```bash
git add src/agent-runtime/ivekit/http-server.ts src/agent-runtime/ivekit/media-hooks.ts src/agent-runtime/ivekit/index.ts test/ivekit-standalone-http.test.ts test/ivekit-media-hooks.test.ts
git commit -m "feat(ivekit): add standalone HTTP server"
```

## Task 2: Extract The iveKit Runtime Lifecycle

**Files:**
- Create: `src/agent-runtime/ivekit/application.ts`
- Create: `test/ivekit-application.test.ts`
- Modify: `src/server.ts`
- Modify: `src/agent-runtime/ivekit/index.ts`

- [x] **Step 1: Write the failing lifecycle test**

```typescript
test('iveKit application starts and stops every worker once', async () => {
  const events: string[] = [];
  const app = startIveKitApplication({
    pg: fakePg,
    adapters: {
      startTinode: () => stopHandle('tinode', events),
      startAttachment: () => stopHandle('attachment', events),
      startQuality: () => stopHandle('quality', events)
    }
  });

  await app.stop();
  await app.stop();
  assert.deepEqual(events, [
    'start:tinode', 'start:attachment', 'start:quality',
    'stop:quality', 'stop:attachment', 'stop:tinode'
  ]);
});
```

- [x] **Step 2: Run the test and verify RED**

```bash
node --import tsx --test test/ivekit-application.test.ts
```

Expected: FAIL because `startIveKitApplication` does not exist.

- [x] **Step 3: Implement one lifecycle interface**

```typescript
export interface IveKitApplication {
  stop(): Promise<void>;
}

export function startIveKitApplication(input: {
  pg: PgQueryable;
  publish?: (tenantId: string, type: string, data: unknown) => void;
  adapters?: Partial<IveKitRuntimeAdapters>;
}): IveKitApplication;
```

Default adapters start the existing Tinode delivery, attachment processing, and quality review workers. `publish` defaults to `wsBroadcast`. Stop order is reverse startup order and is idempotent.

- [x] **Step 4: Move existing callback behavior without changing event payloads**

Preserve these event names exactly:

```typescript
'collaboration.message.delivery_updated'
'collaboration.attachment.processed'
'collaboration.quality_review.completed'
```

Preserve attachment-to-quality auto-enqueue behavior and provider configuration checks from `src/server.ts`.

- [x] **Step 5: Replace duplicated startup in the OPC process**

In `src/server.ts`, replace direct worker construction with:

```typescript
const iveKitApplication = startIveKitApplication({ pg, publish: wsBroadcast });
```

Replace the three worker stops with:

```typescript
await iveKitApplication.stop();
```

Do not change NATS or call-center runtime behavior in this task.

- [x] **Step 6: Verify focused and existing worker tests**

```bash
node --import tsx --test \
  test/ivekit-application.test.ts \
  test/tinode-sync-worker.test.ts \
  test/collaboration-attachment-processing.test.ts \
  test/collaboration-policy-finding.test.ts
npm run typecheck
```

Expected: all selected tests pass and TypeScript reports zero errors.

- [x] **Step 7: Commit**

```bash
git add src/agent-runtime/ivekit/application.ts src/agent-runtime/ivekit/index.ts src/server.ts test/ivekit-application.test.ts
git commit -m "refactor(ivekit): extract runtime lifecycle"
```

## Task 3: Add The Production Standalone Entrypoint

**Files:**
- Create: `src/ivekit-server.ts`
- Create: `test/ivekit-server-entrypoint.test.ts`
- Modify: `package.json`

- [x] **Step 1: Write a static entrypoint contract test**

The test reads `src/ivekit-server.ts` and asserts that it imports only the database, iveKit server/application, WebSocket, and environment validation modules. It must reject imports from call-center, NATS, IVR, and dialer paths.

```typescript
test('iveKit entrypoint excludes unrelated OPC runtimes', () => {
  const source = readFileSync('src/ivekit-server.ts', 'utf8');
  assert.match(source, /createIveKitHttpServer/);
  assert.match(source, /startIveKitApplication/);
  assert.doesNotMatch(source, /call-center|connectNats|migrateIvrRuntimeTables|outbound-dialer/);
});
```

- [x] **Step 2: Run the test and verify RED**

```bash
node --import tsx --test test/ivekit-server-entrypoint.test.ts
```

Expected: FAIL because the entrypoint does not exist.

- [x] **Step 3: Implement fail-fast startup and idempotent shutdown**

The entrypoint performs this exact lifecycle:

```typescript
validateEnvOrExit();
const pg = await initPostgres();
if (!pg) throw new Error('cannot connect to Postgres');
const db = new PgSyncDatabase();
const server = createIveKitHttpServer({ db, pg });
initWebSocket(server);
const application = startIveKitApplication({ pg, publish: wsBroadcast });
server.listen(Number(process.env.PORT || 3000));
```

Shutdown closes the HTTP server, application, synchronous DB adapter, and PostgreSQL pool exactly once. Do not run `migrateIvrRuntimeTables()`.

- [x] **Step 4: Add package commands**

```json
{
  "start:ivekit": "tsx src/ivekit-server.ts",
  "test:ivekit:foundation": "node --import tsx --test test/ivekit-standalone-http.test.ts test/ivekit-media-hooks.test.ts test/ivekit-application.test.ts test/ivekit-server-entrypoint.test.ts"
}
```

Task 4 adds `build:ivekit-sdk` and `pack:ivekit-sdk`; Task 5 appends its deployment test to `test:ivekit:foundation` after those files exist.

- [x] **Step 5: Verify entrypoint and TypeScript**

```bash
node --import tsx --test test/ivekit-server-entrypoint.test.ts
npm run typecheck
```

- [x] **Step 6: Commit**

```bash
git add src/ivekit-server.ts test/ivekit-server-entrypoint.test.ts package.json package-lock.json
git commit -m "feat(ivekit): add standalone process"
```

## Task 4: Publish A Dedicated TypeScript SDK Package

**Files:**
- Create: `sdk/ivekit/package.json`
- Create: `sdk/ivekit/package-lock.json`
- Create: `sdk/ivekit/tsconfig.json`
- Create: `sdk/ivekit/src/http-sdk.ts`
- Create: `sdk/ivekit/src/rustdesk-http-client.ts`
- Create: `sdk/ivekit/src/rustdesk-led-sdk.ts`
- Create: `sdk/ivekit/src/types.ts`
- Create: `sdk/ivekit/src/index.ts`
- Create: `sdk/ivekit/README.md`
- Create: `test/ivekit-sdk-package.test.ts`
- Modify: `src/agent-runtime/ivekit/http-sdk.ts`
- Modify: `src/agent-runtime/ivekit/rustdesk-http-client.ts`
- Modify: `src/agent-runtime/ivekit/rustdesk-led-sdk.ts`
- Modify: `src/agent-runtime/ivekit/index.ts`
- Modify: `Dockerfile`

- [x] **Step 1: Write failing package-interface tests**

```typescript
test('iveKit SDK exposes media chat and rustdesk through one factory', async () => {
  const sdk = createIveKitClient({
    baseUrl: 'https://ivekit.example.test',
    tenantId: 'tenant-led',
    apiKey: 'test-key',
    userId: 'engineer-1',
    fetch: fakeFetch
  });
  assert.equal(typeof sdk.media.createRoom, 'function');
  assert.equal(typeof sdk.chat.postMessage, 'function');
  assert.equal(typeof sdk.rustdesk.startSession, 'function');
});

test('iveKit SDK package has no server-side imports', () => {
  for (const file of sdkSourceFiles()) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /agent-runtime|db-pg|node:fs|livekit-server-sdk/);
  }
});
```

- [x] **Step 2: Run tests and verify RED**

```bash
node --import tsx --test test/ivekit-sdk-package.test.ts
```

Expected: FAIL because `sdk/ivekit` and `createIveKitClient` do not exist.

- [x] **Step 3: Create package metadata**

Use this public package contract:

```json
{
  "name": "@opc/ivekit-sdk",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist", "README.md"],
  "sideEffects": false,
  "scripts": { "build": "tsc -p tsconfig.json", "prepack": "npm run build" },
  "engines": { "node": ">=20" },
  "devDependencies": { "typescript": "^5.9.3" }
}
```

- [x] **Step 4: Move transport and typed clients behind one factory**

The public seam is:

```typescript
export interface IveKitClient {
  media: IveKitMediaClient;
  chat: IveKitChatClient;
  rustdesk: IveKitRustDeskClient;
}

export function createIveKitClient(input: IveKitClientInput): IveKitClient;
```

Reuse the existing behavior from:

1. `src/agent-runtime/ivekit/http-sdk.ts`
2. `src/agent-runtime/ivekit/rustdesk-http-client.ts`
3. `src/agent-runtime/ivekit/rustdesk-led-sdk.ts`

Do not redesign endpoint payloads in this task. Split by caller domain, share one transport, retain `IveKitHttpSdkError` compatibility, and alias `createIveKitHttpSdk` to the media/chat portion of the new factory.

- [x] **Step 5: Replace old implementations with compatibility re-exports**

Each old file becomes a re-export only. For example:

```typescript
export * from '../../../sdk/ivekit/src/index.js';
```

Where names collide, export the exact symbol from its SDK source module. Existing tests and scripts must continue importing old paths unchanged.

- [x] **Step 6: Document the minimal LED flow**

The README example must compile and show:

```typescript
const ivekit = createIveKitClient({ baseUrl, tenantId, accessToken, userId });
const chat = await ivekit.chat.openSession({ business_ref: orderRef });
const room = await ivekit.media.createRoom({ purpose: 'video_service', business_ref: orderRef });
const device = await ivekit.rustdesk.ensureDevice({ businessRef: orderRef, rustdeskId });
```

Document API-key server usage separately from browser bearer-token usage. Warn that browser bundles must never contain `apiKey`.

- [x] **Step 7: Build, pack, and inspect package contents**

```bash
npm install --prefix sdk/ivekit
npm run build:ivekit-sdk
npm run pack:ivekit-sdk
```

Expected package contents: `dist/**`, `README.md`, `package.json`; no `src/agent-runtime`, `.env`, tests, or credentials.

- [x] **Step 8: Run SDK and compatibility tests**

```bash
node --import tsx --test \
  test/ivekit-sdk-package.test.ts \
  test/ivekit-http-sdk.test.ts \
  test/ivekit-rustdesk-http-client.test.ts \
  test/ivekit-rustdesk-led-sdk.test.ts \
  test/ivekit-led-integration-example.test.ts \
  test/ivekit-rustdesk-led-example.test.ts
npm run typecheck
```

- [x] **Step 9: Commit**

```bash
git add sdk/ivekit src/agent-runtime/ivekit Dockerfile test/ivekit-sdk-package.test.ts package.json package-lock.json
git commit -m "feat(sdk): package iveKit client"
```

## Task 5: Switch The Reusable Compose Stack To The Standalone Process

**Files:**
- Modify: `infra/ivekit/docker-compose.yml`
- Modify: `infra/ivekit/env.example`
- Modify: `infra/ivekit/README.md`
- Modify: `test/livekit-standalone-deployment.test.ts`

- [x] **Step 1: Add failing deployment assertions**

```typescript
test('standalone iveKit application stack runs the iveKit-only process', () => {
  const compose = readFileSync('infra/ivekit/docker-compose.yml', 'utf8');
  assert.match(compose, /command:\s*\["npm",\s*"run",\s*"start:ivekit"\]/);
  assert.match(compose, /aliases:\s*\n\s*- ivekit-api/);
  assert.doesNotMatch(compose, /OPC_DISABLE_DIALER/);
});
```

- [x] **Step 2: Run the test and verify RED**

```bash
node --import tsx --test test/livekit-standalone-deployment.test.ts
```

Expected: FAIL because Compose still runs the full OPC entrypoint.

- [x] **Step 3: Change runtime command without renaming the deployed service key**

Under `services.opc`, add:

```yaml
command: ["npm", "run", "start:ivekit"]
```

Keep the service key `opc` so existing URLs and upgrades remain compatible. Add `ivekit-api` as a network alias and document that new deployments should address the alias while old deployments can continue using `opc`.

- [x] **Step 4: Remove unrelated full-OPC runtime settings**

Remove `OPC_DISABLE_DIALER` from the reusable stack. Keep shared auth, PostgreSQL, Redis, LiveKit, MinIO, Tinode, RustDesk, worker, and migration settings.

- [x] **Step 5: Document upgrade and rollback**

Document:

1. No PostgreSQL downgrade or data copy is required.
2. Existing URLs remain stable.
3. Rollback changes only the container command to `npm start` with the same image and volumes.
4. LED should use `@opc/ivekit-sdk` and the public base URL, never the Docker service name.

- [x] **Step 6: Render and verify Compose**

```bash
docker compose --env-file infra/ivekit/env.example -f infra/ivekit/docker-compose.yml config >/tmp/ivekit-compose.yaml
node --import tsx --test test/livekit-standalone-deployment.test.ts
```

Expected: Compose renders successfully and deployment tests pass.

- [x] **Step 7: Commit**

```bash
git add infra/ivekit test/livekit-standalone-deployment.test.ts
git commit -m "build(ivekit): run standalone process"
```

## Task 6: Update Integration Documentation And Gates

**Files:**
- Modify: `docs/ivekit-led-integration-guide.md`
- Modify: `docs/ivekit-openapi.md`
- Modify: `package.json`
- Modify: `test/ivekit-standalone-http.test.ts`
- Modify: `test/ivekit-sdk-package.test.ts`

- [x] **Step 1: Add documentation contract assertions**

Assert that the integration guide contains:

```text
@opc/ivekit-sdk
npm run start:ivekit
/api/ivekit/media/*
/api/ivekit/chat/*
/api/ivekit/rustdesk/*
```

Also assert that it no longer says the SDK has not been packaged or the standalone process has not been created.

- [x] **Step 2: Run the documentation tests and verify RED**

```bash
node --import tsx --test test/ivekit-sdk-package.test.ts
```

Expected: FAIL until documentation is updated.

- [x] **Step 3: Update the LED integration sequence**

Document three supported consumption modes:

1. Node backend using API key.
2. Browser client using short-lived bearer token.
3. Existing OPC internal callers using compatibility exports during migration.

Include SDK build/install commands, error type behavior, timeout behavior, binary downloads, attachment upload body support, and RustDesk launch/audit sequence.

- [x] **Step 4: Add one foundation verification command**

Add:

```json
{
  "verify:ivekit:foundation": "npm run test:ivekit:foundation && npm run build:ivekit-sdk && npm run pack:ivekit-sdk"
}
```

- [x] **Step 5: Run the milestone verification**

```bash
npm run verify:ivekit:foundation
npm run verify
npm --prefix frontend run build
git status --short
```

Expected:

1. Foundation tests pass.
2. SDK builds and dry-run package contains only approved files.
3. Full 1818+ test suite has zero failures.
4. Go, Python, and Rust sidecar checks pass.
5. Frontend production build passes.
6. Git status contains only this milestone's intended files.

- [x] **Step 6: Commit**

```bash
git add docs/ivekit-led-integration-guide.md docs/ivekit-openapi.md package.json package-lock.json test/ivekit-sdk-package.test.ts test/ivekit-standalone-http.test.ts
git commit -m "docs(ivekit): document standalone delivery"
```

## Task 7: Milestone Review And Next-Plan Gate

**Files:**
- Modify: `docs/superpowers/plans/2026-07-11-ivekit-standalone-foundation.md`

- [ ] **Step 1: Review the final diff for interface leakage**

```bash
git diff origin/feat/livekit-acceptance-evidence...HEAD --stat
git diff origin/feat/livekit-acceptance-evidence...HEAD -- src/agent-runtime/ivekit sdk/ivekit infra/ivekit
```

Reject the milestone if the SDK imports server code, the standalone server constructs the full OPC harness, or existing facade paths changed.

- [ ] **Step 2: Run an independent code review**

Review for Critical and Important findings with special focus on:

1. Tenant context and RLS.
2. API-key versus bearer-token handling.
3. Binary upload limits.
4. SDK package secret leakage.
5. Worker shutdown and duplicate startup.
6. Compose upgrade compatibility.

- [ ] **Step 3: Resolve findings using TDD and rerun all gates**

Use a failing regression test for every behavior change. Repeat Task 6 Step 5 after fixes.

- [ ] **Step 4: Mark this plan complete and write the IM client plan**

Only after all gates pass, change completed checkboxes in this document and create:

```text
docs/superpowers/plans/2026-07-11-ivekit-im-reference-client.md
```

That next plan must use the published SDK interface and must not import OPC frontend API helpers.

## Completion Criteria

This milestone is complete only when all statements are true:

1. `npm run start:ivekit` starts an iveKit-only process.
2. The process exposes approved media, chat, RustDesk, health, metrics, webhook, upload, and launch routes only.
3. Existing OPC startup and existing facade contracts still pass their tests.
4. `@opc/ivekit-sdk` builds and packs independently.
5. SDK package contents contain no server implementation or secrets.
6. `infra/ivekit` runs the standalone process without changing persisted volumes or public paths.
7. Full repository verification and frontend build pass.
8. Independent review reports no unresolved Critical or Important findings.
