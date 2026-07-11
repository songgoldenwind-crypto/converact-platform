# iveKit LiveKit Reference Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a standalone LiveKit audio/video reference client and durable iveKit call contract that LED and other products can reuse without importing OPC call-center code.

**Architecture:** PostgreSQL and `/api/ivekit/media/*` remain authoritative for call lifecycle, participant authorization, moderation, recording, evidence, and audit. The browser uses the official `livekit-client` package behind a narrow adapter for media tracks and realtime provider events; those events reconcile into the HTTP projection but never become an alternate business store. The existing `clients/ivekit-reference` application gains a Media workspace beside IM and continues to depend only on `@opc/ivekit-sdk`, `livekit-client`, and browser-safe UI libraries.

**Tech Stack:** TypeScript, PostgreSQL with FORCE RLS, React 19, Vite, official `livekit-client`, `@opc/ivekit-sdk`, Node test runner, Testing Library, Playwright, existing LiveKit server SDK and iveKit evidence tooling.

**Approved scope:** WebRTC voice/video, call lifecycle, prejoin/device control, multi-party layouts, screen share with optional system audio, host moderation, network/reconnect handling, recording/evidence, deterministic local E2E, and deferred real-environment evidence. SIP/VoLTE, RTMP/HLS, digital humans, virtual backgrounds, transcription providers, and server deployment are excluded from M3.

---

## Stable Rules

1. Browsers authenticate to iveKit with a short-lived bearer token and receive only a short-lived participant-scoped LiveKit token. Neither token may be persisted in localStorage, sessionStorage, IndexedDB, source, logs, screenshots, or build output.
2. Every lifecycle, invitation, moderation, recording, and evidence write goes through `/api/ivekit/media/*`. Browser code never receives the LiveKit API secret or calls the server admin SDK.
3. JWT `sub` is authoritative in user mode. Only authenticated service mode may name another identity, and every on-behalf-of action is audited.
4. Call, room, participant, and recording rows are tenant-scoped and FORCE RLS. A room name, call id, recording id, or business reference from another tenant returns 404.
5. LiveKit callbacks update the local projection only when `(tenant_id, room_name, identity)` matches a durable call participant. Duplicate and out-of-order webhooks are idempotent.
6. Closing a call or removing a participant revokes provider access before the durable state is marked terminal. The client disconnects and disables controls immediately on a terminal iveKit event.
7. Browsers cannot force another participant to unmute. Hosts may mute published tracks, remove participants, or close the call through iveKit.
8. Controlled browser E2E proves client logic only. Real camera/microphone, ICE/TURN, Egress/MinIO, and two real browsers remain `not_run` until the existing evidence bundle is completed.

## Public State Contract

```typescript
export type IveKitMediaCallStatus =
  | 'created'
  | 'ringing'
  | 'accepted'
  | 'active'
  | 'rejected'
  | 'cancelled'
  | 'timed_out'
  | 'ended'
  | 'failed';

export type IveKitMediaParticipantStatus =
  | 'invited'
  | 'ringing'
  | 'accepted'
  | 'joined'
  | 'declined'
  | 'left'
  | 'missed'
  | 'removed';

export type IveKitMediaCallRole = 'host' | 'participant' | 'observer';

export interface MediaCallProjection {
  call: IveKitMediaCall;
  participants: IveKitMediaCallParticipant[];
  tracks: MediaTrackProjection[];
  recordings: IveKitMediaRecording[];
  connection: 'idle' | 'preparing' | 'connecting' | 'online' | 'reconnecting' | 'offline' | 'ended' | 'fatal';
  layout: 'grid' | 'speaker' | 'screen_share';
  local: { microphone: boolean; camera: boolean; screen: boolean; screenAudio: boolean };
}
```

The reducer is deterministic. React components render the projection and issue commands; they do not merge LiveKit packets directly.

---

## Task 1: Publish Typed Media SDK Contracts

**Files:**
- Create: `sdk/ivekit/src/media-types.ts`
- Modify: `sdk/ivekit/src/types.ts`
- Modify: `sdk/ivekit/src/http-sdk.ts`
- Modify: `sdk/ivekit/src/index.ts`
- Modify: `sdk/ivekit/README.md`
- Modify: `test/ivekit-http-sdk.test.ts`
- Modify: `test/ivekit-sdk-package.test.ts`

- [x] **Step 1: Write failing type and request-shape tests**

