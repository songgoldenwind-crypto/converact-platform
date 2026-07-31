import assert from 'node:assert/strict';
import { before, describe, it, mock } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { useMemoryRedisForTests } from '../src/agent-runtime/call-center/call-center-runtime.js';
import { OmniStore } from '../src/agent-runtime/call-center/omnichannel/omni-store.js';
import { receiveOmniInbound, sendOmniOutbound } from '../src/agent-runtime/call-center/omnichannel/omni-adapters.js';
import { FacebookChannelConfigStore } from '../src/agent-runtime/call-center/omnichannel/facebook-channel-store.js';
import { routePhase3AgentApi } from '../src/agent-runtime/call-center/agent-panel/phase3-agent-http.js';
import { TransferQueueStore } from '../src/agent-runtime/call-center/agent-panel/transfer-queue-store.js';
import { createObjectStorage } from '../src/storage/object-storage.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';

const API_KEY = 'test-phase3-key';

function authHeaders(tenantId: string, userId = 'user_1') {
  return {
    'X-API-Key': API_KEY,
    'X-Tenant-Id': tenantId,
    'X-User-Id': userId
  };
}

before(() => {
  useMemoryRedisForTests();
  process.env.CONVERACT_API_KEY = API_KEY;
  process.env.CONVERACT_AUTH_DISABLED = '1';
});

describe('Facebook Messenger outbound', () => {
  it('sends reply via Graph API when configured', async () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'FB Out' });
    new FacebookChannelConfigStore(db).upsert(tenant.id, {
      page_access_token: 'page-token',
      page_id: 'page-1'
    });

    const fetchMock = mock.method(global, 'fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message_id: 'm123' })
    }));

    const store = new OmniStore(db);
    const inbound = await receiveOmniInbound(
      { db, store },
      {
        tenant_id: tenant.id,
        channel: 'facebook_messenger',
        content: 'pricing?',
        customer_id: 'fb-user-9'
      }
    );

    const outbound = await sendOmniOutbound(
      { db, store },
      {
        tenant_id: tenant.id,
        channel: 'facebook_messenger',
        conversation_id: inbound.conversation.id,
        content: 'Thanks for reaching out'
      }
    );

    assert.equal(outbound.message.direction, 'outbound');
    assert.equal(fetchMock.mock.callCount(), 1);
    const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    assert.match(url, /graph\.facebook\.com/);
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.recipient.id, 'fb-user-9');
    fetchMock.mock.restore();
  });
});

describe('Screen recording object storage', () => {
  it('uploads to local storage and returns media URL', async () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Rec' });
    delete process.env.S3_BUCKET;
    delete process.env.CONVERACT_S3_BUCKET;
    const storage = createObjectStorage();
    const uploaded = await storage.upload({
      tenantId: tenant.id,
      filename: 'test.webm',
      body: Buffer.from('webm-data'),
      contentType: 'video/webm'
    });
    assert.match(uploaded.storage_url, /\/api\/call-center\/media\//);

    const result = (await routePhase3AgentApi(
      db,
      'POST',
      '/api/call-center/screen-recordings/upload',
      new URL('http://localhost/api/call-center/screen-recordings/upload?duration_sec=10'),
      null,
      Buffer.from('webm-data'),
      authHeaders(tenant.id)
    )) as { status: number; data: { storage_url: string } };
    assert.equal(result.status, 201);
    assert.ok(result.data.storage_url);
  });
});

describe('Phase 3 transfer queue', () => {
  it('enqueues and lists waiting calls', async () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'P3' });
    const voice = new VoiceStore(db);
    const session = voice.createCallSession({
      tenant_id: tenant.id,
      direction: 'inbound',
      rustpbx_call_id: 'p3-call',
      status: 'ringing'
    });

    const created = (await routePhase3AgentApi(
      db,
      'POST',
      '/api/call-center/transfer-queue',
      new URL('http://localhost/api/call-center/transfer-queue'),
      {
        call_session_id: session.id,
        customer_summary: 'High intent buyer',
        intent_score: 0.9
      },
      '',
      authHeaders(tenant.id)
    )) as { status: number; data: { id: string } };
    assert.equal(created.status, 201);

    const list = (await routePhase3AgentApi(
      db,
      'GET',
      '/api/call-center/transfer-queue',
      new URL('http://localhost/api/call-center/transfer-queue'),
      null,
      '',
      authHeaders(tenant.id)
    )) as { data: Array<{ call_session_id: string }> };
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].call_session_id, session.id);
    assert.equal(new TransferQueueStore(db).listWaiting(tenant.id).length, 1);
  });
});
