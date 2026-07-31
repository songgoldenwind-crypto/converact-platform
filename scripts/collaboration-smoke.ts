import { fileURLToPath } from 'node:url';

export interface CollaborationSmokeConfig {
  baseUrl: string;
  opcApiKey: string;
  tenantId: string;
  userId: string;
  businessRefType: string;
  businessRefId: string;
  businessRefDisplayName?: string;
  remoteMode: string;
  adapterProvider: string;
  toolProvider: string;
  toolExternalId: string;
  toolLaunchUrl: string;
  useGatewayTool?: boolean;
  gatewayTargetType?: string;
  gatewayTargetId?: string;
  gatewayTargetDisplayName?: string;
  consentScopes: string[];
  consentExpiresAt?: string;
  evidenceFilename: string;
  evidenceBody: string;
  retentionUntil?: string;
}

export interface CollaborationSmokeStep {
  name: string;
  status: number;
}

export interface CollaborationSmokeResult {
  collaborationSessionId: string;
  remoteSessionId: string;
  toolSessionId: string;
  evidenceId: string;
  steps: CollaborationSmokeStep[];
  timeline: {
    consentEvents: number;
    toolSessions: number;
    auditEvents: number;
    evidenceRecords: number;
  };
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;

export function createCollaborationSmokeConfigFromEnv(env: NodeJS.ProcessEnv): CollaborationSmokeConfig {
  const baseUrl = env.OPC_BASE_URL || '';
  const opcApiKey = env.OPC_COLLAB_SMOKE_API_KEY || env.OPC_API_KEY || '';
  const tenantId = env.OPC_COLLAB_SMOKE_TENANT_ID || env.OPC_TENANT_ID || '';

  if (!baseUrl) throw new Error('OPC_BASE_URL is required');
  if (!opcApiKey) throw new Error('OPC_COLLAB_SMOKE_API_KEY or OPC_API_KEY is required');
  if (!tenantId) throw new Error('OPC_COLLAB_SMOKE_TENANT_ID or OPC_TENANT_ID is required');

  const businessRefId =
    env.OPC_COLLAB_SMOKE_BUSINESS_REF_ID || `${tenantId}-collab-smoke-${Date.now()}`;
  const useGatewayTool = env.OPC_COLLAB_SMOKE_USE_GATEWAY_TOOL === '1';
  const gatewayTargetId = env.OPC_COLLAB_SMOKE_GATEWAY_TARGET_ID || env.OPC_REMOTE_GATEWAY_TARGET_ID || '';
  if (useGatewayTool && !gatewayTargetId) {
    throw new Error('OPC_COLLAB_SMOKE_GATEWAY_TARGET_ID or OPC_REMOTE_GATEWAY_TARGET_ID is required');
  }

  return {
    baseUrl,
    opcApiKey,
    tenantId,
    userId: env.OPC_COLLAB_SMOKE_USER_ID || 'agent_collaboration_smoke',
    businessRefType: env.OPC_COLLAB_SMOKE_BUSINESS_REF_TYPE || 'service_order',
    businessRefId,
    businessRefDisplayName: env.OPC_COLLAB_SMOKE_BUSINESS_REF_DISPLAY_NAME || 'Collaboration smoke',
    remoteMode: env.OPC_COLLAB_SMOKE_REMOTE_MODE || (useGatewayTool ? 'remote_desktop_gateway' : 'third_party_remote_tool'),
    adapterProvider: env.OPC_COLLAB_SMOKE_ADAPTER_PROVIDER || env.OPC_REMOTE_GATEWAY_PROVIDER || 'rustdesk',
    toolProvider:
      env.OPC_COLLAB_SMOKE_TOOL_PROVIDER ||
      (useGatewayTool ? env.OPC_REMOTE_GATEWAY_PROVIDER : env.OPC_COLLAB_SMOKE_ADAPTER_PROVIDER) ||
      'rustdesk',
    toolExternalId: env.OPC_COLLAB_SMOKE_TOOL_EXTERNAL_ID || `${businessRefId}-remote-tool`,
    toolLaunchUrl: env.OPC_COLLAB_SMOKE_TOOL_LAUNCH_URL || `https://remote.example/${businessRefId}`,
    useGatewayTool,
    gatewayTargetType: env.OPC_COLLAB_SMOKE_GATEWAY_TARGET_TYPE || env.OPC_REMOTE_GATEWAY_TARGET_TYPE || 'device',
    gatewayTargetId,
    gatewayTargetDisplayName:
      env.OPC_COLLAB_SMOKE_GATEWAY_TARGET_DISPLAY_NAME || env.OPC_REMOTE_GATEWAY_TARGET_DISPLAY_NAME || undefined,
    consentScopes: splitScopes(env.OPC_COLLAB_SMOKE_CONSENT_SCOPES),
    consentExpiresAt: env.OPC_COLLAB_SMOKE_CONSENT_EXPIRES_AT,
    evidenceFilename: env.OPC_COLLAB_SMOKE_EVIDENCE_FILENAME || 'remote-session.webm',
    evidenceBody: env.OPC_COLLAB_SMOKE_EVIDENCE_BODY || 'opc-collaboration-smoke-screen-recording',
    retentionUntil: env.OPC_COLLAB_SMOKE_RETENTION_UNTIL
  };
}

export async function runCollaborationSmoke(
  config: CollaborationSmokeConfig,
  fetchImpl: FetchLike = fetch
): Promise<CollaborationSmokeResult> {
  const steps: CollaborationSmokeStep[] = [];
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const headers = authHeaders(config);
  const businessRef = {
    type: config.businessRefType,
    id: config.businessRefId,
    display_name: config.businessRefDisplayName,
    metadata: { smoke: true }
  };

  const session = asRecord(await jsonRequest(fetchImpl, steps, 'create_session', `${baseUrl}/api/collaboration/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: config.businessRefDisplayName || 'Collaboration smoke',
      business_ref: businessRef,
      metadata: { source: 'collaboration-smoke' }
    })
  }, [201]));
  const collaborationSessionId = requireString(session?.id, 'collaboration session id');

  const sessionsByRef = await jsonRequest(fetchImpl, steps, 'list_sessions_by_ref', urlWithQuery(
    baseUrl,
    '/api/collaboration/sessions/by-ref',
    {
      business_ref_type: config.businessRefType,
      business_ref_id: config.businessRefId,
      limit: '5'
    }
  ), { headers });
  if (!readArray(sessionsByRef).some((item) => asRecord(item)?.id === collaborationSessionId)) {
    throw new Error('created collaboration session was not returned by business ref lookup');
  }

  const remoteSession = asRecord(await jsonRequest(
    fetchImpl,
    steps,
    'create_remote_session',
    `${baseUrl}/api/collaboration/remote-assistance/sessions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        collaboration_session_id: collaborationSessionId,
        mode: config.remoteMode,
        adapter_provider: config.adapterProvider,
        metadata: { source: 'collaboration-smoke' }
      })
    },
    [201]
  ));
  const remoteSessionId = requireString(remoteSession?.id, 'remote assistance session id');

  await expectRequestFailure(
    fetchImpl,
    steps,
    config.useGatewayTool ? 'gateway_tool_before_consent_blocked' : 'tool_before_consent_blocked',
    remoteToolUrl(baseUrl, remoteSessionId, config),
    {
      method: 'POST',
      headers,
      body: JSON.stringify(toolSessionPayload(config))
    }
  );

  await jsonRequest(fetchImpl, steps, 'request_consent', remoteActionUrl(baseUrl, remoteSessionId, 'consent/request'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      actor_identity: config.userId,
      scopes: config.consentScopes,
      expires_at: consentExpiresAt(config),
      metadata: { source: 'collaboration-smoke' }
    })
  }, [201]);

  await jsonRequest(fetchImpl, steps, 'grant_consent', remoteActionUrl(baseUrl, remoteSessionId, 'consent/grant'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      actor_identity: 'customer_collaboration_smoke',
      scopes: config.consentScopes,
      expires_at: consentExpiresAt(config),
      metadata: { source: 'collaboration-smoke' }
    })
  }, [201]);

  const toolSession = asRecord(await jsonRequest(
    fetchImpl,
    steps,
    config.useGatewayTool ? 'start_gateway_tool' : 'start_tool',
    remoteToolUrl(baseUrl, remoteSessionId, config),
    {
      method: 'POST',
      headers,
      body: JSON.stringify(toolSessionPayload(config))
    },
    [201]
  ));
  const toolSessionId = requireString(toolSession?.id, 'remote tool session id');
  if (String(toolSession?.provider || '') !== config.toolProvider) {
    throw new Error(`remote tool provider mismatch: ${String(toolSession?.provider || '')}`);
  }
  const gatewayAuditEventTypes: string[] = [];
  if (config.useGatewayTool) {
    const syncResult = asRecord(await jsonRequest(
      fetchImpl,
      steps,
      'sync_gateway_audit',
      remoteActionUrl(baseUrl, remoteSessionId, 'audit/gateway-sync'),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          actor_identity: config.userId,
          tool_session_id: toolSessionId
        })
      },
      [201]
    ));
    const synced = Number(syncResult?.synced || 0);
    const syncedEventTypes = readArray(syncResult?.events)
      .map((event) => String(asRecord(event)?.event_type || ''))
      .filter(Boolean);
    if (synced < 1 || !syncedEventTypes.length) {
      throw new Error('gateway audit sync returned no audit events');
    }
    gatewayAuditEventTypes.push(...syncedEventTypes);
  }

  await jsonRequest(fetchImpl, steps, 'record_audit', remoteActionUrl(baseUrl, remoteSessionId, 'audit'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      actor_identity: config.userId,
      event_type: 'remote.operator.note',
      target: toolSessionId,
      metadata: { source: 'collaboration-smoke', message: 'remote assistance smoke audit event' }
    })
  }, [201]);

  const evidence = asRecord(await jsonRequest(
    fetchImpl,
    steps,
    'upload_evidence',
    urlWithQuery(baseUrl, `/api/collaboration/remote-assistance/${encodeURIComponent(remoteSessionId)}/evidence/upload`, {
      kind: 'screen_recording',
      filename: config.evidenceFilename,
      ...(config.retentionUntil ? { retention_until: config.retentionUntil } : {})
    }),
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'video/webm' },
      body: config.evidenceBody
    },
    [201]
  ));
  const evidenceId = requireString(evidence?.id, 'screen recording evidence id');
  if (String(evidence?.kind || '') !== 'screen_recording') {
    throw new Error(`screen recording evidence kind mismatch: ${String(evidence?.kind || '')}`);
  }

  const timelineBeforeRevoke = asRecord(await jsonRequest(
    fetchImpl,
    steps,
    'fetch_timeline',
    remoteActionUrl(baseUrl, remoteSessionId, 'timeline'),
    { headers }
  ));
  validateTimeline(timelineBeforeRevoke, {
    remoteSessionId,
    toolProvider: config.toolProvider,
    requiredConsentEvents: ['requested', 'granted'],
    requiredAuditEvents: ['remote.evidence.recorded', ...gatewayAuditEventTypes],
    requireEvidence: true
  });

  await jsonRequest(fetchImpl, steps, 'revoke_consent', remoteActionUrl(baseUrl, remoteSessionId, 'consent/revoke'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      actor_identity: config.userId,
      scopes: config.consentScopes,
      metadata: { source: 'collaboration-smoke' }
    })
  }, [201]);

  const timelineAfterRevoke = asRecord(await jsonRequest(
    fetchImpl,
    steps,
    'fetch_timeline_after_revoke',
    remoteActionUrl(baseUrl, remoteSessionId, 'timeline'),
    { headers }
  ));
  validateTimeline(timelineAfterRevoke, {
    remoteSessionId,
    toolProvider: config.toolProvider,
    requiredConsentEvents: ['requested', 'granted', 'revoked'],
    requiredAuditEvents: ['remote.consent.revoked', 'remote.tool_session.ended', 'remote.evidence.recorded'],
    requireEvidence: true,
    requireEndedToolSessions: true
  });

  const timeline = timelineSummary(timelineAfterRevoke);
  return {
    collaborationSessionId,
    remoteSessionId,
    toolSessionId,
    evidenceId,
    steps,
    timeline
  };
}

