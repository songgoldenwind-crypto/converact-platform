# @opc/ivekit-sdk

TypeScript client for the reusable iveKit Media, IM, RustDesk, Voice, IVR, and Contact Center HTTP facades.

```bash
npm install @opc/ivekit-sdk
```

```typescript
import {
  createIveKitClient,
  createIveKitVoiceController,
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

const webPhone = createIveKitVoiceController({ client: ivekit.voice });
webPhone.subscribe((state) => renderWebPhone(state));
await webPhone.selectCall(outbound.call.id);
await webPhone.hold();
await webPhone.resume();

const extensionPlan = await ivekit.voice.createExtensionSession('extension-1001', {
  idempotencyKey: crypto.randomUUID()
});
const { createIveKitSipWebPhone } = await import('@opc/ivekit-sdk/sip-webphone');
const sipPhone = createIveKitSipWebPhone({ plan: extensionPlan });
sipPhone.attachRemoteAudio(document.querySelector('#remote-audio')!);
await sipPhone.connect();
await sipPhone.dial('1002');

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

const contactCenter = await ivekit.contactCenter.getMonitorSnapshot();
for (const queue of contactCenter.queues) {
  renderQueue(queue);
}

const endpoints = await ivekit.notifications.listEndpoints({ status: 'active' });
const deliveries = await ivekit.notifications.listDeliveries({
  state: 'failed', limit: 50
});
if (deliveries.items[0]) {
  await ivekit.notifications.retryDelivery(deliveries.items[0].id, {
    expected_state: 'failed'
  });
}
```

The notification client covers in-app inbox state, preferences, versioned templates,
Webhook/email/SMS endpoints, safe endpoint testing, delivery inspection and guarded
manual retries. Endpoint responses expose only `secret_configured` flags. List cursors
are opaque and bound to tenant plus filters. Retrying `uncertain` requires an explicit
`allow_uncertain` request and server-side administrative capability after Provider-side
deduplication; normal recovery should only retry `failed` or `dead_letter` deliveries.

The Voice client covers deployment profiles and capability preflight, SIP trunks,
DIDs, extensions and browser-session plans, versioned routes, outbound calls,
call control, provider event projections, participants, recordings, consent and
retention policy, plus PSTN-to-LiveKit bridge commands. It returns cursor pages for
all durable collections and exposes only redacted `from`, `to`, and DID addresses.
Provider webhook endpoints are intentionally server-only and are not SDK methods.

Every provider-changing Voice operation requires a stable idempotency key. Reuse the
same key and identical payload after an ambiguous timeout or 5xx. A new intent must
use a new key. Browser WebPhones must use a short-lived bearer token and must first
check `voice.getCapabilities().capabilities.extension_sessions`. The fixed plan contains
only a short-lived SIP authorization credential plus WSS/AOR/ICE configuration; never
persist it, log it, render it, or confuse it with a server-side long-lived secret.

Call-control surfaces must also call `voice.getProfileCapabilities(profileId)` and use
the versioned `action_capabilities` matrix. Missing snapshots, unknown schema versions,
and commands marked false are unavailable. `voice.preflightProfile(profileId)` refreshes
that matrix and is an administrative operation; a normal browser should only read it.

`createIveKitVoiceController()` is a framework-neutral WebPhone control-plane
controller. It publishes immutable top-level snapshots, exposes dial/answer/hangup,
DTMF, hold/resume, blind/warm transfer, conference create/add/remove/destroy,
park/pickup, recording and
LiveKit bridge commands, and retains an idempotency key only after an ambiguous
timeout or retryable provider failure. `refresh()` converges the selected call with
the server authority. `conference(id)` remains an add alias; new integrations should
use `createConference`, `addToConference`, `removeFromConference`, and
`destroyConference`. `voice.listParkingSlots()` returns the PostgreSQL-backed parking
authority with profile/state filters and cursor pagination. SIP/WebRTC media is provided separately by the lazy-loadable
`@opc/ivekit-sdk/sip-webphone` entry point. Its SIP.js adapter validates plan expiry
and WSS transport, supports registration/reconnect, incoming and outgoing single-call
control, mute, hold/resume, DTMF, remote audio, input/output selection, and automatic
unregistration when the ephemeral plan expires.

