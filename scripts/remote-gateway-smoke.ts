import { resolveBrandEnv } from '../src/config/converact-env.js';
import { createSocket } from 'node:dgram';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

import { normalizeRemoteGatewaySession, type RemoteGatewayProvider, type RemoteGatewayTarget } from '../src/agent-runtime/collaboration/remote-gateway-adapter.js';
import { isRustDeskProtocolUrl } from '../src/agent-runtime/collaboration/rustdesk-launch-plan.js';
import {
  createGuacamoleGatewayClient,
  createMeshCentralGatewayClient,
  createRustDeskGatewayClient,
  type RemoteGatewayAuditEvent,
  type RemoteGatewayClient
} from '../src/agent-runtime/collaboration/remote-gateway-client.js';
import type { RemoteConsentScope } from '../src/agent-runtime/collaboration/types.js';

export interface RemoteGatewaySmokeConfig {
  provider: RemoteGatewayProvider;
  baseUrl: string;
  apiToken: string;
  tenantId?: string;
  collaborationApiKey?: string;
  actorIdentity: string;
  target: RemoteGatewayTarget;
  permissions: RemoteConsentScope[];
  checkLaunchUrl?: boolean;
  createPath?: string;
  sessionPath?: string;
  auditPath?: string;
  rustdeskCheckServerPorts?: boolean;
  rustdeskCheckHost?: string;
  rustdeskCheckTcpPorts?: number[];
  rustdeskCheckUdpPorts?: number[];
  rustdeskCheckTimeoutMs?: number;
  rustdeskRequireProtocolUrl?: boolean;
  rustdeskCheckDeviceOnline?: boolean;
  rustdeskCheckOperationAudit?: boolean;
  rustdeskDeviceOnlineTtlMs?: number;
}

export interface RemoteGatewaySmokeStep {
  name: string;
  status: number;
}

export interface RemoteGatewaySmokeResult {
  provider: RemoteGatewayProvider;
  externalId: string;
  launchUrl: string;
  auditEvents: number;
  steps: RemoteGatewaySmokeStep[];
  rustdeskClientConfig?: {
    apiServer: string;
    idServer: string;
    manualKey: string;
    relayServer: string;
    publicKeyConfigured: boolean;
    publicKeySource: string;
    serverKeyFingerprint: string;
  };
  rustdeskLaunchPlan?: {
    status: string;
    canLaunch: boolean;
    rustdeskId: string;
    apiServer: string;
    idServer: string;
    protocolUrl: string;
    serverKeyFingerprint: string;
  };
  rustdeskEndedLaunchPlan?: {
    status: string;
    canLaunch: boolean;
  };
  rustdeskEndedLaunchUrlRejected?: boolean;
  rustdeskRegisteredDevice?: {
    deviceId: string;
    rustdeskId: string;
    displayName: string;
    runtimeStatus: string;
    lastSeenAt: string;
    lastSeenActor: string;
    businessRefType: string;
    businessRefId: string;
  };
  rustdeskEndRetried?: boolean;
  rustdeskEndedEventRejected?: boolean;
  rustdeskEndedEventAuditClean?: boolean;
  rustdeskAuditProbe?: {
    eventType: string;
    target: string;
  };
  rustdeskOperationProbe?: {
    eventTypes: string[];
  };
  rustdeskSessionList?: {
    tenantId: string;
    activeFound: boolean;
    endedFound: boolean;
  };
  rustdeskRuntimePorts?: {
    host: string;
    checked: number[];
    udpChecked: number[];
  };
  launchChecked?: boolean;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const allowedScopes = new Set<RemoteConsentScope>([
  'view_screen',
  'control_mouse_keyboard',
  'record_screen',
  'transfer_file',
  'clipboard'
]);

export function createRemoteGatewaySmokeConfigFromEnv(env: NodeJS.ProcessEnv): RemoteGatewaySmokeConfig {
  const provider = parseProvider(resolveBrandEnv(env, 'REMOTE_GATEWAY_PROVIDER') || '');
  const isRustDesk = provider === 'rustdesk';
  const rustdeskBaseUrl = resolveBrandEnv(env, 'RUSTDESK_CONTROL_PLANE_BASE_URL') || '';
  const remoteGatewayBaseUrl = resolveBrandEnv(env, 'REMOTE_GATEWAY_BASE_URL') || '';
  const baseUrlSource = isRustDesk && rustdeskBaseUrl ? 'CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL' : 'CONVERACT_REMOTE_GATEWAY_BASE_URL';
  const rawBaseUrl = (isRustDesk ? rustdeskBaseUrl : '') || remoteGatewayBaseUrl || '';
  const apiToken = (isRustDesk ? resolveBrandEnv(env, 'RUSTDESK_API_TOKEN') : '') || resolveBrandEnv(env, 'REMOTE_GATEWAY_API_TOKEN') || '';
  const tenantId = resolveBrandEnv(env, 'REMOTE_GATEWAY_TENANT_ID') || resolveBrandEnv(env, 'RUSTDESK_EDGE_TENANT_ID') || resolveBrandEnv(env, 'TENANT_ID') || undefined;
  const collaborationApiKey = resolveBrandEnv(env, 'COLLABORATION_API_KEY') || resolveBrandEnv(env, 'API_KEY') || undefined;
  const rustdeskCheckDeviceOnline = envFlag(resolveBrandEnv(env, 'RUSTDESK_CHECK_DEVICE_ONLINE'));
  const targetId = resolveBrandEnv(env, 'REMOTE_GATEWAY_TARGET_ID') || '';

  if (!rawBaseUrl) throw new Error(isRustDesk ? 'CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL or CONVERACT_REMOTE_GATEWAY_BASE_URL is required' : 'CONVERACT_REMOTE_GATEWAY_BASE_URL is required');
  const baseUrl = normalizeRemoteGatewayBaseUrl(rawBaseUrl, baseUrlSource);
  if (!apiToken) throw new Error(isRustDesk ? 'CONVERACT_RUSTDESK_API_TOKEN or CONVERACT_REMOTE_GATEWAY_API_TOKEN is required' : 'CONVERACT_REMOTE_GATEWAY_API_TOKEN is required');
  if (!targetId) throw new Error('CONVERACT_REMOTE_GATEWAY_TARGET_ID is required');
  if (rustdeskCheckDeviceOnline && !tenantId) {
    throw new Error('CONVERACT_REMOTE_GATEWAY_TENANT_ID, CONVERACT_RUSTDESK_EDGE_TENANT_ID, or CONVERACT_TENANT_ID is required when CONVERACT_RUSTDESK_CHECK_DEVICE_ONLINE=1');
  }
  if (rustdeskCheckDeviceOnline && !collaborationApiKey) throw new Error('CONVERACT_API_KEY or CONVERACT_COLLABORATION_API_KEY is required when CONVERACT_RUSTDESK_CHECK_DEVICE_ONLINE=1');

  return {
    provider,
    baseUrl,
    apiToken,
    tenantId,
    collaborationApiKey,
    actorIdentity: resolveBrandEnv(env, 'REMOTE_GATEWAY_ACTOR_IDENTITY') || 'agent_remote_gateway_smoke',
    target: {
      type: resolveBrandEnv(env, 'REMOTE_GATEWAY_TARGET_TYPE') || (provider === 'guacamole' ? 'connection' : 'device'),
      id: targetId,
      display_name: resolveBrandEnv(env, 'REMOTE_GATEWAY_TARGET_DISPLAY_NAME') || undefined
    },
    permissions: splitScopes(resolveBrandEnv(env, 'REMOTE_GATEWAY_CONSENT_SCOPES')),
    checkLaunchUrl: envFlag(resolveBrandEnv(env, 'REMOTE_GATEWAY_CHECK_LAUNCH_URL')),
    createPath: resolveBrandEnv(env, 'REMOTE_GATEWAY_CREATE_PATH') || undefined,
    sessionPath: resolveBrandEnv(env, 'REMOTE_GATEWAY_SESSION_PATH') || undefined,
    auditPath: resolveBrandEnv(env, 'REMOTE_GATEWAY_AUDIT_PATH') || undefined,
    rustdeskCheckServerPorts: envFlag(resolveBrandEnv(env, 'RUSTDESK_CHECK_SERVER_PORTS')),
    rustdeskCheckHost: resolveBrandEnv(env, 'RUSTDESK_CHECK_HOST') || resolveBrandEnv(env, 'RUSTDESK_ID_SERVER') || undefined,
    rustdeskCheckTcpPorts: splitPorts(resolveBrandEnv(env, 'RUSTDESK_CHECK_TCP_PORTS'), 'TCP'),
    rustdeskCheckUdpPorts: splitPorts(resolveBrandEnv(env, 'RUSTDESK_CHECK_UDP_PORTS'), 'UDP'),
    rustdeskCheckTimeoutMs: parseRustDeskMilliseconds(
      resolveBrandEnv(env, 'RUSTDESK_CHECK_TIMEOUT_MS'),
      'CONVERACT_RUSTDESK_CHECK_TIMEOUT_MS',
      1500
    ),
    rustdeskRequireProtocolUrl: envFlag(resolveBrandEnv(env, 'RUSTDESK_REQUIRE_PROTOCOL_URL')),
    rustdeskCheckDeviceOnline,
    rustdeskCheckOperationAudit: resolveBrandEnv(env, 'RUSTDESK_CHECK_OPERATION_AUDIT') === undefined
      ? true
      : envFlag(resolveBrandEnv(env, 'RUSTDESK_CHECK_OPERATION_AUDIT')),
    rustdeskDeviceOnlineTtlMs: parseRustDeskMilliseconds(
      resolveBrandEnv(env, 'RUSTDESK_DEVICE_ONLINE_TTL_MS'),
      'CONVERACT_RUSTDESK_DEVICE_ONLINE_TTL_MS',
      300_000
    )
  };
}

function normalizeRemoteGatewayBaseUrl(rawBaseUrl: string, envName: string): string {
  const baseUrl = rawBaseUrl.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`${envName} must be a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${envName} must use http(s)`);
  }
  return baseUrl;
}

