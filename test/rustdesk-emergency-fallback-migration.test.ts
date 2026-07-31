import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('RustDesk emergency fallback migration persists explicit authorization', () => {
  const migration = readFileSync(
    new URL('../src/migrations/075_rustdesk_emergency_fallback.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /emergency_fallback_authorized BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration, /emergency_fallback_reason TEXT NOT NULL DEFAULT ''/);
  assert.match(migration, /emergency_fallback_authorized_by TEXT NOT NULL DEFAULT ''/);
  assert.match(migration, /emergency_fallback_authorized_at TIMESTAMPTZ/);
});