Assert named DTO exports for capabilities, business refs, calls, call participants, rooms, join plans, provider participants, moderation results, recordings, object inspection, and cursor/list results. Assert no Media method returns `Record<string, unknown>`.

- [x] **Step 2: Verify RED**

```bash
node --import tsx --test test/ivekit-http-sdk.test.ts test/ivekit-sdk-package.test.ts
```

Expected: missing `media-types.ts` exports and typed call methods.

- [x] **Step 3: Add browser-safe JSON DTOs**

Define the status unions above plus:

```typescript
export interface IveKitMediaCall {
  id: string;
  tenant_id: string;
  room_name: string;
  media: 'voice' | 'video';
  status: IveKitMediaCallStatus;
  initiated_by: string;
  business_ref: IveKitSdkBusinessRef;
  ring_expires_at: string | null;
  accepted_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  end_reason: string;
  created_at: string;
  updated_at: string;
}
```

Keep all types structural, JSON-only, and independent from server source.
Move the existing `IveKitSdkBusinessRef` interface to the SDK's shared `types.ts` module and re-export it from the old entrypoint so current consumers do not break.

- [x] **Step 4: Add typed methods without removing existing room methods**

```typescript
createCall(input: IveKitCreateMediaCallInput): Promise<IveKitMediaCallSnapshot>;
getCall(callId: string): Promise<IveKitMediaCallSnapshot>;
transitionCall(callId: string, action: IveKitMediaCallActionInput, options?: { idempotencyKey?: string }): Promise<IveKitMediaCallSnapshot>;
createCallJoinPlan(callId: string, input: IveKitMediaJoinInput): Promise<IveKitMediaJoinPlan>;
muteParticipant(roomName: string, identity: string, input: IveKitMediaMuteInput): Promise<IveKitMediaModerationResult>;
removeParticipant(roomName: string, identity: string, input?: { reason?: string }): Promise<IveKitMediaModerationResult>;
```

- [x] **Step 5: Verify and commit**

```bash
npm run build:ivekit-sdk
npm run pack:ivekit-sdk
node --import tsx --test test/ivekit-http-sdk.test.ts test/ivekit-sdk-package.test.ts
git commit -m "feat(sdk): type iveKit media contract"
```

---

## Task 2: Add Durable Generic Call Lifecycle

**Files:**
- Create: `src/migrations/034_ivekit_media_calls.sql`
- Create: `src/agent-runtime/livekit/media-call-store.ts`
- Create: `src/agent-runtime/livekit/media-call-service.ts`
- Modify: `src/agent-runtime/livekit/types.ts`
- Modify: `src/agent-runtime/ivekit/media-http.ts`
- Create: `test/ivekit-media-call-lifecycle.test.ts`
- Modify: `test/db-rls-integration.test.ts`
- Modify: `docs/ivekit-openapi.md`

- [x] **Step 1: Write failing lifecycle, idempotency, and RLS tests**

Cover allowed transitions, duplicate actions, competing accept/reject, ring timeout to missed, end-after-accept, terminal-state immutability, same-tenant business refs, cross-tenant 404, authenticated caller identity, and FORCE RLS for calls/participants/action audit.

- [x] **Step 2: Add tenant-scoped schema**

Create `ivekit_media_calls`, `ivekit_media_call_participants`, and `ivekit_media_call_actions`. Use unique `(tenant_id, idempotency_key)` for commands and unique `(tenant_id, call_id, identity)` for participants. Add indexes on business ref, room, status/expiry, and participant identity; enable and force RLS on all three tables.

- [x] **Step 3: Implement one transition table**

```typescript
const ALLOWED_MEDIA_CALL_ACTIONS = {
  created: ['ring', 'cancel', 'fail'],
  ringing: ['accept', 'reject', 'cancel', 'timeout', 'fail'],
  accepted: ['activate', 'end', 'fail'],
  active: ['end', 'fail'],
  rejected: [], cancelled: [], timed_out: [], ended: [], failed: []
} as const;
```

Run each transition in one PostgreSQL transaction with row locking. A repeated idempotency key returns the original snapshot.

- [x] **Step 4: Expose stable endpoints and events**

```text
POST /api/ivekit/media/calls
GET  /api/ivekit/media/calls/:id
POST /api/ivekit/media/calls/:id/actions
POST /api/ivekit/media/calls/:id/join
GET  /api/ivekit/media/calls/:id/participants
```

Emit `ivekit.media.call.created`, `call.updated`, `participant.updated`, and `call.ended` with ids/status only; do not include tokens or copied metadata bodies.

