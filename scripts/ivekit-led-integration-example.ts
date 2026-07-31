import { fileURLToPath } from 'node:url';

import {
  createIveKitHttpSdk,
  createIveKitRustDeskLedSdk,
  type IveKitSdkFetch
} from '../src/agent-runtime/converact/index.js';

export interface IveKitLedExampleConfig {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  userId: string;
  businessRefType: string;
  businessRefId: string;
  roomName: string;
  remoteSessionId?: string;
  rustdeskDeviceId?: string;
  rustdeskId?: string;
  fetch?: IveKitSdkFetch;
}

export function iveKitLedExampleConfigFromEnv(env: NodeJS.ProcessEnv): IveKitLedExampleConfig {
  const tenantId = required(env.OPC_IVEKIT_LED_TENANT_ID || env.OPC_TENANT_ID, 'OPC_IVEKIT_LED_TENANT_ID');
  const businessRefType = String(env.OPC_IVEKIT_LED_BUSINESS_REF_TYPE || 'service_order').trim();
  const businessRefId = required(env.OPC_IVEKIT_LED_BUSINESS_REF_ID, 'OPC_IVEKIT_LED_BUSINESS_REF_ID');
  return {
    baseUrl: required(env.OPC_IVEKIT_LED_BASE_URL || env.OPC_BASE_URL, 'OPC_IVEKIT_LED_BASE_URL'),
    apiKey: required(env.OPC_IVEKIT_LED_API_KEY || env.OPC_API_KEY, 'OPC_IVEKIT_LED_API_KEY'),
    tenantId,
    userId: required(env.OPC_IVEKIT_LED_USER_ID, 'OPC_IVEKIT_LED_USER_ID'),
    businessRefType,
    businessRefId,
    roomName: String(env.OPC_IVEKIT_LED_ROOM_NAME || `${tenantId}-${businessRefType}-${businessRefId}`)
      .replace(/[^a-zA-Z0-9_-]/g, '-'),
    remoteSessionId: optional(env.OPC_IVEKIT_LED_REMOTE_SESSION_ID),
    rustdeskDeviceId: optional(env.OPC_IVEKIT_LED_RUSTDESK_DEVICE_ID),
    rustdeskId: optional(env.OPC_IVEKIT_LED_RUSTDESK_ID)
  };
}

export async function runIveKitLedExample(config: IveKitLedExampleConfig): Promise<Record<string, unknown>> {
  const sdk = createIveKitHttpSdk({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    tenantId: config.tenantId,
    userId: config.userId,
    fetch: config.fetch
  });
  const businessRef = { type: config.businessRefType, id: config.businessRefId };
  const session = await sdk.chat.openSession({
    title: `LED ${config.businessRefId}`,
    business_ref: businessRef
  });
  const sessionId = required(session.id, 'chat session id');
  await sdk.chat.addParticipant(sessionId, {
    identity: config.userId,
    role: 'agent',
    display_name: config.userId
  });
  const room = await sdk.media.createRoom({
    purpose: 'video_service',
    room_name: config.roomName,
    business_ref: businessRef,
    metadata: { collaboration_session_id: sessionId, source: 'ivekit-led-example' }
  });
  const joinPlan = await sdk.media.createJoinPlan(config.roomName, {
    identity: config.userId,
    role: 'agent',
    media: 'video',
    channel: 'webrtc'
  });
  const message = await sdk.chat.postMessage(sessionId, {
    sender_identity: config.userId,
    message_type: 'text',
    body: 'LED iveKit integration probe'
  }, {
    idempotencyKey: `led:${config.businessRefType}:${config.businessRefId}:integration-probe`
  });

  let rustdesk: Record<string, unknown> | null = null;
  if (config.remoteSessionId && (config.rustdeskDeviceId || config.rustdeskId)) {
    const rustdeskSdk = createIveKitRustDeskLedSdk({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      tenantId: config.tenantId,
      userId: config.userId,
      fetch: config.fetch,
      source: 'ivekit-led-example'
    });
    const started = await rustdeskSdk.startSession({
      remoteSessionId: config.remoteSessionId,
      deviceId: config.rustdeskDeviceId,
      rustdeskId: config.rustdeskId,
      businessRef,
      deviceDisplayName: `LED ${config.businessRefId}`,
      actorIdentity: config.userId,
      permissions: ['view_screen', 'control_mouse_keyboard']
    });
    rustdesk = {
      external_id: started.gatewaySession.external_id,
      launch_url: started.launch.launchUrl,
      protocol_url: started.launch.protocolUrl
    };
  }

  return {
    tenant_id: config.tenantId,
    collaboration_session_id: sessionId,
    room_id: room.id,
    room_name: config.roomName,
    join_channel: joinPlan.mode || joinPlan.channel,
    message_id: message.message.id,
    rustdesk
  };
}

function required(value: unknown, name: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function optional(value: unknown): string | undefined {
  const normalized = String(value || '').trim();
  return normalized || undefined;
}

async function main(): Promise<void> {
  const result = await runIveKitLedExample(iveKitLedExampleConfigFromEnv(process.env));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
