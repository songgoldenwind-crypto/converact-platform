import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  RustDeskObservationSpool,
  type RustDeskEdgeObservationInput
} from '../scripts/rustdesk-observation-spool.js';

function observation(id: string): RustDeskEdgeObservationInput {
  return {
    external_id: 'gateway-observation-1',
    operation_id: id,
    operation: 'view_screen',
    status: 'observed_succeeded',
    observer: 'native_client',
    source_adapter: 'rustdesk_log',
    observed_at: '2026-07-15T06:00:00.000Z',
    evidence_refs: [{
      type: 'native_log',
      ref: `evidence://rustdesk/${id}`,
      sha256: `sha256:${'a'.repeat(64)}`
    }]
  };
}

test('observation spool persists receive, forwarding recovery, retry, and forwarded terminal state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rustdesk-observation-spool-'));
  let now = new Date('2026-07-15T06:00:00.000Z');
  let spool = await RustDeskObservationSpool.open({
    directory,
    forwarding_lease_ms: 1_000,
    now: () => now
  });
  const first = await spool.receive(observation('screen-1'));
  const replay = await spool.receive(observation('screen-1'));
  assert.equal(replay.id, first.id);
  assert.equal((await spool.list()).length, 1);
  let claimed = await spool.claimBatch(10);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].state, 'forwarding');
  assert.equal(claimed[0].attempt_count, 1);
  await spool.close();

  now = new Date('2026-07-15T06:00:02.000Z');
  spool = await RustDeskObservationSpool.open({
    directory,
    forwarding_lease_ms: 1_000,
    now: () => now
  });
  claimed = await spool.claimBatch(10);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].attempt_count, 2);
  await spool.markForwarded(claimed.map((record) => record.id));
  const forwarded = await spool.list();
  assert.equal(forwarded[0].state, 'forwarded');
  assert.equal(forwarded[0].observation, undefined);
  assert.match(forwarded[0].observation_sha256, /^sha256:[a-f0-9]{64}$/);
  await spool.close();
});

test('observation spool retries transient failure and dead-letters bounded attempts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rustdesk-observation-retry-'));
  let now = new Date('2026-07-15T06:00:00.000Z');
  const spool = await RustDeskObservationSpool.open({
    directory,
    max_attempts: 2,
    retry_delay_ms: 1_000,
    now: () => now
  });
  await spool.receive(observation('screen-retry'));
  let claimed = await spool.claimBatch(1);
  await spool.markFailed(claimed.map((record) => record.id), {
    retriable: true,
    error_code: 'upstream_503'
  });
  assert.equal((await spool.list())[0].state, 'received');
  assert.equal((await spool.claimBatch(1)).length, 0);

  now = new Date('2026-07-15T06:00:02.000Z');
  claimed = await spool.claimBatch(1);
  await spool.markFailed(claimed.map((record) => record.id), {
    retriable: true,
    error_code: 'network_error'
  });
  const records = await spool.list();
  assert.equal(records[0].state, 'dead_letter');
  assert.equal(records[0].last_error_code, 'network_error');
  assert.equal(records[0].attempt_count, 2);
  await spool.close();
});

test('observation spool rejects secrets, unknown input, symlinks, and concurrent processes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rustdesk-observation-secure-'));
  const spool = await RustDeskObservationSpool.open({ directory });
  await assert.rejects(
    () => spool.receive({ ...observation('secret-1'), clipboard_content: 'private text' } as never),
    /unsupported RustDesk observation input field: clipboard_content/
  );
  await assert.rejects(
    () => RustDeskObservationSpool.open({ directory }),
    /already locked by a live process/
  );
  await spool.close();

  const target = join(directory, 'target.json');
  writeFileSync(target, '{}', 'utf8');
  symlinkSync(target, join(directory, 'records.json'));
  await assert.rejects(
    () => RustDeskObservationSpool.open({ directory }),
    /records file must not be a symbolic link/
  );
  assert.equal(readFileSync(target, 'utf8'), '{}');
});

test('observation spool requires explicit native file and local recording security truth', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rustdesk-observation-truth-'));
  const spool = await RustDeskObservationSpool.open({ directory });
  try {
    await assert.rejects(
      () => spool.receive({
        ...observation('native-transfer'),
        operation: 'transfer_file',
        direction: 'upload'
      }),
      /transfer_file observation evidence_security is required/
    );
    const received = await spool.receive({
      ...observation('native-transfer'),
      operation: 'transfer_file',
      direction: 'upload',
      evidence_security: 'native_unscanned'
    });
    assert.equal(received.observation?.evidence_security, 'native_unscanned');
  } finally {
    await spool.close();
  }
});
