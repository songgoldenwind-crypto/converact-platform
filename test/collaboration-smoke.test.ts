import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  createCollaborationSmokeConfigFromEnv,
  runCollaborationSmoke
} from '../scripts/collaboration-smoke.js';

test('collaboration smoke config requires base URL API key and tenant id', () => {
  assert.throws(
    () => createCollaborationSmokeConfigFromEnv({ CONVERACT_API_KEY: 'key', CONVERACT_COLLAB_SMOKE_TENANT_ID: 'tenant' }),
    /CONVERACT_BASE_URL is required/
  );
  assert.throws(
    () => createCollaborationSmokeConfigFromEnv({ CONVERACT_BASE_URL: 'http://localhost:3000', CONVERACT_COLLAB_SMOKE_TENANT_ID: 'tenant' }),
    /CONVERACT_COLLAB_SMOKE_API_KEY or CONVERACT_API_KEY is required/
  );
  assert.throws(
    () => createCollaborationSmokeConfigFromEnv({ CONVERACT_BASE_URL: 'http://localhost:3000', CONVERACT_API_KEY: 'key' }),
    /CONVERACT_COLLAB_SMOKE_TENANT_ID or CONVERACT_TENANT_ID is required/
  );
});

test('collaboration smoke is wired into package scripts and env example', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['smoke:collaboration'],
    'node --import tsx scripts/collaboration-smoke.ts'
  );

  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const key of [
    'CONVERACT_COLLAB_SMOKE_TENANT_ID=',
    'CONVERACT_COLLAB_SMOKE_USER_ID=',
    'CONVERACT_COLLAB_SMOKE_BUSINESS_REF_TYPE=',
    'CONVERACT_COLLAB_SMOKE_ADAPTER_PROVIDER=',
    'CONVERACT_COLLAB_SMOKE_USE_GATEWAY_TOOL=',
    'CONVERACT_COLLAB_SMOKE_GATEWAY_TARGET_ID=',
    'CONVERACT_COLLAB_SMOKE_CONSENT_SCOPES='
  ]) {
    assert.match(envExample, new RegExp(`^${key}`, 'm'));
  }
});

test('collaboration smoke defaults gateway mode to RustDesk', () => {
  const config = createCollaborationSmokeConfigFromEnv({
    CONVERACT_BASE_URL: 'http://localhost:3000',
    CONVERACT_API_KEY: 'key',
    CONVERACT_COLLAB_SMOKE_TENANT_ID: 'tenant',
    CONVERACT_COLLAB_SMOKE_USE_GATEWAY_TOOL: '1',
    CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'rustdesk-device-1'
  });

  assert.equal(config.remoteMode, 'remote_desktop_gateway');
  assert.equal(config.adapterProvider, 'rustdesk');
  assert.equal(config.toolProvider, 'rustdesk');
  assert.equal(config.gatewayTargetId, 'rustdesk-device-1');
});

