import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BoundedAdmissionGate,
  type AdmissionLease
} from '../src/agent-runtime/converact/platform-foundation/resilience.js';

test('admission enforces exact active and pending limits in O(1) state', () => {
  const gate = new BoundedAdmissionGate({ active: 2, pending: 1 });
  const activeA = gate.tryAcquire('active');
  const activeB = gate.tryAcquire('active');
  const pending = gate.tryAcquire('pending');
  assert.equal(activeA.accepted, true);
  assert.equal(activeB.accepted, true);
  assert.equal(pending.accepted, true);
  assert.deepEqual(gate.snapshot(), { active: 2, pending: 1 });
  assert.deepEqual(gate.tryAcquire('active'), { accepted: false, reason: 'overloaded' });
  assert.deepEqual(gate.tryAcquire('pending'), { accepted: false, reason: 'overloaded' });
  assert.equal(Object.isFrozen(gate.snapshot()), true);
  assert.deepEqual(Object.keys(gate), []);
});

test('release is exact and rejects double forged stale and foreign leases', () => {
  const gate = new BoundedAdmissionGate({ active: 1, pending: 1 });
  const other = new BoundedAdmissionGate({ active: 1, pending: 1 });
  const acquired = gate.tryAcquire('active');
  assert.equal(acquired.accepted, true);
  if (!acquired.accepted) return;
  gate.release(acquired.lease);
  assert.deepEqual(gate.snapshot(), { active: 0, pending: 0 });
  assert.throws(() => gate.release(acquired.lease), /admission_lease_invalid/);
  assert.throws(() => gate.release({} as AdmissionLease), /admission_lease_invalid/);
  const foreign = other.tryAcquire('active');
  assert.equal(foreign.accepted, true);
  if (foreign.accepted) assert.throws(() => gate.release(foreign.lease), /admission_lease_invalid/);

  const next = gate.tryAcquire('active');
  assert.equal(next.accepted, true);
  if (next.accepted) assert.notEqual(next.lease, acquired.lease);
});

test('invalid or unrepresentable bounds fail before counters exist', () => {
  for (const limits of [
    { active: -1, pending: 1 },
    { active: 1.5, pending: 1 },
    { active: 1, pending: Number.MAX_SAFE_INTEGER },
    { active: Number.NaN, pending: 1 }
  ]) assert.throws(() => new BoundedAdmissionGate(limits), /admission_limits_invalid/);
  const disabled = new BoundedAdmissionGate({ active: 0, pending: 0 });
  assert.deepEqual(disabled.tryAcquire('active'), { accepted: false, reason: 'overloaded' });
});

test('AI recording event and telemetry gates are independent bulkheads', () => {
  const gates = {
    ai: new BoundedAdmissionGate({ active: 1, pending: 0 }),
    recording: new BoundedAdmissionGate({ active: 1, pending: 0 }),
    event: new BoundedAdmissionGate({ active: 1, pending: 0 }),
    telemetry: new BoundedAdmissionGate({ active: 1, pending: 0 })
  };
  assert.equal(gates.ai.tryAcquire('active').accepted, true);
  assert.equal(gates.ai.tryAcquire('active').accepted, false);
  assert.equal(gates.recording.tryAcquire('active').accepted, true);
  assert.equal(gates.event.tryAcquire('active').accepted, true);
  assert.equal(gates.telemetry.tryAcquire('active').accepted, true);
});
