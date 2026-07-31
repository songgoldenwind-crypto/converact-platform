/**
 * L7 — audio-library / ivr-settings HTTP routes require auth.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { migrateIvrRuntimeTables } from '../src/db-migrations/ivr-runtime-schema.js';
import { routeAudioLibraryApi } from '../src/agent-runtime/ivr/audio-library-http.js';
import { routeIvrSettingsApi } from '../src/agent-runtime/ivr/ivr-settings-http.js';

test('audio-library: unauthenticated GET → 401', () => {
  const db = createDatabase(':memory:');
  migrateIvrRuntimeTables(db);
  assert.throws(
    () => routeAudioLibraryApi(db, 'GET', '/api/ivr/audio-library', new URL('http://x/api/ivr/audio-library'), null, {}),
    (err: Error & { status?: number }) => err.status === 401
  );
});

test('ivr-settings: unauthenticated GET time-groups → 401', () => {
  const db = createDatabase(':memory:');
  migrateIvrRuntimeTables(db);
  assert.throws(
    () =>
      routeIvrSettingsApi(
        db,
        'GET',
        '/api/ivr/settings/time-groups',
        new URL('http://x/api/ivr/settings/time-groups'),
        null,
        {}
      ),
    (err: Error & { status?: number }) => err.status === 401
  );
});

test('audio-library: unrelated path returns undefined without auth', () => {
  const db = createDatabase(':memory:');
  const result = routeAudioLibraryApi(db, 'GET', '/api/ivr/flows', new URL('http://x/api/ivr/flows'), null, {});
  assert.equal(result, undefined);
});
