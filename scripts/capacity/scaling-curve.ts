export interface SingleNodeFrontier {
  hard_capacity: number;
  safe_capacity: number;
  production_headroom_ratio: number;
  repeat_count: number;
}

export function deriveSingleNodeFrontier(input: {
  samples: Array<{ hard_capacity: number; passed: boolean }>;
  production_headroom_ratio: number;
}): SingleNodeFrontier {
  if (!Number.isFinite(input.production_headroom_ratio) ||
      input.production_headroom_ratio < 0 || input.production_headroom_ratio >= 1) {
    throw new Error('production headroom ratio must be in [0, 1)');
  }
  const successful = input.samples.filter((sample) => sample.passed);
  if (successful.length < 3) throw new Error('frontier requires at least three successful repeats');
  for (const sample of successful) {
    if (!Number.isFinite(sample.hard_capacity) || sample.hard_capacity <= 0) {
      throw new Error('hard capacity samples must be positive');
    }
  }
  const hardCapacity = Math.min(...successful.map((sample) => sample.hard_capacity));
  return {
    hard_capacity: hardCapacity,
    safe_capacity: Math.floor(hardCapacity * (1 - input.production_headroom_ratio)),
    production_headroom_ratio: input.production_headroom_ratio,
    repeat_count: successful.length
  };
}

export interface ScalingCurvePointInput {
  units: number;
  profile_id: string;
  profile_sha256: string;
  hardware_class: string;
  hardware_sha256: string;
  configuration_class: string;
  configuration_sha256: string;
  failure_reserve_sha256: string;
  fork_manifest_sha256: string;
  sut_release_id: string;
  generator_release_id: string;
  successful_safe_capacity_repeats: number[];
}

export interface ScalingCurveGates {
  aggregate_linearity_floors: Record<number, number>;
  segment_marginal_efficiency_floor: number;
  maximum_adjacent_segment_drop_ratio: number;
}

export interface ScalingCurveResult {
  outcome: 'passed' | 'failed';
  scope: 'component' | 'cell' | 'shared_data';
  points: Array<{
    units: number;
    safe_capacity: number;
    repeat_count: number;
    aggregate_linearity_ratio: number;
    minimum_aggregate_linearity_ratio: number | null;
  }>;
  segments: Array<{
    from_units: number;
    to_units: number;
    marginal_efficiency_ratio: number;
    minimum_marginal_efficiency_ratio: number;
    decline_from_previous_segment_ratio: number | null;
  }>;
  reasons: string[];
}

const COMPONENT_LINEARITY: Record<number, number> = { 1: 1, 2: 0.95, 4: 0.93, 8: 0.91 };
const CELL_LINEARITY: Record<number, number> = { 1: 1, 2: 0.98, 4: 0.97, 8: 0.96, 10: 0.95 };

