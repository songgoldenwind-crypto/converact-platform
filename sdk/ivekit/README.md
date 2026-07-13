# @opc/ivekit-sdk

TypeScript client for the reusable iveKit Media, IM, RustDesk, Voice, and IVR HTTP facades.

```bash
npm install @opc/ivekit-sdk
```

```typescript
import {
  createIveKitClient,
  type IveKitChatMessage,
  type IveKitChatSnapshot,
  type IveKitMediaCallSnapshot
} from '@opc/ivekit-sdk';

const ivekit = createIveKitClient({
  baseUrl: 'https://ivekit.example.com',
  tenantId: 'tenant-led',
  accessToken: '<short-lived-user-token>',
  userId: 'engineer-1'
});

const orderRef = { type: 'service_order', id: 'order-1001' };
const context = await ivekit.context.getByBusinessRef(orderRef);
const chat = await ivekit.chat.openSession({ business_ref: orderRef });
const snapshot: IveKitChatSnapshot = await ivekit.chat.getSnapshot(chat.id);
const posted = await ivekit.chat.postMessage(
  chat.id,
  { sender_identity: 'engineer-1', body: 'Connected to the LED terminal.' },
  { idempotencyKey: crypto.randomUUID() }
);
const message: IveKitChatMessage = posted.message;
// Closing revokes every active provider participant before persisting closed state.
await ivekit.chat.closeSession(chat.id);
const room = await ivekit.media.createRoom({
  purpose: 'video_service',
  business_ref: orderRef
});
const call: IveKitMediaCallSnapshot = await ivekit.media.createCall({
  media: 'video',
  participant_identities: ['customer-1001'],
  business_ref: orderRef
});
const device = await ivekit.rustdesk.ensureDevice({
  businessRef: orderRef,
  rustdeskId: '123456789',
  deviceDisplayName: 'LED service terminal',
  actorIdentity: 'engineer-1'
});
const distribution = await ivekit.rustdesk.getClientProfile({
  platform: 'windows',
  architecture: 'x86_64',
  client_version: '1.4.7',
  expected_server_version: '1.1.15',
  expected_server_key_fingerprint: '<fingerprint-from-trusted-deployment-record>'
});

const outbound = await ivekit.voice.createOutboundCall({
  profile_id: 'rustpbx-primary',
  from: { kind: 'extension', value: '1001' },
  to: { kind: 'e164', value: '+8613800138000' },
  business_ref: orderRef,
  metadata: { source: 'led-webphone' }
}, { idempotencyKey: crypto.randomUUID() });
await ivekit.voice.enqueueCallAction(outbound.call.id, {
  action: 'dtmf',
  payload: { digits: '123#' }
}, { idempotencyKey: crypto.randomUUID() });

const prompt = await ivekit.ivr.createAudioAsset({
  name: 'LED support welcome',
  source_kind: 'tts',
  tts_text: 'Welcome to LED support.',
  tts_profile_id: 'tts-main'
});
const settings = await ivekit.ivr.getSettings();
await ivekit.ivr.updateSettings({
  expected_revision: settings.revision,
  max_steps: 700,
  allowed_webhook_refs: ['service-order-status']
});
```

The Voice client covers deployment profiles and capability preflight, SIP trunks,
DIDs, extensions and browser-session plans, versioned routes, outbound calls,
call control, provider event projections, participants, recordings, consent and
retention policy, plus PSTN-to-LiveKit bridge commands. It returns cursor pages for
all durable collections and exposes only redacted `from`, `to`, and DID addresses.
Provider webhook endpoints are intentionally server-only and are not SDK methods.

Every provider-changing Voice operation requires a stable idempotency key. Reuse the
same key and identical payload after an ambiguous timeout or 5xx. A new intent must
use a new key. Browser WebPhones must use a short-lived bearer token and must first
check `voice.getCapabilities().capabilities.extension_sessions`; the returned plan is
adapter-defined and never contains iveKit API keys or server-side provider secrets.

The IVR client exposes revisioned flows, immutable publish/rollback versions,
deterministic simulations, durable sessions, audio assets, time/region/ring groups,
and tenant execution settings. Published flow dependencies are validated against
active resources and provider capabilities. Runtime fields of a resource referenced
by any published version cannot be changed in place; create a new resource ID and
publish a new flow version instead.

The chat client exports browser-safe JSON DTOs for sessions, participants, messages,
attachments and processing jobs, provider delivery, receipts, realtime state,
mutations, policy findings and reviews, reactions, pins, and cursor pages. These
types are structural and do not import OPC server modules.

