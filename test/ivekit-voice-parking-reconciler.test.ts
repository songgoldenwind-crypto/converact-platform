import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VoiceParkingCommandReconciler,
  type VoiceCallCommand,
  type VoiceParkingRepository,
  type VoiceParkingSlot
} from '../src/agent-runtime/ivekit/voice/index.js';

test('Voice parking reconciliation trusts only durable terminal slot states', async () => {
  let slot = parkingSlot();
  const reconciler = new VoiceParkingCommandReconciler(repository(() => slot));
  const park = command('park', 'park-command');

  assert.deepEqual(await reconciler.reconcile(park), { state: 'unknown' });
  slot = { ...slot, state: 'parked' };
  assert.deepEqual(await reconciler.reconcile(park), { state: 'succeeded' });
  slot = { ...slot, state: 'failed', released_at: slot.updated_at };
  assert.deepEqual(await reconciler.reconcile(park), { state: 'failed' });
});

test('Voice pickup reconciliation distinguishes released, rolled-back, and unknown states', async () => {
  let slot = parkingSlot({
    state: 'retrieving', pickup_call_id: 'pickup-call', pickup_command_id: 'pickup-command'
  });
  const reconciler = new VoiceParkingCommandReconciler(repository(() => slot));
  const pickup = command('pickup', 'pickup-command');

  assert.deepEqual(await reconciler.reconcile(pickup), { state: 'unknown' });
  slot = { ...slot, state: 'released', released_at: slot.updated_at };
  assert.deepEqual(await reconciler.reconcile(pickup), { state: 'succeeded' });
  slot = { ...slot, state: 'parked', released_at: null };
  assert.deepEqual(await reconciler.reconcile(pickup), { state: 'failed' });
});

function repository(current: () => VoiceParkingSlot): VoiceParkingRepository {
  return {
    async list() { return { items: [current()], next_cursor: null }; },
    async getBySlot() { return current(); },
    async getByParkCommand() { return current(); },
    async getByPickupCommand() { return current(); },
    async insert(value) { return value; },
    async update(value) { return value; }
  };
}

function parkingSlot(patch: Partial<VoiceParkingSlot> = {}): VoiceParkingSlot {
  return {
    id: 'parking-a', tenant_id: 'tenant-a', profile_id: 'profile-a', slot: '701',
    state: 'parking', parked_call_id: 'parked-call', park_command_id: 'park-command',
    pickup_call_id: null, pickup_command_id: null, expires_at: '2026-07-13T01:00:00.000Z',
    release_reason: '', revision: 1, created_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z', released_at: null,
    ...patch
  };
}

function command(kind: 'park' | 'pickup', id: string): VoiceCallCommand {
  return {
    id, tenant_id: 'tenant-a', call_id: kind === 'park' ? 'parked-call' : 'pickup-call',
    kind, state: 'uncertain', idempotency_key: id, payload_hash: 'a'.repeat(64),
    payload: { slot: '701' }, attempt_count: 1, max_attempts: 5, next_attempt_at: null,
    lease_until: null, worker_id: '', provider_command_id: '', result: {}, error_code: '',
    error_message: '', created_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z', completed_at: null
  };
}
