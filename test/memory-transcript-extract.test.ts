import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase, all, one } from '../src/db.js';
import { createTenant } from '../src/services.js';
import { MemoryStore } from '../src/agent-runtime/memory/memory-store.js';
import { MemoryPromoter } from '../src/agent-runtime/memory/memory-promoter.js';
import { TranscriptStore } from '../src/agent-runtime/memory/transcript-store.js';

test('extractFromTranscript: extracts preference', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const promoter = new MemoryPromoter(db, store, null);
  const transcriptStore = new TranscriptStore(db, null);

  const entry = transcriptStore.append({
    tenant_id: tenant.id,
    role: 'user',
    content_type: 'text',
    content: { text: '请记住，以后都用微信联系我' },
    business_object_refs: [{ object_type: 'lead', object_id: 'lead-1' }]
  });

  const candidates = promoter.extractFromTranscript(
    { tenant_id: tenant.id, transcript_entry_id: entry?.id },
    transcriptStore
  );

  assert.ok(candidates.length > 0, 'should extract at least one candidate');
  const pref = candidates.find((c) => c?.memory_type === 'preference');
  assert.ok(pref, 'should extract preference');
  assert.ok(String(pref?.content).includes('微信'), 'preference should mention 微信');
});

test('extractFromTranscript: extracts fact', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const promoter = new MemoryPromoter(db, store, null);
  const transcriptStore = new TranscriptStore(db, null);

  const entry = transcriptStore.append({
    tenant_id: tenant.id,
    role: 'user',
    content_type: 'text',
    content: { text: '事实是，我们是 ABC 公司' },
    business_object_refs: [{ object_type: 'lead', object_id: 'lead-1' }]
  });

  const candidates = promoter.extractFromTranscript(
    { tenant_id: tenant.id, transcript_entry_id: entry?.id },
    transcriptStore
  );

  const fact = candidates.find((c) => c?.memory_type === 'fact');
  assert.ok(fact, 'should extract fact');
});

test('extractFromTranscript: extracts condition', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const promoter = new MemoryPromoter(db, store, null);
  const transcriptStore = new TranscriptStore(db, null);

  const entry = transcriptStore.append({
    tenant_id: tenant.id,
    role: 'user',
    content_type: 'text',
    content: { text: '长期条件是，预算不能超过 10 万' },
    business_object_refs: [{ object_type: 'lead', object_id: 'lead-1' }]
  });

  const candidates = promoter.extractFromTranscript(
    { tenant_id: tenant.id, transcript_entry_id: entry?.id },
    transcriptStore
  );

  const condition = candidates.find((c) => c?.memory_type === 'condition');
  assert.ok(condition, 'should extract condition');
});

test('extractFromTranscript: extracts open_loop', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const promoter = new MemoryPromoter(db, store, null);
  const transcriptStore = new TranscriptStore(db, null);

  const entry = transcriptStore.append({
    tenant_id: tenant.id,
    role: 'user',
    content_type: 'text',
    content: { text: '待下次回拨确认时间' },
    business_object_refs: [{ object_type: 'lead', object_id: 'lead-1' }]
  });

  const candidates = promoter.extractFromTranscript(
    { tenant_id: tenant.id, transcript_entry_id: entry?.id },
    transcriptStore
  );

  const loop = candidates.find((c) => c?.memory_type === 'open_loop');
  assert.ok(loop, 'should extract open_loop');
});

test('extractFromTranscript: dedupes duplicate statements', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const promoter = new MemoryPromoter(db, store, null);
  const transcriptStore = new TranscriptStore(db, null);

  const entry = transcriptStore.append({
    tenant_id: tenant.id,
    role: 'user',
    content_type: 'text',
    content: { text: '请记住用微信。以后都用微信联系。' },
    business_object_refs: [{ object_type: 'lead', object_id: 'lead-1' }]
  });

  const candidates = promoter.extractFromTranscript(
    { tenant_id: tenant.id, transcript_entry_id: entry?.id },
    transcriptStore
  );

  const prefs = candidates.filter((c) => c?.memory_type === 'preference');
  assert.equal(prefs.length, 1, 'should dedupe duplicate preferences');
});

test('extractFromTranscript: empty content returns no candidates', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const promoter = new MemoryPromoter(db, store, null);
  const transcriptStore = new TranscriptStore(db, null);

  const entry = transcriptStore.append({
    tenant_id: tenant.id,
    role: 'user',
    content_type: 'text',
    content: { text: '你好，谢谢' },
    business_object_refs: [{ object_type: 'lead', object_id: 'lead-1' }]
  });

  const candidates = promoter.extractFromTranscript(
    { tenant_id: tenant.id, transcript_entry_id: entry?.id },
    transcriptStore
  );

  assert.equal(candidates.length, 0, 'greeting should not produce candidates');
});
