import assert from 'node:assert/strict';
import { before, describe, it, mock } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { useMemoryRedisForTests } from '../src/agent-runtime/call-center/call-center-runtime.js';
import { WebhookStore } from '../src/agent-runtime/call-center/webhooks/webhook-store.js';
import { WebhookDeliveryStore } from '../src/agent-runtime/call-center/webhooks/webhook-delivery-store.js';
import {
  dispatchWebhookWithLogging,
  emitTenantWebhookEvent,
  processWebhookRetries
} from '../src/agent-runtime/call-center/webhooks/webhook-emitter.js';
import { logKnowledgeQuery, getKnowledgeAnalytics } from '../src/agent-runtime/call-center/knowledge/knowledge-analytics.js';
import {
  createBatchJob,
  runBatchRecordingAnalysis
} from '../src/agent-runtime/call-center/analytics/recording-batch-analyzer.js';
import { getUnifiedCustomerJourney } from '../src/agent-runtime/call-center/omnichannel/customer-journey.js';
import { recordJourneyEvent } from '../src/agent-runtime/call-center/omnichannel/omni-service.js';
import { routeSprint10Api } from '../src/agent-runtime/call-center/analytics/sprint10-http.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { verifyMediaInvite } from '../src/agent-runtime/livekit/invite-token.js';

const API_KEY = 'test-sprint10-key';

function authHeaders(tenantId: string) {
  return { 'X-API-Key': API_KEY, 'X-Tenant-Id': tenantId };
}

before(() => {
  useMemoryRedisForTests();
  process.env.CONVERACT_API_KEY = API_KEY;
});

describe('Sprint 10 webhooks', () => {
  it('logs delivery and retries on failure', async () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'WH' });
    const store = new WebhookStore(db);
    const sub = store.create({
      tenant_id: tenant.id,
      url: 'https://example.com/hook',
      events: ['call.completed']
    });

    const mockFetch = mock.fn(async () => new Response('fail', { status: 500 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    try {
      const result = await dispatchWebhookWithLogging(db, sub, {
        id: 'evt_1',
        event: 'call.completed',
        tenant_id: tenant.id,
        timestamp: new Date().toISOString(),
        data: { call_session_id: 'c1' }
      });
      assert.equal(result.success, false);
      const deliveries = new WebhookDeliveryStore(db).list(tenant.id);
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].status, 'retrying');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emitTenantWebhookEvent dispatches to subscribers', async () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Emit' });
    const store = new WebhookStore(db);
    store.create({ tenant_id: tenant.id, url: 'https://example.com/h', events: ['*'] });

    const mockFetch = mock.fn(async () => new Response('ok', { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    try {
      await emitTenantWebhookEvent(db, tenant.id, 'call.completed', { ok: true });
      assert.equal(mockFetch.mock.calls.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Sprint 10 analytics & journey', () => {
  it('knowledge analytics tracks hits and gaps', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'KB' });
    logKnowledgeQuery(db, { tenant_id: tenant.id, query: '价格', hit_count: 2, confidence: 0.9 });
    logKnowledgeQuery(db, { tenant_id: tenant.id, query: '未知问题', hit_count: 0 });
    const stats = getKnowledgeAnalytics(db, tenant.id, 30);
    assert.equal(stats.total_queries, 2);
    assert.ok(stats.hit_rate > 0);
    assert.ok(stats.content_gaps.length >= 1);
  });

  it('unified journey merges events and call sessions', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Journey' });
    const voiceStore = new VoiceStore(db);
    const session = voiceStore.createCallSession({
      tenant_id: tenant.id,
      direction: 'inbound',
      rustpbx_call_id: 'c-j',
      phone: '+8613800000001',
      status: 'completed'
    });
    recordJourneyEvent(db, {
      tenant_id: tenant.id,
      customer_key: 'phone:+8613800000001',
      event_type: 'message_inbound',
      channel: 'sms',
      summary: '咨询',
      ref_id: 'omni_1'
    });
    const timeline = getUnifiedCustomerJourney(db, tenant.id, { phone: '+8613800000001' });
    assert.ok(timeline.length >= 2);
    assert.ok(timeline.some((e) => e.event_type === 'call_session' && e.ref_id === session.id));
  });

  it('batch recording analysis completes job', async () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Batch' });
    const jobId = createBatchJob(db, { tenant_id: tenant.id, limit: 10 });
    const result = await runBatchRecordingAnalysis(db, jobId);
    assert.equal(result.recording_count, 0);
  });

  it('sprint10 HTTP: journey and batch analyze', async () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'HTTP S10' });
    recordJourneyEvent(db, {
      tenant_id: tenant.id,
      customer_key: 'phone:+8613911111111',
      event_type: 'message_inbound',
      channel: 'web_chat',
      summary: 'hello'
    });
    const journey = (await routeSprint10Api(
      db,
      'GET',
      '/api/call-center/journey/unified',
      new URL(`http://localhost/api/call-center/journey/unified?phone=${encodeURIComponent('+8613911111111')}`),
      null,
      authHeaders(tenant.id)
    )) as { data: unknown[] };
    assert.ok(journey.data.length >= 1);

    const batch = (await routeSprint10Api(
      db,
      'POST',
      '/api/call-center/recordings/batch-analyze',
      new URL('http://localhost/api/call-center/recordings/batch-analyze'),
      { limit: 5 },
      authHeaders(tenant.id)
    )) as { status: number; data: { job_id: string } };
    assert.equal(batch.status, 201);
    assert.ok(batch.data.job_id);
  });

  it('sprint10 HTTP: video start returns signed tenant-aware customer join path', async () => {
    const previousInviteSecret = process.env.CONVERACT_MEDIA_INVITE_SECRET;
    process.env.CONVERACT_MEDIA_INVITE_SECRET = 'sprint10-video-invite-secret';

    try {
      const db = createDatabase(':memory:');
      const tenant = createTenant(db, { name: 'HTTP Video S10' });

      const started = (await routeSprint10Api(
        db,
        'POST',
        '/api/call-center/video/start',
        new URL('http://localhost/api/call-center/video/start'),
        { customer_phone: '+8613911112222' },
        authHeaders(tenant.id)
      )) as {
        data: {
          room: { room_name: string };
          agent_token: { token: string };
          customer_join_path?: string;
        };
      };

      assert.ok(started.data.agent_token.token);
      assert.ok(started.data.customer_join_path);
      const joinUrl = new URL(`http://localhost${started.data.customer_join_path}`);
      assert.equal(joinUrl.pathname, '/video');
      assert.equal(joinUrl.searchParams.get('room'), started.data.room.room_name);
      assert.equal(joinUrl.searchParams.get('tenant_id'), tenant.id);
      assert.ok(joinUrl.searchParams.get('expires_at'));
      assert.ok(joinUrl.searchParams.get('invite'));
      assert.equal(
        verifyMediaInvite({
          tenantId: tenant.id,
          roomName: started.data.room.room_name,
          role: 'customer',
          media: 'video',
          expiresAt: joinUrl.searchParams.get('expires_at'),
          invite: joinUrl.searchParams.get('invite')
        }),
        true
      );
    } finally {
      if (previousInviteSecret == null) delete process.env.CONVERACT_MEDIA_INVITE_SECRET;
      else process.env.CONVERACT_MEDIA_INVITE_SECRET = previousInviteSecret;
    }
  });
});