export function evaluateScalingCurve(input: {
  scope: 'component' | 'cell' | 'shared_data';
  points: ScalingCurvePointInput[];
  gates?: ScalingCurveGates;
}): ScalingCurveResult {
  if (input.points.length === 0) throw new Error('scaling curve requires points');
  const sorted = [...input.points].sort((left, right) => left.units - right.units);
  if (sorted[0].units !== 1) throw new Error('scaling curve must include the one-unit baseline');
  assertComparable(sorted);
  const unitIds = new Set<number>();
  const capacities = sorted.map((point) => {
    if (!Number.isInteger(point.units) || point.units < 1 || unitIds.has(point.units)) {
      throw new Error(`invalid or duplicate unit count ${point.units}`);
    }
    unitIds.add(point.units);
    if (point.successful_safe_capacity_repeats.length < 3) {
      throw new Error(`point ${point.units} requires three successful safe-capacity repeats`);
    }
    for (const capacity of point.successful_safe_capacity_repeats) {
      if (!Number.isFinite(capacity) || capacity <= 0) throw new Error('safe capacity repeats must be positive');
    }
    return Math.min(...point.successful_safe_capacity_repeats);
  });
  const baseline = capacities[0];
  const defaults = defaultGates(input.scope);
  const gates = input.gates ?? defaults;
  validateGates(gates, sorted.map((point) => point.units));
  const thresholds = gates.aggregate_linearity_floors;
  const minimumMarginal = gates.segment_marginal_efficiency_floor;
  const maximumDecline = gates.maximum_adjacent_segment_drop_ratio;
  const reasons: string[] = [];
  const points = sorted.map((point, index) => {
    const ratio = round(capacities[index] / (point.units * baseline));
    const minimum = thresholds[point.units] ?? null;
    if (minimum !== null && ratio + 1e-12 < minimum) {
      reasons.push(`${point.units}-unit aggregate linearity ${ratio} is below ${minimum}`);
    }
    return {
      units: point.units,
      safe_capacity: capacities[index],
      repeat_count: point.successful_safe_capacity_repeats.length,
      aggregate_linearity_ratio: ratio,
      minimum_aggregate_linearity_ratio: minimum
    };
  });
  const segments: ScalingCurveResult['segments'] = [];
  let previousMarginal: number | null = null;
  for (let index = 1; index < sorted.length; index += 1) {
    const from = sorted[index - 1];
    const to = sorted[index];
    const marginal = round(
      (capacities[index] - capacities[index - 1]) / ((to.units - from.units) * baseline)
    );
    const decline = previousMarginal === null ? null : round(previousMarginal - marginal);
    if (marginal + 1e-12 < minimumMarginal) {
      reasons.push(`${from.units}->${to.units} marginal efficiency ${marginal} is below ${minimumMarginal}`);
    }
    if (decline !== null && decline > maximumDecline + 1e-12) {
      reasons.push(`${from.units}->${to.units} marginal efficiency declined by ${decline}, above ${maximumDecline}`);
    }
    segments.push({
      from_units: from.units,
      to_units: to.units,
      marginal_efficiency_ratio: marginal,
      minimum_marginal_efficiency_ratio: minimumMarginal,
      decline_from_previous_segment_ratio: decline
    });
    previousMarginal = marginal;
  }
  return { outcome: reasons.length === 0 ? 'passed' : 'failed', scope: input.scope, points, segments, reasons };
}

function assertComparable(points: ScalingCurvePointInput[]): void {
  const baseline = points[0];
  for (const point of points.slice(1)) {
    for (const field of [
      'profile_id',
      'profile_sha256',
      'hardware_class',
      'hardware_sha256',
      'configuration_class',
      'configuration_sha256',
      'failure_reserve_sha256',
      'fork_manifest_sha256',
      'sut_release_id',
      'generator_release_id'
    ] as const) {
      if (point[field] !== baseline[field]) {
        throw new Error(`scaling points have mismatched ${field}`);
      }
    }
  }
}

function defaultGates(scope: ScalingCurveResult['scope']): ScalingCurveGates {
  return {
    aggregate_linearity_floors: scope === 'component'
      ? { ...COMPONENT_LINEARITY }
      : { ...CELL_LINEARITY },
    segment_marginal_efficiency_floor: scope === 'component' ? 0.9 : 0.95,
    maximum_adjacent_segment_drop_ratio: scope === 'component' ? 0.03 : 0.02
  };
}

function validateGates(gates: ScalingCurveGates, units: number[]): void {
  for (const value of [
    gates.segment_marginal_efficiency_floor,
    gates.maximum_adjacent_segment_drop_ratio
  ]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error('scaling curve gate ratio is invalid');
    }
  }
  for (const unit of units) {
    const floor = gates.aggregate_linearity_floors[unit];
    if (!Number.isFinite(floor) || floor < 0 || floor > 1) {
      throw new Error(`scaling curve has no valid aggregate floor for ${unit} units`);
    }
  }
}

function round(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}