- [x] **Step 5: Verify and commit**

```bash
node --import tsx --test test/ivekit-media-call-lifecycle.test.ts test/db-rls-integration.test.ts
npm run typecheck
git commit -m "feat(media): add durable call lifecycle"
```

---

## Task 3: Enforce Join Identity And Host Moderation

**Files:**
- Create: `src/agent-runtime/livekit/livekit-moderation-service.ts`
- Modify: `src/agent-runtime/livekit/token-service.ts`
- Modify: `src/agent-runtime/livekit/index.ts`
- Modify: `src/agent-runtime/ivekit/media-http.ts`
- Modify: `sdk/ivekit/src/http-sdk.ts`
- Create: `test/ivekit-media-moderation.test.ts`
- Modify: `docs/ivekit-openapi.md`

- [ ] **Step 1: Write failing authorization tests**

Prove JWT users cannot request a join plan for another identity, participants cannot moderate, hosts can mute only audio/video publications inside their tenant call, observers receive subscribe-only grants, remove is idempotent, close revokes all provider participants first, and server/service mode writes an explicit actor audit.

- [ ] **Step 2: Add provider moderation adapter**

Wrap the existing LiveKit server SDK behind:

```typescript
interface LiveKitModerationProvider {
  mutePublishedTrack(roomName: string, identity: string, trackSid: string, muted: boolean): Promise<void>;
  removeParticipant(roomName: string, identity: string): Promise<void>;
  closeRoom(roomName: string): Promise<void>;
}
```

Validate tenant/call/participant state before any provider call and persist audit only after a confirmed provider result.

- [ ] **Step 3: Add moderation endpoints**

```text
POST /api/ivekit/media/rooms/:room/participants/:identity/mute
POST /api/ivekit/media/rooms/:room/participants/:identity/remove
```

Require `track_sid`, `source=camera|microphone|screen_share|screen_share_audio`, and `muted=true`. Remote unmute is intentionally absent because browsers must consent to resume capture; a participant unmutes through its own local track control.

- [ ] **Step 4: Revoke on terminal state**

Call provider remove/close before committing `removed`, `ended`, `cancelled`, or `rejected`. If provider revocation fails, return retryable 502 and keep the durable state non-terminal.

- [ ] **Step 5: Verify and commit**

```bash
node --import tsx --test test/ivekit-media-moderation.test.ts test/ivekit-media-facade.test.ts
npm run typecheck
git commit -m "feat(media): enforce host moderation"
```

---

## Task 4: Build The Official LiveKit Client Adapter

**Files:**
- Modify: `clients/ivekit-reference/package.json`
- Modify: `clients/ivekit-reference/package-lock.json`
- Create: `clients/ivekit-reference/src/media/livekit-adapter.ts`
- Create: `clients/ivekit-reference/src/media/livekit-adapter.test.ts`
- Create: `clients/ivekit-reference/src/media/types.ts`

- [ ] **Step 1: Add `livekit-client@^2.19.2` and failing state-machine tests**

Use an injected fake Room to cover connect coalescing, disconnect during token fetch, stale-generation suppression, track subscribe/unsubscribe, active-speaker order, network quality, reconnect/reconnected, fatal disconnect, autoplay failure, and disposal.

- [ ] **Step 2: Define a narrow adapter surface**

```typescript
interface LiveKitRoomAdapter {
  connect(plan: IveKitMediaJoinPlan): Promise<void>;
  disconnect(): Promise<void>;
  setMicrophone(enabled: boolean): Promise<void>;
  setCamera(enabled: boolean): Promise<void>;
  setScreenShare(enabled: boolean, options?: { audio?: boolean }): Promise<void>;
  switchDevice(kind: 'audioinput' | 'videoinput' | 'audiooutput', deviceId: string): Promise<void>;
  startAudio(): Promise<void>;
}
```

Do not expose the Room instance, publish arbitrary data, or accept server credentials.

- [ ] **Step 3: Normalize LiveKit events**

Map official Room/Participant/Track events into immutable `MediaAdapterEvent` objects. Store `MediaStreamTrack`/track handles only inside the adapter; React receives stable ids and explicit attach/detach callbacks.

- [ ] **Step 4: Add bounded reconnect generations**

LiveKit SDK owns transport retry. The adapter owns UI generation: a token/call change disconnects the old Room, and callbacks from old Rooms cannot update the new projection.

- [ ] **Step 5: Verify and commit**

