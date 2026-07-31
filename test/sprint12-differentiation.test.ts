import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { useMemoryRedisForTests } from '../src/agent-runtime/call-center/call-center-runtime.js';
import { routeSprint12Api } from '../src/agent-runtime/call-center/analytics/sprint12-http.js';
import { ProactivePushStore, evaluateProactivePush } from '../src/agent-runtime/call-center/omnichannel/proactive-push.js';
import { DashboardWidgetStore } from '../src/agent-runtime/call-center/analytics/custom-dashboard.js';
import { ScreenRecordingStore } from '../src/agent-runtime/call-center/analytics/screen-recording.js';
import { normalizeFacebookMessengerInbound } from '../src/agent-runtime/call-center/omnichannel/facebook-adapter.js';
import { predictBestSeat } from '../src/agent-runtime/call-center/routing/heuristic-router.js';
import { predictCustomerIntent } from '../src/agent-runtime/call-center/analytics/intent-predictor.js';
import { AgentSeatStore } from '../src/agent-runtime/call-center/seat-store.js';
import { IvrMarketplaceStore, resolveTenantIvrSelection } from '../src/agent-runtime/call-center/ivr/ivr-marketplace-store.js';
import { processIvrRouteCommand } from '../src/agent-runtime/call-center/application.js';

const API_KEY = 'test-sprint12-key';

function authHeaders(tenantId: string) {
  return { 'X-API-Key': API_KEY, 'X-Tenant-Id': tenantId };
}

before(() => {
  useMemoryRedisForTests();
  process.env.OPC_API_KEY = API_KEY;
});

describe('Sprint 12 facebook adapter', () => {
  it('normalizes messenger webhook payload', () => {
    const normalized = normalizeFacebookMessengerInbound({
      tenant_id: 'tenant_1',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'fb-user-1' },
              message: { mid: 'm1', text: 'hello fb' }
            }
          ]
        }
      ]
    });
    assert.ok(normalized);
    assert.equal(normalized!.text, 'hello fb');
    assert.equal(normalized!.sender_id, 'fb-user-1');
  });
});

describe('Sprint 12 proactive push', () => {
  it('evaluates rules by intent score', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Push' });
    const store = new ProactivePushStore(db);
    store.create({
      tenant_id: tenant.id,
      name: 'High intent',
      trigger_event: 'page_view',
      channel: 'web_chat',
      message_template: 'Hi {{name}}',
      min_intent_score: 0.7,
      enabled: true
    });
    const low = evaluateProactivePush(db, {
      tenant_id: tenant.id,
      trigger_event: 'page_view',
      customer_key: 'web:1',
      intent_score: 0.2,
      variables: { name: 'A' }
    });
    assert.equal(low.queued, 0);
    assert.equal(low.skipped, 1);
    const high = evaluateProactivePush(db, {
      tenant_id: tenant.id,
      trigger_event: 'page_view',
      customer_key: 'web:1',
      intent_score: 0.9,
      variables: { name: 'A' }
    });
    assert.equal(high.queued, 1);
  });
});

describe('Sprint 12 HTTP', () => {
  it('custom dashboard and screen recording endpoints', async () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'S12' });
    const headers = authHeaders(tenant.id);

    const widgets = (await routeSprint12Api(
      db,
      'PUT',
      '/api/call-center/dashboard/custom',
      new URL('http://localhost/api/call-center/dashboard/custom'),
      {
        widgets: [{ widget_type: 'call_volume', title: '通话量', position: 0, config: { range: '7d' } }]
      },
      headers
    )) as { data: Array<{ widget_type: string }> };
    assert.equal(widgets.data.length, 1);
    assert.equal(widgets.data[0].widget_type, 'call_volume');

    const rec = (await routeSprint12Api(
      db,
      'POST',
      '/api/call-center/screen-recordings',
      new URL('http://localhost/api/call-center/screen-recordings'),
      { storage_url: 's3://bucket/screen.webm', duration_sec: 120 },
      headers
    )) as { status: number; data: { storage_url: string } };
    assert.equal(rec.status, 201);
    assert.equal(rec.data.storage_url, 's3://bucket/screen.webm');
  });

  it('facebook webhook creates omni conversation', async () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'FB' });
    const result = (await routeSprint12Api(
      db,
      'POST',
      '/api/call-center/omni/webhooks/facebook',
      new URL('http://localhost/api/call-center/omni/webhooks/facebook'),
      {
        tenant_id: tenant.id,
        entry: [{ messaging: [{ sender: { id: 'u1' }, message: { mid: 'm1', text: 'pricing?' } }] }]
      },
      {}
    )) as { data: { conversation: { id: string } } };
    assert.ok(result.data.conversation.id);
  });
});

