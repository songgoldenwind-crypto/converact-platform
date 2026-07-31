import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { all } from '../src/db.js';
import { createDatabase } from '../src/db.js';
import { createHarness } from '../src/agent-runtime/index.js';
import { createServer } from '../src/http.js';
import { createTenant } from '../src/services.js';
import { listenOnRandomPort } from './test-helpers.js';

test('transcript hooks record context, tool results, and artifact refs', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Transcript 测试公司' });
  const harness = createHarness(db);

  await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    user_id: 'user_test',
    playbook_id: 'analytics_agent.weekly_review.v1',
    goal: '生成 transcript 测试周报'
  });

  const entries = all(db, 'SELECT role, content_type FROM transcript_entries WHERE tenant_id = ? ORDER BY created_at ASC', [
    tenant.id
  ]);
  assert.deepEqual(
    entries.map((entry) => `${entry.role}:${entry.content_type}`),
    ['system:context_pack', 'tool:tool_result', 'event:artifact_ref']
  );
});

test('transcript store redacts PII before persistence', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'PII Transcript 测试公司' });
  const harness = createHarness(db);

  const entry = harness.transcriptStore.append({
    tenant_id: tenant.id,
    role: 'user',
    content_type: 'text',
    content: {
      message: 'Contact me at alice@example.com or +1 415 555 0100'
    }
  });

  assert.equal(entry.content_redacted.message.includes('alice@example.com'), false);
  assert.equal(entry.content_redacted.message.includes('+1 415 555 0100'), false);
  assert.deepEqual(entry.pii_classes.sort(), ['email', 'phone']);
});

test('memory promoter keeps candidate evidence before explicit approval', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Memory Promotion 测试公司' });
  const harness = createHarness(db);

  const transcript = harness.transcriptStore.append({
    tenant_id: tenant.id,
    role: 'user',
    content_type: 'text',
    content: { message: '以后这个 lead 都用表格总结。' }
  });
  const candidate = harness.memoryPromoter.propose({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead_123',
    memory_type: 'preference',
    content: '用户希望 lead_123 的跟进总结使用表格。',
    confidence: 0.95,
    evidence_refs: [{ object_type: 'transcript_entry', object_id: transcript.id }],
    source: 'explicit_user'
  });

  assert.equal(candidate.status, 'candidate');
  assert.equal(harness.memoryStore.search({ tenant_id: tenant.id, scope_type: 'lead', scope_id: 'lead_123' }).length, 0);

  const approved = harness.memoryPromoter.approve(tenant.id, candidate.id);
  assert.equal(approved.candidate.status, 'approved');
  assert.equal(approved.memory.scope_type, 'lead');
  assert.equal(approved.memory.evidence_object_id, transcript.id);
});

test('memory retrieval ranks scoped active memories and excludes stale entries', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Memory Retrieval 公司' });
  const harness = createHarness(db);

  harness.memoryStore.write({
    tenant_id: tenant.id,
    scope_type: 'tenant',
    memory_type: 'preference',
    content: '默认输出要简短。',
    confidence: 0.9
  });
  harness.memoryStore.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead_123',
    memory_type: 'preference',
    content: 'lead_123 跟进总结必须用表格。',
    confidence: 0.7
  });
  const stale = harness.memoryStore.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead_123',
    memory_type: 'fact',
    content: '过期的线索事实。',
    confidence: 1
  });
  harness.memoryStore.updateStatus(tenant.id, stale.id, 'stale', { reason: 'superseded' });

  const retrieved = harness.memoryStore.retrieve({
    tenant_id: tenant.id,
    scopes: [
      { scope_type: 'tenant', scope_id: '' },
      { scope_type: 'lead', scope_id: 'lead_123' }
    ]
  });

  assert.equal(retrieved.memories[0].content, 'lead_123 跟进总结必须用表格。');
  assert.equal(retrieved.memories.some((memory) => memory.content === '过期的线索事实。'), false);

  const contextPack = harness.contextBuilder.build({
    tenantId: tenant.id,
    agent: harness.agentRegistry.getManifest('crm_agent'),
    playbook: harness.agentRegistry.getPlaybook('crm_agent.create_followup_task.v1'),
    goal: '跟进 lead_123',
    businessContext: { lead_id: 'lead_123' }
  });
  assert.equal(contextPack.memoryPack.facts[0].content, 'lead_123 跟进总结必须用表格。');
});