function parseRustDeskMilliseconds(rawMilliseconds: string | undefined, envName: string, defaultMilliseconds: number): number {
  if (rawMilliseconds === undefined || rawMilliseconds.trim() === '') return defaultMilliseconds;
  const milliseconds = Number(rawMilliseconds);
  if (!Number.isFinite(milliseconds) || milliseconds < 100) {
    throw new Error(`${envName} must be a number >= 100`);
  }
  return milliseconds;
}

export async function runRemoteGatewaySmoke(
  config: RemoteGatewaySmokeConfig,
  fetchImpl: FetchLike = fetch
): Promise<RemoteGatewaySmokeResult> {
  const steps: RemoteGatewaySmokeStep[] = [];
  let activeStep = 'gateway_request';
  const client = createGatewayClient(config, async (input, init) => {
    const response = await fetchImpl(input, init);
    steps.push({ name: activeStep, status: response.status });
    return response;
  });

  const rustdeskClientConfig = config.provider === 'rustdesk'
    ? await fetchRustDeskClientConfig(config, fetchImpl, steps)
    : undefined;
  const rustdeskRuntimePorts = config.provider === 'rustdesk' && config.rustdeskCheckServerPorts
    ? await checkRustDeskRuntimePorts(config, rustdeskClientConfig, steps)
    : undefined;
  const rustdeskRegisteredDevice = config.provider === 'rustdesk' && config.rustdeskCheckDeviceOnline
    ? await checkRustDeskRegisteredDevice(config, fetchImpl, steps)
    : undefined;
  const gatewayTarget: RemoteGatewayTarget = rustdeskRegisteredDevice
    ? {
      type: 'device',
      id: rustdeskRegisteredDevice.rustdeskId,
      display_name: config.target.display_name || rustdeskRegisteredDevice.displayName
    }
    : config.target;

  let session: ReturnType<typeof normalizeRemoteGatewaySession> | undefined;
  let endAttempted = false;
  activeStep = 'create_gateway_session';
  try {
    session = normalizeRemoteGatewaySession(await client.createSession({
      target: gatewayTarget,
      permissions: config.permissions,
      actor_identity: config.actorIdentity,
      metadata: rustDeskSmokeMetadata(config, rustdeskRegisteredDevice)
    }));

    const rustdeskLaunchPlan = config.provider === 'rustdesk'
      ? await checkRustDeskLaunchPlan(
        config,
        session,
        rustdeskClientConfig,
        fetchImpl,
        steps,
        rustdeskRegisteredDevice?.rustdeskId || config.target.id
      )
      : undefined;
    const activeSessionList = config.provider === 'rustdesk' && config.tenantId
      ? await checkRustDeskSessionList(config, session.external_id, 'active', fetchImpl, steps)
      : undefined;
    const launchChecked = config.checkLaunchUrl
      ? await checkLaunchUrl(session.launch_url, fetchImpl, steps, {
        rustdeskExternalId: config.provider === 'rustdesk' ? session.external_id : ''
      })
      : undefined;
    const rustdeskAuditProbe = config.provider === 'rustdesk'
      ? await postRustDeskAuditProbe(config, session, fetchImpl, steps)
      : undefined;
    const rustdeskOperationProbe = config.provider === 'rustdesk' && config.rustdeskCheckOperationAudit
      ? await postRustDeskOperationProbe(config, session, fetchImpl, steps)
      : undefined;

    activeStep = 'list_gateway_audit';
    const auditEvents = await client.listAuditEvents({ external_id: session.external_id });
    assertGatewayAuditContainsSessionEvent(
      session.external_id,
      auditEvents,
      'remote.gateway_session.created',
      'created'
    );
    if (rustdeskAuditProbe) {
      assertGatewayAuditContainsSessionEvent(
        session.external_id,
        auditEvents,
        rustdeskAuditProbe.eventType,
        'RustDesk smoke probe'
      );
      assertRustDeskAuditProbeIsIdempotent(session.external_id, auditEvents, rustdeskAuditProbe.eventType);
    }
    if (rustdeskOperationProbe) {
      for (const eventType of rustdeskOperationProbe.eventTypes) {
        assertGatewayAuditContainsSessionEvent(
          session.external_id,
          auditEvents,
          eventType,
          `RustDesk operation ${eventType}`
        );
      }
    }

    activeStep = 'end_gateway_session';
    endAttempted = true;
    await client.endSession({
      external_id: session.external_id,
      actor_identity: config.actorIdentity
    });

    activeStep = 'list_gateway_audit_after_end';
    const finalAuditEvents = await client.listAuditEvents({ external_id: session.external_id });
    assertGatewayAuditContainsSessionEvent(
      session.external_id,
      finalAuditEvents,
      'remote.gateway_session.ended',
      'ended'
    );
    const endedSessionList = config.provider === 'rustdesk' && config.tenantId
      ? await checkRustDeskSessionList(config, session.external_id, 'ended', fetchImpl, steps)
      : undefined;
    const rustdeskEndedLaunchPlan = config.provider === 'rustdesk'
      ? await checkRustDeskEndedLaunchPlan(config, session.external_id, fetchImpl, steps)
      : undefined;
    const rustdeskEndedLaunchUrlRejected = config.provider === 'rustdesk' && config.checkLaunchUrl
      ? await checkRustDeskEndedLaunchUrlRejected(session.launch_url, fetchImpl, steps)
      : undefined;
    let rustdeskEndRetried: boolean | undefined;
    if (config.provider === 'rustdesk') {
      activeStep = 'rustdesk_end_gateway_session_retry';
      await client.endSession({
        external_id: session.external_id,
        actor_identity: config.actorIdentity
      });
      rustdeskEndRetried = true;
    }
    let rustdeskEndedEventRejected: boolean | undefined;
    let rustdeskEndedEventAuditClean: boolean | undefined;
    if (config.provider === 'rustdesk') {
      const endedEventCheck = await checkRustDeskEndedEventRejected(config, session, fetchImpl, steps);
      rustdeskEndedEventRejected = endedEventCheck.rejected;
      rustdeskEndedEventAuditClean = endedEventCheck.auditClean;
    }

    return {
      provider: config.provider,
      externalId: session.external_id,
      launchUrl: session.launch_url,
      auditEvents: finalAuditEvents.length,
      steps,
      rustdeskClientConfig,
      rustdeskLaunchPlan,
      rustdeskEndedLaunchPlan,
      rustdeskEndedLaunchUrlRejected,
      rustdeskRegisteredDevice,
      rustdeskEndRetried,
      rustdeskEndedEventRejected,
      rustdeskEndedEventAuditClean,
      rustdeskAuditProbe,
      rustdeskOperationProbe,
      rustdeskSessionList: config.tenantId && activeSessionList && endedSessionList
        ? {
          tenantId: config.tenantId,
          activeFound: activeSessionList,
          endedFound: endedSessionList
        }
        : undefined,
      rustdeskRuntimePorts,
      launchChecked
    };
  } catch (error) {
    const cleanupExternalId = session?.external_id || errorExternalId(error);
    if (cleanupExternalId && !endAttempted) {
      activeStep = 'cleanup_gateway_session';
      try {
        await client.endSession({
          external_id: cleanupExternalId,
          actor_identity: config.actorIdentity
        });
      } catch (cleanupError) {
        throw new Error(`${errorMessage(error)}; cleanup failed: ${errorMessage(cleanupError)}`);
      }
    }
    throw error;
  }
}

