import { canonicalSha256 } from './canonical-json.js';
import {
  replayCapacityFrontier,
  type CapacityFrontierHistoryEntry,
  type CapacityFrontierResult,
  type CapacityProbeOutcome
} from './frontier-runner.js';
import type { CapacityRunEvidenceDocument } from './orchestrator/run-finalizer.js';
import type { CapacityRunContext, LoadRunManifest } from './profile-compiler.js';
import {
  evaluateScalingCurve,
  type ScalingCurveGates,
  type ScalingCurveResult
} from './scaling-curve.js';

export type CapacityScalingRunEvidenceDocument = CapacityRunEvidenceDocument;

export interface CapacityScalingCampaignIdentity {
  profile_id: string;
  profile_sha256: string;
  component_role?: string;
  hardware_class: string;
  hardware_sha256: string;
  configuration_class: string;
  configuration_sha256: string;
  failure_reserve_sha256: string;
  fork_manifest_id: string;
  fork_manifest_sha256: string;
  sut_release_id: string;
  generator_release_id: string;
}

export interface CapacityScalingProbeReference {
  units: number;
  attempt: number;
  phase: CapacityFrontierHistoryEntry['phase'];
  requested_load: number;
  run_id: string;
  manifest_sha256: string;
  evidence_manifest_sha256: string;
  dominant_resource: string;
}

export interface CapacityScalingCampaignSubmission {
  schema_version: '1.0.0';
  campaign_id: string;
  contract_id: string;
  contract_sha256: string;
  curve_id: string;
  mode: 'controlled' | 'production';
  identity: CapacityScalingCampaignIdentity;
  frontier_bounds: Array<{
    units: number;
    minimum_load: number;
    maximum_load: number;
    resolution: number;
  }>;
  ramp_ratios: number[];
  probes: CapacityScalingProbeReference[];
}

export interface ScalingEfficiencyContract {
  schema_version: string;
  contract_id: string;
  workload_profile_id: string;
  endpoint_target_interactions: number;
  single_node: {
    minimum_repetitions: number;
    production_headroom_ratio: number;
    required_component_roles: string[];
  };
  scaling_curves: Array<{
    curve_id: string;
    scope: 'component_node_pool' | 'cell' | 'shared_data_plane';
    node_or_unit_points: number[];
    minimum_repetitions_per_point: number;
    aggregate_linearity_floors: Array<{ point: number; minimum_ratio: number }>;
    segment_marginal_efficiency_floor: number;
    maximum_adjacent_segment_drop_ratio: number;
    failure_reserve_included: boolean;
  }>;
}

export interface CapacityScalingCampaignResult {
  schema_version: '1.0.0';
  campaign_id: string;
  contract_id: string;
  contract_sha256: string;
  submission_sha256: string;
  curve_id: string;
  scope: 'component' | 'cell' | 'shared_data';
  mode: 'controlled' | 'production';
  identity: CapacityScalingCampaignIdentity;
  outcome: CapacityProbeOutcome;
  capacity_claim: 'none' | 'component_pass' | 'cell_pass';
  source_run_count: number;
  source_evidence_sha256: string[];
  frontiers: CapacityFrontierResult[];
  curve: ScalingCurveResult | null;
  reasons: string[];
}

