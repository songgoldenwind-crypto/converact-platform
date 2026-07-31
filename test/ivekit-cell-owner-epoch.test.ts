import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCurrentOwnerEpoch,
  compareOwnerEpoch,
  composeOwnerEpoch,
  splitOwnerEpoch
} from '../src/agent-runtime/converact/placement/owner-epoch.js';

test('owner epoch composes cell lease and local sequence without JS integer loss', () => {
  const epoch = composeOwnerEpoch(7, 3);
  assert.equal(epoch, String((7n << 32n) | 3n));
  assert.deepEqual(splitOwnerEpoch(epoch), {
    cell_lease_epoch: 7,
    cell_local_sequence: 3
  });
  assert.equal(compareOwnerEpoch(epoch, epoch), 0);
  assert.equal(compareOwnerEpoch(composeOwnerEpoch(7, 4), epoch), 1);
  assert.equal(compareOwnerEpoch(composeOwnerEpoch(6, 100), epoch), -1);
});

test('owner fencing rejects stale and future epochs before side effects', () => {
  const current = composeOwnerEpoch(9, 4);
  assert.doesNotThrow(() => assertCurrentOwnerEpoch(current, current));
  assert.throws(
    () => assertCurrentOwnerEpoch(composeOwnerEpoch(9, 3), current),
    (error: any) => error?.code === 'stale_owner_epoch' && error?.status === 409
  );
  assert.throws(
    () => assertCurrentOwnerEpoch(composeOwnerEpoch(10, 1), current),
    (error: any) => error?.code === 'owner_epoch_ahead' && error?.status === 409
  );
});

test('owner epoch components must remain unsigned 32-bit integers', () => {
  assert.throws(() => composeOwnerEpoch(-1, 1), /cell lease epoch/i);
  assert.throws(() => composeOwnerEpoch(1, 0), /local sequence/i);
  assert.throws(() => splitOwnerEpoch('9007199254740993.5'), /owner epoch/i);
});