function rustDeskSmokeMetadata(
  config: RemoteGatewaySmokeConfig,
  registeredDevice?: NonNullable<RemoteGatewaySmokeResult['rustdeskRegisteredDevice']>
): Record<string, unknown> {
  return {
    source: 'remote-gateway-smoke',
    ...(config.provider === 'rustdesk' && config.tenantId ? { tenant_id: config.tenantId } : {}),
    ...(registeredDevice
      ? {
        rustdesk_target_mode: 'registered_device',
        rustdesk_device_id: registeredDevice.deviceId,
        rustdesk_id: registeredDevice.rustdeskId,
        target_id: registeredDevice.deviceId,
        target_display_name: registeredDevice.displayName,
        rustdesk_device_runtime_status: registeredDevice.runtimeStatus,
        rustdesk_device_last_seen_at: registeredDevice.lastSeenAt,
        rustdesk_device_last_seen_actor: registeredDevice.lastSeenActor,
        business_ref_type: registeredDevice.businessRefType,
        business_ref_id: registeredDevice.businessRefId
      }
      : {})
  };
}

function assertGatewayAuditContainsSessionEvent(
  externalId: string,
  auditEvents: RemoteGatewayAuditEvent[],
  eventType: string,
  label: string
): void {
  if (auditEvents.length === 0) {
    throw new Error('remote gateway audit events are required');
  }
  const hasSessionEvent = auditEvents.some(
    (event) => event.external_id === externalId && event.event_type === eventType
  );
  if (!hasSessionEvent) {
    throw new Error(`remote gateway audit must include the ${label} session event`);
  }
}