The context client returns a metadata-safe business projection for unified navigation.
Bearer callers see only chat/media resources they participate in; remote sessions and
device summaries additionally require visible chat membership. The projection never
returns provider credentials, launch links, RustDesk IDs, tokens, or business metadata.
Its read-only `authorization` projection includes participant roles/statuses, active
remote consent scopes, gateway permissions, and current control ownership. Clients
must still issue writes through the owning Chat, Media, or RustDesk command API.
Use `context.listTimeline(orderRef, { limit, cursor })` for the redacted cross-domain
activity/evidence index. Its cursor is opaque and business-ref scoped; timeline items
never contain message bodies, provider metadata, storage URLs, or captured content.

The event client provides durable reconnect convergence without provider credentials:

```typescript
const cursor = await ivekit.events.getHeadCursor();
const replay = await ivekit.events.replay({ cursor, limit: 100, max_pages: 20 });
if (replay.snapshot_required) {
  // Refresh Chat, Media, and Remote snapshots, then request a new head cursor.
} else {
  // Apply events once by event_id and retain replay.next_cursor in runtime memory.
}
```

Event cursors are opaque, tenant-bound, signed, and retention-limited. A 409 snapshot
fallback is returned as a typed page instead of an exception. The SDK never exposes
the cursor signing secret, provider credentials, or unrestricted tenant events.

The media client exports typed capabilities, durable call snapshots and actions,
rooms, join plans, provider participants, host moderation, recordings, object
inspection, retention cleanup, and cursor/list results. Existing room APIs remain
available while products migrate to the durable call lifecycle.

Call transitions and host moderation are idempotent commands. Pass a stable
`{ idempotencyKey }` option to `transitionCall()`, `muteParticipant()`, and
`removeParticipant()`; retry an ambiguous timeout or 5xx with the same key and
payload.
Backend recovery jobs can call `media.recoverModerationCommands({ limit })` with
API-key system credentials; browser JWTs are not authorized for this operation.

`chat.listSessions()` returns viewer-specific `summary` data for unread count,
online participant count, and the latest-message preview. `chat.closeSession()`
closes the session only after provider access has been revoked.

Chat writes always go through the iveKit HTTP facade. A Tinode client may subscribe
for receive-only acceleration, but it must converge messages from iveKit HTTP and
must not publish directly.

For browser file transfers use `chat.uploadAttachmentWithProgress()`. It returns
`{result, abort}` and reports monotonic byte progress without base64 conversion.
After the descriptor is attached to a message, use `chat.downloadAttachment()` for
an authenticated binary response; object-store credentials and internal media paths
are never returned to the client.

`ivekit.rustdesk.startSession()` adds consent-scoped launch planning, while the same client retains lower-level methods such as `startGatewaySession()` for advanced integrations. Control-enabled clients use `issueControlConfirmation()`, `acquireControl()`, `heartbeatControl()`, `transferControl()`, and `releaseControl()`. Before a keyboard/mouse, file, or clipboard action, call `confirmOperation()` and place its returned `id` in audit metadata as `operation_grant_id` together with the current `control_version`. The grant is short-lived and can be linked to only one audit event.

Native integrations use `recordOperationObservation()` for view, control, multi-display, file, clipboard, recording, and disconnect evidence. Missing telemetry is sent as `not_observed`; observed success/failure requires a timestamp and SHA-256-bound evidence reference. The SDK sends metadata and hashes only, never screen pixels, keystrokes, clipboard/file contents, recording bytes, passwords, or tokens. Sensitive control/file/clipboard observations must carry the current `controlVersion` and actor identity.

`getClientProfile()` returns a separately typed, pinned desktop distribution profile. Both expected server pins are mandatory. The SDK validates the requested platform/architecture, exact client and server versions, canonical 32-byte RustDesk public key, a Web Crypto-derived server-key fingerprint, canonical timestamps, expiry, a 60-second to one-hour lifetime, and exact release/platform/architecture installer identity. Official filenames use `rustdesk-1.4.7-<architecture>.<platform-extension>` without a platform token. Installer filenames are bounded canonical ASCII and URL basenames may not use whitespace, controls, Unicode, or percent escapes. A missing deployment artifact is returned as `install_source.state = 'not_configured'`; the SDK never downloads or executes it. Unattended access additionally requires an active access policy, active consent, and a fresh `unattended_launch` confirmation before `getGatewayLaunchPlan()` returns a usable plan.

Browser and desktop webview clients must use a short-lived `accessToken`. Backend integrations may use `apiKey` instead. Exactly one authentication mode is required, and an API key must never be embedded in a browser or desktop webview bundle.

The package also exports the lower-level `createIveKitHttpSdk()`, `createIveKitRustDeskHttpClient()`, and `createIveKitRustDeskLedSdk()` factories for integrations that need separate lifecycles.
