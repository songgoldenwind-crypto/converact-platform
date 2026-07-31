import {
  evaluateScalingCurve,
  type ScalingCurveGates,
  type ScalingCurveResult
} from './scaling-curve.js';

export type CapacityProbeOutcome = 'passed' | 'failed' | 'invalid_generator_capacity' | 'not_run';

export interface CapacityProbeResult {
  outcome: CapacityProbeOutcome;
  achieved_load: number;
  slo_passed: boolean;
  generator_qualified: boolean;
  dominant_resource: string;
  reasons?: string[];
}

export interface CapacityFrontierHistoryEntry extends CapacityProbeResult {
  phase: 'ramp' | 'binary_search' | 'final_repeat';
  requested_load: number;
  attempt: number;
}

export interface CapacityFrontierResult {
  outcome: CapacityProbeOutcome;
  units: number;
  hard_capacity: number | null;
  safe_capacity: number | null;
  successful_repeat_safe_capacities: number[];
  dominant_resource: string;
  history: CapacityFrontierHistoryEntry[];
  reasons: string[];
}

export async function runCapacityFrontier(input: {
  units: number;
  minimum_load: number;
  maximum_load: number;
  resolution: number;
  production_headroom_ratio: number;
  final_repeat_count: number;
  ramp_ratios?: number[];
  probe(context: {
    units: number;
    requested_load: number;
    phase: CapacityFrontierHistoryEntry['phase'];
    attempt: number;
  }): Promise<CapacityProbeResult>;
}): Promise<CapacityFrontierResult> {
  validateFrontierInput(input);
  const history: CapacityFrontierHistoryEntry[] = [];
  const reasons: string[] = [];
  let attempt = 0;
  const probe = async (
    requestedLoad: number,
    phase: CapacityFrontierHistoryEntry['phase']
  ): Promise<CapacityProbeResult> => {
    attempt += 1;
    const raw = await input.probe({
      units: input.units,
      requested_load: requestedLoad,
      phase,
      attempt
    });
    const normalized = normalizeProbe(raw, requestedLoad);
    history.push({ ...normalized, phase, requested_load: requestedLoad, attempt });
    return normalized;
  };

  const rampCandidates = uniqueSorted([
    input.minimum_load,
    ...(input.ramp_ratios ?? [0.25, 0.5, 0.7, 0.85, 0.95])
      .map((ratio) => quantize(input.maximum_load * ratio, input.resolution)),
    input.maximum_load
  ]).filter((load) => load >= input.minimum_load && load <= input.maximum_load);
  let highestPass = 0;
  let firstFail: number | null = null;

  for (const candidate of rampCandidates) {
    const result = await probe(candidate, 'ramp');
    const terminal = terminalProbeOutcome(result, history, input.units);
    if (terminal) return terminal;
    if (isPass(result)) {
      highestPass = candidate;
      continue;
    }
    firstFail = candidate;
    break;
  }

  if (highestPass === 0) {
    return failedFrontier(input.units, history, ['minimum load did not pass its SLO']);
  }
  let upper = firstFail ?? input.maximum_load;
  if (firstFail === null && highestPass === input.maximum_load) upper = highestPass;
  while (upper - highestPass > input.resolution) {
    const midpoint = quantize((highestPass + upper) / 2, input.resolution);
    if (midpoint <= highestPass || midpoint >= upper) break;
    const result = await probe(midpoint, 'binary_search');
    const terminal = terminalProbeOutcome(result, history, input.units);
    if (terminal) return terminal;
    if (isPass(result)) highestPass = midpoint;
    else upper = midpoint;
  }

  const finalResults: CapacityProbeResult[] = [];
  for (let repeat = 0; repeat < input.final_repeat_count; repeat += 1) {
    const result = await probe(highestPass, 'final_repeat');
    const terminal = terminalProbeOutcome(result, history, input.units);
    if (terminal) return terminal;
    if (!isPass(result)) {
      reasons.push(`final repeat ${repeat + 1} failed at ${highestPass}`);
      return failedFrontier(input.units, history, reasons);
    }
    finalResults.push(result);
  }
  const hardCapacity = Math.min(...finalResults.map((result) => result.achieved_load));
  const safeRepeats = finalResults.map((result) =>
    Math.floor(result.achieved_load * (1 - input.production_headroom_ratio))
  );
  return {
    outcome: 'passed',
    units: input.units,
    hard_capacity: hardCapacity,
    safe_capacity: Math.min(...safeRepeats),
    successful_repeat_safe_capacities: safeRepeats,
    dominant_resource: dominantResource(finalResults),
    history,
    reasons
  };
}

