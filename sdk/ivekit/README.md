# @opc/ivekit-sdk

TypeScript client for the reusable iveKit Media, IM, and RustDesk HTTP facades.

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
```

The chat client exports browser-safe JSON DTOs for sessions, participants, messages,
attachments and processing jobs, provider delivery, receipts, realtime state,
mutations, policy findings and reviews, reactions, pins, and cursor pages. These
types are structural and do not import OPC server modules.

The context client returns a metadata-safe business projection for unified navigation.
Bearer callers see only chat/media resources they participate in; remote sessions and
device summaries additionally require visible chat membership. The projection never
returns provider credentials, launch links, RustDesk IDs, tokens, or business metadata.

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