test('memory promoter extracts candidates from transcript and lifecycle status controls retrieval', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Memory Extraction 公司' });
  const harness = createHarness(db);
  const transcript = harness.transcriptStore.append({
    tenant_id: tenant.id,
    role: 'user',
    content_type: 'text',
    content: { message: '以后这个 lead 都用表格总结。事实是客户是 SaaS 创始人。' },
    business_object_refs: [{ object_type: 'lead', object_id: 'lead_123' }]
  });

  const candidates = harness.memoryPromoter.extractFromTranscript(
    {
      tenant_id: tenant.id,
      transcript_entry_id: transcript.id
    },
    harness.transcriptStore
  );

  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map((candidate) => candidate.memory_type).sort(),
    ['fact', 'preference']
  );

  const approved = harness.memoryPromoter.approve(tenant.id, candidates[0].id);
  assert.equal(approved.memory.status, 'active');
  assert.equal(harness.memoryStore.retrieve({ tenant_id: tenant.id, scopes: [{ scope_type: 'lead', scope_id: 'lead_123' }] }).memories.length, 1);

  harness.memoryStore.updateStatus(tenant.id, approved.memory.id, 'contradicted', { reason: 'new user correction' });
  assert.equal(harness.memoryStore.retrieve({ tenant_id: tenant.id, scopes: [{ scope_type: 'lead', scope_id: 'lead_123' }] }).memories.length, 0);
});

test('memory recall returns temporal source lineage and query funnel reasons', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Long Memory Recall 公司' });
  const harness = createHarness(db);

  const memory = harness.memoryStore.write({
    tenant_id: tenant.id,
    scope_type: 'customer',
    scope_id: 'customer_789',
    memory_type: 'condition',
    content: 'Customer requires ROI proof before any proposal.',
    entity_key: 'customer:customer_789',
    fact_key: 'condition:proposal_roi',
    confidence: 0.92,
    known_at: '2026-04-30T10:00:00.000Z',
    occurred_at: '2026-04-29T10:00:00.000Z',
    source_refs: [{ object_type: 'transcript_entry', object_id: 'trn_roi' }]
  });

  const recalled = harness.memoryStore.retrieve({
    tenant_id: tenant.id,
    query: 'ROI proposal',
    scopes: [{ scope_type: 'customer', scope_id: 'customer_789' }]
  });

  assert.equal(recalled.memories[0].id, memory.id);
  assert.equal(recalled.memories[0].entity_key, 'customer:customer_789');
  assert.equal(recalled.memories[0].fact_key, 'condition:proposal_roi');
  assert.equal(recalled.memories[0].temporal.known_at, '2026-04-30T10:00:00.000Z');
  assert.deepEqual(recalled.memories[0].source_refs, [{ object_type: 'transcript_entry', object_id: 'trn_roi' }]);
  assert.equal(recalled.memories[0].recall_path.includes('query'), true);
  assert.equal(recalled.memories[0].rank_reason.includes('query_exact='), true);
});

test('approving newer memory supersedes older active fact with same key', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Memory Supersede 公司' });
  const harness = createHarness(db);

  const oldMemory = harness.memoryStore.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead_budget',
    memory_type: 'fact',
    content: '客户预算是 5000 元。',
    entity_key: 'lead:lead_budget',
    fact_key: 'fact:budget',
    confidence: 0.7
  });
  const candidate = harness.memoryPromoter.propose({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead_budget',
    memory_type: 'fact',
    content: '客户预算更新为 12000 元。',
    entity_key: 'lead:lead_budget',
    fact_key: 'fact:budget',
    confidence: 0.95,
    evidence_refs: [{ object_type: 'transcript_entry', object_id: 'trn_budget_new' }]
  });

  const approved = harness.memoryPromoter.approve(tenant.id, candidate.id);
  const oldAfter = harness.memoryStore.get(tenant.id, oldMemory.id);
  const recalled = harness.memoryStore.retrieve({
    tenant_id: tenant.id,
    query: '预算',
    scopes: [{ scope_type: 'lead', scope_id: 'lead_budget' }]
  });

  assert.equal(oldAfter.status, 'superseded');
  assert.equal(oldAfter.superseded_by_memory_id, approved.memory.id);
  assert.equal(approved.memory.supersedes_memory_id, oldMemory.id);
  assert.equal(approved.superseded.length, 1);
  assert.equal(recalled.memories.length, 1);
  assert.equal(recalled.memories[0].content, '客户预算更新为 12000 元。');
  assert.equal(recalled.memories[0].lineage.supersedes_memory_id, oldMemory.id);
});