export async function finalizeCapacityScalingCampaign(input: {
  contract: ScalingEfficiencyContract;
  submission: CapacityScalingCampaignSubmission;
  load_run_evidence(
    reference: CapacityScalingProbeReference
  ): Promise<CapacityScalingRunEvidenceDocument>;
}): Promise<CapacityScalingCampaignResult> {
  const context = validateCampaign(input.contract, input.submission);
  const documents = await Promise.all(input.submission.probes.map(async (reference) => ({
    reference,
    document: await input.load_run_evidence(reference)
  })));
  const runIds = new Set<string>();
  const historyByUnits = new Map<number, CapacityFrontierHistoryEntry[]>();
  for (const source of documents) {
    if (runIds.has(source.reference.run_id)) throw new Error('scaling campaign contains a duplicate run_id');
    runIds.add(source.reference.run_id);
    validateRunEvidence(source.reference, source.document, input.submission, context.scope);
    const history = historyByUnits.get(source.reference.units) ?? [];
    history.push(historyEntry(source.reference, source.document));
    historyByUnits.set(source.reference.units, history);
  }

  const frontiers: CapacityFrontierResult[] = [];
  for (const units of context.curve.node_or_unit_points) {
    const history = historyByUnits.get(units);
    if (!history) {
      if (frontiers.at(-1)?.outcome !== 'passed') break;
      throw new Error(`scaling campaign is missing frontier history for ${units} units`);
    }
    const bounds = context.bounds.get(units)!;
    const frontier = await replayCapacityFrontier({
      units,
      minimum_load: bounds.minimum_load,
      maximum_load: bounds.maximum_load,
      resolution: bounds.resolution,
      production_headroom_ratio: input.contract.single_node.production_headroom_ratio,
      final_repeat_count: Math.max(
        input.contract.single_node.minimum_repetitions,
        context.curve.minimum_repetitions_per_point
      ),
      ramp_ratios: [...input.submission.ramp_ratios],
      history
    });
    frontiers.push(frontier);
    if (frontier.outcome !== 'passed') break;
  }
  const consumedUnits = new Set(frontiers.map((frontier) => frontier.units));
  for (const units of historyByUnits.keys()) {
    if (!consumedUnits.has(units)) throw new Error(`scaling campaign contains unused ${units}-unit evidence`);
  }

  const terminal = frontiers.find((frontier) => frontier.outcome !== 'passed');
  let curve: ScalingCurveResult | null = null;
  let outcome: CapacityProbeOutcome;
  let reasons: string[];
  if (terminal) {
    outcome = terminal.outcome;
    reasons = [...terminal.reasons];
  } else {
    curve = evaluateScalingCurve({
      scope: context.scope,
      gates: context.gates,
      points: frontiers.map((frontier) => ({
        units: frontier.units,
        profile_id: input.submission.identity.profile_id,
        profile_sha256: input.submission.identity.profile_sha256,
        hardware_class: input.submission.identity.hardware_class,
        hardware_sha256: input.submission.identity.hardware_sha256,
        configuration_class: input.submission.identity.configuration_class,
        configuration_sha256: input.submission.identity.configuration_sha256,
        failure_reserve_sha256: input.submission.identity.failure_reserve_sha256,
        fork_manifest_sha256: input.submission.identity.fork_manifest_sha256,
        sut_release_id: input.submission.identity.sut_release_id,
        generator_release_id: input.submission.identity.generator_release_id,
        successful_safe_capacity_repeats: frontier.successful_repeat_safe_capacities
      }))
    });
    outcome = curve.outcome;
    reasons = [...curve.reasons];
  }
  return {
    schema_version: '1.0.0',
    campaign_id: input.submission.campaign_id,
    contract_id: input.submission.contract_id,
    contract_sha256: input.submission.contract_sha256,
    submission_sha256: canonicalSha256(input.submission),
    curve_id: input.submission.curve_id,
    scope: context.scope,
    mode: input.submission.mode,
    identity: structuredClone(input.submission.identity),
    outcome,
    capacity_claim: capacityClaim(input.submission.mode, context.scope, outcome),
    source_run_count: documents.length,
    source_evidence_sha256: documents.map(({ reference }) => reference.evidence_manifest_sha256),
    frontiers,
    curve,
    reasons
  };
}

