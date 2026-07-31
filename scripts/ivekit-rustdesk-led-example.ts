import { fileURLToPath } from 'node:url';

import type { RemoteConsentScope } from '../src/agent-runtime/collaboration/types.js';
import {
  createIveKitRustDeskHttpClient,
  type IveKitRustDeskHttpClient
} from '../src/agent-runtime/converact/index.js';

export interface IveKitRustDeskLedExampleConfig {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  userId?: string;
  remoteSessionId: string;
  deviceId?: string;
  rustdeskId?: string;
  businessRef: {
    type: string;
    id: string;
    display_name?: string;
    metadata?: Record<string, unknown>;
  };
  deviceDisplayName: string;
  actorIdentity: string;
  permissions: RemoteConsentScope[];
  postAuditProbe: boolean;
  endSession: boolean;
}

export interface IveKitRustDeskLedExampleResult {
  deviceId: string;
  rustdeskId: string;
  externalId: string;
  launchUrl: string;
  protocolUrl: string;
  auditEvents: number;
  auditProbePosted: boolean;
  ended: boolean;
  clientConfig: {
    idServer: string;
    relayServer: string;
    publicKeyConfigured: boolean;
    serverKeyFingerprint: string;
  };
}

const allowedScopes = new Set<RemoteConsentScope>([
  'view_screen',
  'control_mouse_keyboard',
  'record_screen',
  'transfer_file',
  'clipboard'
]);

