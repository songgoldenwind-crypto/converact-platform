import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { AudioLibraryStore } from '../src/agent-runtime/ivr/audio-library-store.js';

test('AudioLibraryStore creates and retrieves an entry', () => {
  const db = createDatabase(':memory:');
  const store = new AudioLibraryStore(db);
  store.ensureTable();

  const entry = store.upsert({
    id: 'audio-1',
    scope: 'enterprise',
    tenant_id: 'tenant-1',
    name: '欢迎语',
    entry_type: 'tts',
    tts_text: '欢迎致电{{公司名}}',
    tts_engine: 'ali',
    language: 'zh',
  });

  assert.equal(entry.id, 'audio-1');
  assert.equal(entry.name, '欢迎语');
  assert.equal(entry.entry_type, 'tts');
  assert.equal(entry.tts_text, '欢迎致电{{公司名}}');

  const got = store.get('audio-1');
  assert.ok(got);
  assert.equal(got.tts_engine, 'ali');
});

test('AudioLibraryStore upserts existing entry (ON CONFLICT)', () => {
  const db = createDatabase(':memory:');
  const store = new AudioLibraryStore(db);
  store.ensureTable();

  store.upsert({ id: 'audio-2', scope: 'enterprise', tenant_id: 't1', name: 'Original', entry_type: 'tts' });
  const updated = store.upsert({ id: 'audio-2', scope: 'enterprise', tenant_id: 't1', name: 'Updated', entry_type: 'audio_file', audio_url: 'welcome.wav' });

  assert.equal(updated.name, 'Updated');
  assert.equal(updated.entry_type, 'audio_file');
  assert.equal(updated.audio_url, 'welcome.wav');
});

test('listForTenant returns public + tenant enterprise entries', () => {
  const db = createDatabase(':memory:');
  const store = new AudioLibraryStore(db);
  store.ensureTable();

  store.upsert({ id: 'pub-1', scope: 'public', tenant_id: '', name: 'Public Greeting', entry_type: 'tts' });
  store.upsert({ id: 'ent-1', scope: 'enterprise', tenant_id: 'tenant-A', name: 'Enterprise Welcome', entry_type: 'tts' });
  store.upsert({ id: 'ent-2', scope: 'enterprise', tenant_id: 'tenant-B', name: 'Other Tenant', entry_type: 'tts' });

  const visible = store.listForTenant('tenant-A');
  assert.equal(visible.length, 2); // pub-1 + ent-1, NOT ent-2
  assert.ok(visible.some((e) => e.id === 'pub-1'));
  assert.ok(visible.some((e) => e.id === 'ent-1'));
  assert.ok(!visible.some((e) => e.id === 'ent-2'));
});

test('delete removes entry', () => {
  const db = createDatabase(':memory:');
  const store = new AudioLibraryStore(db);
  store.ensureTable();

  store.upsert({ id: 'del-1', scope: 'enterprise', tenant_id: 't1', name: 'Delete Me', entry_type: 'tts' });
  assert.ok(store.get('del-1'));
  const deleted = store.delete('del-1');
  assert.equal(deleted, true);
  assert.equal(store.get('del-1'), null);
});

test('ensureTable is idempotent (call twice without error)', () => {
  const db = createDatabase(':memory:');
  const store = new AudioLibraryStore(db);
  store.ensureTable();
  store.ensureTable(); // should not throw
  assert.ok(store.listForTenant('any')); // returns empty array
});

test('audio_file type stores audio_url', () => {
  const db = createDatabase(':memory:');
  const store = new AudioLibraryStore(db);
  store.ensureTable();

  const entry = store.upsert({
    id: 'file-1',
    scope: 'public',
    tenant_id: '',
    name: '背景音乐',
    entry_type: 'audio_file',
    audio_url: 'https://cdn.example.com/bgm.wav',
    duration_sec: 30,
  });

  assert.equal(entry.audio_url, 'https://cdn.example.com/bgm.wav');
  assert.equal(entry.duration_sec, 30);
});

test('audio_var type stores variable_name', () => {
  const db = createDatabase(':memory:');
  const store = new AudioLibraryStore(db);
  store.ensureTable();

  const entry = store.upsert({
    id: 'var-1',
    scope: 'enterprise',
    tenant_id: 't1',
    name: '动态语音',
    entry_type: 'audio_var',
    variable_name: 'user_recorded_greeting',
  });

  assert.equal(entry.variable_name, 'user_recorded_greeting');
});