function assertRustDeskAuditProbeIsIdempotent(
  externalId: string,
  auditEvents: RemoteGatewayAuditEvent[],
  eventType: string
): void {
  const probeEvents = auditEvents.filter(
    (event) => event.external_id === externalId && event.event_type === eventType
  );
  if (probeEvents.length !== 1) {
    throw new Error('RustDesk smoke probe audit event must be idempotent');
  }
}

async function postRustDeskAuditProbe(
  config: RemoteGatewaySmokeConfig,
  session: ReturnType<typeof normalizeRemoteGatewaySession>,
  fetchImpl: FetchLike,
  steps: RemoteGatewaySmokeStep[]
): Promise<NonNullable<RemoteGatewaySmokeResult['rustdeskAuditProbe']>> {
  const eventType = 'remote.rustdesk.smoke.probe';
  const target = String(session.metadata.target_id || config.target.id);
  const url = `${config.baseUrl.replace(/\/+$/, '')}/api/opc/rustdesk/sessions/${encodeURIComponent(session.external_id)}/events`;
  const payload = {
    event_type: eventType,
    actor_identity: config.actorIdentity,
    target,
    idempotency_key: `remote-gateway-smoke:${session.external_id}:probe`,
    metadata: { source: 'remote-gateway-smoke' }
  };
  await postRustDeskAuditProbeAttempt(url, payload, config.apiToken, session.external_id, target, fetchImpl, steps, 'rustdesk_audit_probe');
  await postRustDeskAuditProbeAttempt(url, payload, config.apiToken, session.external_id, target, fetchImpl, steps, 'rustdesk_audit_probe_retry');
  return { eventType, target };
}

async function postRustDeskOperationProbe(
  config: RemoteGatewaySmokeConfig,
  session: ReturnType<typeof normalizeRemoteGatewaySession>,
  fetchImpl: FetchLike,
  steps: RemoteGatewaySmokeStep[]
): Promise<NonNullable<RemoteGatewaySmokeResult['rustdeskOperationProbe']>> {
  const target = String(session.metadata.target_id || config.target.id);
  const url = `${config.baseUrl.replace(/\/+$/, '')}/api/opc/rustdesk/sessions/${encodeURIComponent(session.external_id)}/events`;
  const events = [
    {
      stepName: 'rustdesk_operation_control_probe',
      payload: {
        event_type: 'remote.rustdesk.control_action.performed',
        actor_identity: config.actorIdentity,
        target,
        idempotency_key: `remote-gateway-smoke:${session.external_id}:control-action`,
        metadata: {
          source: 'remote-gateway-smoke',
          operation_id: `smoke-control-${session.external_id}`,
          action: 'mouse_click',
          permission: 'control_mouse_keyboard'
        }
      }
    },
    {
      stepName: 'rustdesk_operation_file_transfer_probe',
      payload: {
        event_type: 'remote.rustdesk.file_transfer.started',
        actor_identity: config.actorIdentity,
        target,
        idempotency_key: `remote-gateway-smoke:${session.external_id}:file-transfer`,
        metadata: {
          source: 'remote-gateway-smoke',
          transfer_id: `smoke-transfer-${session.external_id}`,
          file_name: 'remote-gateway-smoke.txt',
          direction: 'upload'
        }
      }
    },
    {
      stepName: 'rustdesk_operation_file_transfer_completed_probe',
      payload: {
        event_type: 'remote.rustdesk.file_transfer.completed',
        actor_identity: config.actorIdentity,
        target,
        idempotency_key: `remote-gateway-smoke:${session.external_id}:file-transfer-completed`,
        metadata: {
          source: 'remote-gateway-smoke',
          transfer_id: `smoke-transfer-${session.external_id}`,
          file_name: 'remote-gateway-smoke.txt',
          direction: 'upload',
          status: 'completed'
        }
      }
    },
    {
      stepName: 'rustdesk_operation_recording_probe',
      payload: {
        event_type: 'remote.rustdesk.recording.started',
        actor_identity: config.actorIdentity,
        target,
        idempotency_key: `remote-gateway-smoke:${session.external_id}:recording`,
        metadata: {
          source: 'remote-gateway-smoke',
          recording_id: `smoke-recording-${session.external_id}`,
          evidence_type: 'screen_recording'
        }
      }
    },
    {
      stepName: 'rustdesk_operation_recording_stopped_probe',
      payload: {
        event_type: 'remote.rustdesk.recording.stopped',
        actor_identity: config.actorIdentity,
        target,
        idempotency_key: `remote-gateway-smoke:${session.external_id}:recording-stopped`,
        metadata: {
          source: 'remote-gateway-smoke',
          recording_id: `smoke-recording-${session.external_id}`,
          evidence_type: 'screen_recording',
          status: 'stopped'
        }
      }
    },
    {
      stepName: 'rustdesk_operation_clipboard_probe',
      payload: {
        event_type: 'remote.rustdesk.clipboard.synced',
        actor_identity: config.actorIdentity,
        target,
        idempotency_key: `remote-gateway-smoke:${session.external_id}:clipboard`,
        metadata: {
          source: 'remote-gateway-smoke',
          clipboard_id: `smoke-clipboard-${session.external_id}`,
          direction: 'agent_to_device',
          format: 'text'
        }
      }
    }
  ];

  for (const event of events) {
    await postRustDeskAuditProbeAttempt(
      url,
      event.payload,
      config.apiToken,
      session.external_id,
      target,
      fetchImpl,
      steps,
      event.stepName
    );
  }

  return { eventTypes: events.map((event) => String(event.payload.event_type)) };
}