test('transcript extraction promotes persistent conditions open loops and synthesized profiles', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Memory Profile 公司' });
  const harness = createHarness(db);
  const transcript = harness.transcriptStore.append({
    tenant_id: tenant.id,
    role: 'user',
    content_type: 'text',
    content: {
      message: '长期目标是只找杭州本地财税客户。下次记得回拨王总确认报价。以后话术先讲节省时间。'
    },
    business_object_refs: [{ object_type: 'customer', object_id: 'customer_profile' }]
  });

  const candidates = harness.memoryPromoter.extractFromTranscript(
    {
      tenant_id: tenant.id,
      transcript_entry_id: transcript.id
    },
    harness.transcriptStore
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.memory_type).sort(),
    ['condition', 'open_loop', 'preference']
  );
  for (const candidate of candidates) harness.memoryPromoter.approve(tenant.id, candidate.id);

  const profile = harness.memoryStore.synthesizeProfile({
    tenant_id: tenant.id,
    scope_type: 'customer',
    scope_id: 'customer_profile'
  });
  assert.equal(profile.memory_type, 'profile');
  assert.equal(profile.content.includes('长期条件'), true);
  assert.equal(profile.content.includes('未完成线索'), true);

  const refreshed = harness.memoryStore.synthesizeProfile({
    tenant_id: tenant.id,
    scope_type: 'customer',
    scope_id: 'customer_profile'
  });
  const oldProfile = harness.memoryStore.get(tenant.id, profile.id);
  assert.equal(oldProfile.status, 'superseded');
  assert.equal(refreshed.supersedes_memory_id, profile.id);
});

const apiDb = createDatabase(':memory:');
const apiServer = createServer(apiDb);
let baseUrl = '';

before(async () => {
  const port = await listenOnRandomPort(apiServer);
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => apiServer.close(resolve));
});

test('memory HTTP API supports transcript extraction, approval, ranked search, and lifecycle review', async () => {
  const tenant = await post('/api/tenants', { name: 'Memory API 公司' });
  const transcript = await post('/api/transcripts', {
    tenant_id: tenant.id,
    role: 'user',
    content_type: 'text',
    content: { message: '记住后续给这个客户的方案都要先列 ROI。' },
    business_object_refs: [{ object_type: 'customer', object_id: 'customer_123' }]
  });
  const extracted = await post('/api/memory/candidates/extract', {
    tenant_id: tenant.id,
    transcript_entry_id: transcript.id
  });
  assert.equal(extracted.candidates.length, 1);

  const approved = await post(`/api/memory/candidates/${extracted.candidates[0].id}/approve`, {
    tenant_id: tenant.id
  });
  assert.equal(approved.memory.scope_type, 'customer');

  const search = await post('/api/memory/search', {
    tenant_id: tenant.id,
    scopes: [{ scope_type: 'customer', scope_id: 'customer_123' }]
  });
  assert.equal(search.memories[0].id, approved.memory.id);

  const marked = await post(`/api/memory/${approved.memory.id}/status`, {
    tenant_id: tenant.id,
    status: 'archived',
    reason: 'manual cleanup'
  });
  assert.equal(marked.status, 'archived');
});

test('memory HTTP API recalls long memory and synthesizes scoped profile', async () => {
  const tenant = await post('/api/tenants', { name: 'Memory Recall API 公司' });
  const candidate = await post('/api/memory/candidates/propose', {
    tenant_id: tenant.id,
    scope_type: 'customer',
    scope_id: 'customer_api',
    memory_type: 'condition',
    content: 'Customer API requires a callback after every quote.',
    entity_key: 'customer:customer_api',
    fact_key: 'condition:quote_callback',
    confidence: 0.91,
    source_refs: [{ object_type: 'transcript_entry', object_id: 'trn_api_callback' }],
    known_at: '2026-04-30T09:30:00.000Z'
  });
  await post(`/api/memory/candidates/${candidate.id}/approve`, {
    tenant_id: tenant.id
  });

  const recall = await post('/api/memory/recall', {
    tenant_id: tenant.id,
    query: 'callback quote',
    scopes: [{ scope_type: 'customer', scope_id: 'customer_api' }]
  });
  assert.equal(recall.memories[0].fact_key, 'condition:quote_callback');
  assert.equal(recall.memories[0].recall_path.includes('source'), true);

  const profile = await post('/api/memory/profile/synthesize', {
    tenant_id: tenant.id,
    scope_type: 'customer',
    scope_id: 'customer_api'
  });
  assert.equal(profile.memory_type, 'profile');
  assert.equal(profile.content.includes('长期条件'), true);
});

async function post<T = any>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = (await response.json()) as T;
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}
