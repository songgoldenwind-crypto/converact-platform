import assert from 'node:assert/strict';
import test from 'node:test';

import {
  replayCapacityFrontier,
  runCapacityFrontier,
  runMeasuredScalingCurve,
  type CapacityFrontierResult
} from '../scripts/capacity/frontier-runner.js';

test('frontier runner ramps, brackets, binary-searches and repeats the safe hard boundary', async () => {
  const requested: number[] = [];
  const result = await runCapacityFrontier({
    units: 1,
    minimum_load: 100,
    maximum_load: 1000,
    resolution: 10,
    production_headroom_ratio: 0.2,
    final_repeat_count: 3,
    probe: async ({ requested_load }) => {
      requested.push(requested_load);
      return {
        outcome: requested_load <= 880 ? 'passed' : 'failed',
        achieved_load: requested_load,
        slo_passed: requested_load <= 880,
        generator_qualified: true,
        dominant_resource: requested_load >= 800 ? 'cpu' : 'none'
      };
    }
  });

  assert.equal(result.outcome, 'passed');
  assert.equal(result.hard_capacity, 880);
  assert.equal(result.safe_capacity, 704);
  assert.equal(result.successful_repeat_safe_capacities.length, 3);
  assert.ok(requested.includes(950));
  assert.ok(requested.includes(880));
  assert.equal(result.dominant_resource, 'cpu');
});

test('frontier runner aborts without capacity when generator qualification fails', async () => {
  const result = await runCapacityFrontier({
    units: 1,
    minimum_load: 100,
    maximum_load: 1000,
    resolution: 10,
    production_headroom_ratio: 0.2,
    final_repeat_count: 3,
    probe: async ({ requested_load }) => ({
      outcome: requested_load >= 500 ? 'invalid_generator_capacity' : 'passed',
      achieved_load: requested_load,
      slo_passed: true,
      generator_qualified: requested_load < 500,
      dominant_resource: 'generator_cpu'
    })
  });

  assert.equal(result.outcome, 'invalid_generator_capacity');
  assert.equal(result.hard_capacity, null);
  assert.equal(result.safe_capacity, null);
  assert.match(result.reasons.join('\n'), /generator/i);
});

test('frontier history replay rejects omitted reordered or invented probe points', async () => {
  const config = {
    units: 1,
    minimum_load: 100,
    maximum_load: 1000,
    resolution: 10,
    production_headroom_ratio: 0.2,
    final_repeat_count: 3
  };
  const measured = await runCapacityFrontier({
    ...config,
    probe: async ({ requested_load }) => ({
      outcome: requested_load <= 880 ? 'passed' as const : 'failed' as const,
      achieved_load: requested_load,
      slo_passed: requested_load <= 880,
      generator_qualified: true,
      dominant_resource: 'cpu'
    })
  });

  assert.deepEqual(
    await replayCapacityFrontier({ ...config, history: measured.history }),
    measured
  );
  const tampered = structuredClone(measured.history);
  tampered[2].requested_load += 10;
  await assert.rejects(
    () => replayCapacityFrontier({ ...config, history: tampered }),
    /history.*requested_load/i
  );
  await assert.rejects(
    () => replayCapacityFrontier({ ...config, history: measured.history.slice(0, -1) }),
    /history ended/i
  );
  await assert.rejects(
    () => replayCapacityFrontier({
      ...config,
      history: [...measured.history, measured.history.at(-1)!]
    }),
    /unused entries/i
  );
});

test('measured curve runner executes 1/2/4/8 sequentially and applies efficiency gates', async () => {
  const visited: number[] = [];
  const safeByUnits: Record<number, number> = {
    1: 10_000,
    2: 19_700,
    4: 38_700,
    8: 75_900
  };
  const result = await runMeasuredScalingCurve({
    scope: 'component',
    unit_counts: [1, 2, 4, 8],
    identity: {
      profile_id: 'cell-10k-v1',
      profile_sha256: 'a'.repeat(64),
      hardware_class: 'c32-64g-25gbe',
      hardware_sha256: 'b'.repeat(64),
      configuration_class: 'tinode-v1',
      configuration_sha256: 'c'.repeat(64),
      failure_reserve_sha256: 'd'.repeat(64),
      fork_manifest_sha256: 'e'.repeat(64),
      sut_release_id: 'ivekit@0123456789abcdef0123456789abcdef01234567',
      generator_release_id: 'loadgen@fedcba9876543210fedcba9876543210fedcba98'
    },
    run_frontier: async (units) => {
      visited.push(units);
      const safe = safeByUnits[units];
      return passedFrontier(units, safe);
    }
  });

  assert.deepEqual(visited, [1, 2, 4, 8]);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.curve?.segments.at(-1)?.marginal_efficiency_ratio, 0.93);
});

test('measured curve runner stops when a point is not real evidence', async () => {
  const visited: number[] = [];
  const result = await runMeasuredScalingCurve({
    scope: 'component',
    unit_counts: [1, 2, 4, 8],
    identity: {
      profile_id: 'cell-10k-v1',
      profile_sha256: 'a'.repeat(64),
      hardware_class: 'c32-64g-25gbe',
      hardware_sha256: 'b'.repeat(64),
      configuration_class: 'tinode-v1',
      configuration_sha256: 'c'.repeat(64),
      failure_reserve_sha256: 'd'.repeat(64),
      fork_manifest_sha256: 'e'.repeat(64),
      sut_release_id: 'ivekit@0123456789abcdef0123456789abcdef01234567',
      generator_release_id: 'loadgen@fedcba9876543210fedcba9876543210fedcba98'
    },
    run_frontier: async (units) => {
      visited.push(units);
      if (units === 4) return {
        outcome: 'not_run',
        units,
        hard_capacity: null,
        safe_capacity: null,
        successful_repeat_safe_capacities: [],
        dominant_resource: 'unknown',
        history: [],
        reasons: ['four-node environment is absent']
      };
      return passedFrontier(units, units * 10_000);
    }
  });

  assert.deepEqual(visited, [1, 2, 4]);
  assert.equal(result.outcome, 'not_run');
  assert.equal(result.curve, null);
});

function passedFrontier(units: number, safe: number): CapacityFrontierResult {
  return {
    outcome: 'passed',
    units,
    hard_capacity: Math.ceil(safe / 0.8),
    safe_capacity: safe,
    successful_repeat_safe_capacities: [safe, safe + 10, safe + 20],
    dominant_resource: 'cpu',
    history: [],
    reasons: []
  };
}
