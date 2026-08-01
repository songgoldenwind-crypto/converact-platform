import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ordinaryMediaPlatformDependencies,
  platformFaultPolicy
} from '../src/agent-runtime/converact/platform-foundation/fault-policy.js';

const matrix = JSON.parse(readFileSync(new URL(
  '../architecture-foundation/execution/goal-02/fault-matrix-v1.json',
  import.meta.url
), 'utf8')) as {
  dependencies: Array<{
    dependency: string;
    failure_modes: string[];
    established_human_media: string;
    new_work: string;
    optional_attachment: string;
    recovery: string;
    hot_path_dependency: boolean;
  }>;
};

test('runtime fault policy exactly covers every machine-contract dependency and failure mode', () => {
  assert.equal(matrix.dependencies.length, 12);
  for (const expected of matrix.dependencies) {
    for (const failureMode of expected.failure_modes) {
      const actual = platformFaultPolicy({
        dependency: expected.dependency as never,
        failure_mode: failureMode
      });
      assert.deepEqual(actual, {
        dependency: expected.dependency,
        failure_mode: failureMode,
        established_human_media: expected.established_human_media,
        new_work: expected.new_work,
        optional_attachment: expected.optional_attachment,
        recovery: expected.recovery,
        hot_path_dependency: false,
        sends_call_termination: false
      }, `${expected.dependency}:${failureMode}`);
    }
  }
});

test('ordinary media has no platform dependency and optional faults never terminate calls', () => {
  assert.deepEqual(ordinaryMediaPlatformDependencies(), []);
  assert.equal(Object.isFrozen(ordinaryMediaPlatformDependencies()), true);
  for (const expected of matrix.dependencies) {
    const policy = platformFaultPolicy({
      dependency: expected.dependency as never,
      failure_mode: expected.failure_modes[0]
    });
    assert.equal(policy.sends_call_termination, false);
    assert.equal(policy.hot_path_dependency, false);
    assert.match(policy.established_human_media, /^continue/);
  }
});

test('unknown dependency or failure mode fails closed', () => {
  assert.throws(() => platformFaultPolicy({
    dependency: 'unknown' as never, failure_mode: 'timeout'
  }), /platform_fault_unknown/);
  assert.throws(() => platformFaultPolicy({
    dependency: 'database', failure_mode: 'made_up'
  }), /platform_fault_unknown/);
});