```bash
npm --prefix clients/ivekit-reference test
npm --prefix clients/ivekit-reference run build
git commit -m "feat(client): add LiveKit room adapter"
```

---

## Task 5: Implement Prejoin And Device Management

**Files:**
- Create: `clients/ivekit-reference/src/media/device-controller.ts`
- Create: `clients/ivekit-reference/src/media/device-controller.test.ts`
- Create: `clients/ivekit-reference/src/media/prejoin-panel.tsx`
- Create: `clients/ivekit-reference/src/media/prejoin-panel.test.tsx`
- Modify: `clients/ivekit-reference/src/styles.css`

- [ ] **Step 1: Write failing permission/device tests**

Cover permission prompt, no-device state, permission denied, device unplug, remembered selection during one browser session, camera preview cleanup, microphone level sampling cleanup, and unsupported output selection.

- [ ] **Step 2: Implement browser device controller**

Use `navigator.mediaDevices.getUserMedia`, `enumerateDevices`, `devicechange`, `MediaStreamTrack.stop`, and feature-detected `HTMLMediaElement.setSinkId`. Never persist labels or device ids outside component memory.

- [ ] **Step 3: Build the prejoin panel**

Show real preview, microphone meter, camera/microphone toggles, three device selectors, voice/video mode, and Join/Accept command. Permission errors must remain visible and must not claim the user joined.

- [ ] **Step 4: Verify responsive layout**

Use stable preview aspect ratio and fixed control dimensions at 1440x900, 1024x768, and 390x844. Long device names truncate with accessible titles and do not resize controls.

- [ ] **Step 5: Verify and commit**

```bash
npm --prefix clients/ivekit-reference test
npm --prefix clients/ivekit-reference run build
git commit -m "feat(client): add media prejoin"
```

---

## Task 6: Add Call Workflow And Deterministic Reducer

**Files:**
- Create: `clients/ivekit-reference/src/media/media-reducer.ts`
- Create: `clients/ivekit-reference/src/media/media-reducer.test.ts`
- Create: `clients/ivekit-reference/src/media/use-media-call.ts`
- Create: `clients/ivekit-reference/src/media/call-header.tsx`
- Create: `clients/ivekit-reference/src/media/media-toolbar.tsx`
- Modify: `clients/ivekit-reference/src/app.tsx`

- [ ] **Step 1: Write failing reducer and hook tests**

Cover outgoing ring/cancel/timeout, incoming accept/reject/missed, accepted-to-active after provider join, idempotent end, stale HTTP/event suppression, call switch, terminal revoke, media command pending/error states, and retry with the original idempotency key.

- [ ] **Step 2: Implement reducer actions**

```typescript
type MediaAction =
  | { type: 'snapshot_loaded'; requestId: number; snapshot: IveKitMediaCallSnapshot }
  | { type: 'call_updated'; requestId: number; call: IveKitMediaCall }
  | { type: 'adapter_event'; generation: number; event: MediaAdapterEvent }
  | { type: 'command_started'; command: string }
  | { type: 'command_failed'; command: string; error: string }
  | { type: 'revoked'; reason: string };
```

Reject stale request ids and adapter generations before mutation.

- [ ] **Step 3: Implement lifecycle commands through SDK**

Every action uses `transitionCall()` with a stable idempotency key. Connect to LiveKit only after iveKit returns an accepted join plan. On reject/cancel/end/revoke, dispose the adapter before clearing UI media.

- [ ] **Step 4: Build call header and toolbar**

Use icon controls with tooltips for microphone, camera, share, layout, devices, recording, and hangup. Disable controls while pending or terminal; show elapsed time only after `active`.

- [ ] **Step 5: Verify and commit**

```bash
npm --prefix clients/ivekit-reference test
npm --prefix clients/ivekit-reference run build
git commit -m "feat(client): implement media call workflow"
```

---

## Task 7: Render Participants, Active Speaker, And Screen Share

**Files:**
- Create: `clients/ivekit-reference/src/media/participant-grid.tsx`
- Create: `clients/ivekit-reference/src/media/participant-grid.test.tsx`
- Create: `clients/ivekit-reference/src/media/media-tile.tsx`
- Create: `clients/ivekit-reference/src/media/screen-share-stage.tsx`
- Modify: `clients/ivekit-reference/src/styles.css`

- [ ] **Step 1: Write failing projection/layout tests**