describe('Sprint 12 stores', () => {
  it('dashboard widget store upserts layout', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Dash' });
    const store = new DashboardWidgetStore(db);
    const saved = store.upsert(tenant.id, [
      { widget_type: 'qm_score', title: 'QM', position: 1, config: {} }
    ]);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].title, 'QM');
  });

  it('screen recording store persists metadata', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Rec' });
    const rec = new ScreenRecordingStore(db).create({
      tenant_id: tenant.id,
      storage_url: 'https://cdn.example.com/r.webm',
      duration_sec: 30
    });
    assert.ok(rec.id.startsWith('scrn_'));
  });
});

describe('Sprint 12 F7/F9 heuristics', () => {
  it('predictBestSeat ranks idle skilled agent', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Route' });
    const seats = new AgentSeatStore(db);
    const a = seats.upsertSeat({
      tenant_id: tenant.id,
      user_id: 'u1',
      display_name: 'Alice',
      skills: ['sales']
    });
    seats.updateStatus(tenant.id, a.id, 'idle');
    seats.heartbeat(tenant.id, a.id);
    const b = seats.upsertSeat({
      tenant_id: tenant.id,
      user_id: 'u2',
      display_name: 'Bob',
      skills: ['support']
    });
    seats.updateStatus(tenant.id, b.id, 'idle');

    const prediction = predictBestSeat(db, {
      tenant_id: tenant.id,
      required_skills: ['sales']
    });
    assert.equal(prediction.seat_id, a.id);
    assert.ok(prediction.confidence > 0);
  });

  it('predictCustomerIntent recommends proactive chat on pricing signals', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Intent' });
    const result = predictCustomerIntent(db, tenant.id, 'web:99', [
      { event: 'pricing_page' },
      { event: 'cart_abandon' }
    ]);
    assert.ok(result.intent_score >= 0.5);
    assert.equal(result.predicted_topic, 'purchase_hesitation');
    assert.ok(['proactive_chat', 'outbound_call'].includes(result.recommended_action));
  });

  it('routing and intent HTTP endpoints', async () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'HTTP F7F9' });
    const headers = authHeaders(tenant.id);
    const seats = new AgentSeatStore(db);
    const seat = seats.upsertSeat({
      tenant_id: tenant.id,
      user_id: 'u1',
      display_name: 'Agent',
      skills: ['vip']
    });
    seats.updateStatus(tenant.id, seat.id, 'idle');

    const routing = (await routeSprint12Api(
      db,
      'POST',
      '/api/call-center/routing/predict',
      new URL('http://localhost/api/call-center/routing/predict'),
      { required_skills: ['vip'] },
      headers
    )) as { data: { seat_id: string | null } };
    assert.equal(routing.data.seat_id, seat.id);

    const intent = (await routeSprint12Api(
      db,
      'POST',
      '/api/call-center/intent/predict',
      new URL('http://localhost/api/call-center/intent/predict'),
      {
        customer_key: 'web:1',
        signals: [{ event: 'demo_request' }]
      },
      headers
    )) as { data: { intent_score: number; recommended_action: string } };
    assert.ok(intent.data.intent_score >= 0.5);
    assert.equal(intent.data.recommended_action, 'outbound_call');
  });
});

describe('Sprint 12 IVR marketplace', () => {
  it('installs component and resolves tenant menu', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'IVR' });
    const store = new IvrMarketplaceStore(db);
    const catalog = store.listCatalog(tenant.id);
    assert.ok(catalog.length >= 2);
    const support = catalog.find((c) => c.manifest.id === 'support_first');
    assert.ok(support);
    store.install(tenant.id, support!.id, 'default');
    const resolved = resolveTenantIvrSelection(db, tenant.id, 'default', '1');
    assert.equal(resolved.route_type, 'queue');
    assert.equal(resolved.route_target, 'default');
    assert.equal(resolved.label, '客服');
  });

  it('marketplace HTTP install and route', async () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'IVR HTTP' });
    const headers = authHeaders(tenant.id);
    const catalog = (await routeSprint12Api(
      db,
      'GET',
      '/api/call-center/ivr/marketplace',
      new URL('http://localhost/api/call-center/ivr/marketplace'),
      null,
      headers
    )) as { data: Array<{ id: string; manifest: { id: string } }> };
    assert.ok(catalog.data.length >= 1);
    const component = catalog.data.find((c) => c.manifest.id === 'support_first') || catalog.data[0];
    const install = (await routeSprint12Api(
      db,
      'POST',
      '/api/call-center/ivr/installs',
      new URL('http://localhost/api/call-center/ivr/installs'),
      { component_id: component.id, menu_key: 'default' },
      headers
    )) as { status: number; data: { menu_key: string } };
    assert.equal(install.status, 201);
    assert.equal(install.data.menu_key, 'default');

    const route = processIvrRouteCommand(db, {
      tenant_id: tenant.id,
      menu_id: 'default',
      digit: '1'
    }) as { data: { route: { route_target: string } } };
    assert.equal(route.data.route.route_target, 'default');
  });
});
