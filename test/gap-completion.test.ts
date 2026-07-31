import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { useMemoryRedisForTests } from '../src/agent-runtime/call-center/call-center-runtime.js';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { ConversationTurnStore } from '../src/agent-runtime/call-center/conversation-turn-store.js';
import { KnowledgeStore } from '../src/agent-runtime/call-center/knowledge/knowledge-store.js';
import {
  processIvrRouteCommand,
  listAgentScriptsCommand,
  getAgentScriptProgressCommand,
  advanceAgentScriptCommand,
  reportConversationTurnCommand,
  listRecordingsCommand
} from '../src/agent-runtime/call-center/application.js';
import { routeAgentToolsApi } from '../src/agent-runtime/call-center/agent-tools/agent-tools-http.js';
import { routeQmApi } from '../src/agent-runtime/call-center/qm/qm-http.js';
import { searchRecordings } from '../src/agent-runtime/call-center/agent-tools/recording-search.js';
import { generateCallSummary } from '../src/agent-runtime/call-center/agent-tools/auto-summary.js';
import { resolveIvrSelection } from '../src/agent-runtime/call-center/agent-tools/ivr-menu.js';

const GAP_API_KEY = 'test-gap-key';

before(() => {
  useMemoryRedisForTests();
  process.env.CONVERACT_API_KEY = GAP_API_KEY;
});

test('IVR menu resolves digit and timeout', () => {
  const sales = resolveIvrSelection('default', '1');
  assert.equal(sales.route_type, 'queue');
  assert.equal(sales.route_target, 'sales');

  const timeout = resolveIvrSelection('default', null);
  assert.equal(timeout.label, 'timeout');
});

test('processIvrRouteCommand returns menu and route', () => {
  const result = processIvrRouteCommand(null, { menu_id: 'default', digit: '2' }) as {
    data: { route: { route_target: string } };
  };
  assert.equal(result.data.route.route_target, 'default');
});

test('agent script seed and advance on active call', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Script' });
  const voiceStore = new VoiceStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'outbound',
    rustpbx_call_id: 'c-script',
    phone: '+8613900000099',
    status: 'active'
  });

  const scripts = listAgentScriptsCommand(db, tenant.id) as { data: unknown[] };
  assert.ok(scripts.data.length >= 1);

  const progress = getAgentScriptProgressCommand(db, tenant.id, session.id) as {
    data: { current_step_index: number };
  };
  assert.equal(progress.data.current_step_index, 0);

  const advanced = advanceAgentScriptCommand(db, tenant.id, session.id) as {
    data: { advanced_to: string | null };
  };
  assert.equal(advanced.data.advanced_to, 'disclose');

  const after = getAgentScriptProgressCommand(db, tenant.id, session.id) as {
    data: { current_step_index: number };
  };
  assert.equal(after.data.current_step_index, 1);
});

test('reportConversationTurn triggers agent assist path without error', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Assist' });
  const voiceStore = new VoiceStore(db);
  const kb = new KnowledgeStore(db);
  const base = kb.createKnowledgeBase({ tenant_id: tenant.id, name: 'FAQ' });
  kb.addDocument({
    knowledge_base_id: base.id,
    tenant_id: tenant.id,
    title: '退款',
    content: '退款需在 7 个工作日内处理完成。'
  });

  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    rustpbx_call_id: 'c-assist',
    phone: '+8613900000088',
    status: 'active'
  });

  const result = reportConversationTurnCommand(db, session.id, {
    role: 'customer',
    content: '怎么退款？'
  });
  assert.equal(result.status, 201);
});

test('auto summary persists fallback when no LLM key', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Summary' });
  const voiceStore = new VoiceStore(db);
  const turns = new ConversationTurnStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'outbound',
    rustpbx_call_id: 'c-sum',
    phone: '+8613900000077',
    status: 'completed'
  });
  turns.appendTurn(session.id, { role: 'customer', content: '想了解产品' });
  turns.appendTurn(session.id, { role: 'ai', content: '好的，我来介绍' });

  const summary = await generateCallSummary(db, tenant.id, session.id);
  assert.ok(summary?.summary);
});

test('recording search and HTTP list recordings', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Rec' });
  const voiceStore = new VoiceStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    rustpbx_call_id: 'c-rec',
    phone: '+8613900000044',
    status: 'completed'
  });
  db.prepare(
    `INSERT INTO call_recordings (id, tenant_id, call_session_id, source, format, storage_url, egress_id, created_at)
     VALUES ('rec1', ?, ?, 'livekit_egress', 'ogg', 's3://bucket/a.ogg', 'eg1', datetime('now'))`
  ).run(tenant.id, session.id);

  const rows = searchRecordings(db, { tenant_id: tenant.id, q: session.id });
  assert.equal(rows.length, 1);

  const listed = listRecordingsCommand(db, tenant.id, { q: session.id }) as { data: unknown[] };
  assert.equal(listed.data.length, 1);
});

test('manual QM evaluation API', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'QM' });
  const voiceStore = new VoiceStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    rustpbx_call_id: 'c-qm',
    phone: '+8613900000066',
    status: 'completed'
  });

  const result = await routeQmApi(
    db,
    'POST',
    '/api/qm/evaluations/manual',
    new URL('http://local'),
    {
      call_session_id: session.id,
      overall_score: 0.75,
      summary: '人工复核'
    },
    { 'X-API-Key': GAP_API_KEY, 'X-Tenant-Id': tenant.id }
  );
  assert.equal((result as { status: number }).status, 201);
});

test('agent tools HTTP exposes IVR route', async () => {
  const db = createDatabase(':memory:');

  const ivr = await routeAgentToolsApi(
    db,
    'POST',
    '/api/call-center/ivr/route',
    new URL('http://local'),
    { menu_id: 'default', digit: '0' },
    {}
  );
  const route = (ivr as { data: { route: { route_type: string } } }).data.route;
  assert.equal(route.route_type, 'voicemail');
});