export function createIveKitRustDeskLedExampleConfigFromEnv(env: NodeJS.ProcessEnv): IveKitRustDeskLedExampleConfig {
  const rawBaseUrl =
    env.OPC_RUSTDESK_LED_EXAMPLE_BASE_URL ||
    env.OPC_RUSTDESK_IVEKIT_BASE_URL ||
    env.OPC_BASE_URL ||
    env.OPC_COLLABORATION_BASE_URL ||
    '';
  const apiKey =
    env.OPC_RUSTDESK_LED_EXAMPLE_API_KEY ||
    env.OPC_RUSTDESK_IVEKIT_API_KEY ||
    env.OPC_COLLABORATION_API_KEY ||
    env.OPC_API_KEY ||
    '';
  const tenantId =
    env.OPC_RUSTDESK_LED_EXAMPLE_TENANT_ID ||
    env.OPC_RUSTDESK_IVEKIT_TENANT_ID ||
    env.OPC_REMOTE_GATEWAY_TENANT_ID ||
    env.OPC_RUSTDESK_EDGE_TENANT_ID ||
    env.OPC_TENANT_ID ||
    '';
  const remoteSessionId =
    env.OPC_RUSTDESK_LED_EXAMPLE_REMOTE_SESSION_ID ||
    env.OPC_RUSTDESK_IVEKIT_REMOTE_SESSION_ID ||
    env.OPC_REMOTE_SESSION_ID ||
    '';
  const deviceId = normalizedOptional(env.OPC_RUSTDESK_LED_EXAMPLE_DEVICE_ID || env.OPC_RUSTDESK_IVEKIT_DEVICE_ID);
  const rustdeskId = normalizedOptional(
    env.OPC_RUSTDESK_LED_EXAMPLE_RUSTDESK_ID ||
    env.OPC_RUSTDESK_IVEKIT_RUSTDESK_ID ||
    env.OPC_RUSTDESK_EDGE_RUSTDESK_ID
  );

  if (!rawBaseUrl) throw new Error('OPC_RUSTDESK_LED_EXAMPLE_BASE_URL or OPC_RUSTDESK_IVEKIT_BASE_URL or OPC_BASE_URL is required');
  if (!apiKey) throw new Error('OPC_RUSTDESK_LED_EXAMPLE_API_KEY or OPC_RUSTDESK_IVEKIT_API_KEY or OPC_COLLABORATION_API_KEY or OPC_API_KEY is required');
  if (!tenantId) throw new Error('OPC_RUSTDESK_LED_EXAMPLE_TENANT_ID or OPC_RUSTDESK_IVEKIT_TENANT_ID or OPC_REMOTE_GATEWAY_TENANT_ID is required');
  if (!remoteSessionId) throw new Error('OPC_RUSTDESK_LED_EXAMPLE_REMOTE_SESSION_ID is required');
  if (!deviceId && !rustdeskId) throw new Error('OPC_RUSTDESK_LED_EXAMPLE_DEVICE_ID or OPC_RUSTDESK_LED_EXAMPLE_RUSTDESK_ID is required');

  return {
    baseUrl: normalizeBaseUrl(rawBaseUrl),
    apiKey: requiredString(apiKey, 'apiKey is required'),
    tenantId: requiredString(tenantId, 'tenantId is required'),
    userId: normalizedOptional(env.OPC_RUSTDESK_LED_EXAMPLE_USER_ID || env.OPC_RUSTDESK_IVEKIT_USER_ID),
    remoteSessionId: requiredString(remoteSessionId, 'remoteSessionId is required'),
    ...(deviceId ? { deviceId } : {}),
    ...(rustdeskId ? { rustdeskId } : {}),
    businessRef: {
      type: requiredString(
        env.OPC_RUSTDESK_LED_EXAMPLE_BUSINESS_REF_TYPE ||
        env.OPC_RUSTDESK_IVEKIT_BUSINESS_REF_TYPE ||
        env.OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE ||
        'service_order',
        'businessRef.type is required'
      ),
      id: requiredString(
        env.OPC_RUSTDESK_LED_EXAMPLE_BUSINESS_REF_ID ||
        env.OPC_RUSTDESK_IVEKIT_BUSINESS_REF_ID ||
        env.OPC_RUSTDESK_EDGE_BUSINESS_REF_ID ||
        remoteSessionId,
        'businessRef.id is required'
      ),
      display_name: normalizedOptional(
        env.OPC_RUSTDESK_LED_EXAMPLE_BUSINESS_REF_DISPLAY_NAME ||
        env.OPC_RUSTDESK_IVEKIT_BUSINESS_REF_DISPLAY_NAME
      )
    },
    deviceDisplayName: requiredString(
      env.OPC_RUSTDESK_LED_EXAMPLE_DEVICE_DISPLAY_NAME ||
      env.OPC_RUSTDESK_IVEKIT_DEVICE_DISPLAY_NAME ||
      env.OPC_RUSTDESK_EDGE_DEVICE_DISPLAY_NAME ||
      rustdeskId ||
      deviceId,
      'deviceDisplayName is required'
    ),
    actorIdentity: requiredString(
      env.OPC_RUSTDESK_LED_EXAMPLE_ACTOR_IDENTITY ||
      env.OPC_RUSTDESK_IVEKIT_ACTOR_IDENTITY ||
      env.OPC_REMOTE_GATEWAY_ACTOR_IDENTITY ||
      'agent_led_rustdesk_example',
      'actorIdentity is required'
    ),
    permissions: splitScopes(env.OPC_RUSTDESK_LED_EXAMPLE_PERMISSIONS || env.OPC_RUSTDESK_IVEKIT_CONSENT_SCOPES),
    postAuditProbe: envFlag(env.OPC_RUSTDESK_LED_EXAMPLE_POST_AUDIT_PROBE),
    endSession: envFlag(env.OPC_RUSTDESK_LED_EXAMPLE_END_SESSION)
  };
}

