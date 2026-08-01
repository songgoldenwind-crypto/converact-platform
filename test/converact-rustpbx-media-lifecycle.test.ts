import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RUSTPBX_MEDIA_LIFECYCLE_STATES,
  transitionRustPbxMediaLifecycle
} from '../src/agent-runtime/converact/voice/media-lifecycle.js';

describe('RustPBX media lifecycle', () => {
  it('covers prepare, early media, final answer, update and close', () => {
    let state = transitionRustPbxMediaLifecycle('unallocated', 'prepare');
    assert.equal(state, 'preparing');
    state = transitionRustPbxMediaLifecycle(state, 'prepare_committed');
    assert.equal(state, 'prepared');
    state = transitionRustPbxMediaLifecycle(state, 'early_update');
    assert.equal(state, 'updating');
    state = transitionRustPbxMediaLifecycle(state, 'early_committed');
    assert.equal(state, 'early');
    state = transitionRustPbxMediaLifecycle(state, 'answer_update');
    assert.equal(state, 'updating');
    state = transitionRustPbxMediaLifecycle(state, 'answer_committed');
    assert.equal(state, 'committed');
    state = transitionRustPbxMediaLifecycle(state, 'update');
    assert.equal(state, 'updating');
    state = transitionRustPbxMediaLifecycle(state, 'update_committed');
    assert.equal(state, 'committed');
    state = transitionRustPbxMediaLifecycle(state, 'delete');
    assert.equal(state, 'deleting');
    state = transitionRustPbxMediaLifecycle(state, 'delete_committed');
    assert.equal(state, 'closed');
  });

  it('freezes an uncertain mutation until an explicit reconciliation', () => {
    let state = transitionRustPbxMediaLifecycle('committed', 'update');
    state = transitionRustPbxMediaLifecycle(state, 'command_unknown');
    assert.equal(state, 'uncertain');
    assert.throws(
      () => transitionRustPbxMediaLifecycle(state, 'update'),
      /media_lifecycle_transition_invalid/
    );
    state = transitionRustPbxMediaLifecycle(state, 'reconcile');
    assert.equal(state, 'reconciling');
    state = transitionRustPbxMediaLifecycle(state, 'reconciled_committed');
    assert.equal(state, 'committed');
  });

  it('separates cancellation, timeout and delete terminal paths', () => {
    assert.equal(
      transitionRustPbxMediaLifecycle('prepared', 'cancel'),
      'cancelling'
    );
    assert.equal(
      transitionRustPbxMediaLifecycle('cancelling', 'delete_committed'),
      'closed'
    );
    assert.equal(
      transitionRustPbxMediaLifecycle('committed', 'lease_expired'),
      'expired'
    );
  });

  it('rejects illegal terminal transitions and exposes the frozen state set', () => {
    assert.deepEqual(RUSTPBX_MEDIA_LIFECYCLE_STATES, [
      'unallocated',
      'preparing',
      'prepared',
      'early',
      'committed',
      'updating',
      'deleting',
      'cancelling',
      'uncertain',
      'reconciling',
      'closed',
      'expired'
    ]);
    for (const state of ['closed', 'expired'] as const) {
      assert.throws(
        () => transitionRustPbxMediaLifecycle(state, 'prepare'),
        new RegExp(`media_lifecycle_transition_invalid:${state}:prepare`)
      );
    }
  });
});