export async function replayCapacityFrontier(input: {
  units: number;
  minimum_load: number;
  maximum_load: number;
  resolution: number;
  production_headroom_ratio: number;
  final_repeat_count: number;
  ramp_ratios?: number[];
  history: CapacityFrontierHistoryEntry[];
}): Promise<CapacityFrontierResult> {
  let cursor = 0;
  const result = await runCapacityFrontier({
    units: input.units,
    minimum_load: input.minimum_load,
    maximum_load: input.maximum_load,
    resolution: input.resolution,
    production_headroom_ratio: input.production_headroom_ratio,
    final_repeat_count: input.final_repeat_count,
    ...(input.ramp_ratios ? { ramp_ratios: input.ramp_ratios } : {}),
    probe: async (expected) => {
      const entry = input.history[cursor];
      if (!entry) throw new Error(`frontier history ended before attempt ${expected.attempt}`);
      if (entry.attempt !== expected.attempt) {
        throw new Error(`frontier history attempt ${entry.attempt} does not match ${expected.attempt}`);
      }
      if (entry.phase !== expected.phase) {
        throw new Error(`frontier history phase ${entry.phase} does not match ${expected.phase}`);
      }
      if (entry.requested_load !== expected.requested_load) {
        throw new Error(
          `frontier history requested_load ${entry.requested_load} does not match ${expected.requested_load}`
        );
      }
      cursor += 1;
      return {
        outcome: entry.outcome,
        achieved_load: entry.achieved_load,
        slo_passed: entry.slo_passed,
        generator_qualified: entry.generator_qualified,
        dominant_resource: entry.dominant_resource,
        reasons: [...(entry.reasons ?? [])]
      };
    }
  });
  if (cursor !== input.history.length) {
    throw new Error(`frontier history contains ${input.history.length - cursor} unused entries`);
  }
  return result;
}

export async function runMeasuredScalingCurve(input: {
  scope: 'component' | 'cell' | 'shared_data';
  unit_counts: number[];
  identity: {
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
  };
  gates?: ScalingCurveGates;
  run_frontier(units: number): Promise<CapacityFrontierResult>;
}): Promise<{
  outcome: CapacityProbeOutcome;
  curve: ScalingCurveResult | null;
  frontiers: CapacityFrontierResult[];
  reasons: string[];
}> {
  validateUnitCounts(input.unit_counts);
  const frontiers: CapacityFrontierResult[] = [];
  for (const units of input.unit_counts) {
    const frontier = await input.run_frontier(units);
    if (frontier.units !== units) throw new Error(`frontier result units ${frontier.units} do not match ${units}`);
    frontiers.push(frontier);
    if (frontier.outcome !== 'passed') {
      return {
        outcome: frontier.outcome,
        curve: null,
        frontiers,
        reasons: [...frontier.reasons]
      };
    }
    if (frontier.successful_repeat_safe_capacities.length < 3) {
      throw new Error(`${units}-unit frontier does not contain three successful repeats`);
    }
  }
  const curve = evaluateScalingCurve({
    scope: input.scope,
    ...(input.gates ? { gates: input.gates } : {}),
    points: frontiers.map((frontier) => ({
      units: frontier.units,
      ...input.identity,
      successful_safe_capacity_repeats: frontier.successful_repeat_safe_capacities
    }))
  });
  return {
    outcome: curve.outcome,
    curve,
    frontiers,
    reasons: [...curve.reasons]
  };
}