test('collaboration smoke drives consent gated remote assistance and evidence APIs', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let toolAttempts = 0;

  const result = await runCollaborationSmoke(
    {
      baseUrl: 'http://opc.local',
      opcApiKey: 'smoke-opc-key',
      tenantId: 'tenant_smoke',
      userId: 'agent_smoke',
      businessRefType: 'service_order',
      businessRefId: 'order-smoke-1',
      businessRefDisplayName: 'Smoke order',
      remoteMode: 'third_party_remote_tool',
      adapterProvider: 'rustdesk',
      toolProvider: 'rustdesk',
      toolExternalId: 'rd-smoke-1',
      toolLaunchUrl: 'https://remote.example/rd-smoke-1',
      consentScopes: ['view_screen', 'control_mouse_keyboard', 'record_screen'],
      evidenceFilename: 'remote-session.webm',
      evidenceBody: 'webm-screen-recording',
      retentionUntil: '2099-01-01T00:00:00.000Z'
    },
    async (input, init) => {
      const url = input.toString();
      calls.push({ url, init });
      const { pathname } = new URL(url);

      if (pathname === '/api/collaboration/sessions') {
        return jsonResponse(201, {
          id: 'collab_smoke_1',
          business_ref: { tenant_id: 'tenant_smoke', type: 'service_order', id: 'order-smoke-1' }
        });
      }
      if (pathname === '/api/collaboration/sessions/by-ref') {
        return jsonResponse(200, [{ id: 'collab_smoke_1' }]);
      }
      if (pathname === '/api/collaboration/remote-assistance/sessions') {
        return jsonResponse(201, {
          id: 'remote_smoke_1',
          status: 'active',
          business_ref: { tenant_id: 'tenant_smoke', type: 'service_order', id: 'order-smoke-1' }
        });
      }
      if (pathname === '/api/collaboration/remote-assistance/remote_smoke_1/tools') {
        toolAttempts += 1;
        if (toolAttempts === 1) {
          return jsonResponse(403, { error: { message: 'active consent required before starting remote tool session' } });
        }
        return jsonResponse(201, { id: 'tool_smoke_1', provider: 'rustdesk', status: 'active' });
      }
      if (pathname === '/api/collaboration/remote-assistance/remote_smoke_1/consent/request') {
        return jsonResponse(201, { id: 'consent_request_1', event_type: 'requested' });
      }
      if (pathname === '/api/collaboration/remote-assistance/remote_smoke_1/consent/grant') {
        return jsonResponse(201, { id: 'consent_grant_1', event_type: 'granted' });
      }
      if (pathname === '/api/collaboration/remote-assistance/remote_smoke_1/audit') {
        return jsonResponse(201, { id: 'audit_smoke_1', event_type: 'remote.operator.note' });
      }
      if (pathname === '/api/collaboration/remote-assistance/remote_smoke_1/evidence/upload') {
        assert.equal(init?.body, 'webm-screen-recording');
        return jsonResponse(201, {
          id: 'evidence_smoke_1',
          kind: 'screen_recording',
          storage_url: '/api/collaboration/media/tenant_smoke/remote-session.webm',
          checksum: 'sha256:test'
        });
      }
      if (pathname === '/api/collaboration/remote-assistance/remote_smoke_1/timeline') {
        const revoked = calls.some((call) => call.url.includes('/consent/revoke'));
        return jsonResponse(200, {
          session: { id: 'remote_smoke_1' },
          consent_events: [
            { event_type: 'requested' },
            { event_type: 'granted' },
            ...(revoked ? [{ event_type: 'revoked' }] : [])
          ],
          tool_sessions: [{ provider: 'rustdesk', status: revoked ? 'ended' : 'active' }],
          audit_events: [
            { event_type: 'remote.tool.started' },
            { event_type: 'remote.evidence.recorded' },
            ...(revoked ? [{ event_type: 'remote.consent.revoked' }, { event_type: 'remote.tool_session.ended' }] : [])
          ],
          evidence: [{ kind: 'screen_recording' }]
        });
      }
      if (pathname === '/api/collaboration/remote-assistance/remote_smoke_1/consent/revoke') {
        return jsonResponse(201, { id: 'consent_revoke_1', event_type: 'revoked' });
      }

      return jsonResponse(404, { error: { message: `unexpected ${pathname}` } });
    }
  );

  assert.equal(result.collaborationSessionId, 'collab_smoke_1');
  assert.equal(result.remoteSessionId, 'remote_smoke_1');
  assert.equal(result.toolSessionId, 'tool_smoke_1');
  assert.equal(result.evidenceId, 'evidence_smoke_1');
  assert.deepEqual(
    result.steps.map((step) => `${step.name}:${step.status}`),
    [
      'create_session:201',
      'list_sessions_by_ref:200',
      'create_remote_session:201',
      'tool_before_consent_blocked:403',
      'request_consent:201',
      'grant_consent:201',
      'start_tool:201',
      'record_audit:201',
      'upload_evidence:201',
      'fetch_timeline:200',
      'revoke_consent:201',
      'fetch_timeline_after_revoke:200'
    ]
  );
  assert.equal(result.timeline.consentEvents, 3);
  assert.equal(result.timeline.toolSessions, 1);
  assert.equal(result.timeline.evidenceRecords, 1);

  for (const call of calls) {
    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'smoke-opc-key');
    assert.equal(headers['x-tenant-id'], 'tenant_smoke');
    assert.equal(headers['x-user-id'], 'agent_smoke');
  }
});