async function checkRustDeskEndedEventRejected(
  config: RemoteGatewaySmokeConfig,
  session: ReturnType<typeof normalizeRemoteGatewaySession>,
  fetchImpl: FetchLike,
  steps: RemoteGatewaySmokeStep[]
): Promise<{ rejected: boolean; auditClean: boolean }> {
  const target = String(session.metadata.target_id || config.target.id);
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const idempotencyKey = `remote-gateway-smoke:${session.external_id}:after-end-file-transfer`;
  const transferId = `smoke-after-end-transfer-${session.external_id}`;
  const response = await fetchImpl(`${baseUrl}/api/opc/rustdesk/sessions/${encodeURIComponent(session.external_id)}/events`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      event_type: 'remote.rustdesk.file_transfer.started',
      actor_identity: config.actorIdentity,
      target,
      idempotency_key: idempotencyKey,
      metadata: {
        source: 'remote-gateway-smoke',
        transfer_id: transferId,
        direction: 'upload'
      }
    })
  });
  steps.push({ name: 'rustdesk_ended_event_rejected', status: response.status });
  if (response.status !== 409) {
    throw new Error(`RustDesk ended session event check must be rejected with status 409, got ${response.status}`);
  }
  const auditResponse = await fetchImpl(`${baseUrl}/api/opc/rustdesk/sessions/${encodeURIComponent(session.external_id)}/audit`, {
    method: 'GET',
    headers: { authorization: `Bearer ${config.apiToken}` }
  });
  steps.push({ name: 'rustdesk_ended_event_audit_clean', status: auditResponse.status });
  if (!auditResponse.ok) {
    throw new Error(`RustDesk ended event audit cleanliness check failed with status ${auditResponse.status}`);
  }
  const auditBody = await auditResponse.json() as Record<string, unknown>;
  const auditEvents = Array.isArray(auditBody.events) ? auditBody.events : [];
  const leaked = auditEvents.some((event) => {
    const row = (event || {}) as Record<string, unknown>;
    const metadata = typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {};
    return String(row.external_id || session.external_id) === session.external_id
      && String(row.event_type || '') === 'remote.rustdesk.file_transfer.started'
      && (
        String(row.idempotency_key || '') === idempotencyKey
        || String(metadata.idempotency_key || '') === idempotencyKey
        || String(metadata.transfer_id || '') === transferId
      );
  });
  if (leaked) {
    throw new Error('RustDesk ended session rejected event must not appear in audit');
  }
  return { rejected: true, auditClean: true };
}

async function postRustDeskAuditProbeAttempt(
  url: string,
  payload: Record<string, unknown>,
  apiToken: string,
  externalId: string,
  target: string,
  fetchImpl: FetchLike,
  steps: RemoteGatewaySmokeStep[],
  stepName: string
): Promise<void> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  steps.push({ name: stepName, status: response.status });
  if (!response.ok) {
    throw new Error(`RustDesk audit probe check failed with status ${response.status}`);
  }
  const body = await response.json() as Record<string, unknown>;
  const rawEvent = typeof body.event === 'object' && body.event !== null && !Array.isArray(body.event)
    ? body.event as Record<string, unknown>
    : body;
  const returnedExternalId = String(rawEvent.external_id || externalId);
  const returnedEventType = String(rawEvent.event_type || '');
  const returnedTarget = String(rawEvent.target || '');
  if (returnedExternalId !== externalId) {
    throw new Error('RustDesk audit probe external_id must match created session');
  }
  if (returnedEventType !== String(payload.event_type || '')) {
    throw new Error('RustDesk audit probe event_type must match request');
  }
  if (returnedTarget !== target) {
    throw new Error('RustDesk audit probe target must match request');
  }
}

async function checkRustDeskSessionList(
  config: RemoteGatewaySmokeConfig,
  externalId: string,
  status: 'active' | 'ended',
  fetchImpl: FetchLike,
  steps: RemoteGatewaySmokeStep[]
): Promise<boolean> {
  const tenantId = String(config.tenantId || '').trim();
  const url = `${config.baseUrl.replace(/\/+$/, '')}/api/opc/rustdesk/sessions?tenant_id=${encodeURIComponent(tenantId)}&status=${status}&limit=50`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${config.apiToken}` }
  });
  steps.push({ name: `rustdesk_list_${status}_sessions`, status: response.status });
  if (!response.ok) {
    throw new Error(`RustDesk ${status} session list check failed with status ${response.status}`);
  }
  const body = await response.json() as Record<string, unknown>;
  const sessions = Array.isArray(body.sessions) ? body.sessions : [];
  const found = sessions.some((session) => {
    const row = (session || {}) as Record<string, unknown>;
    return String(row.external_id || '') === externalId && String(row.status || '') === status;
  });
  if (!found) {
    throw new Error(`RustDesk session list must include ${status} session`);
  }
  return true;
}

async function checkRustDeskRegisteredDevice(
  config: RemoteGatewaySmokeConfig,
  fetchImpl: FetchLike,
  steps: RemoteGatewaySmokeStep[]
): Promise<NonNullable<RemoteGatewaySmokeResult['rustdeskRegisteredDevice']>> {
  const tenantId = String(config.tenantId || '').trim();
  if (!tenantId) {
    throw new Error('CONVERACT_REMOTE_GATEWAY_TENANT_ID, CONVERACT_RUSTDESK_EDGE_TENANT_ID, or CONVERACT_TENANT_ID is required when CONVERACT_RUSTDESK_CHECK_DEVICE_ONLINE=1');
  }
  if (config.target.type !== 'device') throw new Error('RustDesk registered device smoke requires target type device');
  const url = `${config.baseUrl.replace(/\/+$/, '')}/api/collaboration/rustdesk/devices/${encodeURIComponent(config.target.id)}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: collaborationAuthHeaders(config, tenantId)
  });
  steps.push({ name: 'rustdesk_registered_device', status: response.status });
  if (!response.ok) {
    throw new Error(`RustDesk registered device check failed with status ${response.status}`);
  }
  const body = await response.json() as Record<string, unknown>;
  const rawDevice = typeof body.data === 'object' && body.data !== null && !Array.isArray(body.data)
    ? body.data as Record<string, unknown>
    : body;
  const deviceId = String(rawDevice.id || '').trim();
  const rustdeskId = String(rawDevice.rustdesk_id || '').trim();
  const displayName = String(rawDevice.display_name || config.target.display_name || '').trim();
  const status = String(rawDevice.status || '').trim();
  const runtimeStatus = String(rawDevice.runtime_status || '').trim();
  const lastSeenAt = String(rawDevice.last_seen_at || '').trim();
  const lastSeenActor = String(rawDevice.last_seen_actor || '').trim();
  const lastSeenMs = lastSeenAt ? new Date(lastSeenAt).getTime() : NaN;
  if (deviceId !== config.target.id) {
    throw new Error('RustDesk registered device id must match target id');
  }
  if (!rustdeskId) {
    throw new Error('RustDesk registered device rustdesk_id is required');
  }
  if (status !== 'active') {
    throw new Error('RustDesk registered device must be active');
  }
  if (runtimeStatus !== 'online' || Number.isNaN(lastSeenMs)) {
    throw new Error('RustDesk registered device must be online');
  }
  if (Date.now() - lastSeenMs > rustDeskDeviceOnlineTtlMs(config)) {
    throw new Error('RustDesk registered device online heartbeat is stale');
  }
  return {
    deviceId,
    rustdeskId,
    displayName,
    runtimeStatus,
    lastSeenAt,
    lastSeenActor,
    businessRefType: String(rawDevice.business_ref_type || ''),
    businessRefId: String(rawDevice.business_ref_id || '')
  };
}

