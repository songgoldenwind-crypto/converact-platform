# iveKit IM Reference Client Implementation Plan

> **Execution rule:** implement task-by-task with TDD. Every behavioral change starts with a failing test. Do not import `frontend/src/api/client.ts`, `frontend/src/pages/collaboration-chat.ts`, or any OPC call-center module.

**Goal:** Deliver a standalone, reusable IM reference client that uses `@opc/ivekit-sdk` for every business write, uses Tinode only as a receive-only realtime accelerator, and demonstrates the complete V1 chat workflow for LED and other products.

**Architecture:** The reusable UI lives in `clients/ivekit-reference` and becomes the shared reference application for M2-M5. Its only platform dependency is `@opc/ivekit-sdk`; Tinode SDK is isolated behind a local receive-only adapter. PostgreSQL remains the canonical message/audit store. Realtime packets trigger incremental convergence against iveKit HTTP rather than becoming an independent source of truth.

**Stack:** React 19, TypeScript, Vite, `@opc/ivekit-sdk`, `tinode-sdk`, Lucide React, CSS modules/plain CSS, Node test runner for contracts, Playwright or the in-app browser for final interaction evidence.

**V1 exclusions:** no real OCR/ASR/AI provider selection, no direct Tinode publish, no API key in browser code, no call-center routes, no SIP/VoLTE, no LiveKit call UI in this milestone.

---

## Stable Rules

1. Browser authentication uses one short-lived bearer token. Never persist an API key in localStorage, sessionStorage, IndexedDB, source, or build output.
2. Every message, attachment descriptor, mutation, reaction, pin, receipt, presence, typing update, and review action goes through `/api/ivekit/chat/*` via `@opc/ivekit-sdk`.
3. Tinode topic permission remains `JRP`; the client has no publish method and never receives root/service credentials.
4. HTTP mirror state is authoritative. WebSocket/Tinode events only invalidate or advance the local projection.
5. All writes use stable idempotency keys. A retry reuses its original key.
6. Session close/participant leave revokes Tinode access and disables the composer.
7. UI must show pending/retry/failed states without claiming provider delivery or attachment processing succeeded.
8. Reference-client source must be independently buildable and must not import `frontend/src` or server implementation files.

## Public Client State

```typescript
type ChatConnectionState =
  | 'idle'
  | 'loading'
  | 'connecting_realtime'
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'closed'
  | 'fatal';

interface ChatProjection {
  session: IveKitChatSession;
  participants: IveKitChatParticipant[];
  messages: IveKitChatMessage[];
  realtime: IveKitChatRealtimeState[];
  unreadCount: number;
  findings: IveKitPolicyFinding[];
  nextCursor: string | null;
  connection: ChatConnectionState;
}
```

The reducer must be deterministic and independently testable. React components dispatch domain actions; they do not merge packets ad hoc.

---

## Task 1: Deepen The Published Chat SDK Contract

**Files:**
- Create: `sdk/ivekit/src/chat-types.ts`
- Modify: `sdk/ivekit/src/http-sdk.ts`
- Modify: `sdk/ivekit/src/index.ts`
- Modify: `sdk/ivekit/README.md`
- Modify: `test/ivekit-http-sdk.test.ts`
- Modify: `test/ivekit-sdk-package.test.ts`

- [x] **Step 1: Write failing typed-contract tests**

Assert that the SDK exports named DTOs for sessions, participants, messages, attachments, delivery, receipts, realtime state, findings, reactions, pins, and cursor pages. Assert that `IveKitChatHttpClient` no longer returns `Record<string, unknown>` for the M2 methods.

- [x] **Step 2: Verify RED**

```bash
node --import tsx --test test/ivekit-http-sdk.test.ts test/ivekit-sdk-package.test.ts
```

Expected: missing named chat DTOs and methods.

- [x] **Step 3: Add browser-safe DTOs**

Keep types structural and JSON-only. Do not import server types. Model provider delivery separately from participant receipts and include mutation, relation, reaction, pin, attachment-processing, and finding-review fields.

- [x] **Step 4: Add typed methods without changing existing payloads**

