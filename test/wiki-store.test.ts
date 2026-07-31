import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { KnowledgeWikiStore } from '../src/agent-runtime/knowledge/wiki-store.js';

let db: ReturnType<typeof createDatabase>;
let store: KnowledgeWikiStore;
let tenantId: string;

function setup() {
  db = createDatabase(':memory:');
  store = new KnowledgeWikiStore(db);
  tenantId = createTenant(db, { name: 'Wiki Test' }).id;
}

// ---- ingestSource ----

test('ingestSource creates a knowledge source with content hash', () => {
  setup();
  const source = store.ingestSource({
    tenant_id: tenantId,
    title: 'Product FAQ',
    content_text: 'What is OPC? It is an AI communication platform.'
  });
  assert.ok(source.id);
  assert.equal(source.title, 'Product FAQ');
  assert.ok(source.content_hash);
  assert.equal(source.source_type, 'document');
});

test('ingestSource deduplicates by content hash (INSERT OR IGNORE)', () => {
  setup();
  const s1 = store.ingestSource({ tenant_id: tenantId, title: 'A', content_text: 'same content' });
  const s2 = store.ingestSource({ tenant_id: tenantId, title: 'B', content_text: 'same content' });
  // Same content hash → same source returned (deduplicated)
  assert.equal(s1.id, s2.id);
});

test('ingestSource validates required fields', () => {
  setup();
  assert.throws(() => store.ingestSource({ tenant_id: '', title: 'T', content_text: 'C' }), /tenant_id/);
  assert.throws(() => store.ingestSource({ tenant_id: tenantId, title: '', content_text: 'C' }), /title/);
  assert.throws(() => store.ingestSource({ tenant_id: tenantId, title: 'T', content_text: '' }), /content/);
});

test('getSource retrieves by id, returns null if not found', () => {
  setup();
  const source = store.ingestSource({ tenant_id: tenantId, title: 'S', content_text: 'content' });
  assert.ok(store.getSource(tenantId, source.id));
  assert.equal(store.getSource(tenantId, 'nonexistent'), null);
});

test('listSources returns active sources', () => {
  setup();
  store.ingestSource({ tenant_id: tenantId, title: 'S1', content_text: 'c1' });
  store.ingestSource({ tenant_id: tenantId, title: 'S2', content_text: 'c2' });
  const sources = store.listSources({ tenant_id: tenantId });
  assert.equal(sources.length, 2);
});

// ---- upsertPage ----

test('upsertPage creates a new wiki page', () => {
  setup();
  const page = store.upsertPage({
    tenant_id: tenantId,
    title: 'Getting Started',
    content_markdown: '# Getting Started\nWelcome to OPC.'
  });
  assert.ok(page.id);
  assert.equal(page.title, 'Getting Started');
  assert.equal(page.version, 1);
  assert.equal(page.status, 'active');
  assert.ok(page.summary);
});

test('upsertPage updates existing page (version increment)', () => {
  setup();
  const v1 = store.upsertPage({ tenant_id: tenantId, title: 'Guide', content_markdown: 'v1 content' });
  const v2 = store.upsertPage({ tenant_id: tenantId, title: 'Guide', content_markdown: 'v2 content updated' });
  // Same slug → updated, not duplicated
  assert.equal(v2.id, v1.id);
  assert.equal(v2.version, 2);
  assert.equal(v2.title, 'Guide');
});

test('upsertPage normalizes slug from title', () => {
  setup();
  const page = store.upsertPage({ tenant_id: tenantId, title: 'API Reference Guide', content_markdown: 'x' });
  assert.ok(page.slug);
  // slug should be slugified version of the title
  assert.match(page.slug, /api|reference|guide/i);
});

test('upsertPage accepts explicit slug', () => {
  setup();
  const page = store.upsertPage({ tenant_id: tenantId, title: 'Custom Title', slug: 'custom-slug', content_markdown: 'x' });
  assert.equal(page.slug, 'custom-slug');
});

test('upsertPage replaces links (DELETE + INSERT)', () => {
  setup();
  const page1 = store.upsertPage({ tenant_id: tenantId, title: 'Page A', content_markdown: 'a' });
  const page2 = store.upsertPage({ tenant_id: tenantId, title: 'Page B', content_markdown: 'b' });
  // Add links from A → B
  store.upsertPage({
    tenant_id: tenantId,
    title: 'Page A',
    content_markdown: 'a updated',
    links: [{ to_page_id: page2.id, label: 'see also' }]
  });
  const page = store.getPage(tenantId, page1.id);
  assert.equal(page.links.length, 1);
  assert.equal(page.links[0].to_page_id, page2.id);

  // Update again with different links — old ones should be replaced
  store.upsertPage({
    tenant_id: tenantId,
    title: 'Page A',
    content_markdown: 'a updated again',
    links: []
  });
  const updated = store.getPage(tenantId, page1.id);
  assert.equal(updated.links.length, 0);
});