function collaborationAuthHeaders(config: RemoteGatewaySmokeConfig, tenantId: string): Record<string, string> {
  return {
    authorization: `Bearer ${config.apiToken}`,
    ...(config.collaborationApiKey ? { 'x-api-key': config.collaborationApiKey } : {}),
    'x-tenant-id': tenantId,
    'x-user-id': config.actorIdentity
  };
}

function rustDeskDeviceOnlineTtlMs(config: RemoteGatewaySmokeConfig): number {
  const value = Number(config.rustdeskDeviceOnlineTtlMs || 300_000);
  return Number.isFinite(value) && value > 0 ? value : 300_000;
}

async function fetchRustDeskClientConfig(
  config: RemoteGatewaySmokeConfig,
  fetchImpl: FetchLike,
  steps: RemoteGatewaySmokeStep[]
): Promise<NonNullable<RemoteGatewaySmokeResult['rustdeskClientConfig']>> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/api/opc/rustdesk/client-config`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${config.apiToken}` }
  });
  steps.push({ name: 'rustdesk_client_config', status: response.status });
  if (!response.ok) {
    throw new Error(`RustDesk client config check failed with status ${response.status}`);
  }
  const body = await response.json() as Record<string, unknown>;
  const idServer = String(body.id_server || '').trim();
  const relayServer = String(body.relay_server || '').trim();
  const apiServer = String(body.api_server || '').trim();
  const publicKey = String(body.public_key || '').trim();
  const publicKeyConfigured = body.public_key_configured === true;
  const publicKeySource = String(body.public_key_source || '').trim();
  const publicKeyFile = String(body.public_key_file || '').trim();
  const serverKeyFingerprint = String(body.server_key_fingerprint || '').trim();
  const manualFields = typeof body.manual_fields === 'object' && body.manual_fields !== null && !Array.isArray(body.manual_fields)
    ? body.manual_fields as Record<string, unknown>
    : {};
  const manualIdServer = String(manualFields.id_server || '').trim();
  const manualRelayServer = String(manualFields.relay_server || '').trim();
  const manualApiServer = String(manualFields.api_server || '').trim();
  const manualKey = String(manualFields.key || '').trim();
  if (!idServer) throw new Error('RustDesk client config id_server is required');
  if (!publicKeyConfigured && publicKeyFile) throw new Error(`RustDesk client config public key file cannot be read: ${publicKeyFile}`);
  if (!publicKeyConfigured) throw new Error('RustDesk client config public key is not configured');
  if (!publicKey) throw new Error('RustDesk client config public_key is required');
  if (!serverKeyFingerprint) throw new Error('RustDesk client config server_key_fingerprint is required');
  if (!manualIdServer) throw new Error('RustDesk client config manual_fields.id_server is required');
  if (!manualKey) throw new Error('RustDesk client config manual_fields.key is required');
  if (manualIdServer !== idServer) throw new Error('RustDesk client config manual_fields.id_server must match id_server');
  if (relayServer && manualRelayServer !== relayServer) throw new Error('RustDesk client config manual_fields.relay_server must match relay_server');
  if (apiServer && manualApiServer !== apiServer) throw new Error('RustDesk client config manual_fields.api_server must match api_server');
  if (publicKey && manualKey !== publicKey) throw new Error('RustDesk client config manual_fields.key must match public_key');
  return {
    apiServer,
    idServer,
    manualKey,
    relayServer,
    publicKeyConfigured,
    publicKeySource,
    serverKeyFingerprint
  };
}

async function checkRustDeskRuntimePorts(
  config: RemoteGatewaySmokeConfig,
  clientConfig: NonNullable<RemoteGatewaySmokeResult['rustdeskClientConfig']> | undefined,
  steps: RemoteGatewaySmokeStep[]
): Promise<NonNullable<RemoteGatewaySmokeResult['rustdeskRuntimePorts']>> {
  const host = normalizeHost(config.rustdeskCheckHost || clientConfig?.idServer || '');
  if (!host) throw new Error('CONVERACT_RUSTDESK_CHECK_HOST or CONVERACT_RUSTDESK_ID_SERVER is required for RustDesk port checks');
  const ports = config.rustdeskCheckTcpPorts?.length
    ? config.rustdeskCheckTcpPorts
    : [21115, 21116, 21117, 21118, 21119];
  const udpPorts = config.rustdeskCheckUdpPorts?.length
    ? config.rustdeskCheckUdpPorts
    : [21116];
  for (const port of ports) {
    await connectTcpPort(host, port, config.rustdeskCheckTimeoutMs || 1500);
    steps.push({ name: `rustdesk_tcp_port_${port}`, status: 200 });
  }
  for (const port of udpPorts) {
    await sendUdpProbe(host, port, config.rustdeskCheckTimeoutMs || 1500);
    steps.push({ name: `rustdesk_udp_port_${port}`, status: 200 });
  }
  return { host, checked: ports, udpChecked: udpPorts };
}

