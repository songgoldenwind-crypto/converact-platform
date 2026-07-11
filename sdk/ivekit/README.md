# @opc/ivekit-sdk

TypeScript client for the reusable iveKit Media, IM, and RustDesk HTTP facades.

```bash
npm install @opc/ivekit-sdk
```

```typescript
import {
  createIveKitClient,
  type IveKitChatMessage,
  type IveKitChatSnapshot
} from '@opc/ivekit-sdk';

const ivekit = createIveKitClient({
  baseUrl: 'https://ivekit.example.com',
  tenantId: 'tenant-led',
  accessToken: '<short-lived-user-token>',
  userId: 'engineer-1'
});

const orderRef = { type: 'service_order', id: 'order-1001' };
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
const device = await ivekit.rustdesk.ensureDevice({
  businessRef: orderRef,
  rustdeskId: '123456789',
  deviceDisplayName: 'LED service terminal',
  actorIdentity: 'engineer-1'
});
```

The chat client exports browser-safe JSON DTOs for sessions, participants, messages,
attachments and processing jobs, provider delivery, receipts, realtime state,
mutations, policy findings and reviews, reactions, pins, and cursor pages. These
types are structural and do not import OPC server modules.

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

`ivekit.rustdesk.startSession()` adds consent-scoped launch planning, while the same client retains lower-level methods such as `startGatewaySession()` for advanced integrations. It also exposes typed operation-audit helpers for control actions, file transfer, screen recording, and clipboard synchronization.

Browser and desktop webview clients must use a short-lived `accessToken`. Backend integrations may use `apiKey` instead. Exactly one authentication mode is required, and an API key must never be embedded in a browser or desktop webview bundle.

The package also exports the lower-level `createIveKitHttpSdk()`, `createIveKitRustDeskHttpClient()`, and `createIveKitRustDeskLedSdk()` factories for integrations that need separate lifecycles.
