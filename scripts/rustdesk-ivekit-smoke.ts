import { resolveBrandEnv } from '../src/config/converact-env.js';
import { fileURLToPath } from 'node:url';

import type { RemoteConsentScope } from '../src/agent-runtime/collaboration/types.js';

export interface RustDeskIveKitSmokeConfig {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  actorIdentity: string;
  customerIdentity: string;
  businessRefType: string;
  businessRefId: string;
  businessRefDisplayName: string;
  rustdeskId: string;
  deviceDisplayName: string;
  permissions: RemoteConsentScope[];
  consentExpiresAt?: string;
}

export interface RustDeskIveKitSmokeStep {
  name: string;
  status: number;
}

export interface RustDeskIveKitSmokeResult {
  collaborationSessionId: string;
  remoteSessionId: string;
  deviceId: string;
  externalId: string;
  launchUrl: string;
  steps: RustDeskIveKitSmokeStep[];
  clientConfig: {
    idServer: string;
    manualKey: string;
    relayServer: string;
    publicKeyConfigured: boolean;
    serverKeyFingerprint: string;
  };
  launchPlan: {
    status: string;
    canLaunch: boolean;
    rustdeskId: string;
    protocolUrl: string;
  };
  endedLaunchPlan: {
    status: string;
    canLaunch: boolean;
  };
  launchPageChecked: boolean;
  endedLaunchUrlRejected: boolean;
  auditEvents: number;
  afterEndEventRejected: boolean;
  invalidEventRejected: boolean;
  operationEventTypes: string[];
  timeline: {
    consentEvents: number;
    toolSessions: number;
    auditEvents: number;
  };
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;

const allowedScopes = new Set<RemoteConsentScope>([
  'view_screen',
  'control_mouse_keyboard',
  'record_screen',
  'transfer_file',
  'clipboard'
]);

export function createRustDeskIveKitSmokeConfigFromEnv(env: NodeJS.ProcessEnv): RustDeskIveKitSmokeConfig {
  const rawBaseUrl =
    resolveBrandEnv(env, 'RUSTDESK_IVEKIT_BASE_URL') ||
    resolveBrandEnv(env, 'BASE_URL') ||
    resolveBrandEnv(env, 'COLLABORATION_BASE_URL') ||
    resolveBrandEnv(env, 'RUSTDESK_EDGE_BASE_URL') ||
    resolveBrandEnv(env, 'RUSTDESK_CONTROL_PLANE_BASE_URL') ||
    resolveBrandEnv(env, 'REMOTE_GATEWAY_BASE_URL') ||
    '';
  if (!rawBaseUrl) {
    throw new Error('CONVERACT_RUSTDESK_IVEKIT_BASE_URL, CONVERACT_BASE_URL, CONVERACT_COLLABORATION_BASE_URL, CONVERACT_RUSTDESK_EDGE_BASE_URL, CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL, or CONVERACT_REMOTE_GATEWAY_BASE_URL is required');
  }
  const apiKey = resolveBrandEnv(env, 'RUSTDESK_IVEKIT_API_KEY') || resolveBrandEnv(env, 'COLLABORATION_API_KEY') || resolveBrandEnv(env, 'API_KEY') || '';
  if (!apiKey) throw new Error('CONVERACT_RUSTDESK_IVEKIT_API_KEY, CONVERACT_COLLABORATION_API_KEY, or CONVERACT_API_KEY is required');
  const tenantId = resolveBrandEnv(env, 'RUSTDESK_IVEKIT_TENANT_ID') || resolveBrandEnv(env, 'REMOTE_GATEWAY_TENANT_ID') || resolveBrandEnv(env, 'RUSTDESK_EDGE_TENANT_ID') || resolveBrandEnv(env, 'TENANT_ID') || '';
  if (!tenantId) throw new Error('CONVERACT_RUSTDESK_IVEKIT_TENANT_ID, CONVERACT_REMOTE_GATEWAY_TENANT_ID, CONVERACT_RUSTDESK_EDGE_TENANT_ID, or CONVERACT_TENANT_ID is required');
  const rustdeskId = resolveBrandEnv(env, 'RUSTDESK_IVEKIT_RUSTDESK_ID') || resolveBrandEnv(env, 'RUSTDESK_EDGE_RUSTDESK_ID') || resolveBrandEnv(env, 'REMOTE_GATEWAY_TARGET_ID') || '';
  if (!rustdeskId) throw new Error('CONVERACT_RUSTDESK_IVEKIT_RUSTDESK_ID, CONVERACT_RUSTDESK_EDGE_RUSTDESK_ID, or CONVERACT_REMOTE_GATEWAY_TARGET_ID is required');
  const businessRefId = resolveBrandEnv(env, 'RUSTDESK_IVEKIT_BUSINESS_REF_ID') || resolveBrandEnv(env, 'RUSTDESK_EDGE_BUSINESS_REF_ID') || `${tenantId}-rustdesk-ivekit-smoke-${Date.now()}`;
  return {
    baseUrl: normalizeBaseUrl(rawBaseUrl),
    apiKey,
    tenantId,
    actorIdentity: resolveBrandEnv(env, 'RUSTDESK_IVEKIT_ACTOR_IDENTITY') || resolveBrandEnv(env, 'REMOTE_GATEWAY_ACTOR_IDENTITY') || 'agent_ivekit_rustdesk_smoke',
    customerIdentity: resolveBrandEnv(env, 'RUSTDESK_IVEKIT_CUSTOMER_IDENTITY') || 'customer_ivekit_rustdesk_smoke',
    businessRefType: resolveBrandEnv(env, 'RUSTDESK_IVEKIT_BUSINESS_REF_TYPE') || resolveBrandEnv(env, 'RUSTDESK_EDGE_BUSINESS_REF_TYPE') || 'service_order',
    businessRefId,
    businessRefDisplayName: resolveBrandEnv(env, 'RUSTDESK_IVEKIT_BUSINESS_REF_DISPLAY_NAME') || 'RustDesk iveKit smoke',
    rustdeskId,
    deviceDisplayName: resolveBrandEnv(env, 'RUSTDESK_IVEKIT_DEVICE_DISPLAY_NAME') || resolveBrandEnv(env, 'RUSTDESK_EDGE_DEVICE_DISPLAY_NAME') || resolveBrandEnv(env, 'REMOTE_GATEWAY_TARGET_DISPLAY_NAME') || 'RustDesk iveKit smoke device',
    permissions: splitScopes(resolveBrandEnv(env, 'RUSTDESK_IVEKIT_CONSENT_SCOPES')),
    consentExpiresAt: resolveBrandEnv(env, 'RUSTDESK_IVEKIT_CONSENT_EXPIRES_AT') || undefined
  };
}

export async function runRustDeskIveKitSmoke(
  config: RustDeskIveKitSmokeConfig,
  fetchImpl: FetchLike = fetch
): Promise<RustDeskIveKitSmokeResult> {
  const steps: RustDeskIveKitSmokeStep[] = [];
  const headers = authHeaders(config);
  const businessRef = {
    type: config.businessRefType,
    id: config.businessRefId,
    display_name: config.businessRefDisplayName,
    metadata: { source: 'rustdesk-ivekit-smoke' }
  };
  let externalId = '';
  let cleanupAttempted = false;

  try {
    const session = unwrapRecord(await jsonRequest(fetchImpl, steps, 'create_collaboration_session', `${config.baseUrl}/api/collaboration/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: config.businessRefDisplayName,
        business_ref: businessRef,
        metadata: { source: 'rustdesk-ivekit-smoke' }
      })
    }, [201]));
    const collaborationSessionId = requireString(session?.id, 'collaboration session id');

    const remote = unwrapRecord(await jsonRequest(fetchImpl, steps, 'create_remote_session', `${config.baseUrl}/api/collaboration/remote-assistance/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        collaboration_session_id: collaborationSessionId,
        mode: 'remote_desktop_gateway',
        adapter_provider: 'rustdesk',
        metadata: { source: 'rustdesk-ivekit-smoke' }
      })
    }, [201]));
    const remoteSessionId = requireString(remote?.id, 'remote assistance session id');

    await jsonRequest(fetchImpl, steps, 'grant_remote_consent', remoteActionUrl(config, remoteSessionId, 'consent/grant'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        actor_identity: config.customerIdentity,
        scopes: config.permissions,
        expires_at: consentExpiresAt(config),
        metadata: { source: 'rustdesk-ivekit-smoke' }
      })
    }, [201]);

    const clientConfig = unwrapRecord(await jsonRequest(fetchImpl, steps, 'get_ivekit_client_config', `${config.baseUrl}/api/ivekit/rustdesk/client-config`, {
      headers
    }));
    const clientConfigSummary = assertClientConfig(clientConfig);

    const device = unwrapRecord(await jsonRequest(fetchImpl, steps, 'register_ivekit_device', `${config.baseUrl}/api/ivekit/rustdesk/devices`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        business_ref: businessRef,
        rustdesk_id: config.rustdeskId,
        display_name: config.deviceDisplayName,
        metadata: { source: 'rustdesk-ivekit-smoke' }
      })
    }, [201]));
    const deviceId = requireString(device?.id, 'RustDesk device id');
    const returnedRustDeskId = requireString(device?.rustdesk_id, 'RustDesk runtime id');
    if (returnedRustDeskId !== config.rustdeskId) {
      throw new Error(`registered RustDesk id mismatch: ${returnedRustDeskId}`);
    }

    await jsonRequest(fetchImpl, steps, 'heartbeat_ivekit_device', `${config.baseUrl}/api/ivekit/rustdesk/devices/${encodeURIComponent(deviceId)}/heartbeat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        actor_identity: config.actorIdentity,
        runtime_status: 'online',
        metadata: { source: 'rustdesk-ivekit-smoke' }
      })
    }, [201]);

    const devicesByRef = unwrapArray(await jsonRequest(fetchImpl, steps, 'list_ivekit_devices_by_ref', urlWithQuery(config.baseUrl, '/api/ivekit/rustdesk/devices/by-ref', {
      business_ref_type: config.businessRefType,
      business_ref_id: config.businessRefId,
      limit: '50'
    }), { headers }));
    if (!devicesByRef.some((row) => asRecord(row)?.id === deviceId)) {
      throw new Error('iveKit RustDesk device was not returned by business ref lookup');
    }

    const tool = unwrapRecord(await jsonRequest(fetchImpl, steps, 'start_ivekit_gateway_session', `${config.baseUrl}/api/ivekit/rustdesk/gateway-sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        remote_session_id: remoteSessionId,
        device_id: deviceId,
        actor_identity: config.actorIdentity,
        permissions: config.permissions,
        metadata: { source: 'rustdesk-ivekit-smoke' }
      })
    }, [201]));
    externalId = requireString(tool?.external_id, 'RustDesk gateway external id');
    const launchUrl = requireString(tool?.launch_url, 'RustDesk gateway launch url');
    if (String(tool?.provider || '') !== 'rustdesk') {
      throw new Error(`iveKit gateway provider mismatch: ${String(tool?.provider || '')}`);
    }
    assertIveKitLaunchUrl(externalId, launchUrl);

    const launchPlan = unwrapRecord(await jsonRequest(fetchImpl, steps, 'get_ivekit_launch_plan', gatewayUrl(config, externalId, 'launch'), {
      headers
    }));
    const launchPlanSummary = assertLaunchPlan(
      launchPlan,
      config.rustdeskId,
      true,
      externalId,
      launchUrl,
      clientConfigSummary,
      config.permissions
    );
    await checkIveKitLaunchPage(fetchImpl, steps, launchUrl, externalId);

    await expectStatus(fetchImpl, steps, 'ivekit_invalid_clipboard_event_rejected', gatewayUrl(config, externalId, 'events'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        event_type: 'remote.rustdesk.clipboard.synced',
        actor_identity: config.actorIdentity,
        target: config.rustdeskId,
        idempotency_key: `rustdesk-ivekit-smoke:${externalId}:invalid-clipboard`,
        metadata: {
          source: 'rustdesk-ivekit-smoke',
          clipboard_id: `rustdesk-ivekit-smoke-invalid-clipboard-${externalId}`,
          direction: 'sideways'
        }
      })
    }, 400);

    const operationEvents = rustDeskOperationEvents(config, externalId);
    for (const operationEvent of operationEvents) {
      await jsonRequest(fetchImpl, steps, operationEvent.stepName, gatewayUrl(config, externalId, 'events'), {
        method: 'POST',
        headers,
        body: JSON.stringify(operationEvent.payload)
      }, [201]);
    }
    const operationEventTypes = operationEvents.map((event) => event.payload.event_type);

    const audit = unwrapRecord(await jsonRequest(fetchImpl, steps, 'list_ivekit_gateway_audit', gatewayUrl(config, externalId, 'audit'), {
      headers
    }));
    const auditEvents = readArray(audit?.events);
    assertAuditHas(auditEvents, externalId, 'remote.gateway_session.created');
    for (const eventType of operationEventTypes) {
      assertAuditHas(auditEvents, externalId, eventType);
    }

    cleanupAttempted = true;
    await jsonRequest(fetchImpl, steps, 'end_ivekit_gateway_session', `${config.baseUrl}/api/ivekit/rustdesk/gateway-sessions/${encodeURIComponent(externalId)}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ actor_identity: config.actorIdentity })
    }, [204]);

    const endedLaunchPlan = unwrapRecord(await jsonRequest(fetchImpl, steps, 'get_ivekit_ended_launch_plan', gatewayUrl(config, externalId, 'launch'), {
      headers
    }));
    const endedLaunchPlanSummary = assertLaunchPlan(
      endedLaunchPlan,
      config.rustdeskId,
      false,
      externalId,
      launchUrl,
      clientConfigSummary,
      config.permissions
    );
    await checkIveKitEndedLaunchUrlRejected(fetchImpl, steps, launchUrl);

    await expectStatus(fetchImpl, steps, 'ivekit_after_end_event_rejected', gatewayUrl(config, externalId, 'events'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        event_type: 'remote.rustdesk.control_action.performed',
        actor_identity: config.actorIdentity,
        target: config.rustdeskId,
        idempotency_key: `rustdesk-ivekit-smoke:${externalId}:after-end-control`,
        metadata: {
          source: 'rustdesk-ivekit-smoke',
          operation_id: `rustdesk-ivekit-smoke-after-end-${externalId}`,
          action: 'mouse_click',
          permission: 'control_mouse_keyboard'
        }
      })
    }, 409);

    const timeline = unwrapRecord(await jsonRequest(fetchImpl, steps, 'get_ivekit_timeline_after_end', remoteActionUrl(config, remoteSessionId, 'timeline'), {
      headers
    }));
    const timelineSummary = validateTimeline(timeline, remoteSessionId, externalId, operationEventTypes);

    return {
      collaborationSessionId,
      remoteSessionId,
      deviceId,
      externalId,
      launchUrl,
      steps,
      clientConfig: clientConfigSummary,
      launchPlan: launchPlanSummary,
      endedLaunchPlan: endedLaunchPlanSummary,
      launchPageChecked: true,
      endedLaunchUrlRejected: true,
      auditEvents: auditEvents.length,
      afterEndEventRejected: true,
      invalidEventRejected: true,
      operationEventTypes,
      timeline: timelineSummary
    };
  } catch (error) {
    if (externalId && !cleanupAttempted) {
      try {
        await jsonRequest(fetchImpl, steps, 'cleanup_ivekit_gateway_session', `${config.baseUrl}/api/ivekit/rustdesk/gateway-sessions/${encodeURIComponent(externalId)}`, {
          method: 'DELETE',
          headers,
          body: JSON.stringify({ actor_identity: config.actorIdentity })
        }, [204]);
      } catch (cleanupError) {
        throw new Error(`${errorMessage(error)}; cleanup failed: ${errorMessage(cleanupError)}`);
      }
    }
    throw error;
  }
}

interface RustDeskOperationSmokeEvent {
  stepName: string;
  payload: {
    event_type: string;
    actor_identity: string;
    target: string;
    idempotency_key: string;
    metadata: Record<string, unknown>;
  };
}

function rustDeskOperationEvents(
  config: RustDeskIveKitSmokeConfig,
  externalId: string
): RustDeskOperationSmokeEvent[] {
  const target = config.rustdeskId;
  return [
    {
      stepName: 'post_ivekit_control_event',
      payload: {
        event_type: 'remote.rustdesk.control_action.performed',
        actor_identity: config.actorIdentity,
        target,
        idempotency_key: `rustdesk-ivekit-smoke:${externalId}:control`,
        metadata: {
          source: 'rustdesk-ivekit-smoke',
          operation_id: `rustdesk-ivekit-smoke-control-${externalId}`,
          action: 'mouse_click',
          permission: 'control_mouse_keyboard'
        }
      }
    },
    {
      stepName: 'post_ivekit_file_transfer_started_event',
      payload: {
        event_type: 'remote.rustdesk.file_transfer.started',
        actor_identity: config.actorIdentity,
        target,
        idempotency_key: `rustdesk-ivekit-smoke:${externalId}:file-transfer`,
        metadata: {
          source: 'rustdesk-ivekit-smoke',
          transfer_id: `rustdesk-ivekit-smoke-transfer-${externalId}`,
          direction: 'upload',
          file_name: 'rustdesk-ivekit-smoke.txt'
        }
      }
    },
    {
      stepName: 'post_ivekit_file_transfer_completed_event',
      payload: {
        event_type: 'remote.rustdesk.file_transfer.completed',
        actor_identity: config.actorIdentity,
        target,
        idempotency_key: `rustdesk-ivekit-smoke:${externalId}:file-transfer-completed`,
        metadata: {
          source: 'rustdesk-ivekit-smoke',
          transfer_id: `rustdesk-ivekit-smoke-transfer-${externalId}`,
          direction: 'upload',
          file_name: 'rustdesk-ivekit-smoke.txt',
          status: 'completed'
        }
      }
    },
    {
      stepName: 'post_ivekit_recording_started_event',
      payload: {
        event_type: 'remote.rustdesk.recording.started',
        actor_identity: config.actorIdentity,
        target,
        idempotency_key: `rustdesk-ivekit-smoke:${externalId}:recording`,
        metadata: {
          source: 'rustdesk-ivekit-smoke',
          recording_id: `rustdesk-ivekit-smoke-recording-${externalId}`,
          evidence_type: 'screen_recording'
        }
      }
    },
    {
      stepName: 'post_ivekit_recording_stopped_event',
      payload: {
        event_type: 'remote.rustdesk.recording.stopped',
        actor_identity: config.actorIdentity,
        target,
        idempotency_key: `rustdesk-ivekit-smoke:${externalId}:recording-stopped`,
        metadata: {
          source: 'rustdesk-ivekit-smoke',
          recording_id: `rustdesk-ivekit-smoke-recording-${externalId}`,
          evidence_type: 'screen_recording',
          status: 'stopped'
        }
      }
    },
    {
      stepName: 'post_ivekit_clipboard_event',
      payload: {
        event_type: 'remote.rustdesk.clipboard.synced',
        actor_identity: config.actorIdentity,
        target,
        idempotency_key: `rustdesk-ivekit-smoke:${externalId}:clipboard`,
        metadata: {
          source: 'rustdesk-ivekit-smoke',
          clipboard_id: `rustdesk-ivekit-smoke-clipboard-${externalId}`,
          direction: 'agent_to_device',
          format: 'text'
        }
      }
    }
  ];
}

function normalizeBaseUrl(rawBaseUrl: string): string {
  const baseUrl = String(rawBaseUrl || '').trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('OPC RustDesk iveKit base URL must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('OPC RustDesk iveKit base URL must use http(s)');
  }
  return baseUrl;
}

function splitScopes(value: string | undefined): RemoteConsentScope[] {
  const scopes = (value || 'view_screen,control_mouse_keyboard,record_screen,transfer_file,clipboard')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (!scopes.length) throw new Error('CONVERACT_RUSTDESK_IVEKIT_CONSENT_SCOPES must include at least one scope');
  const unsupported = scopes.find((scope) => !allowedScopes.has(scope as RemoteConsentScope));
  if (unsupported) throw new Error(`unsupported CONVERACT_RUSTDESK_IVEKIT_CONSENT_SCOPES value: ${unsupported}`);
  return scopes as RemoteConsentScope[];
}

function authHeaders(config: RustDeskIveKitSmokeConfig): Record<string, string> {
  return {
    'x-api-key': config.apiKey,
    'x-tenant-id': config.tenantId,
    'x-user-id': config.actorIdentity,
    'content-type': 'application/json'
  };
}

function consentExpiresAt(config: RustDeskIveKitSmokeConfig): string {
  return config.consentExpiresAt || new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function remoteActionUrl(config: RustDeskIveKitSmokeConfig, remoteSessionId: string, action: string): string {
  return `${config.baseUrl}/api/collaboration/remote-assistance/${encodeURIComponent(remoteSessionId)}/${action}`;
}

function gatewayUrl(config: RustDeskIveKitSmokeConfig, externalId: string, action: string): string {
  return `${config.baseUrl}/api/ivekit/rustdesk/gateway-sessions/${encodeURIComponent(externalId)}/${action}`;
}

function urlWithQuery(baseUrl: string, path: string, query: Record<string, string>): string {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function jsonRequest(
  fetchImpl: FetchLike,
  steps: RustDeskIveKitSmokeStep[],
  name: string,
  url: string,
  init: RequestInit = {},
  okStatuses: number[] = [200]
): Promise<unknown> {
  const response = await fetchImpl(url, init);
  steps.push({ name, status: response.status });
  const payload = await readJson(response);
  if (!okStatuses.includes(response.status)) {
    throw new Error(`${name} failed with ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function expectStatus(
  fetchImpl: FetchLike,
  steps: RustDeskIveKitSmokeStep[],
  name: string,
  url: string,
  init: RequestInit,
  expectedStatus: number
): Promise<void> {
  const response = await fetchImpl(url, init);
  steps.push({ name, status: response.status });
  if (response.status !== expectedStatus) {
    const payload = await readJson(response);
    throw new Error(`${name} expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(payload)}`);
  }
}

async function checkIveKitLaunchPage(
  fetchImpl: FetchLike,
  steps: RustDeskIveKitSmokeStep[],
  launchUrl: string,
  externalId: string
): Promise<void> {
  const response = await fetchImpl(launchUrl, { method: 'GET' });
  steps.push({ name: 'check_ivekit_launch_url', status: response.status });
  if (!response.ok) {
    throw new Error(`iveKit RustDesk launch URL check failed with status ${response.status}`);
  }
  const text = await response.text();
  if (!text.includes('RustDesk Remote Launch') || !text.includes(externalId)) {
    throw new Error('iveKit RustDesk launch page did not contain the expected launch content');
  }
}

async function checkIveKitEndedLaunchUrlRejected(
  fetchImpl: FetchLike,
  steps: RustDeskIveKitSmokeStep[],
  launchUrl: string
): Promise<void> {
  const response = await fetchImpl(launchUrl, { method: 'GET' });
  steps.push({ name: 'ivekit_ended_launch_url_rejected', status: response.status });
  if (response.status !== 409) {
    throw new Error(`iveKit RustDesk ended launch URL must be rejected with 409, got ${response.status}`);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function unwrapRecord(value: unknown): JsonRecord | null {
  const record = asRecord(value);
  if (record && Object.prototype.hasOwnProperty.call(record, 'data')) {
    return asRecord(record.data);
  }
  return record;
}

function unwrapArray(value: unknown): unknown[] {
  const record = asRecord(value);
  if (record && Object.prototype.hasOwnProperty.call(record, 'data')) {
    return Array.isArray(record.data) ? record.data : [];
  }
  return Array.isArray(value) ? value : [];
}

function readArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (Array.isArray(record?.data)) return record.data;
  return [];
}

function requireString(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error(`${label} is required`);
}

function assertIveKitLaunchUrl(externalId: string, launchUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(launchUrl);
  } catch {
    throw new Error('iveKit RustDesk launch_url must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('iveKit RustDesk launch_url must be http(s)');
  }
  if (parsed.pathname !== '/remote/rustdesk/launch') {
    throw new Error('iveKit RustDesk launch_url path must be /remote/rustdesk/launch');
  }
  const sessionId = String(parsed.searchParams.get('session_id') || '').trim();
  if (sessionId !== externalId) {
    throw new Error('iveKit RustDesk launch_url session_id must match external_id');
  }
  const token = String(parsed.searchParams.get('token') || '').trim();
  if (!token) {
    throw new Error('iveKit RustDesk launch_url token is required');
  }
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    throw new Error('iveKit RustDesk launch_url token must be a 64 character hex HMAC');
  }
  const expiresAt = String(parsed.searchParams.get('expires_at') || '').trim();
  if (!expiresAt) {
    throw new Error('iveKit RustDesk launch_url expires_at is required');
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error('iveKit RustDesk launch_url expires_at must be a future ISO timestamp');
  }
}

function assertClientConfig(value: JsonRecord | null): RustDeskIveKitSmokeResult['clientConfig'] {
  if (!value) throw new Error('RustDesk client config is required');
  const manualFields = asRecord(value.manual_fields);
  const idServer = String(value.id_server || manualFields?.id_server || '').trim();
  const publicKey = String(value.public_key || '').trim();
  const serverKeyFingerprint = String(value.server_key_fingerprint || '').trim();
  const manualIdServer = String(manualFields?.id_server || '').trim();
  const manualRelayServer = String(manualFields?.relay_server || '').trim();
  const manualKey = String(manualFields?.key || '').trim();
  if (!idServer) {
    throw new Error('RustDesk client config id_server is required');
  }
  if (!manualIdServer) {
    throw new Error('RustDesk client config manual_fields.id_server is required');
  }
  if (manualIdServer !== idServer) {
    throw new Error('RustDesk client config manual_fields.id_server must match id_server');
  }
  const publicKeyConfigured = Boolean(value.public_key_configured);
  if (!publicKeyConfigured) {
    throw new Error('RustDesk client config public key is not configured');
  }
  if (publicKeyConfigured && !publicKey) {
    throw new Error('RustDesk client config public key is required when configured');
  }
  if (publicKeyConfigured && !manualKey) {
    throw new Error('RustDesk client config manual_fields.key is required');
  }
  if (publicKey && manualKey !== publicKey) {
    throw new Error('RustDesk client config manual_fields.key must match public_key');
  }
  if (!serverKeyFingerprint) {
    throw new Error('RustDesk client config server_key_fingerprint is required');
  }
  const relayServer = String(value.relay_server || manualFields?.relay_server || '').trim();
  if (String(value.relay_server || '').trim() && manualRelayServer !== String(value.relay_server || '').trim()) {
    throw new Error('RustDesk client config manual_fields.relay_server must match relay_server');
  }
  return {
    idServer,
    manualKey,
    relayServer,
    publicKeyConfigured,
    serverKeyFingerprint
  };
}

function assertLaunchPlan(
  value: JsonRecord | null,
  expectedRustDeskId: string,
  expectLaunchable: boolean,
  expectedExternalId: string,
  expectedLaunchUrl?: string,
  expectedClientConfig?: RustDeskIveKitSmokeResult['clientConfig'],
  expectedPermissions: RemoteConsentScope[] = []
): RustDeskIveKitSmokeResult['launchPlan'] {
  if (!value) throw new Error('RustDesk launch plan is required');
  const runtime = asRecord(value.runtime);
  const actions = asRecord(value.actions);
  const externalId = String(value.external_id || '').trim();
  if (externalId !== expectedExternalId) {
    throw new Error('RustDesk launch plan external_id must match gateway session');
  }
  const rustdeskId = String(runtime?.rustdesk_id || '');
  if (rustdeskId !== expectedRustDeskId) {
    throw new Error(`RustDesk launch plan target mismatch: ${rustdeskId}`);
  }
  const status = String(value.status || '').trim();
  const canLaunch = Boolean(actions?.can_launch);
  if (canLaunch !== expectLaunchable) {
    throw new Error(`RustDesk launch plan can_launch mismatch: ${String(canLaunch)}`);
  }
  if (expectLaunchable && status !== 'active') {
    throw new Error('RustDesk active launch plan status must be active');
  }
  if (!expectLaunchable && status !== 'ended') {
    throw new Error('RustDesk ended launch plan status must be ended');
  }
  const planLaunchUrl = String(value.launch_url || '').trim();
  const openUrl = String(actions?.open_url || '').trim();
  const protocolUrl = String(actions?.protocol_url || '').trim();
  if (expectLaunchable && expectedLaunchUrl && planLaunchUrl !== expectedLaunchUrl) {
    throw new Error('RustDesk launch plan launch_url must match created session launch_url');
  }
  if (!expectLaunchable && planLaunchUrl) {
    throw new Error('RustDesk ended launch plan launch_url must be empty');
  }
  if (expectLaunchable && expectedLaunchUrl && openUrl !== expectedLaunchUrl) {
    throw new Error('RustDesk launch plan launch_url must match created session launch_url');
  }
  if (!expectLaunchable && openUrl) {
    throw new Error('RustDesk ended launch plan open_url must be empty');
  }
  if (!expectLaunchable && protocolUrl) {
    throw new Error('RustDesk ended launch plan protocol_url must be empty');
  }
  if (expectLaunchable) {
    assertActiveRustDeskProtocolUrl(protocolUrl, expectedRustDeskId);
  }
  if (expectedClientConfig) {
    const runtimeIdServer = String(runtime?.id_server || '').trim();
    const runtimeRelayServer = String(runtime?.relay_server || '').trim();
    const runtimeServerKeyFingerprint = String(runtime?.server_key_fingerprint || '').trim();
    const runtimePublicKeyConfigured = String(runtime?.public_key_configured || '').trim().toLowerCase();
    const launchClientConfig = asRecord(value.client_config);
    const launchManualFields = asRecord(launchClientConfig?.manual_fields);
    const manualIdServer = String(launchManualFields?.id_server || '').trim();
    const manualRelayServer = String(launchManualFields?.relay_server || '').trim();
    const manualKey = String(launchManualFields?.key || '').trim();
    if (!runtimeIdServer) {
      throw new Error('RustDesk launch plan runtime id_server is required');
    }
    if (runtimeIdServer !== expectedClientConfig.idServer) {
      throw new Error('RustDesk launch plan runtime id_server must match client config');
    }
    if (expectedClientConfig.relayServer && runtimeRelayServer !== expectedClientConfig.relayServer) {
      throw new Error('RustDesk launch plan runtime relay_server must match client config');
    }
    if (runtimeServerKeyFingerprint !== expectedClientConfig.serverKeyFingerprint) {
      throw new Error('RustDesk launch plan runtime server_key_fingerprint must match client config');
    }
    if (!manualIdServer) {
      throw new Error('RustDesk launch plan client_config.manual_fields.id_server is required');
    }
    if (manualIdServer !== expectedClientConfig.idServer) {
      throw new Error('RustDesk launch plan client_config.manual_fields.id_server must match client config');
    }
    if (expectedClientConfig.relayServer && manualRelayServer !== expectedClientConfig.relayServer) {
      throw new Error('RustDesk launch plan client_config.manual_fields.relay_server must match client config');
    }
    if (expectedClientConfig.manualKey && manualKey !== expectedClientConfig.manualKey) {
      throw new Error('RustDesk launch plan client_config.manual_fields.key must match client config');
    }
    if (expectedClientConfig.publicKeyConfigured && launchClientConfig?.public_key_configured !== true) {
      throw new Error('RustDesk launch plan client_config.public_key_configured must be true');
    }
    if (expectedClientConfig.publicKeyConfigured && runtimePublicKeyConfigured !== 'true') {
      throw new Error('RustDesk launch plan runtime public_key_configured must be true');
    }
  }
  assertLaunchPlanPermissions(value.permissions, expectedPermissions);
  assertLaunchPlanTarget(value.target, expectedRustDeskId);
  return {
    status,
    canLaunch,
    rustdeskId,
    protocolUrl
  };
}

function assertLaunchPlanPermissions(value: unknown, expectedPermissions: RemoteConsentScope[]): void {
  const permissions = new Set(readArray(value).map((scope) => String(scope || '').trim()).filter(Boolean));
  for (const scope of expectedPermissions) {
    if (!permissions.has(scope)) {
      throw new Error(`RustDesk launch plan permissions must include requested scope ${scope}`);
    }
  }
}

function assertLaunchPlanTarget(value: unknown, expectedRustDeskId: string): void {
  const target = asRecord(value);
  const targetId = String(target?.id || '').trim();
  if (!targetId) {
    throw new Error('RustDesk launch plan target.id is required');
  }
  if (targetId !== expectedRustDeskId) {
    throw new Error('RustDesk launch plan target.id must match RustDesk target');
  }
}

function assertActiveRustDeskProtocolUrl(protocolUrl: string, expectedRustDeskId: string): void {
  if (!protocolUrl) {
    throw new Error('RustDesk active launch plan protocol_url is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(protocolUrl);
  } catch {
    throw new Error('RustDesk active launch plan protocol_url must be a valid URL');
  }
  if (parsed.protocol !== 'rustdesk:') {
    throw new Error('RustDesk active launch plan protocol_url must use the rustdesk scheme');
  }
  if (!containsEncodedValue(protocolUrl, expectedRustDeskId)) {
    throw new Error('RustDesk active launch plan protocol_url must reference the RustDesk target');
  }
}

function containsEncodedValue(value: string, expected: string): boolean {
  return value.includes(expected) || value.includes(encodeURIComponent(expected));
}

function assertAuditHas(auditEvents: unknown[], externalId: string, eventType: string): void {
  const found = auditEvents.some((event) => {
    const record = asRecord(event);
    return String(record?.external_id || externalId) === externalId && String(record?.event_type || '') === eventType;
  });
  if (!found) throw new Error(`iveKit RustDesk audit missing ${eventType}`);
}

function validateTimeline(
  timeline: JsonRecord | null,
  remoteSessionId: string,
  externalId: string,
  operationEventTypes: string[]
): RustDeskIveKitSmokeResult['timeline'] {
  if (asRecord(timeline?.session)?.id !== remoteSessionId) {
    throw new Error('timeline did not return the remote assistance session');
  }
  const toolSessions = readArray(timeline?.tool_sessions);
  const matchingTool = toolSessions.find((tool) => {
    const record = asRecord(tool);
    return String(record?.provider || '') === 'rustdesk' && String(record?.external_id || '') === externalId;
  });
  if (!matchingTool) throw new Error('timeline missing RustDesk tool session');
  if (String(asRecord(matchingTool)?.status || '') !== 'ended') {
    throw new Error('timeline RustDesk tool session is not ended');
  }
  const auditTypes = readArray(timeline?.audit_events).map((event) => String(asRecord(event)?.event_type || ''));
  for (const eventType of [
    ...operationEventTypes,
    'remote.gateway_session.ended',
    'remote.tool_session.ended'
  ]) {
    if (!auditTypes.includes(eventType)) throw new Error(`timeline missing audit event: ${eventType}`);
  }
  return {
    consentEvents: readArray(timeline?.consent_events).length,
    toolSessions: toolSessions.length,
    auditEvents: auditTypes.length
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const result = await runRustDeskIveKitSmoke(createRustDeskIveKitSmokeConfigFromEnv(process.env));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exit(1);
  });
}