async function checkRustDeskLaunchPlan(
  config: RemoteGatewaySmokeConfig,
  session: ReturnType<typeof normalizeRemoteGatewaySession>,
  clientConfig: NonNullable<RemoteGatewaySmokeResult['rustdeskClientConfig']> | undefined,
  fetchImpl: FetchLike,
  steps: RemoteGatewaySmokeStep[],
  expectedRustDeskId: string
): Promise<NonNullable<RemoteGatewaySmokeResult['rustdeskLaunchPlan']>> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/api/opc/rustdesk/sessions/${encodeURIComponent(session.external_id)}/launch`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${config.apiToken}` }
  });
  steps.push({ name: 'rustdesk_launch_plan', status: response.status });
  if (!response.ok) {
    throw new Error(`RustDesk launch plan check failed with status ${response.status}`);
  }
  const body = await response.json() as Record<string, unknown>;
  const actions = typeof body.actions === 'object' && body.actions !== null && !Array.isArray(body.actions)
    ? body.actions as Record<string, unknown>
    : {};
  const runtime = typeof body.runtime === 'object' && body.runtime !== null && !Array.isArray(body.runtime)
    ? body.runtime as Record<string, unknown>
    : {};
  const target = typeof body.target === 'object' && body.target !== null && !Array.isArray(body.target)
    ? body.target as Record<string, unknown>
    : {};
  const status = String(body.status || '').trim();
  const canLaunch = actions.can_launch === true;
  const openUrl = String(actions.open_url || '').trim();
  const protocolUrl = String(actions.protocol_url || '').trim();
  const planLaunchUrl = String(body.launch_url || '').trim();
  const targetId = String(target.id || '').trim();
  const rustdeskId = String(runtime.rustdesk_id || '').trim();
  const apiServer = String(runtime.api_server || '').trim();
  const idServer = String(runtime.id_server || '').trim();
  const relayServer = String(runtime.relay_server || '').trim();
  const serverKeyFingerprint = String(runtime.server_key_fingerprint || '').trim();
  const runtimePublicKeyConfigured = String(runtime.public_key_configured || '').trim().toLowerCase();
  const planPermissions = new Set(
    (Array.isArray(body.permissions) ? body.permissions : [])
      .map((scope) => String(scope || '').trim())
      .filter(Boolean)
  );
  const launchClientConfig = typeof body.client_config === 'object' && body.client_config !== null && !Array.isArray(body.client_config)
    ? body.client_config as Record<string, unknown>
    : {};
  const launchManualFields = typeof launchClientConfig.manual_fields === 'object' && launchClientConfig.manual_fields !== null && !Array.isArray(launchClientConfig.manual_fields)
    ? launchClientConfig.manual_fields as Record<string, unknown>
    : {};
  const launchManualIdServer = String(launchManualFields.id_server || '').trim();
  const launchManualRelayServer = String(launchManualFields.relay_server || '').trim();
  const launchManualApiServer = String(launchManualFields.api_server || '').trim();
  const launchManualKey = String(launchManualFields.key || '').trim();
  if (String(body.external_id || '').trim() !== session.external_id) {
    throw new Error('RustDesk launch plan external_id must match created session');
  }
  if (status !== 'active' || !canLaunch) {
    throw new Error('RustDesk launch plan must be active and launchable');
  }
  if (planLaunchUrl !== session.launch_url || openUrl !== session.launch_url) {
    throw new Error('RustDesk launch plan launch_url must match created session launch_url');
  }
  if (targetId !== expectedRustDeskId) {
    throw new Error('RustDesk launch plan target.id must match target id');
  }
  for (const scope of config.permissions) {
    if (!planPermissions.has(scope)) {
      throw new Error(`RustDesk launch plan permissions must include requested scope ${scope}`);
    }
  }
  if (rustdeskId !== expectedRustDeskId) {
    throw new Error('RustDesk launch plan runtime rustdesk_id must match target id');
  }
  if (idServer !== clientConfig?.idServer) {
    throw new Error('RustDesk launch plan runtime id_server must match client config');
  }
  if (clientConfig.relayServer && relayServer !== clientConfig.relayServer) {
    throw new Error('RustDesk launch plan runtime relay_server must match client config');
  }
  if (clientConfig.apiServer && apiServer !== clientConfig.apiServer) {
    throw new Error('RustDesk launch plan runtime api_server must match client config');
  }
  if (clientConfig.serverKeyFingerprint && serverKeyFingerprint !== clientConfig.serverKeyFingerprint) {
    throw new Error('RustDesk launch plan runtime server_key_fingerprint must match client config');
  }
  if (!launchManualIdServer) {
    throw new Error('RustDesk launch plan client_config.manual_fields.id_server is required');
  }
  if (!launchManualKey) {
    throw new Error('RustDesk launch plan client_config.manual_fields.key is required');
  }
  if (clientConfig?.publicKeyConfigured && (launchClientConfig.public_key_configured !== true || runtimePublicKeyConfigured !== 'true')) {
    throw new Error('RustDesk launch plan public key must be configured');
  }
  if (launchManualIdServer !== clientConfig.idServer) {
    throw new Error('RustDesk launch plan client_config.manual_fields.id_server must match client config');
  }
  if (clientConfig.relayServer && launchManualRelayServer !== clientConfig.relayServer) {
    throw new Error('RustDesk launch plan client_config.manual_fields.relay_server must match client config');
  }
  if (clientConfig.apiServer && launchManualApiServer !== clientConfig.apiServer) {
    throw new Error('RustDesk launch plan client_config.manual_fields.api_server must match client config');
  }
  if (clientConfig.manualKey && launchManualKey !== clientConfig.manualKey) {
    throw new Error('RustDesk launch plan client_config.manual_fields.key must match client config');
  }
  if (config.rustdeskRequireProtocolUrl && !protocolUrl) {
    throw new Error('RustDesk launch plan protocol_url is required');
  }
  if (config.rustdeskRequireProtocolUrl && !isRustDeskProtocolUrl(protocolUrl)) {
    throw new Error('RustDesk launch plan protocol_url must use the rustdesk scheme');
  }
  if (config.rustdeskRequireProtocolUrl && !containsEncodedValue(protocolUrl, rustdeskId)) {
    throw new Error('RustDesk launch plan protocol_url must reference the target RustDesk ID');
  }
  return { status, canLaunch, rustdeskId, apiServer, idServer, protocolUrl, serverKeyFingerprint };
}