function authHeaders(config: CollaborationSmokeConfig): Record<string, string> {
  return {
    'x-api-key': config.opcApiKey,
    'x-tenant-id': config.tenantId,
    'x-user-id': config.userId,
    'content-type': 'application/json'
  };
}

function toolSessionPayload(config: CollaborationSmokeConfig): JsonRecord {
  if (config.useGatewayTool) {
    return {
      actor_identity: config.userId,
      target: {
        type: config.gatewayTargetType || 'device',
        id: config.gatewayTargetId,
        display_name: config.gatewayTargetDisplayName
      },
      permissions: config.consentScopes,
      metadata: { source: 'collaboration-smoke' }
    };
  }
  return {
    actor_identity: config.userId,
    provider: config.toolProvider,
    external_id: config.toolExternalId,
    launch_url: config.toolLaunchUrl,
    metadata: { source: 'collaboration-smoke' }
  };
}

async function jsonRequest(
  fetchImpl: FetchLike,
  steps: CollaborationSmokeStep[],
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

async function expectRequestFailure(
  fetchImpl: FetchLike,
  steps: CollaborationSmokeStep[],
  name: string,
  url: string,
  init: RequestInit
): Promise<void> {
  const response = await fetchImpl(url, init);
  steps.push({ name, status: response.status });
  const payload = await readJson(response);
  if (response.status >= 200 && response.status < 300) {
    throw new Error(`${name} unexpectedly succeeded before active consent: ${JSON.stringify(payload)}`);
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

function urlWithQuery(baseUrl: string, path: string, query: Record<string, string>): string {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function remoteActionUrl(baseUrl: string, remoteSessionId: string, action: string): string {
  return `${baseUrl}/api/collaboration/remote-assistance/${encodeURIComponent(remoteSessionId)}/${action}`;
}

function remoteToolUrl(baseUrl: string, remoteSessionId: string, config: CollaborationSmokeConfig): string {
  return remoteActionUrl(baseUrl, remoteSessionId, config.useGatewayTool ? 'tools/gateway' : 'tools');
}

function splitScopes(value: string | undefined): string[] {
  const scopes = (value || 'view_screen,control_mouse_keyboard,record_screen')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (!scopes.length) throw new Error('OPC_COLLAB_SMOKE_CONSENT_SCOPES must include at least one scope');
  return scopes;
}

function consentExpiresAt(config: CollaborationSmokeConfig): string {
  return config.consentExpiresAt || new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requireString(value: unknown, label: string): string {
  if (typeof value === 'string' && value) return value;
  throw new Error(`${label} is required`);
}

function validateTimeline(
  timeline: JsonRecord | null,
  expected: {
    remoteSessionId: string;
    toolProvider: string;
    requiredConsentEvents: string[];
    requiredAuditEvents: string[];
    requireEvidence: boolean;
    requireEndedToolSessions?: boolean;
  }
): void {
  const session = asRecord(timeline?.session);
  if (session?.id !== expected.remoteSessionId) {
    throw new Error('timeline did not return the remote assistance session');
  }
  const consentTypes = readArray(timeline?.consent_events).map((event) => String(asRecord(event)?.event_type || ''));
  for (const eventType of expected.requiredConsentEvents) {
    if (!consentTypes.includes(eventType)) throw new Error(`timeline missing consent event: ${eventType}`);
  }
  const toolProviders = readArray(timeline?.tool_sessions).map((tool) => String(asRecord(tool)?.provider || ''));
  if (!toolProviders.includes(expected.toolProvider)) {
    throw new Error(`timeline missing remote tool provider: ${expected.toolProvider}`);
  }
  if (expected.requireEndedToolSessions) {
    const activeTools = readArray(timeline?.tool_sessions).filter((tool) => asRecord(tool)?.status !== 'ended');
    if (activeTools.length) {
      throw new Error('timeline still has active remote tool sessions after consent revoke');
    }
  }
  const auditTypes = readArray(timeline?.audit_events).map((event) => String(asRecord(event)?.event_type || ''));
  for (const eventType of expected.requiredAuditEvents) {
    if (!auditTypes.includes(eventType)) throw new Error(`timeline missing audit event: ${eventType}`);
  }
  const evidenceKinds = readArray(timeline?.evidence).map((record) => String(asRecord(record)?.kind || ''));
  if (expected.requireEvidence && !evidenceKinds.includes('screen_recording')) {
    throw new Error('timeline missing screen recording evidence');
  }
}

function timelineSummary(timeline: JsonRecord | null): CollaborationSmokeResult['timeline'] {
  return {
    consentEvents: readArray(timeline?.consent_events).length,
    toolSessions: readArray(timeline?.tool_sessions).length,
    auditEvents: readArray(timeline?.audit_events).length,
    evidenceRecords: readArray(timeline?.evidence).length
  };
}

async function main(): Promise<void> {
  const config = createCollaborationSmokeConfigFromEnv(process.env);
  const result = await runCollaborationSmoke(config);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