function validateCampaign(
  contract: ScalingEfficiencyContract,
  submission: CapacityScalingCampaignSubmission
): {
  curve: ScalingEfficiencyContract['scaling_curves'][number];
  scope: CapacityRunContext['scope'];
  gates: ScalingCurveGates;
  bounds: Map<number, CapacityScalingCampaignSubmission['frontier_bounds'][number]>;
} {
  if (!contract || contract.schema_version !== '1.0.0' ||
      submission.schema_version !== '1.0.0' ||
      submission.contract_id !== contract.contract_id ||
      submission.contract_sha256 !== canonicalSha256(contract)) {
    throw new Error('scaling campaign contract SHA-256 binding is invalid');
  }
  safeId(submission.campaign_id, 'campaign_id');
  if (!['controlled', 'production'].includes(submission.mode)) throw new Error('scaling campaign mode is invalid');
  const curve = contract.scaling_curves.find((candidate) => candidate.curve_id === submission.curve_id);
  if (!curve || curve.failure_reserve_included !== true) throw new Error('scaling campaign curve is invalid');
  if (submission.identity.profile_id !== contract.workload_profile_id) {
    throw new Error('scaling campaign profile_id does not match the contract');
  }
  validateIdentity(submission.identity);
  const scope = curve.scope === 'component_node_pool'
    ? 'component'
    : curve.scope === 'shared_data_plane'
      ? 'shared_data'
      : 'cell';
  if (scope === 'component') {
    if (!submission.identity.component_role ||
        !contract.single_node.required_component_roles.includes(submission.identity.component_role)) {
      throw new Error('scaling campaign component role is not required by the contract');
    }
  } else if (submission.identity.component_role != null) {
    throw new Error('non-component scaling campaign cannot declare a component role');
  }
  const units = [...curve.node_or_unit_points];
  if (units.length < 2 || units[0] !== 1 || units.some((unit, index) =>
    !Number.isInteger(unit) || unit < 1 || (index > 0 && unit <= units[index - 1]))) {
    throw new Error('scaling campaign unit points are invalid');
  }
  const bounds = new Map<number, CapacityScalingCampaignSubmission['frontier_bounds'][number]>();
  for (const bound of submission.frontier_bounds) {
    if (!units.includes(bound.units) || bounds.has(bound.units) ||
        !Number.isSafeInteger(bound.minimum_load) || bound.minimum_load < 1 ||
        !Number.isSafeInteger(bound.maximum_load) || bound.maximum_load < bound.minimum_load ||
        !Number.isSafeInteger(bound.resolution) || bound.resolution < 1) {
      throw new Error('scaling campaign frontier bounds are invalid');
    }
    bounds.set(bound.units, structuredClone(bound));
  }
  if (bounds.size !== units.length) throw new Error('scaling campaign frontier bounds are incomplete');
  if (submission.ramp_ratios.length === 0 || submission.ramp_ratios.some(
    (ratio) => !Number.isFinite(ratio) || ratio <= 0 || ratio > 1
  )) throw new Error('scaling campaign ramp ratios are invalid');
  const aggregate = Object.fromEntries(curve.aggregate_linearity_floors.map(
    (entry) => [entry.point, entry.minimum_ratio]
  ));
  if (Object.keys(aggregate).length !== units.length || units.some((unit) => aggregate[unit] == null)) {
    throw new Error('scaling campaign aggregate gates are incomplete');
  }
  return {
    curve,
    scope,
    gates: {
      aggregate_linearity_floors: aggregate,
      segment_marginal_efficiency_floor: curve.segment_marginal_efficiency_floor,
      maximum_adjacent_segment_drop_ratio: curve.maximum_adjacent_segment_drop_ratio
    },
    bounds
  };
}