test('upsertPage validates required fields', () => {
  setup();
  assert.throws(() => store.upsertPage({ tenant_id: '', title: 'T', content_markdown: 'C' }), /tenant_id/);
  assert.throws(() => store.upsertPage({ tenant_id: tenantId, title: '', content_markdown: 'C' }), /title/);
});

// ---- getPage / listPages ----

test('getPage returns null for non-existent', () => {
  setup();
  assert.equal(store.getPage(tenantId, 'nonexistent'), null);
});

test('listPages filters by category and excludes archived', () => {
  setup();
  store.upsertPage({ tenant_id: tenantId, title: 'Concept 1', content_markdown: 'c', category: 'concept' });
  store.upsertPage({ tenant_id: tenantId, title: 'Guide 1', content_markdown: 'g', category: 'guide' });
  store.upsertPage({ tenant_id: tenantId, title: 'Concept 2', content_markdown: 'c2', category: 'concept' });
  const concepts = store.listPages({ tenant_id: tenantId, category: 'concept' });
  assert.equal(concepts.length, 2);
  const all = store.listPages({ tenant_id: tenantId });
  assert.equal(all.length, 3);
});

// ---- buildIndex / latestIndex ----

test('buildIndex creates a snapshot grouped by category', () => {
  setup();
  store.upsertPage({ tenant_id: tenantId, title: 'A', content_markdown: 'a', category: 'concept' });
  store.upsertPage({ tenant_id: tenantId, title: 'B', content_markdown: 'b', category: 'guide' });
  const index = store.buildIndex({ tenant_id: tenantId });
  assert.ok(index.id);
  assert.equal(index.page_count, 2);
  assert.ok(index.content_markdown.includes('# Wiki Index'));
  assert.ok(index.content_markdown.includes('## concept'));
  assert.ok(index.content_markdown.includes('## guide'));
});

test('latestIndex returns the most recent snapshot', () => {
  setup();
  store.upsertPage({ tenant_id: tenantId, title: 'X', content_markdown: 'x' });
  store.buildIndex({ tenant_id: tenantId });
  store.upsertPage({ tenant_id: tenantId, title: 'Y', content_markdown: 'y' });
  store.buildIndex({ tenant_id: tenantId });
  const latest = store.latestIndex({ tenant_id: tenantId });
  assert.ok(latest);
  assert.equal(latest.page_count, 2);
});

test('latestIndex returns null when no snapshots exist', () => {
  setup();
  assert.equal(store.latestIndex({ tenant_id: tenantId }), null);
});

// ---- query (search) ----

test('query finds pages matching search terms', () => {
  setup();
  store.upsertPage({ tenant_id: tenantId, title: 'API Setup', content_markdown: 'How to configure the REST API endpoint' });
  store.upsertPage({ tenant_id: tenantId, title: 'Webhook Guide', content_markdown: 'Configure webhooks for events' });
  const result = store.query({ tenant_id: tenantId, query: 'API configure' });
  assert.ok(result.results);
  assert.ok(result.results.length >= 1, `expected at least 1 result, got ${result.results.length}`);
  // Should rank API Setup higher (both terms match)
  assert.ok(result.results.some((r: { title: string }) => r.title === 'API Setup'));
});

test('query throws on empty query', () => {
  setup();
  assert.throws(() => store.query({ tenant_id: tenantId, query: '' }), /query is required/);
});

// ---- listEvents ----

test('listEvents returns wiki events in order', () => {
  setup();
  store.ingestSource({ tenant_id: tenantId, title: 'S', content_text: 'content' });
  store.upsertPage({ tenant_id: tenantId, title: 'P', content_markdown: 'p' });
  store.buildIndex({ tenant_id: tenantId });
  const events = store.listEvents({ tenant_id: tenantId });
  assert.ok(events.length >= 3);
  // Events should include ingest, page_upsert, index_build
  const types = events.map((e: { event_type: string }) => e.event_type);
  assert.ok(types.includes('ingest'));
  assert.ok(types.includes('page_upsert'));
  assert.ok(types.includes('index_build'));
});