async function checkRustDeskEndedLaunchPlan(
  config: RemoteGatewaySmokeConfig,
  externalId: string,
  fetchImpl: FetchLike,
  steps: RemoteGatewaySmokeStep[]
): Promise<NonNullable<RemoteGatewaySmokeResult['rustdeskEndedLaunchPlan']>> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/api/opc/rustdesk/sessions/${encodeURIComponent(externalId)}/launch`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${config.apiToken}` }
  });
  steps.push({ name: 'rustdesk_ended_launch_plan', status: response.status });
  if (!response.ok) {
    throw new Error(`RustDesk ended launch plan check failed with status ${response.status}`);
  }
  const body = await response.json() as Record<string, unknown>;
  const actions = typeof body.actions === 'object' && body.actions !== null && !Array.isArray(body.actions)
    ? body.actions as Record<string, unknown>
    : {};
  const status = String(body.status || '').trim();
  const canLaunch = actions.can_launch === true;
  const launchUrl = String(body.launch_url || '').trim();
  const openUrl = String(actions.open_url || '').trim();
  const protocolUrl = String(actions.protocol_url || '').trim();
  if (String(body.external_id || '').trim() !== externalId) {
    throw new Error('RustDesk ended launch plan external_id must match ended session');
  }
  if (status !== 'ended' || canLaunch) {
    throw new Error('RustDesk ended launch plan must be ended and not launchable');
  }
  if (launchUrl) {
    throw new Error('RustDesk ended launch plan launch_url must be empty');
  }
  if (openUrl || protocolUrl) {
    throw new Error('RustDesk ended launch plan actions must not expose launch URLs');
  }
  return { status, canLaunch };
}

function containsEncodedValue(value: string, expected: string): boolean {
  return Boolean(expected) && (value.includes(expected) || value.includes(encodeURIComponent(expected)));
}

function connectTcpPort(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => done(new Error(`RustDesk TCP port check timed out: ${host}:${port}`)));
    socket.once('connect', () => done());
    socket.once('error', (error) => done(new Error(`RustDesk TCP port check failed: ${host}:${port} ${error.message}`)));
  });
}

function sendUdpProbe(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    timer = setTimeout(() => done(new Error(`RustDesk UDP port probe timed out: ${host}:${port}`)), timeoutMs);
    socket.once('error', (error) => done(new Error(`RustDesk UDP port probe failed: ${host}:${port} ${error.message}`)));
    socket.send(Buffer.from('opc-rustdesk-smoke'), port, host, (error) => done(error || undefined));
  });
}

async function checkLaunchUrl(
  launchUrl: string,
  fetchImpl: FetchLike,
  steps: RemoteGatewaySmokeStep[],
  options: { rustdeskExternalId?: string } = {}
): Promise<boolean> {
  const response = await fetchImpl(launchUrl, { method: 'GET' });
  steps.push({ name: 'check_launch_url', status: response.status });
  if (!response.ok) {
    throw new Error(`remote gateway launch URL check failed with status ${response.status}`);
  }
  if (options.rustdeskExternalId) {
    const text = await response.text();
    if (!text.includes('RustDesk Remote Launch') || !text.includes(options.rustdeskExternalId)) {
      throw new Error('RustDesk launch page did not contain the expected launch content');
    }
  }
  return true;
}

async function checkRustDeskEndedLaunchUrlRejected(
  launchUrl: string,
  fetchImpl: FetchLike,
  steps: RemoteGatewaySmokeStep[]
): Promise<boolean> {
  const response = await fetchImpl(launchUrl, { method: 'GET' });
  steps.push({ name: 'rustdesk_ended_launch_url', status: response.status });
  if (response.status !== 409) {
    throw new Error(`RustDesk ended launch URL must be rejected with 409, got ${response.status}`);
  }
  return true;
}

function createGatewayClient(config: RemoteGatewaySmokeConfig, fetchImpl: typeof fetch): RemoteGatewayClient {
  const input = {
    base_url: config.baseUrl,
    api_token: config.apiToken,
    create_path: config.createPath,
    session_path: config.sessionPath,
    audit_path: config.auditPath,
    fetch: fetchImpl
  };
  if (config.provider === 'meshcentral') return createMeshCentralGatewayClient(input);
  if (config.provider === 'guacamole') return createGuacamoleGatewayClient(input);
  return createRustDeskGatewayClient(input);
}

function parseProvider(value: string): RemoteGatewayProvider {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 'rustdesk';
  if (normalized === 'meshcentral' || normalized === 'guacamole' || normalized === 'rustdesk') return normalized;
  throw new Error('CONVERACT_REMOTE_GATEWAY_PROVIDER must be meshcentral, guacamole, or rustdesk');
}

function splitScopes(raw: string | undefined): RemoteConsentScope[] {
  const scopes = (raw || 'view_screen,control_mouse_keyboard,record_screen,transfer_file,clipboard')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  for (const scope of scopes) {
    if (!allowedScopes.has(scope as RemoteConsentScope)) {
      throw new Error(`unsupported remote gateway consent scope: ${scope}`);
    }
  }
  return scopes as RemoteConsentScope[];
}

function splitPorts(raw: string | undefined, protocol: 'TCP' | 'UDP'): number[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((port) => {
      const trimmed = port.trim();
      const value = Number(trimmed);
      if (!Number.isInteger(value) || value <= 0 || value >= 65536) {
        throw new Error(`CONVERACT_RUSTDESK_CHECK_${protocol}_PORTS contains invalid ${protocol} port: ${trimmed}`);
      }
      return value;
    });
}

function normalizeHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed.includes('://') ? trimmed : `tcp://${trimmed}`).hostname;
  } catch {
    return trimmed;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorExternalId(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  return String((error as { external_id?: unknown }).external_id || '').trim();
}

function envFlag(value: string | undefined): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

async function main(): Promise<void> {
  const result = await runRemoteGatewaySmoke(createRemoteGatewaySmokeConfigFromEnv(process.env));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
