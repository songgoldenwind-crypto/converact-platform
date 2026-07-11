# @opc/ivekit-sdk

TypeScript client for the reusable iveKit Media, IM, and RustDesk HTTP facades.

```bash
npm install @opc/ivekit-sdk
```

```typescript
import { createIveKitClient } from '@opc/ivekit-sdk';

const ivekit = createIveKitClient({
  baseUrl: 'https://ivekit.example.com',
  tenantId: 'tenant-led',
  accessToken: '<short-lived-user-token>',
  userId: 'engineer-1'
});

const orderRef = { type: 'service_order', id: 'order-1001' };
const chat = await ivekit.chat.openSession({ business_ref: orderRef });
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

`ivekit.rustdesk.startSession()` adds consent-scoped launch planning, while the same client retains lower-level methods such as `startGatewaySession()` for advanced integrations. It also exposes typed operation-audit helpers for control actions, file transfer, screen recording, and clipboard synchronization.

Browser and desktop webview clients must use a short-lived `accessToken`. Backend integrations may use `apiKey` instead. Exactly one authentication mode is required, and an API key must never be embedded in a browser or desktop webview bundle.

The package also exports the lower-level `createIveKitHttpSdk()`, `createIveKitRustDeskHttpClient()`, and `createIveKitRustDeskLedSdk()` factories for integrations that need separate lifecycles.