### Realtime Voice AI

The root package exports provider-neutral Realtime Voice AI types for Active Call,
LiveKit Agents, self-hosted streaming ASR/LLM/TTS pipelines, and third-party
providers. The contract covers capabilities, session plans, published tool
references, DTMF, interruption, transcript/tool events, latency metrics, and
evidence-safe projections. These are integration types; a deployment must still
install and verify a concrete server-side provider adapter.

The IVR client exposes revisioned flows, immutable publish/rollback versions,
deterministic simulations, durable sessions, audio assets, time/region/ring groups,
and tenant execution settings. Published flow dependencies are validated against
active resources and provider capabilities. Runtime fields of a resource referenced
by any published version cannot be changed in place; create a new resource ID and
publish a new flow version instead.

The reference client includes a lazy-loaded IVR Designer at
`?workspace=ivr&flow_id=<flow-id>`. It maps all 26 provider-neutral runtime node types
onto a React Flow canvas and uses only this typed IVR client for optimistic draft
saves, server validation, idempotent publishing, immutable rollback, and deterministic
simulation. Product applications may embed the workspace or build their own UI while
keeping the same `IveKitIvrFlowGraph` and HTTP contracts.

The Contact Center client covers Agent, Skill, Presence, Queue, Membership and
skill-requirement configuration; queue-entry and assignment lifecycles; encrypted
callback requests; supervisor control requests; and the tenant monitor projection.
Configuration creation, callback requests, routing offers, and supervisor starts
require stable idempotency keys. `getMonitorSnapshot()` returns one UTC-day snapshot
with eligible ACD capacity, queue backlog, wait estimates, SLA counters, active Voice
calls, callback/overflow health, and safe operational alerts. It contains no clear
phone numbers or provider credentials.

The chat client exports browser-safe JSON DTOs for sessions, participants, messages,
attachments and processing jobs, provider delivery, receipts, realtime state,
mutations, policy findings and reviews, reactions, pins, and cursor pages. These
types are structural and do not import OPC server modules.

For Tinode-backed messages, edit and soft delete responses include
`provider_mutation.status`; iveKit remains the UI authority while the durable native
replacement/delete operation converges. Administrators use
`listTinodeMutationDeadLetters()` and `replayTinodeMutationDeadLetter()` for explicit
reconciliation. A `provider_outcome_uncertain` edit means either its publish
acknowledgement was lost or an expired processing lease was recovered after a possible
publish. Clients and workers must not retry it automatically; recovered deletes remain
safe to retry.
If a verifiable Tinode echo arrives later, iveKit corrects the durable status to
`delivered` and writes `collaboration.message.provider_mutation_updated` to the durable
tenant event journal in the same transaction, with `reconciled_from_status`. Realtime
publication uses the same idempotency key, so replay/Webhook recovery survives a broadcast
failure without creating a second logical correction. Consumers should replace their older
dead-letter projection.

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
  // Refresh Chat, Media, Remote, and Notification inbox snapshots, then request a new head cursor.
} else {
  // Apply events once by event_id and retain replay.next_cursor in runtime memory.
}
```

Event cursors are opaque, tenant-bound, signed, and retention-limited. A 409 snapshot
fallback is returned as a typed page instead of an exception. The SDK never exposes
the cursor signing secret, provider credentials, or unrestricted tenant events.
Notification clients can consume `notification.created`, `notification.delivery.updated`,
`notification.inbox.created`, and `notification.inbox.updated`; all four are durable,
producer-idempotent, and restricted to the target user audience.

Backend integrations can ask iveKit to push selected journal events through the same
durable notification Webhook delivery path:

```typescript
const catalog = await ivekit.events.getCatalog();
const created = await ivekit.events.createWebhookSubscription({
  endpoint_id: endpoint.id,
  name: 'LED communication events',
  event_patterns: ['collaboration.message.*', 'ivekit.media.*', 'ivekit.voice.*']
}, { idempotencyKey: crypto.randomUUID() });

