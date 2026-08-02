import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const probePath = new URL(
  '../services/converact-service/acceptance/g03-sip-foundation/postgres-effect-restart-probe.ts',
  import.meta.url
);

test('G03 PostgreSQL restart probe freezes a deterministic cross-process effect identity', async () => {
  assert.equal(
    existsSync(probePath),
    true,
    'missing G03 PostgreSQL restart probe'
  );

  const probe = await import(pathToFileURL(probePath.pathname).href);
  const first = probe.createPostgresRestartFixture('g03-pg-restart-01');
  const second = probe.createPostgresRestartFixture('g03-pg-restart-01');

  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first.authority), true);
  assert.equal(Object.isFrozen(first.input.prepared_effect), true);
  assert.equal(first.identity.tenant_id, 'g03-pg-restart-01');
  assert.equal(first.identity.protocol_effect_id, 'g03-effect-g03-pg-restart-01');
  assert.match(first.identity.wire_bytes_hash, /^[a-f0-9]{64}$/u);
  assert.match(first.identity.wire_freeze_sha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(first.identity), /password|database_url|secret/iu);
});

test('G03 PostgreSQL restart probe accepts only explicit prepare, recover and cleanup phases', async () => {
  assert.equal(existsSync(probePath), true, 'missing G03 PostgreSQL restart probe');
  const probe = await import(pathToFileURL(probePath.pathname).href);

  assert.equal(probe.parsePostgresRestartPhase(['prepare']), 'prepare');
  assert.equal(probe.parsePostgresRestartPhase(['recover']), 'recover');
  assert.equal(probe.parsePostgresRestartPhase(['cleanup']), 'cleanup');
  assert.throws(
    () => probe.parsePostgresRestartPhase([]),
    /g03_postgres_restart_phase_invalid/u
  );
  assert.throws(
    () => probe.parsePostgresRestartPhase(['prepare', 'extra']),
    /g03_postgres_restart_phase_invalid/u
  );
  assert.throws(
    () => probe.parsePostgresRestartPhase(['unknown']),
    /g03_postgres_restart_phase_invalid/u
  );
});
