import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RustDeskOwnerEpochFence,
  assertRustDeskOwnerBinding
} from '../scripts/rustdesk-owner-epoch-fence.js';

const owner = {
  interaction_id: 'remote-session-owner-fence-1',
  reservation_id: 'reservation-owner-fence-1',
  owner_epoch: '41'
};

test('RustDesk owner binding rejects commands outside the server-bound placement', () => {
  assert.doesNotThrow(() => assertRustDeskOwnerBinding(owner, owner, true));
  assert.throws(
    () => assertRustDeskOwnerBinding(
      { ...owner, owner_epoch: '42' },
      owner,
      true
    ),
    /rustdesk_owner_binding_mismatch/
  );
  assert.throws(
    () => assertRustDeskOwnerBinding(undefined, undefined, true),
    /rustdesk_owner_binding_required/
  );
  assert.doesNotThrow(() => assertRustDeskOwnerBinding(undefined, undefined, false));
});

test('RustDesk owner epoch fence persists the greatest accepted exact-session epoch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'converact-rustdesk-owner-fence-'));
  const first = await RustDeskOwnerEpochFence.open({ directory });
  try {
    assert.equal(await first.accept({
      external_id: 'rdgw-owner-fence-1',
      command_id: 'rdcmd-owner-fence-1',
      ...owner
    }), 'accepted');
    assert.equal(await first.accept({
      external_id: 'rdgw-owner-fence-1',
      command_id: 'rdcmd-owner-fence-1',
      ...owner
    }), 'replayed');
    await assert.rejects(
      () => first.accept({
        external_id: 'rdgw-owner-fence-1',
        command_id: 'rdcmd-owner-fence-conflict',
        ...owner,
        reservation_id: 'reservation-owner-fence-conflict'
      }),
      /rustdesk_owner_epoch_conflict/
    );
    assert.equal(await first.accept({
      external_id: 'rdgw-owner-fence-1',
      command_id: 'rdcmd-owner-fence-2',
      ...owner,
      reservation_id: 'reservation-owner-fence-2',
      owner_epoch: '42'
    }), 'accepted');
    assert.equal(existsSync(join(directory, 'owner-epochs.json')), false);
    assert.equal(
      readdirSync(join(directory, 'owner-epochs')).filter((name) => name.endsWith('.json')).length,
      1
    );
    assert.equal(await first.accept({
      external_id: 'rdgw-owner-fence-2',
      command_id: 'rdcmd-owner-fence-other-session',
      interaction_id: 'remote-session-owner-fence-2',
      reservation_id: 'reservation-owner-fence-other-session',
      owner_epoch: '1'
    }), 'accepted');
    assert.equal(
      readdirSync(join(directory, 'owner-epochs')).filter((name) => name.endsWith('.json')).length,
      2
    );
  } finally {
    await first.close();
  }

  const reopened = await RustDeskOwnerEpochFence.open({ directory });
  try {
    await assert.rejects(
      () => reopened.accept({
        external_id: 'rdgw-owner-fence-1',
        command_id: 'rdcmd-owner-fence-stale',
        ...owner
      }),
      /stale_rustdesk_owner_epoch/
    );
    assert.equal(await reopened.accept({
      external_id: 'rdgw-owner-fence-1',
      command_id: 'rdcmd-owner-fence-2',
      ...owner,
      reservation_id: 'reservation-owner-fence-2',
      owner_epoch: '42'
    }), 'replayed');
  } finally {
    await reopened.close();
  }
});

test('RustDesk owner epoch fence recovers a lock left by a dead process', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'converact-rustdesk-owner-fence-dead-lock-'));
  writeFileSync(join(directory, '.owner-epochs.lock'), `${JSON.stringify({
    schema_version: 1,
    pid: 2_147_483_647,
    token: 'dead-owner-fence'
  })}\n`, { mode: 0o600 });

  const fence = await RustDeskOwnerEpochFence.open({ directory });
  await fence.close();
});

test('RustDesk owner epoch fence migrates the legacy aggregate state without losing fencing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'converact-rustdesk-owner-fence-legacy-'));
  writeFileSync(join(directory, 'owner-epochs.json'), `${JSON.stringify({
    schema_version: 1,
    records: [{
      external_id: 'rdgw-owner-fence-legacy',
      interaction_id: 'remote-session-owner-fence-legacy',
      reservation_id: 'reservation-owner-fence-legacy',
      owner_epoch: '12',
      command_ids: ['rdcmd-owner-fence-legacy'],
      updated_at: '2026-07-17T00:00:00.000Z'
    }]
  })}\n`, { mode: 0o600 });

  const fence = await RustDeskOwnerEpochFence.open({ directory });
  try {
    assert.equal(existsSync(join(directory, 'owner-epochs.json')), false);
    assert.equal(
      readdirSync(join(directory, 'owner-epochs')).filter((name) => name.endsWith('.json')).length,
      1
    );
    await assert.rejects(
      () => fence.accept({
        external_id: 'rdgw-owner-fence-legacy',
        command_id: 'rdcmd-owner-fence-stale-after-migration',
        interaction_id: 'remote-session-owner-fence-legacy',
        reservation_id: 'reservation-owner-fence-stale',
        owner_epoch: '11'
      }),
      /stale_rustdesk_owner_epoch/
    );
    assert.equal(await fence.accept({
      external_id: 'rdgw-owner-fence-legacy',
      command_id: 'rdcmd-owner-fence-legacy',
      interaction_id: 'remote-session-owner-fence-legacy',
      reservation_id: 'reservation-owner-fence-legacy',
      owner_epoch: '12'
    }), 'replayed');
  } finally {
    await fence.close();
  }
});

test('RustDesk owner epoch fence rejects a second live companion process', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'converact-rustdesk-owner-fence-live-lock-'));
  const first = await RustDeskOwnerEpochFence.open({ directory });
  try {
    await assert.rejects(
      () => RustDeskOwnerEpochFence.open({ directory }),
      /already locked by a live process/
    );
  } finally {
    await first.close();
  }
});