Cover 1-9 participants, camera-off avatar, speaking indicator, muted state, dominant speaker ordering, screen share as a separate track, screen-share audio state, track detach, participant leave, and duplicate subscription packets.

- [ ] **Step 2: Build stable track projection**

Key tiles by participant identity plus track source, never array index. A screen share track moves to the main stage while participant camera stays visible in the rail.

- [ ] **Step 3: Add three layouts**

Grid uses bounded CSS tracks; speaker mode uses one focus stage plus participant rail; screen-share mode gives content priority and preserves a visible strip of participants. Mobile shows one main stage and a horizontal rail without overlap.

- [ ] **Step 4: Implement screen share commands**

Call `setScreenShare(true, {audio})`, handle browser cancellation without erroring the call, listen for the browser's track-ended event, and always reconcile the toolbar to actual publication state.

- [ ] **Step 5: Verify and commit**

```bash
npm --prefix clients/ivekit-reference test
npm --prefix clients/ivekit-reference run build
git commit -m "feat(client): render media participants"
```

---

## Task 8: Add Host Controls, Network Health, And Recovery

**Files:**
- Create: `clients/ivekit-reference/src/media/host-controls.tsx`
- Create: `clients/ivekit-reference/src/media/host-controls.test.tsx`
- Create: `clients/ivekit-reference/src/media/network-status.tsx`
- Create: `clients/ivekit-reference/src/media/network-status.test.tsx`
- Modify: `clients/ivekit-reference/src/media/use-media-call.ts`

- [ ] **Step 1: Write failing role and recovery tests**

Cover participant-hidden host controls, host mute/remove/close confirmation, provider 403/502, reconnect banner, reconnect success, terminal disconnect, offline/online changes, device removal fallback, audio autoplay unblock, and session revoke during reconnect.

- [ ] **Step 2: Implement host commands through iveKit**

Never call LiveKit admin methods in the browser. After a successful mute/remove response, wait for provider/iveKit convergence; show a retryable error if confirmation does not arrive.

- [ ] **Step 3: Project network quality**

Normalize LiveKit quality to `excellent|good|poor|lost|unknown`, show per-participant indicators without exposing raw provider diagnostics, and store no IP/ICE candidate data in logs or audit metadata.

- [ ] **Step 4: Make recovery generation-safe**

On call/token change or terminal event, invalidate all in-flight join/moderation requests, disconnect the old Room, stop local preview tracks, and ignore old callbacks. A stale 401/403 cannot mark a new call fatal.

- [ ] **Step 5: Verify and commit**

```bash
npm --prefix clients/ivekit-reference test
npm --prefix clients/ivekit-reference run build
git commit -m "feat(client): add media recovery controls"
```

---

## Task 9: Add Recording And Evidence Workspace

**Files:**
- Modify: `sdk/ivekit/src/media-types.ts`
- Modify: `sdk/ivekit/src/http-sdk.ts`
- Modify: `src/agent-runtime/ivekit/media-http.ts`
- Create: `clients/ivekit-reference/src/media/recording-panel.tsx`
- Create: `clients/ivekit-reference/src/media/recording-panel.test.tsx`
- Create: `test/ivekit-media-recording-list.test.ts`
- Modify: `docs/ivekit-openapi.md`

- [ ] **Step 1: Write failing recording filters and UI tests**

Cover call/business-ref filtering, host-only start/stop, duplicate start, stopping by recording id and egress id, pending/active/completed/failed/deleted states, object availability, authenticated export, filename/content type, evidence id, and retention metadata.

- [ ] **Step 2: Add typed list filters**

Extend `listRecordings()` with `call_id`, `room_name`, `business_ref_type`, `business_ref_id`, `status`, cursor, and bounded limit. Preserve the old unfiltered call.

- [ ] **Step 3: Build recording panel**

Show recording state and elapsed duration, object inspection, evidence reference, retention deadline, play when the browser supports the returned content type, and explicit authenticated export. Do not embed storage credentials or raw S3 URLs.

- [ ] **Step 4: Reconcile webhook updates**

iveKit recording events invalidate the list. Poll only while a recording is pending/active and stop on completion, terminal call, unmount, or authorization failure.

- [ ] **Step 5: Verify and commit**

```bash
node --import tsx --test test/ivekit-media-recording-list.test.ts test/livekit-recording-retention-export.test.ts
npm --prefix clients/ivekit-reference test
npm run typecheck
git commit -m "feat(client): add recording evidence view"
```

---

## Task 10: Add Deterministic Browser E2E And Real Evidence Binding