Retain all current methods and errors. Add optional cursor/query inputs in a backward-compatible way. Build must remain DOM + ES only.

- [x] **Step 5: Verify and commit**

```bash
npm run build:ivekit-sdk
npm run pack:ivekit-sdk
node --import tsx --test test/ivekit-http-sdk.test.ts test/ivekit-sdk-package.test.ts
git commit -m "feat(sdk): type iveKit chat contract"
```

---

## Task 2: Add Session Listing And Cursor Message History

**Files:**
- Modify: `src/agent-runtime/collaboration/collaboration-store.ts`
- Modify: `src/agent-runtime/collaboration/collaboration-http.ts`
- Modify: `src/agent-runtime/ivekit/chat-http.ts`
- Modify: `sdk/ivekit/src/http-sdk.ts`
- Modify: `sdk/ivekit/src/chat-types.ts`
- Create: `test/collaboration-chat-pagination.test.ts`
- Modify: `test/ivekit-http-sdk.test.ts`
- Modify: `docs/ivekit-openapi.md`

- [x] **Step 1: Write failing pagination and isolation tests**

Cover session list filters (`status`, `business_ref`, text query), opaque cursor validation, stable `(created_at,id)` ordering, no duplicates between pages, search before limit, soft-delete behavior, and cross-tenant rejection.

- [x] **Step 2: Implement opaque cursors**

Use base64url JSON containing version, timestamp, and id. Reject malformed/foreign-direction cursors with 400. Do not expose SQL offsets.

- [x] **Step 3: Add stable endpoints**

```text
GET /api/ivekit/chat/sessions?status=&query=&cursor=&limit=
GET /api/ivekit/chat/sessions/:id/messages?cursor=&direction=before|after&query=&limit=
```

Return `{items,next_cursor,has_more}`. Existing unpaged calls remain supported during migration.

- [x] **Step 4: Update SDK and docs**

Expose `listSessions()` and typed `listMessagesPage()`. Keep `listMessages()` compatibility until M5.

- [x] **Step 5: Verify and commit**

```bash
node --import tsx --test test/collaboration-chat-pagination.test.ts test/collaboration-http.test.ts test/ivekit-http-sdk.test.ts
npm run typecheck
git commit -m "feat(chat): add cursor history"
```

---

## Task 3: Add Reply, Forward, Mentions, Reactions, And Pins

**Files:**
- Create: `src/migrations/033_collaboration_im_features.sql`
- Modify: `src/agent-runtime/collaboration/types.ts`
- Modify: `src/agent-runtime/collaboration/collaboration-store.ts`
- Modify: `src/agent-runtime/collaboration/collaboration-http.ts`
- Modify: `src/agent-runtime/ivekit/chat-http.ts`
- Modify: `sdk/ivekit/src/chat-types.ts`
- Modify: `sdk/ivekit/src/http-sdk.ts`
- Create: `test/collaboration-im-features.test.ts`
- Modify: `docs/ivekit-openapi.md`

- [ ] **Step 1: Write failing domain and RLS tests**

Cover reply target existence, forward source lineage, active-participant mentions, one reaction per `(message,identity,emoji)`, idempotent remove, one session pin per message, pin ordering, soft-deleted target handling, event payloads, and forced tenant RLS.

- [ ] **Step 2: Add schema**

Add explicit relation columns to `collaboration_messages`, plus tenant-scoped `collaboration_message_reactions` and `collaboration_message_pins`. Store no duplicated reply plaintext. Add indexes for session/message lookup and FORCE RLS policies.

- [ ] **Step 3: Add HTTP contracts**

```text
POST   /sessions/:id/messages                    reply_to_message_id, forwarded_from_message_id, mentions
PUT    /sessions/:id/messages/:message/reactions/:emoji
DELETE /sessions/:id/messages/:message/reactions/:emoji
GET    /sessions/:id/messages/:message/reactions
PUT    /sessions/:id/pins/:message
DELETE /sessions/:id/pins/:message
GET    /sessions/:id/pins
```

All identity-bearing writes use the authenticated user unless system API-key mode explicitly acts on behalf of a user.

