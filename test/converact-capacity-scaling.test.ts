import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveSingleNodeFrontier,
  evaluateScalingCurve
} from '../scripts/capacity/scaling-curve.js';

test('single-node frontier uses the lowest of three successful repeats and reserves headroom', () => {
  const result = deriveSingleNodeFrontier({
    samples: [
      { hard_capacity: 10_000, passed: true },
      { hard_capacity: 9_800, passed: true },
      { hard_capacity: 9_900, passed: true }
    ],
    production_headroom_ratio: 0.2
  });

  assert.equal(result.hard_capacity, 9_800);
  assert.equal(result.safe_capacity, 7_840);
  assert.equal(result.repeat_count, 3);
});

test('single-node frontier rejects fewer than three successful repeats', () => {
  assert.throws(() => deriveSingleNodeFrontier({
    samples: [
      { hard_capacity: 10_000, passed: true },
      { hard_capacity: 9_800, passed: true },
      { hard_capacity: 9_900, passed: false }
    ],
    production_headroom_ratio: 0.2
  }), /three successful/i);
});

function point(units: number, safeCapacity: number, overrides: Record<string, unknown> = {}) {
  return {
    units,
    profile_id: 'cell-10k-v1',
    profile_sha256: 'a'.repeat(64),
    hardware_class: 'c32-64g-25gbe',
    hardware_sha256: 'b'.repeat(64),
    configuration_class: 'voice-default-v1',
    configuration_sha256: 'c'.repeat(64),
    failure_reserve_sha256: 'd'.repeat(64),
    fork_manifest_sha256: 'e'.repeat(64),
    sut_release_id: 'converact@0123456789abcdef0123456789abcdef01234567',
    generator_release_id: 'loadgen@fedcba9876543210fedcba9876543210fedcba98',
    successful_safe_capacity_repeats: [safeCapacity, safeCapacity + 10, safeCapacity + 20],
    ...overrides
  };
}

test('component curve calculates aggregate and marginal efficiency', () => {
  const result = evaluateScalingCurve({
    scope: 'component',
    points: [
      point(1, 10_000),
      point(2, 19_700),
      point(4, 38_700),
      point(8, 75_900)
    ]
  });

  assert.equal(result.outcome, 'passed');
  assert.equal(result.points[1].aggregate_linearity_ratio, 0.985);
  assert.equal(result.segments[0].marginal_efficiency_ratio, 0.97);
  assert.equal(result.segments[1].marginal_efficiency_ratio, 0.95);
  assert.equal(result.segments[2].marginal_efficiency_ratio, 0.93);
});

test('100K total cannot override a bent scaling curve', () => {
  const result = evaluateScalingCurve({
    scope: 'component',
    points: [
      point(1, 20_000),
      point(2, 39_000),
      point(4, 74_000),
      point(8, 120_000)
    ]
  });

  assert.equal(result.outcome, 'failed');
  assert.ok(result.points.at(-1)!.safe_capacity >= 100_000);
  assert.match(result.reasons.join('\n'), /linearity|marginal|declined/i);
});

test('profile, hardware and configuration drift invalidate curve comparison', () => {
  assert.throws(() => evaluateScalingCurve({
    scope: 'component',
    points: [
      point(1, 10_000),
      point(2, 19_500, { hardware_class: 'c64-128g-25gbe' })
    ]
  }), /hardware_class/i);
});

test('exact hardware configuration failure reserve and release hashes are comparison boundaries', () => {
  for (const [field, value] of [
    ['hardware_sha256', '1'.repeat(64)],
    ['configuration_sha256', '2'.repeat(64)],
    ['failure_reserve_sha256', '3'.repeat(64)],
    ['fork_manifest_sha256', '4'.repeat(64)],
    ['sut_release_id', 'converact@1111111111111111111111111111111111111111'],
    ['generator_release_id', 'loadgen@2222222222222222222222222222222222222222']
  ] as const) {
    assert.throws(() => evaluateScalingCurve({
      scope: 'component',
      points: [
        point(1, 10_000),
        point(2, 19_500, { [field]: value })
      ]
    }), new RegExp(field));
  }
});

test('curve evaluator uses the hash-bound contract gates supplied by the campaign', () => {
  const result = evaluateScalingCurve({
    scope: 'component',
    gates: {
      aggregate_linearity_floors: { 1: 1, 2: 0.99 },
      segment_marginal_efficiency_floor: 0.98,
      maximum_adjacent_segment_drop_ratio: 0.01
    },
    points: [point(1, 10_000), point(2, 19_700)]
  });

  assert.equal(result.outcome, 'failed');
  assert.match(result.reasons.join('\n'), /0\.985.*0\.99|0\.97.*0\.98/);
});
