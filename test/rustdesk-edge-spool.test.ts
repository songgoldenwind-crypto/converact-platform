import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RustDeskEdgePendingFileStore,
  type RustDeskEdgeExecutingRecord
} from '../scripts/rustdesk-edge-pending-store.js';

const command: RustDeskEdgeExecutingRecord['command'] = {
  id: 'rdcmd_spool_1',
  command_type: 'disconnect_session',
  external_id: 'rdgw_spool_1',
  target_id: 'rdesk_spool_1',
  rustdesk_id: '123456789',
  controller_rustdesk_id: '987654321',
  requested_reason: 'consent_revoked',
  attempt: 1,
  emergency_fallback_authorized: false,
  emergency_fallback_reason: ''
};

test('RustDesk edge spool persists executing/executed state without credentials or output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'converact-rustdesk-spool-'));
  const store = await RustDeskEdgePendingFileStore.open({ directory: dir });
  try {
    await store.writeExecuting({
      edge_instance_id: 'edge-spool-1',
      device_id: command.target_id,
      command,
      progress: []
    });
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'active.json')).mode & 0o777, 0o600);
    const executing = await store.load();
    assert.equal(executing?.state, 'executing');

    await store.writeExecuted({
      edge_instance_id: 'edge-spool-1',
      device_id: command.target_id,
      command,
      progress: [{
        progress: 'fallback_started',
        metadata: { fallback_reason: 'adapter_exit_nonzero' }
      }],
      result: {
        status: 'succeeded',
        execution_method: 'service_restart',
        exit_code: 0,
        duration_ms: 42,
        stdout_bytes: 12,
        stderr_bytes: 0,
        stdout_sha256: `sha256:${'a'.repeat(64)}`,
        stderr_sha256: `sha256:${'b'.repeat(64)}`,
        metadata: { edge_instance_id: 'edge-spool-1' }
      }
    });
    const executed = await store.load();
    assert.equal(executed?.state, 'executed');
    const raw = readFileSync(join(dir, 'active.json'), 'utf8');
    for (const forbidden of ['claim_token', 'commandToken', 'apiKey', 'stdout"', 'stderr"', 'password']) {
      assert.equal(raw.includes(forbidden), false, forbidden);
    }
    assert.equal(readdirSync(dir).some((name) => name.includes('.tmp-')), false);
  } finally {
    await store.close();
  }

  const reopened = await RustDeskEdgePendingFileStore.open({ directory: dir });
  try {
    assert.equal((await reopened.load())?.state, 'executed');
    await reopened.quarantine('recovery_lease_owned_by_another_edge');
    assert.equal(await reopened.load(), null);
    const names = readdirSync(join(dir, 'quarantine'));
    assert.equal(names.length, 1);
    const quarantined = readFileSync(join(dir, 'quarantine', names[0]), 'utf8');
    assert.match(quarantined, /recovery_lease_owned_by_another_edge/);
  } finally {
    await reopened.close();
  }
});

test('RustDesk edge spool enforces a single live process lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'converact-rustdesk-spool-lock-'));
  const first = await RustDeskEdgePendingFileStore.open({ directory: dir });
  try {
    await assert.rejects(
      () => RustDeskEdgePendingFileStore.open({ directory: dir }),
      /already locked by a live process/
    );
  } finally {
    await first.close();
  }
});

test('RustDesk edge spool fails closed for symbolic links and unknown schemas', async () => {
  const root = mkdtempSync(join(tmpdir(), 'converact-rustdesk-spool-hardening-'));
  const target = join(root, 'target');
  const linked = join(root, 'linked');
  mkdirSync(target);
  symlinkSync(target, linked);
  await assert.rejects(
    () => RustDeskEdgePendingFileStore.open({ directory: linked }),
    /must be a real directory, not a symbolic link/
  );

  const dir = join(root, 'schema');
  const store = await RustDeskEdgePendingFileStore.open({ directory: dir });
  try {
    writeFileSync(join(dir, 'outside.json'), '{}');
    symlinkSync(join(dir, 'outside.json'), join(dir, 'active.json'));
    await assert.rejects(() => store.load(), /must be a regular file, not a symbolic link/);
  } finally {
    await store.close();
  }

  const schemaStore = await RustDeskEdgePendingFileStore.open({ directory: join(root, 'unknown') });
  try {
    writeFileSync(join(root, 'unknown', 'active.json'), JSON.stringify({ version: 2, state: 'executed' }));
    await assert.rejects(() => schemaStore.load(), /version or state is unsupported/);
  } finally {
    await schemaStore.close();
  }
});

test('RustDesk edge spool keeps expired active state available for server recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'converact-rustdesk-spool-expired-'));
  let now = new Date('2026-07-12T00:00:00.000Z');
  const store = await RustDeskEdgePendingFileStore.open({
    directory: dir,
    max_age_ms: 1_000,
    now: () => now
  });
  try {
    await store.writeExecuting({
      edge_instance_id: 'edge-expired-1',
      device_id: command.target_id,
      command,
      progress: []
    });
    now = new Date('2026-07-12T00:00:02.000Z');
    const expired = await store.load();
    assert.equal(expired?.command.id, command.id);
    assert.equal(store.isExpired(expired!), true);
  } finally {
    await store.close();
  }
});