test('collaboration smoke can drive the configured remote gateway tool endpoint', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let gatewayAttempts = 0;

  const result = await runCollaborationSmoke(
    {
      baseUrl: 'http://opc.local',
      opcApiKey: 'smoke-opc-key',
      tenantId: 'tenant_gateway_smoke',
      userId: 'agent_gateway_smoke',
      businessRefType: 'service_order',
      businessRefId: 'order-gateway-smoke-1',
      businessRefDisplayName: 'Gateway smoke order',
      remoteMode: 'remote_desktop_gateway',
      adapterProvider: 'meshcentral',
      toolProvider: 'meshcentral',
      toolExternalId: 'unused-external-tool',
      toolLaunchUrl: 'https://unused.example/tool',
      useGatewayTool: true,
      gatewayTargetType: 'device',
      gatewayTargetId: 'device-gateway-smoke',
      gatewayTargetDisplayName: 'Gateway smoke device',
      consentScopes: ['view_screen', 'control_mouse_keyboard'],
      evidenceFilename: 'gateway-remote-session.webm',
      evidenceBody: 'gateway-webm-screen-recording'
    },
    async (input, init) => {
      const url = input.toString();
      calls.push({ url, init });
      const { pathname } = new URL(url);

      if (pathname === '/api/collaboration/sessions') {
        return jsonResponse(201, { id: 'collab_gateway_smoke_1' });
      }
      if (pathname === '/api/collaboration/sessions/by-ref') {
        return jsonResponse(200, [{ id: 'collab_gateway_smoke_1' }]);
      }
      if (pathname === '/api/collaboration/remote-assistance/sessions') {
        return jsonResponse(201, { id: 'remote_gateway_smoke_1', status: 'active' });
      }
      if (pathname === '/api/collaboration/remote-assistance/remote_gateway_smoke_1/tools/gateway') {
        gatewayAttempts += 1;
        const payload = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
        const target = payload.target as Record<string, unknown>;
        assert.equal(target.id, 'device-gateway-smoke');
        assert.deepEqual(payload.permissions, ['view_screen', 'control_mouse_keyboard']);
        if (gatewayAttempts === 1) {
          return jsonResponse(403, { error: { message: 'active consent required before starting remote tool session' } });
        }
        return jsonResponse(201, {
          id: 'gateway_tool_smoke_1',
          provider: 'meshcentral',
          external_id: 'mesh-gateway-smoke-1',
          launch_url: 'https://mesh.example/control/mesh-gateway-smoke-1',
          status: 'active'
        });
      }
      if (pathname === '/api/collaboration/remote-assistance/remote_gateway_smoke_1/consent/request') {
        return jsonResponse(201, { id: 'gateway_consent_request_1', event_type: 'requested' });
      }
      if (pathname === '/api/collaboration/remote-assistance/remote_gateway_smoke_1/consent/grant') {
        return jsonResponse(201, { id: 'gateway_consent_grant_1', event_type: 'granted' });
      }
      if (pathname === '/api/collaboration/remote-assistance/remote_gateway_smoke_1/audit/gateway-sync') {
        const payload = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
        assert.equal(payload.tool_session_id, 'gateway_tool_smoke_1');
        return jsonResponse(201, {
          synced: 1,
          events: [{ event_type: 'meshcentral.mouse.click' }]
        });
      }
      if (pathname === '/api/collaboration/remote-assistance/remote_gateway_smoke_1/audit') {
        return jsonResponse(201, { id: 'gateway_audit_smoke_1', event_type: 'remote.operator.note' });
      }
      if (pathname === '/api/collaboration/remote-assistance/remote_gateway_smoke_1/evidence/upload') {
        return jsonResponse(201, { id: 'gateway_evidence_smoke_1', kind: 'screen_recording' });
      }
      if (pathname === '/api/collaboration/remote-assistance/remote_gateway_smoke_1/timeline') {
        const revoked = calls.some((call) => call.url.includes('/consent/revoke'));
        return jsonResponse(200, {
          session: { id: 'remote_gateway_smoke_1' },
          consent_events: [
            { event_type: 'requested' },
            { event_type: 'granted' },
            ...(revoked ? [{ event_type: 'revoked' }] : [])
          ],
          tool_sessions: [{ provider: 'meshcentral', status: revoked ? 'ended' : 'active' }],
          audit_events: [
            { event_type: 'meshcentral.mouse.click' },
            { event_type: 'remote.evidence.recorded' },
            ...(revoked ? [{ event_type: 'remote.consent.revoked' }, { event_type: 'remote.tool_session.ended' }] : [])
          ],
          evidence: [{ kind: 'screen_recording' }]
        });
      }
      if (pathname === '/api/collaboration/remote-assistance/remote_gateway_smoke_1/consent/revoke') {
        return jsonResponse(201, { id: 'gateway_consent_revoke_1', event_type: 'revoked' });
      }

      return jsonResponse(404, { error: { message: `unexpected ${pathname}` } });
    }
  );

  assert.equal(result.toolSessionId, 'gateway_tool_smoke_1');
  assert.equal(gatewayAttempts, 2);
  assert.deepEqual(
    result.steps.map((step) => `${step.name}:${step.status}`),
    [
      'create_session:201',
      'list_sessions_by_ref:200',
      'create_remote_session:201',
      'gateway_tool_before_consent_blocked:403',
      'request_consent:201',
      'grant_consent:201',
      'start_gateway_tool:201',
      'sync_gateway_audit:201',
      'record_audit:201',
      'upload_evidence:201',
      'fetch_timeline:200',
      'revoke_consent:201',
      'fetch_timeline_after_revoke:200'
    ]
  );
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