describe('Sprint 10 SSO & white-label', () => {
  it('email template render and preview', async () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'WL' });
    const { EmailTemplateStore, renderEmailTemplate } = await import(
      '../src/agent-runtime/call-center/white-label/email-template-store.js'
    );
    const store = new EmailTemplateStore(db);
    store.upsert(tenant.id, 'welcome', { subject: 'Hi {{brand_name}}' });
    const rendered = renderEmailTemplate(store.get(tenant.id, 'welcome'), {
      brand_name: 'Acme',
      customer_name: 'Li'
    });
    assert.equal(rendered.subject, 'Hi Acme');
  });

  it('SSO callback provisions user with mocked OIDC', async () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'SSO Co' });
    const { MemoryPg, resetPostgresForTests } = await import('../src/db-pg.js');
    const pg = new MemoryPg();
    resetPostgresForTests(pg);
    await pg.query(`INSERT INTO tenants (id, name, plan_code) VALUES ($1, $2, 'free')`, [
      tenant.id,
      'SSO Co'
    ]);

    const { upsertSsoConfig } = await import('../src/sso-config-store.js');
    upsertSsoConfig(db, tenant.id, {
      enabled: true,
      issuer_url: 'https://idp.example.com',
      client_id: 'client',
      client_secret: 'secret',
      redirect_uri: 'http://localhost/login'
    });

    process.env.CONVERACT_JWT_SECRET = 'test-sso-secret';
    const { createSsoState, _clearOidcDiscoveryCache } = await import('../src/oidc-client.js');
    _clearOidcDiscoveryCache();
    const { state } = createSsoState(tenant.id, process.env.CONVERACT_JWT_SECRET);

    const payload = Buffer.from(
      JSON.stringify({
        sub: 'oidc-sub-1',
        email: 'sso@example.com',
        name: 'SSO User',
        exp: Math.floor(Date.now() / 1000) + 3600
      })
    ).toString('base64url');
    const idToken = `hdr.${payload}.sig`;

    const mockFetch = mock.fn(async (url: string) => {
      if (String(url).includes('openid-configuration')) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: 'https://idp.example.com/auth',
            token_endpoint: 'https://idp.example.com/token',
            issuer: 'https://idp.example.com'
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ access_token: 'at', id_token: idToken, token_type: 'Bearer' }), {
        status: 200
      });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    try {
      const { routeAuthApi } = await import('../src/auth-http.js');
      const result = (await routeAuthApi(
        pg,
        db,
        'POST',
        '/api/auth/sso/callback',
        new URL('http://localhost/api/auth/sso/callback'),
        { tenant_id: tenant.id, code: 'auth-code', state },
        {}
      )) as { data: { token: string; user: { email: string } } };
      assert.ok(result.data.token);
      assert.equal(result.data.user.email, 'sso@example.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