**Files:**
- Create: `clients/ivekit-reference/e2e/media.spec.ts`
- Create: `clients/ivekit-reference/e2e/controlled-media-server.ts`
- Modify: `clients/ivekit-reference/playwright.config.ts`
- Modify: `scripts/livekit-client-acceptance.ts`
- Modify: `test/livekit-client-acceptance.test.ts`
- Modify: `package.json`
- Modify: `infra/ivekit/README.md`

- [ ] **Step 1: Build a controlled two-browser media adapter**

Run caller and callee in isolated contexts. The controlled iveKit server persists call state; an injected LiveKit Room factory emits tracks, speakers, reconnect, device changes, network quality, screen share, moderation, and terminal disconnect without claiming real WebRTC evidence.

- [ ] **Step 2: Cover the complete local workflow**

Test outgoing ring/accept/active/end; reject/cancel/timeout; mic/camera/device switching; grid/speaker/share layouts; host mute/remove; offline/reconnect; recording state/evidence; revoke; and zero token persistence.

- [ ] **Step 3: Capture desktop/mobile layout evidence**

Assert nonblank video stages, no horizontal overflow, no toolbar shift, stable tile dimensions, screen share priority, visible hangup, and mobile participant rail at 1440x900 and 390x844.

- [ ] **Step 4: Bind existing real-environment tooling**

Extend the existing LiveKit client report only with reference-client-specific check ids. Keep `source=real_environment`, unique structured observations, SHA-256 binding, distinct operator/QA attestation, and `not_run` when no report is supplied. Controlled E2E output cannot satisfy real ICE, TURN, camera, microphone, Egress, or recording checks.

- [ ] **Step 5: Verify and commit**

```bash
npm --prefix clients/ivekit-reference test
npm --prefix clients/ivekit-reference run test:e2e
node --import tsx --test test/livekit-client-acceptance.test.ts
git commit -m "test(client): add media acceptance flow"
```

---

## Task 11: M3 Milestone Verification And Review

- [ ] **Step 1: Run all local gates**

```bash
npm run verify:ivekit:foundation
npm run verify:ivekit:im-client
npm --prefix clients/ivekit-reference run test:e2e
npm run verify
npm --prefix frontend run build
npm run pack:ivekit-sdk
docker compose --env-file infra/ivekit/env.example -f infra/ivekit/docker-compose.yml config --quiet
git diff --check
```

- [ ] **Step 2: Inspect browser and package boundaries**

Reject M3 if the bundle contains service credentials, persists participant tokens, imports OPC frontend/server modules, exposes LiveKit Room/admin objects outside the adapter, or packages server source in the SDK.

- [ ] **Step 3: Request independent review**

Review tenant/RLS, JWT identity, lifecycle transition races, idempotency, provider revoke ordering, moderation roles, token lifetime/storage, media track cleanup, autoplay/permission handling, reconnect generations, XSS in participant labels, recording authorization, object export, and evidence honesty.

- [ ] **Step 4: Resolve every Critical/Important finding with TDD**

Repeat the complete local gates after the final fix. Mark real client evidence `not_run` because this plan does not upload or deploy to a server.

- [ ] **Step 5: Update roadmap and write M4 plan**

Mark M3 local code complete only after all local gates and independent review pass. Keep the overall Goal active until real LiveKit/TURN/Egress evidence and M4/M5 are complete.

---

## Completion Criteria

1. The published SDK has typed Media methods and no server-source dependency.
2. Calls have a durable tenant-scoped lifecycle, idempotent actions, participant state, and immutable action audit.
3. Two reference-client identities complete call, media, screen share, moderation, reconnect, recording, and end/revoke workflows.
4. Camera, microphone, output device, autoplay, permission denial, and device removal states are explicit and recoverable.
5. LiveKit provider events cannot overwrite newer HTTP/call state or revive a terminal call.
6. Host operations are authorized server-side; browsers never receive admin credentials and cannot force remote unmute.
7. Recordings and evidence are tenant-scoped, inspectable, exportable through authenticated iveKit routes, and free of storage credentials.
8. Desktop/mobile layouts have no overlap, blank stage, hidden primary control, or dynamic tile shift.
9. Full repository, SDK, frontend, Compose, E2E, and independent-review gates have zero unresolved failures.
10. Real LiveKit, ICE/TURN, camera/microphone, Egress/MinIO, and two-browser evidence remain explicitly `not_run` until executed on the server.