- [ ] **Step 4: Emit convergence events**

Add `collaboration.message.reaction_updated` and `collaboration.message.pin_updated`. Events contain ids and aggregate counts, never copied message bodies.

- [ ] **Step 5: Update SDK, verify, and commit**

```bash
node --import tsx --test test/collaboration-im-features.test.ts test/db-rls-integration.test.ts
npm run typecheck
git commit -m "feat(chat): add rich message actions"
```

---

## Task 4: Add Upload Progress And Attachment Download Contract

**Files:**
- Modify: `sdk/ivekit/src/chat-types.ts`
- Modify: `sdk/ivekit/src/http-sdk.ts`
- Create: `sdk/ivekit/src/upload-transport.ts`
- Modify: `src/agent-runtime/collaboration/collaboration-http.ts`
- Modify: `src/agent-runtime/ivekit/http-server.ts`
- Create: `test/ivekit-attachment-client.test.ts`
- Modify: `docs/ivekit-openapi.md`

- [ ] **Step 1: Write failing browser upload tests**

Use an injected fake upload transport to assert progress monotonicity, abort, timeout, auth headers, binary preservation, retry with a new upload id but stable message idempotency key, and structured HTTP errors.

- [ ] **Step 2: Add progress transport**

Provide XHR progress in browsers and an injectable/fetch fallback in Node. Never base64 encode files. Expose an abort handle and typed progress `{loaded,total,percent}`.

- [ ] **Step 3: Add authenticated attachment object retrieval**

Return either a controlled binary response or a short-lived object URL under `/api/ivekit/chat/*`. Do not return MinIO credentials or local `/api/call-center/media/*` paths.

- [ ] **Step 4: Verify attachment processing states**

The SDK must distinguish upload, message attachment, OCR/ASR pending, retry_wait, completed, failed, and provider_unconfigured.

- [ ] **Step 5: Verify and commit**

```bash
node --import tsx --test test/ivekit-attachment-client.test.ts test/collaboration-attachment-processing.test.ts
npm run build:ivekit-sdk
git commit -m "feat(chat): add attachment transfer client"
```

---

## Task 5: Build A Receive-Only Tinode Reconnect Adapter

**Files:**
- Create: `clients/ivekit-reference/src/chat/tinode-adapter.ts`
- Create: `clients/ivekit-reference/src/chat/tinode-adapter.test.ts`
- Create: `clients/ivekit-reference/src/chat/convergence.ts`
- Create: `clients/ivekit-reference/src/chat/convergence.test.ts`
- Create: `clients/ivekit-reference/src/chat/types.ts`

- [ ] **Step 1: Write failing adapter state-machine tests**

Cover connect/login/subscribe, duplicate connect coalescing, explicit disconnect during login, exponential reconnect with jitter injection, offline/online events, token refresh, stale-generation suppression, Tinode sequence notes, and disposal.

- [ ] **Step 2: Prove no publish capability**

The adapter interface exposes only connect, disconnect, receipt notes, typing notes, and callbacks. Static tests reject `publish`, `send`, or `createMessage` methods.

- [ ] **Step 3: Implement convergence**

On Tinode data, iveKit WebSocket event, reconnect, or visibility resume, fetch an `after` page from iveKit. Deduplicate by message id and order by `(created_at,id)`. A stale response must not overwrite a newer projection.

- [ ] **Step 4: Add bounded backoff**

Use injectable clock/random. Reset after a stable connection. Stop immediately on session close, participant revoke, auth 401/403, or explicit disposal.

- [ ] **Step 5: Verify and commit**

```bash
npm --prefix clients/ivekit-reference test
git commit -m "feat(client): add Tinode convergence"
```

---

## Task 6: Scaffold The Standalone Reference Application