await ivekit.events.updateWebhookSubscription(created.subscription.id, {
  expected_revision: created.subscription.revision,
  status: 'paused'
}, { idempotencyKey: crypto.randomUUID() });
```

Only exact event names and trailing family wildcards are accepted. The selected
notification endpoint must be an active Webhook endpoint and its event allowlist is
still enforced. Subscription cursors, leases and retries are PostgreSQL-owned; do not
advance them from LED code.

Use `verifyIveKitWebhook()` against the exact raw body before JSON processing. It uses
Web Crypto HMAC-SHA256, validates the outer and inner tenant/event identities, enforces
a 1 MiB body limit, a 32-byte minimum secret and a bounded timestamp window. Its
`IveKitWebhookReplayStore.claim()` receives the verified envelope, body SHA-256,
delivery/event IDs and a replay expiry. The claim implementation must atomically write
a durable PostgreSQL/Redis inbox and return false for an existing delivery. The default
replay retention is seven days and is independent from the five-minute signature window.
Never use an in-process Set in production. See
`examples/webhook-receiver.ts` for the framework-neutral LED backend flow.

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

Native integrations use `recordOperationObservation()` for view, control, multi-display, file, clipboard, recording, and disconnect evidence. Missing telemetry is sent as `not_observed`; observed success/failure requires a timestamp and SHA-256-bound evidence reference. File and recording observations use the bounded `evidenceSecurity` label: `ivekit_secure_file`, `native_unscanned`, or `local_only`. The SDK sends metadata and hashes only, never screen pixels, keystrokes, clipboard/file contents, recording bytes, passwords, or tokens. Sensitive control/file/clipboard observations must carry the current `controlVersion` and actor identity.

`authorizeEmergencyFallback(externalId, input)` is an owner/admin-only recovery command for the Windows companion. It requires a substantive reason and literal `collateral_sessions_may_disconnect: true`; normal disconnect never authorizes service restart. After authorization, continue polling `getGatewayDisconnectState()` and surface the execution method and physical observation instead of treating HTTP acceptance as a completed disconnect.

RustDesk native file and recording bytes are not uploaded by this browser SDK. The pinned Windows companion uses the fixed `rustdesk-native-evidence-v1` producer/watcher/uploader chain and publishes durable `remote.rustdesk.evidence.security_updated`, `.derivative_updated`, `.intelligence_enqueued`, `.intelligence_updated`, and `.quality_updated` events. The service idempotently reconciles ready evidence that missed its convergence callback, so clients may receive the enqueue event after process recovery. Product clients may render those metadata-only events, but must keep `native_unscanned` and `local_only` distinct from `ivekit_secure_file`.

`getClientProfile()` returns a separately typed, pinned desktop distribution profile. Both expected server pins are mandatory. The SDK validates the requested platform/architecture, exact client and server versions, canonical 32-byte RustDesk public key, a Web Crypto-derived server-key fingerprint, canonical timestamps, expiry, a 60-second to one-hour lifetime, and exact release/platform/architecture installer identity. Official filenames use `rustdesk-1.4.7-<architecture>.<platform-extension>` without a platform token. Installer filenames are bounded canonical ASCII and URL basenames may not use whitespace, controls, Unicode, or percent escapes. A missing deployment artifact is returned as `install_source.state = 'not_configured'`; the SDK never downloads or executes it. Unattended access additionally requires an active access policy, active consent, and a fresh `unattended_launch` confirmation before `getGatewayLaunchPlan()` returns a usable plan.

The controlled placement-enabled Windows package accepts only an iveKit 1.4.7 artifact that declares both `ivekit-rustdesk-native-control-v2` and `rustdesk-native-evidence-v1`. The SDK preserves v1 and v2 in the typed client profile, but v1 is valid only for a rolling package with Cell placement disabled. Official unmodified binaries remain valid general client-profile artifacts, but they cannot be used to claim owner-fenced precise disconnect or automatic native-evidence capabilities.

Browser and desktop webview clients must use a short-lived `accessToken`. Backend integrations may use `apiKey` instead. Exactly one authentication mode is required, and an API key must never be embedded in a browser or desktop webview bundle.

The package also exports the lower-level `createIveKitHttpSdk()`, `createIveKitRustDeskHttpClient()`, and `createIveKitRustDeskLedSdk()` factories for integrations that need separate lifecycles.
