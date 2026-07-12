import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

type Json = Record<string, unknown>;

interface ControlledGateway {
  externalId: string;
  remoteSessionId: string;
  deviceId: string;
  startedBy: string;
  status: 'active' | 'ended';
  scopes: string[];
  fingerprint: string;
  launchGeneration: number;
  owner: string | null;
  controlVersion: number;
  audit: Json[];
  disconnectReads: number;
}

export interface ControlledRustDeskServer {
  baseUrl: string;
  state: {
    startRequests: number;
    gateways: Map<string, ControlledGateway>;
    launchedTokens: string[];
  };
  failNextStart(): void;
  rotateFingerprint(externalId: string): void;
  close(): Promise<void>;
}

const TENANT = 'tenant-e2e';
const NOW = '2026-07-12T08:00:00.000Z';
const FINGERPRINT = 'sha256:0011223344556677';
const DEVICE = {
  id: 'device-1', tenant_id: TENANT, business_ref_type: 'service_order', business_ref_id: 'SO-100',
  rustdesk_id: '123456789', display_name: 'LED controller', status: 'active', runtime_status: 'online',
  last_seen_at: NOW, last_seen_actor: 'edge-led-1', metadata: {}, created_at: NOW, updated_at: NOW,
  deactivated_at: null
};

export async function startControlledRustDeskServer(): Promise<ControlledRustDeskServer> {
  let rejectNextStart = false;
  const state = {
    startRequests: 0,
    gateways: new Map<string, ControlledGateway>(),
    launchedTokens: [] as string[]
  };
  const server = createServer((request, response) => {
    void route(request, response, state, () => {
      if (!rejectNextStart) return false;
      rejectNextStart = false;
      return true;
    }).catch((cause) => json(response, Number((cause as { status?: number }).status || 500), {
      error: cause instanceof Error ? cause.message : String(cause)
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('controlled RustDesk server failed to bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    state,
    failNextStart() { rejectNextStart = true; },
    rotateFingerprint(externalId) {
      const gateway = requiredGateway(state.gateways, externalId);
      gateway.fingerprint = gateway.fingerprint === FINGERPRINT
        ? 'sha256:8899aabbccddeeff'
        : FINGERPRINT;
      gateway.launchGeneration += 1;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  state: ControlledRustDeskServer['state'],
  consumeStartFailure: () => boolean
): Promise<void> {
  cors(response);
  if (request.method === 'OPTIONS') return void response.writeHead(204).end();
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const method = request.method || 'GET';

  const launchToken = url.pathname.match(/^\/controlled\/launch\/([^/]+)$/);
  if (launchToken && method === 'GET') {
    const token = decodeURIComponent(launchToken[1]);
    const gateway = [...state.gateways.values()].find((item) => signedToken(item) === token);
    if (!gateway || gateway.status !== 'active') throw statusError(410, 'launch link expired');
    state.launchedTokens.push(token);
    return json(response, 200, { status: 'launchable', external_id: gateway.externalId });
  }

  const actor = authenticate(request);
  const input = await body(request);
  if (request.headers['x-tenant-id'] !== TENANT || actor.tenant !== TENANT) {
    throw statusError(403, 'cross-tenant access denied');
  }

  if (url.pathname === '/api/ivekit/context/by-ref' && method === 'GET') {
    requireParticipant(actor.identity);
    const matches = url.searchParams.get('business_ref_type') === 'service_order' &&
      url.searchParams.get('business_ref_id') === 'SO-100';
    if (!matches) throw statusError(404, 'business context not found');
    return json(response, 200, {
      tenant_id: TENANT,
      business_ref: { type: 'service_order', id: 'SO-100' },
      viewer: { identity: actor.identity, system: false },
      capabilities: { chat: true, media: true, remote_assistance: true },
      chat: { count: 0, sessions: [] },
      media: { count: 1, calls: [{
        id: 'call-context', title: 'Controlled completed call', media: 'video', status: 'ended',
        room_name: 'room-context', created_at: NOW, updated_at: NOW, ended_at: NOW
      }] },
      remote_assistance: { count: 1, sessions: [{
        id: 'remote-1', collaboration_session_id: 'collab-context', status: 'created',
        mode: 'remote_desktop_gateway', adapter_provider: 'rustdesk', created_at: NOW,
        started_at: null, ended_at: null
      }], devices: [{
        id: DEVICE.id, display_name: DEVICE.display_name, status: DEVICE.status,
        runtime_status: DEVICE.runtime_status, last_seen_at: DEVICE.last_seen_at
      }] },
      authorization: {
        chat: [],
        media: [{ call_id: 'call-context', viewer_role: 'host', viewer_status: 'left', participants: [{
          identity: actor.identity, display_name: actor.identity, role: 'host', status: 'left'
        }] }],
        remote_assistance: [{
          remote_session_id: 'remote-1', viewer_role: 'agent',
          consent: { active: true, scopes: ['view_screen', 'control_mouse_keyboard'], expires_at: null },
          gateway: null
        }]
      }
    });
  }

  if (url.pathname === '/api/ivekit/context/timeline' && method === 'GET') {
    requireParticipant(actor.identity);
    return json(response, 200, {
      items: [{
        id: 'remote_consent:controlled-1', source: 'remote', event_type: 'remote.consent.granted',
        resource_type: 'remote_session', resource_id: 'remote-1', actor_identity: 'customer-1',
        occurred_at: NOW, attributes: { scopes: ['view_screen', 'control_mouse_keyboard'] }, evidence_ref: null
      }, {
        id: 'evidence:controlled-2', source: 'evidence', event_type: 'evidence.video_recording',
        resource_type: 'evidence', resource_id: 'recording-1', actor_identity: 'media-core',
        occurred_at: NOW, attributes: { kind: 'video_recording' }, evidence_ref: {
          id: 'controlled-2', kind: 'video_recording', checksum: 'c'.repeat(64), retention_until: null
        }
      }],
      has_more: false,
      next_cursor: null
    });
  }

  if (url.pathname === '/api/ivekit/media/calls/call-context' && method === 'GET') {
    requireParticipant(actor.identity);
    return json(response, 200, {
      call: {
        id: 'call-context', tenant_id: TENANT, room_name: 'room-context', media: 'video', status: 'ended',
        initiated_by: 'agent-1', business_ref: { type: 'service_order', id: 'SO-100', metadata: {} },
        title: 'Controlled completed call', metadata: {}, ring_timeout_seconds: 30,
        ring_expires_at: null, accepted_at: NOW, started_at: NOW, ended_at: NOW,
        end_reason: 'controlled completion', created_at: NOW, updated_at: NOW
      },
      participants: [{
        id: 'participant-context', tenant_id: TENANT, call_id: 'call-context', identity: actor.identity,
        role: actor.identity === 'agent-1' ? 'host' : 'participant', status: 'left', display_name: actor.identity,
        metadata: {}, invited_at: NOW, accepted_at: NOW, joined_at: NOW, left_at: NOW, updated_at: NOW
      }]
    });
  }

  if (url.pathname === '/api/ivekit/chat/sessions' && method === 'GET') {
    requireParticipant(actor.identity);
    return json(response, 200, { items: [], next_cursor: null, has_more: false });
  }

  if (url.pathname === '/api/ivekit/rustdesk/devices/by-ref' && method === 'GET') {
    requireParticipant(actor.identity);
    const matches = url.searchParams.get('business_ref_type') === DEVICE.business_ref_type &&
      url.searchParams.get('business_ref_id') === DEVICE.business_ref_id;
    return json(response, 200, matches ? [DEVICE] : []);
  }

  if (url.pathname === '/api/ivekit/rustdesk/gateway-sessions' && method === 'POST') {
    state.startRequests += 1;
    requireParticipant(actor.identity);
    if (consumeStartFailure()) throw statusError(503, 'controlled transient start failure');
    if (input.remote_session_id !== 'remote-1') throw statusError(403, 'remote session membership required');
    if (input.actor_identity !== actor.identity) throw statusError(403, 'actor identity mismatch');
    if (input.device_id !== DEVICE.id) throw statusError(404, 'device not found');
    let gateway = [...state.gateways.values()].find((item) =>
      item.remoteSessionId === input.remote_session_id && item.deviceId === input.device_id && item.status === 'active'
    );
    if (!gateway) {
      const sequence = state.gateways.size + 1;
      gateway = {
        externalId: `gateway-${sequence}`, remoteSessionId: String(input.remote_session_id), deviceId: String(input.device_id),
        startedBy: actor.identity, status: 'active', scopes: stringArray(input.permissions), fingerprint: FINGERPRINT,
        launchGeneration: 1, owner: null, controlVersion: 0, disconnectReads: 0,
        audit: [auditEvent(`gateway-${sequence}`, 'remote.gateway_session.created', actor.identity)]
      };
      state.gateways.set(gateway.externalId, gateway);
    }
    return json(response, 201, toolSession(gateway));
  }

  const sessionMatch = url.pathname.match(/^\/api\/ivekit\/rustdesk\/gateway-sessions\/([^/]+)(?:\/(launch|audit|events|disconnect|control)(?:\/[^/]+)?)?$/);
  if (sessionMatch) {
    const gateway = requiredGateway(state.gateways, decodeURIComponent(sessionMatch[1]));
    requireGatewayMember(gateway, actor.identity);
    const action = sessionMatch[2] || '';
    if (action === 'launch' && method === 'GET') return json(response, 200, launchPlan(gateway, url));
    if (action === 'audit' && method === 'GET') return json(response, 200, { events: gateway.audit });
    if (action === 'events' && method === 'POST') {
      if (input.actor_identity !== actor.identity) throw statusError(403, 'actor identity mismatch');
      const key = String(input.idempotency_key || '');
      const existing = key && gateway.audit.find((event) => event.idempotency_key === key);
      if (existing) return json(response, 200, { event: existing, replayed: true });
      const event = {
        ...auditEvent(gateway.externalId, String(input.event_type || 'remote.rustdesk.operation.observed'), actor.identity),
        idempotency_key: key, metadata: input.metadata || {}
      };
      gateway.audit.push(event);
      return json(response, 201, { event, replayed: false });
    }
    if (action === 'disconnect' && method === 'GET') {
      if (gateway.status === 'active') return json(response, 200, { required: true, status: 'unavailable', command: null, observation_status: 'not_observed' });
      gateway.disconnectReads += 1;
      return json(response, 200, disconnectState(gateway, gateway.disconnectReads > 1 ? 'succeeded' : 'pending'));
    }
    if (action === 'control') return controlRoute(request, response, url, gateway, actor.identity, input);
    if (!action && method === 'DELETE') {
      gateway.status = 'ended';
      gateway.launchGeneration += 1;
      gateway.owner = null;
      gateway.controlVersion += 1;
      gateway.audit.push(auditEvent(gateway.externalId, 'remote.gateway_session.ended', actor.identity));
      response.writeHead(204).end();
      return;
    }
  }

  const policyRevoke = url.pathname.match(/^\/api\/ivekit\/rustdesk\/devices\/([^/]+)\/access-policy\/revoke$/);
  if (policyRevoke && method === 'POST') {
    requireParticipant(actor.identity);
    if (policyRevoke[1] !== DEVICE.id) throw statusError(404, 'device not found');
    for (const gateway of state.gateways.values()) {
      if (gateway.deviceId !== DEVICE.id || gateway.status !== 'active') continue;
      gateway.status = 'ended';
      gateway.launchGeneration += 1;
      gateway.audit.push(auditEvent(gateway.externalId, 'remote.consent.revoked', actor.identity));
    }
    return json(response, 200, { state: 'revoked', device_id: DEVICE.id, replayed: false });
  }

  throw statusError(404, `controlled route not found: ${method} ${url.pathname}`);
}

function controlRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  gateway: ControlledGateway,
  identity: string,
  input: Json
): void {
  const method = request.method || 'GET';
  const suffix = url.pathname.match(/\/control(?:\/(confirmations|acquire|heartbeat|release|transfer|operations))?$/)?.[1] || '';
  if (!suffix && method === 'GET') return json(response, 200, ownership(gateway));
  if (gateway.status !== 'active') throw statusError(409, 'gateway session ended');
  if (suffix === 'confirmations' && method === 'POST') return json(response, 201, {
    id: `confirmation-${gateway.audit.length}`, external_id: gateway.externalId, actor_identity: identity,
    operation: input.operation, expires_at: '2026-07-12T08:02:00.000Z', consumed_at: null, created_at: NOW
  });
  if (suffix === 'acquire' && method === 'POST') {
    if (gateway.owner && gateway.owner !== identity) throw statusError(409, 'control already owned');
    gateway.owner = identity;
    gateway.controlVersion += 1;
    gateway.audit.push(auditEvent(gateway.externalId, 'remote.control.acquired', identity));
    return json(response, 201, ownership(gateway));
  }
  if (suffix === 'heartbeat' && method === 'POST') {
    requireOwnerVersion(gateway, identity, input.version);
    gateway.controlVersion += 1;
    return json(response, 201, ownership(gateway));
  }
  if (suffix === 'release' && method === 'POST') {
    requireOwnerVersion(gateway, identity, input.version);
    gateway.owner = null;
    gateway.controlVersion += 1;
    gateway.audit.push(auditEvent(gateway.externalId, 'remote.control.released', identity));
    return json(response, 201, ownership(gateway));
  }
  if (suffix === 'transfer' && method === 'POST') {
    requireOwnerVersion(gateway, identity, input.version);
    requireParticipant(String(input.to_identity || ''));
    gateway.owner = String(input.to_identity);
    gateway.controlVersion += 1;
    gateway.audit.push(auditEvent(gateway.externalId, 'remote.control.transferred', identity));
    return json(response, 201, ownership(gateway));
  }
  throw statusError(404, 'controlled control route not found');
}

function launchPlan(gateway: ControlledGateway, requestUrl: URL): Json {
  const token = signedToken(gateway);
  const base = `${requestUrl.protocol}//${requestUrl.host}`;
  const launchUrl = `${base}/controlled/launch/${encodeURIComponent(token)}`;
  const active = gateway.status === 'active';
  return {
    external_id: gateway.externalId, status: gateway.status, launch_url: active ? launchUrl : '',
    target: { type: 'device', id: DEVICE.rustdesk_id, display_name: DEVICE.display_name }, permissions: gateway.scopes,
    runtime: {
      rustdesk_id: DEVICE.rustdesk_id, id_server: 'rustdesk-id.example.test', relay_server: 'rustdesk-relay.example.test',
      api_server: '', server_key_fingerprint: gateway.fingerprint, public_key_configured: 'true', public_key_source: 'env'
    },
    client_config: {
      public_key_configured: true, public_key_source: 'env',
      manual_fields: { id_server: 'rustdesk-id.example.test', relay_server: 'rustdesk-relay.example.test', key: 'public-key-value' }
    },
    actions: {
      can_launch: active, open_url: active ? launchUrl : '',
      protocol_url: active ? `rustdesk://connect/${DEVICE.rustdesk_id}?launch_token=${encodeURIComponent(token)}` : ''
    },
    metadata: {}, created_at: NOW, ended_at: active ? null : NOW,
    permission_scopes: { requested: gateway.scopes, consented: gateway.scopes, granted: gateway.scopes },
    control_ownership: ownership(gateway)
  };
}

function toolSession(gateway: ControlledGateway): Json {
  return {
    id: `tool-${gateway.externalId}`, tenant_id: TENANT, remote_session_id: gateway.remoteSessionId,
    provider: 'rustdesk', external_id: gateway.externalId, launch_url: `https://hidden.invalid/${signedToken(gateway)}`,
    status: gateway.status, started_by: gateway.startedBy, started_at: NOW, ended_at: gateway.status === 'ended' ? NOW : null,
    metadata: {}, permission_scopes: { requested: gateway.scopes, consented: gateway.scopes, granted: gateway.scopes }
  };
}

function ownership(gateway: ControlledGateway): Json {
  return {
    status: gateway.owner ? 'owned' : gateway.controlVersion ? 'released' : 'unowned', owner_identity: gateway.owner,
    lease_expires_at: gateway.owner ? '2026-07-12T08:10:00.000Z' : null, version: gateway.controlVersion, updated_at: NOW
  };
}

function disconnectState(gateway: ControlledGateway, status: 'pending' | 'succeeded'): Json {
  const command = {
    id: `disconnect-${gateway.externalId}`, tenant_id: TENANT, device_id: gateway.deviceId, external_id: gateway.externalId,
    command_type: 'disconnect_session', status, requested_by: gateway.startedBy, requested_reason: 'gateway_ended',
    attempt_count: status === 'pending' ? 0 : 1, max_attempts: 3, claimed_by: status === 'pending' ? '' : 'edge-led-1',
    lease_expires_at: null, next_attempt_at: null, execution_method: status === 'pending' ? null : 'session_adapter',
    exit_code: status === 'pending' ? null : 0, duration_ms: status === 'pending' ? null : 42,
    stdout_bytes: status === 'pending' ? null : 0, stderr_bytes: status === 'pending' ? null : 0,
    stdout_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    stderr_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    result_metadata: {}, requested_at: NOW,
    started_at: status === 'pending' ? null : NOW, completed_at: status === 'pending' ? null : NOW, updated_at: NOW
  };
  return { required: true, status, command, observation_status: status === 'succeeded' ? 'observed_disconnected' : 'not_observed',
    ...(status === 'succeeded' ? { observed: {
      operation_id: `disconnect-observation-${gateway.externalId}`, operation: 'session_disconnect', status: 'observed_succeeded',
      observer: 'edge_adapter', observed_at: NOW,
      evidence_refs: [{ type: 'edge_log', ref: `evidence://controlled/${gateway.externalId}/disconnect`, sha256: 'a'.repeat(64) }],
      metadata: { external_id: gateway.externalId }
    } } : {}) };
}

function auditEvent(externalId: string, eventType: string, identity: string): Json {
  return { external_id: externalId, event_type: eventType, actor_identity: identity, target: DEVICE.rustdesk_id, metadata: {}, occurred_at: NOW };
}

function signedToken(gateway: ControlledGateway): string {
  return `controlled-secret-${gateway.externalId}-v${gateway.launchGeneration}`;
}

function authenticate(request: IncomingMessage): { identity: string; tenant: string } {
  const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const identities: Record<string, { identity: string; tenant: string }> = {
    'token-agent': { identity: 'agent-1', tenant: TENANT },
    'token-participant': { identity: 'participant-1', tenant: TENANT },
    'token-outsider': { identity: 'outsider-1', tenant: TENANT },
    'token-other-tenant': { identity: 'agent-1', tenant: 'tenant-other' }
  };
  const actor = identities[token];
  if (!actor) throw statusError(401, 'invalid controlled token');
  return actor;
}

function requireParticipant(identity: string): void {
  if (!['agent-1', 'participant-1'].includes(identity)) throw statusError(403, 'participant access required');
}

function requireGatewayMember(gateway: ControlledGateway, identity: string): void {
  requireParticipant(identity);
  if (gateway.remoteSessionId !== 'remote-1') throw statusError(403, 'remote session membership required');
}

function requireOwnerVersion(gateway: ControlledGateway, identity: string, version: unknown): void {
  if (gateway.owner !== identity) throw statusError(409, 'active control owner required');
  if (Number(version) !== gateway.controlVersion) throw statusError(409, 'stale control version');
}

function requiredGateway(gateways: Map<string, ControlledGateway>, externalId: string): ControlledGateway {
  const gateway = gateways.get(externalId);
  if (!gateway) throw statusError(404, 'gateway session not found');
  return gateway;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw statusError(400, 'permissions are required');
  return value.map(String);
}

async function body(request: IncomingMessage): Promise<Json> {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method || '')) return {};
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function cors(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'authorization,content-type,idempotency-key,x-tenant-id');
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
}

function statusError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}