function normalizeProbe(result: CapacityProbeResult, requestedLoad: number): CapacityProbeResult {
  if (!['passed', 'failed', 'invalid_generator_capacity', 'not_run'].includes(result.outcome)) {
    throw new Error('capacity probe returned an invalid outcome');
  }
  if (!Number.isFinite(result.achieved_load) || result.achieved_load < 0) {
    throw new Error('capacity probe returned an invalid achieved load');
  }
  if (!result.dominant_resource) throw new Error('capacity probe must name its dominant resource');
  if (result.outcome === 'passed' && result.achieved_load < requestedLoad) {
    return {
      ...result,
      outcome: 'failed',
      slo_passed: false,
      reasons: [...(result.reasons ?? []), 'probe achieved load is below requested load']
    };
  }
  if (result.outcome === 'passed' && (!result.slo_passed || !result.generator_qualified)) {
    return {
      ...result,
      outcome: result.generator_qualified ? 'failed' : 'invalid_generator_capacity',
      reasons: [
        ...(result.reasons ?? []),
        result.generator_qualified ? 'probe marked passed while SLO failed' : 'probe generator is not qualified'
      ]
    };
  }
  return { ...result, reasons: [...(result.reasons ?? [])] };
}

function terminalProbeOutcome(
  result: CapacityProbeResult,
  history: CapacityFrontierHistoryEntry[],
  units: number
): CapacityFrontierResult | null {
  if (result.outcome !== 'invalid_generator_capacity' && result.outcome !== 'not_run') return null;
  const label = result.outcome === 'invalid_generator_capacity'
    ? 'generator qualification failed during frontier search'
    : 'required frontier environment was not run';
  return {
    outcome: result.outcome,
    units,
    hard_capacity: null,
    safe_capacity: null,
    successful_repeat_safe_capacities: [],
    dominant_resource: result.dominant_resource,
    history,
    reasons: [label, ...(result.reasons ?? [])]
  };
}

function failedFrontier(
  units: number,
  history: CapacityFrontierHistoryEntry[],
  reasons: string[]
): CapacityFrontierResult {
  return {
    outcome: 'failed',
    units,
    hard_capacity: null,
    safe_capacity: null,
    successful_repeat_safe_capacities: [],
    dominant_resource: history.at(-1)?.dominant_resource || 'unknown',
    history,
    reasons
  };
}

function isPass(result: CapacityProbeResult): boolean {
  return result.outcome === 'passed' && result.slo_passed && result.generator_qualified;
}

function dominantResource(results: CapacityProbeResult[]): string {
  const counts = new Map<string, number>();
  for (const result of results) {
    if (result.dominant_resource === 'none') continue;
    counts.set(result.dominant_resource, (counts.get(result.dominant_resource) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]
    ?? results.at(-1)?.dominant_resource
    ?? 'unknown';
}

function validateFrontierInput(input: {
  units: number;
  minimum_load: number;
  maximum_load: number;
  resolution: number;
  production_headroom_ratio: number;
  final_repeat_count: number;
  ramp_ratios?: number[];
}): void {
  if (!Number.isInteger(input.units) || input.units < 1) throw new Error('frontier units must be a positive integer');
  for (const [field, value] of Object.entries({
    minimum_load: input.minimum_load,
    maximum_load: input.maximum_load,
    resolution: input.resolution
  })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`);
  }
  if (input.maximum_load < input.minimum_load) throw new Error('maximum load must not be below minimum load');
  if (!Number.isInteger(input.final_repeat_count) || input.final_repeat_count < 3) {
    throw new Error('frontier requires at least three final repeats');
  }
  if (!Number.isFinite(input.production_headroom_ratio) ||
      input.production_headroom_ratio < 0 || input.production_headroom_ratio >= 1) {
    throw new Error('production headroom ratio must be in [0, 1)');
  }
  for (const ratio of input.ramp_ratios ?? []) {
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) throw new Error('frontier ramp ratio is invalid');
  }
}

function validateUnitCounts(values: number[]): void {
  if (values.length === 0 || values[0] !== 1) throw new Error('measured curve must start with one unit');
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isInteger(values[index]) || values[index] < 1 ||
        (index > 0 && values[index] <= values[index - 1])) {
      throw new Error('measured curve unit counts must be strictly increasing positive integers');
    }
  }
}

function quantize(value: number, resolution: number): number {
  return Math.floor(value / resolution) * resolution;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}