**Files:**
- Create: `clients/ivekit-reference/package.json`
- Create: `clients/ivekit-reference/package-lock.json`
- Create: `clients/ivekit-reference/tsconfig.json`
- Create: `clients/ivekit-reference/vite.config.ts`
- Create: `clients/ivekit-reference/index.html`
- Create: `clients/ivekit-reference/src/main.tsx`
- Create: `clients/ivekit-reference/src/app.tsx`
- Create: `clients/ivekit-reference/src/runtime-config.ts`
- Create: `clients/ivekit-reference/src/styles.css`
- Create: `clients/ivekit-reference/public/ivekit-config.example.json`
- Create: `test/ivekit-reference-client-package.test.ts`

- [ ] **Step 1: Write failing independence tests**

Assert the client depends on `@opc/ivekit-sdk`, contains no `frontend/src`, `src/agent-runtime`, API key storage, call-center route, or direct Tinode publish import. Assert build/test scripts exist.

- [ ] **Step 2: Add runtime bootstrap**

Load public `baseUrl`, tenant, and optional WebSocket URL from runtime JSON. Obtain the short-lived user token through a host callback or session-only development bootstrap. Never compile secrets into Vite env.

- [ ] **Step 3: Build the work-focused shell**

Use a compact three-column layout: session list, message timeline/composer, participant/details rail. No marketing screen, nested cards, decorative gradients, or oversized headings. Use Lucide icons and tooltips for icon-only controls.

- [ ] **Step 4: Verify responsive constraints**

Desktop shows all panes. Tablet collapses details. Mobile uses session/timeline tabs with stable composer height and no overlap.

- [ ] **Step 5: Build and commit**

```bash
npm ci --prefix clients/ivekit-reference
npm --prefix clients/ivekit-reference run build
node --import tsx --test test/ivekit-reference-client-package.test.ts
git commit -m "feat(client): scaffold iveKit reference app"
```

---

## Task 7: Implement Session List, Timeline, Composer, And Realtime State

**Files:**
- Create: `clients/ivekit-reference/src/chat/chat-reducer.ts`
- Create: `clients/ivekit-reference/src/chat/chat-reducer.test.ts`
- Create: `clients/ivekit-reference/src/chat/use-chat-session.ts`
- Create: `clients/ivekit-reference/src/chat/session-list.tsx`
- Create: `clients/ivekit-reference/src/chat/message-timeline.tsx`
- Create: `clients/ivekit-reference/src/chat/message-composer.tsx`
- Create: `clients/ivekit-reference/src/chat/participant-rail.tsx`
- Modify: `clients/ivekit-reference/src/app.tsx`
- Modify: `clients/ivekit-reference/src/styles.css`

- [ ] **Step 1: Write reducer tests**

Cover initial load, prepend history without scroll jump, realtime dedupe, optimistic send, 202 retry state, 502 terminal state, unread/read-through, presence expiry, typing expiry, edit/delete, reactions, pins, session close, and stale request suppression.

- [ ] **Step 2: Implement session list**

Include search, unread badge, last-message summary, participant presence, closed state, cursor loading, keyboard navigation, and empty/error/loading states.

- [ ] **Step 3: Implement timeline**

Group consecutive messages, render date separators, reply/forward context, mentions, reactions, delivery/read state, edit/delete markers, attachment state, retry commands, and pinned-message navigation.

- [ ] **Step 4: Implement composer**

Support text, multiline, reply, forward, mentions, emoji reactions, file selection, drag/drop/paste, upload progress, cancel/retry, and a stable idempotency key per send attempt. Disable writes after leave/close.

- [ ] **Step 5: Connect receipts/presence/typing**

Use visibility and intersection state before marking read. Presence heartbeat is independent from Tinode. Typing is debounced and explicitly cleared on send/blur/dispose.

- [ ] **Step 6: Verify and commit**

```bash
npm --prefix clients/ivekit-reference test
npm --prefix clients/ivekit-reference run build
git commit -m "feat(client): implement IM workspace"
```

---

## Task 8: Implement Findings And Human Review

**Files:**
- Create: `clients/ivekit-reference/src/chat/finding-panel.tsx`
- Create: `clients/ivekit-reference/src/chat/finding-view-model.ts`
- Create: `clients/ivekit-reference/src/chat/finding-view-model.test.ts`
- Modify: `clients/ivekit-reference/src/chat/message-timeline.tsx`
- Modify: `clients/ivekit-reference/src/chat/participant-rail.tsx`