export async function runIveKitRustDeskLedExample(
  config: IveKitRustDeskLedExampleConfig,
  client: IveKitRustDeskHttpClient = createIveKitRustDeskHttpClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    tenantId: config.tenantId,
    userId: config.userId
  })
): Promise<IveKitRustDeskLedExampleResult> {
  const clientConfig = await client.getClientConfig();
  const clientConfigSummary = assertClientConfigReady(clientConfig);
  const device = config.deviceId
    ? await client.getDevice(config.deviceId)
    : await client.registerDevice({
      business_ref: {
        tenant_id: config.tenantId,
        ...config.businessRef,
        metadata: {
          source: 'ivekit-rustdesk-led-example',
          ...config.businessRef.metadata
        }
      },
      rustdesk_id: requiredString(config.rustdeskId, 'rustdeskId is required when deviceId is not provided'),
      display_name: config.deviceDisplayName,
      metadata: { source: 'ivekit-rustdesk-led-example' }
    });
  const deviceId = requiredString(device.id, 'RustDesk device id is required');
  const rustdeskId = requiredString(device.rustdesk_id || config.rustdeskId, 'RustDesk runtime id is required');

  await client.heartbeatDevice(deviceId, {
    actor_identity: config.actorIdentity,
    runtime_status: 'online',
    metadata: { source: 'ivekit-rustdesk-led-example' }
  });

  const session = await client.startGatewaySession({
    remote_session_id: config.remoteSessionId,
    device_id: deviceId,
    actor_identity: config.actorIdentity,
    permissions: config.permissions,
    metadata: {
      source: 'ivekit-rustdesk-led-example',
      rustdesk_id: rustdeskId
    }
  });
  const externalId = requiredString(session.external_id, 'RustDesk gateway external id is required');
  const launchUrl = requiredString(session.launch_url, 'RustDesk gateway launch URL is required');
  const launchPlan = await client.getGatewayLaunchPlan(externalId);
  const protocolUrl = String(launchPlan.actions?.protocol_url || '');

  let auditProbePosted = false;
  if (config.postAuditProbe) {
    assertCanPostControlProbe(config.permissions);
    await client.recordGatewayEvent(externalId, {
      event_type: 'remote.rustdesk.control_action.performed',
      actor_identity: config.actorIdentity,
      target: rustdeskId,
      idempotency_key: `ivekit-rustdesk-led-example:${externalId}:control-action`,
      metadata: {
        source: 'ivekit-rustdesk-led-example',
        operation_id: `ivekit-rustdesk-led-example-${externalId}`,
        action: 'example.probe',
        permission: 'control_mouse_keyboard'
      }
    });
    auditProbePosted = true;
  }

  const auditEvents = await client.listGatewayAuditEvents(externalId);
  if (config.endSession) {
    await client.endGatewaySession(externalId, { actor_identity: config.actorIdentity });
  }

  return {
    deviceId,
    rustdeskId,
    externalId,
    launchUrl,
    protocolUrl,
    auditEvents: auditEvents.length,
    auditProbePosted,
    ended: config.endSession,
    clientConfig: clientConfigSummary
  };
}

function assertClientConfigReady(config: {
  id_server?: string;
  relay_server?: string;
  public_key_configured?: boolean;
  server_key_fingerprint?: string;
  manual_fields?: { key?: string };
}): IveKitRustDeskLedExampleResult['clientConfig'] {
  const idServer = requiredString(config.id_server, 'RustDesk client config id_server is required');
  if (!config.public_key_configured) throw new Error('RustDesk client config public key is not configured');
  if (!config.manual_fields?.key) throw new Error('RustDesk client config manual key is required');
  return {
    idServer,
    relayServer: String(config.relay_server || ''),
    publicKeyConfigured: true,
    serverKeyFingerprint: String(config.server_key_fingerprint || '')
  };
}

function assertCanPostControlProbe(permissions: RemoteConsentScope[]): void {
  if (!permissions.includes('control_mouse_keyboard')) {
    throw new Error('OPC_RUSTDESK_LED_EXAMPLE_POST_AUDIT_PROBE requires control_mouse_keyboard permission');
  }
}

function splitScopes(rawScopes: string | undefined): RemoteConsentScope[] {
  const values = String(rawScopes || 'view_screen,control_mouse_keyboard')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (!values.length) throw new Error('permissions are required');
  for (const value of values) {
    if (!allowedScopes.has(value as RemoteConsentScope)) {
      throw new Error(`unsupported RustDesk permission scope: ${value}`);
    }
  }
  return values as RemoteConsentScope[];
}

function normalizeBaseUrl(rawBaseUrl: string): string {
  const value = requiredString(rawBaseUrl, 'baseUrl is required').replace(/\/+$/, '');
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('baseUrl must use http(s)');
  }
  return value;
}

function requiredString(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function normalizedOptional(value: unknown): string | undefined {
  const normalized = String(value || '').trim();
  return normalized || undefined;
}

function envFlag(value: string | undefined): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

async function main(): Promise<void> {
  const result = await runIveKitRustDeskLedExample(createIveKitRustDeskLedExampleConfigFromEnv(process.env));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