function validateRunEvidence(
  reference: CapacityScalingProbeReference,
  document: CapacityScalingRunEvidenceDocument,
  submission: CapacityScalingCampaignSubmission,
  scope: CapacityRunContext['scope']
): void {
  if (!document || document.schema_version !== '1.0.0' ||
      canonicalSha256(document) !== reference.evidence_manifest_sha256) {
    throw new Error(`run ${reference.run_id} evidence SHA-256 mismatch`);
  }
  const manifest = document.manifest;
  if (!manifest || canonicalSha256(manifest) !== reference.manifest_sha256 ||
      document.manifest_sha256 !== reference.manifest_sha256) {
    throw new Error(`run ${reference.run_id} manifest SHA-256 mismatch`);
  }
  if (document.run_id !== reference.run_id || manifest.run_id !== reference.run_id ||
      document.mode !== submission.mode || document.profile_id !== submission.identity.profile_id ||
      document.fork_manifest_id !== submission.identity.fork_manifest_id ||
      document.sut_release_id !== submission.identity.sut_release_id ||
      document.generator_release_id !== submission.identity.generator_release_id) {
    throw new Error(`run ${reference.run_id} evidence identity mismatch`);
  }
  const identity = submission.identity;
  for (const [field, expected] of Object.entries({
    profile_id: identity.profile_id,
    profile_sha256: identity.profile_sha256,
    fork_manifest_id: identity.fork_manifest_id,
    fork_manifest_sha256: identity.fork_manifest_sha256,
    sut_release_id: identity.sut_release_id,
    generator_release_id: identity.generator_release_id
  })) {
    if (String(manifest[field as keyof LoadRunManifest] || '') !== expected) {
      throw new Error(`run ${reference.run_id} has mismatched ${field}`);
    }
  }
  const context = manifest.capacity_context;
  if (!context || context.scope !== scope || context.units !== reference.units) {
    throw new Error(`run ${reference.run_id} capacity context mismatch`);
  }
  if (context.component_role !== submission.identity.component_role) {
    throw new Error(`run ${reference.run_id} has mismatched component_role`);
  }
  for (const field of [
    'hardware_class',
    'hardware_sha256',
    'configuration_class',
    'configuration_sha256',
    'failure_reserve_sha256'
  ] as const) {
    if (context[field] !== identity[field]) throw new Error(`run ${reference.run_id} has mismatched ${field}`);
  }
  const load = manifest.profile_load;
  if (!load || load.target_interactions !== reference.requested_load ||
      load.scale_numerator !== reference.requested_load ||
      load.scale_denominator !== load.base_interactions ||
      load.apportionment !== 'largest_remainder_v1' ||
      manifest.expected_totals.interactions !== reference.requested_load) {
    throw new Error(`run ${reference.run_id} profile-equivalent load mismatch`);
  }
  if (!['passed', 'failed', 'invalid_generator_capacity', 'not_run'].includes(document.validation.outcome)) {
    throw new Error(`run ${reference.run_id} validation outcome is invalid`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(reference.dominant_resource)) {
    throw new Error(`run ${reference.run_id} dominant_resource is invalid`);
  }
}

function historyEntry(
  reference: CapacityScalingProbeReference,
  document: CapacityScalingRunEvidenceDocument
): CapacityFrontierHistoryEntry {
  const outcome = document.validation.outcome;
  return {
    phase: reference.phase,
    requested_load: reference.requested_load,
    attempt: reference.attempt,
    outcome,
    achieved_load: reference.requested_load,
    slo_passed: outcome === 'passed',
    generator_qualified: outcome !== 'invalid_generator_capacity',
    dominant_resource: reference.dominant_resource,
    reasons: [...document.validation.reasons]
  };
}

function validateIdentity(identity: CapacityScalingCampaignIdentity): void {
  for (const [field, value] of Object.entries(identity)) {
    if (value == null) continue;
    if (field.endsWith('_sha256')) {
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`scaling campaign ${field} is invalid`);
    } else {
      safeId(value, field);
    }
  }
}

function safeId(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/.test(value)) {
    throw new Error(`scaling campaign ${field} is invalid`);
  }
}

function capacityClaim(
  mode: CapacityScalingCampaignSubmission['mode'],
  scope: CapacityRunContext['scope'],
  outcome: CapacityProbeOutcome
): CapacityScalingCampaignResult['capacity_claim'] {
  if (mode !== 'production' || outcome !== 'passed') return 'none';
  return scope === 'cell' ? 'cell_pass' : 'component_pass';
}