- [ ] **Step 1: Write finding projection tests**

Cover text/OCR/ASR/AI source labels, redacted evidence, pending provider state, severity ordering, review transitions, duplicate events, and reviewer authorization failures.

- [ ] **Step 2: Add message indicators**

Show restrained risk markers on affected messages. Never reveal hashed/redacted PII from storage as if it were original text.

- [ ] **Step 3: Add review workflow**

Allow authorized users to confirm, dismiss, or request follow-up with a reason. Display immutable review history and provider-unconfigured status honestly.

- [ ] **Step 4: Verify and commit**

```bash
npm --prefix clients/ivekit-reference test
npm --prefix clients/ivekit-reference run build
git commit -m "feat(client): add chat quality review"
```

---

## Task 9: End-To-End Browser And Deployment Evidence

**Files:**
- Create: `clients/ivekit-reference/e2e/chat.spec.ts`
- Create: `scripts/ivekit-im-client-acceptance.ts`
- Create: `test/ivekit-im-client-acceptance.test.ts`
- Modify: `package.json`
- Modify: `infra/ivekit/README.md`
- Modify: `docs/ivekit-led-integration-guide.md`

- [ ] **Step 1: Add deterministic browser E2E**

Run two browser identities against controlled HTTP/Tinode adapters. Cover send, receive, attachment progress, read receipt, typing, presence, edit/delete, reply, reaction, pin, finding review, offline/reconnect, and session close.

- [ ] **Step 2: Add real-environment acceptance script**

Generate a secret-safe checklist/artifact for two real browsers and real Tinode. Do not fabricate provider evidence when environment variables are absent.

- [ ] **Step 3: Verify desktop/mobile layout**

Capture desktop and mobile screenshots. Check no text overflow, pane overlap, composer shift, blank content, or hidden primary controls.

- [ ] **Step 4: Add commands**

```json
{
  "verify:ivekit:im-client": "npm --prefix clients/ivekit-reference test && npm --prefix clients/ivekit-reference run build && node --import tsx --test test/ivekit-im-client-acceptance.test.ts"
}
```

- [ ] **Step 5: Commit**

```bash
git commit -m "test(client): add IM acceptance flow"
```

---

## Task 10: Milestone Verification And Review

- [ ] **Step 1: Run every local gate**

```bash
npm run verify:ivekit:foundation
npm run verify:ivekit:im-client
npm run verify
npm --prefix frontend run build
npm run pack:ivekit-sdk
docker compose --env-file infra/ivekit/env.example -f infra/ivekit/docker-compose.yml config --quiet
```

- [ ] **Step 2: Inspect package and source boundaries**

Reject the milestone if the browser bundle contains API keys, imports OPC frontend helpers, exposes Tinode publish, or packages server code.

- [ ] **Step 3: Request independent review**

Review tenant/RLS, authenticated identity, cursor correctness, idempotency, attachment bounds, XSS/file rendering, token storage, reconnect races, event convergence, and session revocation.

- [ ] **Step 4: Resolve every Critical/Important finding with TDD**

Repeat all gates after the final fix.

- [ ] **Step 5: Update roadmap and write M3 plan**

Mark M2 complete only after local gates and available real Tinode/browser evidence pass. If real environment is deferred, label M2 code-complete but not environment-accepted and keep the overall Goal active.

---

## Completion Criteria

1. Standalone reference client builds independently and uses only the published iveKit SDK plus Tinode receive-only adapter.
2. Session list, cursor history/search, text/rich message actions, attachments, receipts, unread, presence, typing, edit/delete, reactions, pins, and findings are implemented.
3. Two browser projections converge after duplicate packets, out-of-order HTTP responses, disconnect, reconnect, and visibility resume.
4. Every business write is present in the PostgreSQL mirror and policy pipeline before Tinode delivery.
5. Session close/participant leave disables writes and revokes Tinode access.
6. No browser artifact contains API keys, provider secrets, or call-center dependencies.
7. Full repository, SDK, frontend, reference-client, Compose, and independent-review gates have zero unresolved failures.
