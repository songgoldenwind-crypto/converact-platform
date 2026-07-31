import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryPg } from '../src/db-pg.js';
import { signAccessToken } from '../src/middleware/auth.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { TranslationService } from '../src/agent-runtime/collaboration/translation-service.js';
import { routeIveKitChatApi } from '../src/agent-runtime/ivekit/chat-http.js';

test('translation HTTP requests, runs, and lists message translations without leaking job internals', async () => {
  const previous = { secret: process.env.OPC_JWT_SECRET, key: process.env.OPC_API_KEY };
  process.env.OPC_JWT_SECRET = 'translation-http-jwt-secret-with-sufficient-length';
  process.env.OPC_API_KEY = 'translation-http-system-key';
  const pg = new MemoryPg();
  const tenantId = 'tenant-translation-http';
  const store = new CollaborationStore(pg);
  try {
    const session = await store.openSession({
      tenant_id: tenantId,
      business_ref: { tenant_id: tenantId, type: 'service_order', id: 'translation-http-order' }
    });
    await store.addParticipant({ tenant_id: tenantId, session_id: session.id, identity: 'agent-1', role: 'agent' });
    const message = await store.postMessage({
      tenant_id: tenantId,
      session_id: session.id,
      sender_identity: 'agent-1',
      message_type: 'text',
      body: 'HTTP translation source'
    });
    const service = new TranslationService({
      pg,
      provider: {
        name: 'translation-http-provider',
        mode: 'self_hosted',
        translate: async () => ({ translated_text: 'HTTP translated result' })
      }
    });
    const durableEvents: Array<{ tenant_id: string; type: string; data: unknown }> = [];
    const realtimeEvents: Array<{ tenantId: string; type: string; data: unknown }> = [];
    const options = {
      translation: service,
      eventStore: {
        async append(event: { tenant_id: string; type: string; data: unknown }) {
          durableEvents.push(event);
          return {} as never;
        }
      },
      publish(tenantId: string, type: string, data: unknown) {
        realtimeEvents.push({ tenantId, type, data });
      }
    };
    const agentHeaders = {
      authorization: `Bearer ${signAccessToken({ sub: 'agent-1', tid: tenantId, role: 'operator' })}`,
      'idempotency-key': 'translation-http-key'
    };
    const path = `/api/ivekit/chat/sessions/${session.id}/messages/${message.id}/translations`;
    const created = await routeIveKitChatApi(
      pg, 'POST', path, new URL(`http://localhost${path}`),
      { target_language: 'en-US' }, '', agentHeaders, options
    ) as { status: number; data: { job: Record<string, unknown> }; afterCommit: () => Promise<void> };
    assert.equal(created.status, 201);
    assert.equal(created.data.job.status, 'pending');
    assert.equal('idempotency_key' in created.data.job, false);
    assert.equal('payload_hash' in created.data.job, false);
    await created.afterCommit();
    assert.equal(durableEvents.length, 1);
    assert.equal(realtimeEvents.length, 1);
    assert.doesNotMatch(
      JSON.stringify([durableEvents, realtimeEvents]),
      /HTTP translation source|HTTP translated result|translation-http-key|payload_hash/
    );

    const run = await routeIveKitChatApi(
      pg, 'POST', '/api/ivekit/chat/translation/run',
      new URL('http://localhost/api/ivekit/chat/translation/run'), { limit: 10 }, '',
      { 'x-api-key': 'translation-http-system-key', 'x-tenant-id': tenantId },
      options
    ) as { data: { succeeded: number } };
    assert.equal(run.data.succeeded, 1);

    const listed = await routeIveKitChatApi(
      pg, 'GET', path, new URL(`http://localhost${path}`), {}, '', agentHeaders,
      options
    ) as { data: { items: Array<{ translated_text: string }> } };
    assert.equal(listed.data.items[0]?.translated_text, 'HTTP translated result');

    await assert.rejects(
      () => routeIveKitChatApi(
        pg, 'GET', path, new URL(`http://localhost${path}`), {}, '',
        { authorization: `Bearer ${signAccessToken({ sub: 'outsider', tid: tenantId, role: 'operator' })}` },
        options
      ),
      (error: unknown) => Number((error as { status?: unknown })?.status) === 404
    );
  } finally {
    if (previous.secret === undefined) delete process.env.OPC_JWT_SECRET;
    else process.env.OPC_JWT_SECRET = previous.secret;
    if (previous.key === undefined) delete process.env.OPC_API_KEY;
    else process.env.OPC_API_KEY = previous.key;
  }
});
