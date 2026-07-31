import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { KnowledgeStore } from '../src/agent-runtime/call-center/knowledge/knowledge-store.js';
import { routeKnowledgeApi } from '../src/agent-runtime/call-center/knowledge/knowledge-http.js';

const API_KEY = 'test-knowledge-key';
const authHeaders = (tenantId: string) => ({ 'X-API-Key': API_KEY, 'X-Tenant-Id': tenantId });

test('KnowledgeStore creates and lists knowledge bases', () => {
  const db = createDatabase(':memory:');
  const store = new KnowledgeStore(db);

  const kb = store.createKnowledgeBase({
    tenant_id: 'tenant-1',
    name: '产品知识库',
    description: '产品相关FAQ'
  });

  assert.ok(kb.id.startsWith('kb_'));
  assert.equal(kb.tenant_id, 'tenant-1');
  assert.equal(kb.name, '产品知识库');
  assert.equal(kb.description, '产品相关FAQ');
  assert.equal(kb.status, 'active');
  assert.equal(kb.document_count, 0);

  const list = store.listKnowledgeBases('tenant-1');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, kb.id);

  const empty = store.listKnowledgeBases('tenant-other');
  assert.equal(empty.length, 0);
});

test('KnowledgeStore adds and retrieves documents', () => {
  const db = createDatabase(':memory:');
  const store = new KnowledgeStore(db);

  const kb = store.createKnowledgeBase({ tenant_id: 't1', name: 'KB1' });

  const doc = store.addDocument({
    knowledge_base_id: kb.id,
    tenant_id: 't1',
    title: '退货政策',
    content: '30天内可无理由退货，需保持商品完好。'
  });

  assert.ok(doc.id.startsWith('doc_'));
  assert.equal(doc.title, '退货政策');
  assert.equal(doc.content_type, 'text');
  assert.equal(doc.status, 'indexed');

  const fetched = store.getDocument(doc.id);
  assert.equal(fetched?.title, '退货政策');

  const kbUpdated = store.getKnowledgeBase(kb.id);
  assert.equal(kbUpdated?.document_count, 1);

  const docs = store.listDocuments(kb.id);
  assert.equal(docs.length, 1);

  store.deleteDocument(doc.id);
  assert.equal(store.getDocument(doc.id), null);
  assert.equal(store.getKnowledgeBase(kb.id)?.document_count, 0);
});

test('searchDocuments finds matching documents by keyword', () => {
  const db = createDatabase(':memory:');
  const store = new KnowledgeStore(db);

  const kb = store.createKnowledgeBase({ tenant_id: 't1', name: 'KB' });

  store.addDocument({
    knowledge_base_id: kb.id,
    tenant_id: 't1',
    title: '退货政策',
    content: '30天内可无理由退货，需保持商品完好。'
  });
  store.addDocument({
    knowledge_base_id: kb.id,
    tenant_id: 't1',
    title: '配送说明',
    content: '全国包邮，3-5个工作日送达。'
  });
  store.addDocument({
    knowledge_base_id: kb.id,
    tenant_id: 't1',
    title: '会员权益',
    content: '会员享受9折优惠和免费退货服务。'
  });

  const results = store.searchDocuments('t1', '退货');
  assert.ok(results.length >= 1);
  assert.ok(results.some((d) => d.title === '退货政策'));

  const multiWord = store.searchDocuments('t1', '退货 会员');
  assert.ok(multiWord.length >= 1);
  assert.ok(multiWord.every((d) => d.content.includes('退货') && (d.content.includes('会员') || d.title.includes('会员'))));
});

test('searchDocuments returns empty for no match', () => {
  const db = createDatabase(':memory:');
  const store = new KnowledgeStore(db);

  const kb = store.createKnowledgeBase({ tenant_id: 't1', name: 'KB' });
  store.addDocument({
    knowledge_base_id: kb.id,
    tenant_id: 't1',
    title: '退货政策',
    content: '30天内可无理由退货。'
  });

  const results = store.searchDocuments('t1', '区块链技术');
  assert.equal(results.length, 0);
});

test('knowledge HTTP routes CRUD operations', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const db = createDatabase(':memory:');

  const createResult = await routeKnowledgeApi(
    db, 'POST', '/api/knowledge/bases',
    new URL('http://localhost/api/knowledge/bases'),
    { name: '测试知识库', description: '测试用' },
    authHeaders('t1')
  ) as { status: number; data: { id: string } };
  assert.equal(createResult.status, 201);
  assert.ok(createResult.data.id.startsWith('kb_'));
  const kbId = createResult.data.id;

  const listResult = await routeKnowledgeApi(
    db, 'GET', '/api/knowledge/bases',
    new URL('http://localhost/api/knowledge/bases'),
    null,
    authHeaders('t1')
  ) as { id: string }[];
  assert.equal(listResult.length, 1);

  const addDocResult = await routeKnowledgeApi(
    db, 'POST', `/api/knowledge/bases/${kbId}/documents`,
    new URL(`http://localhost/api/knowledge/bases/${kbId}/documents`),
    { title: '常见问题', content: '如何退货？30天内退货。' },
    authHeaders('t1')
  ) as { status: number; data: { id: string } };
  assert.equal(addDocResult.status, 201);
  const docId = addDocResult.data.id;

  const docsResult = await routeKnowledgeApi(
    db, 'GET', `/api/knowledge/bases/${kbId}/documents`,
    new URL(`http://localhost/api/knowledge/bases/${kbId}/documents`),
    null,
    authHeaders('t1')
  ) as { id: string }[];
  assert.equal(docsResult.length, 1);

  const searchResult = await routeKnowledgeApi(
    db, 'POST', '/api/knowledge/search',
    new URL('http://localhost/api/knowledge/search'),
    { query: '退货' },
    authHeaders('t1')
  ) as { id: string }[];
  assert.ok(searchResult.length >= 1);

  const deleteResult = await routeKnowledgeApi(
    db, 'DELETE', `/api/knowledge/documents/${docId}`,
    new URL(`http://localhost/api/knowledge/documents/${docId}`),
    null,
    authHeaders('t1')
  ) as { status: number };
  assert.equal(deleteResult.status, 204);

  // Cross-tenant access should be denied.
  const crossTenant = await routeKnowledgeApi(
    db, 'GET', `/api/knowledge/bases/${kbId}/documents`,
    new URL(`http://localhost/api/knowledge/bases/${kbId}/documents`),
    null,
    authHeaders('other-tenant')
  ) as { status: number; data: { error: string } };
  assert.equal(crossTenant.status, 404);

  const unmatched = await routeKnowledgeApi(
    db, 'GET', '/api/unknown',
    new URL('http://localhost/api/unknown'),
    null,
    authHeaders('t1')
  );
  assert.equal(unmatched, undefined);
});
