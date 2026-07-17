import { canonicalSha256 } from './canonical-json.js';
import type {
  CapacityScalingCampaignResult,
  CapacityScalingRunEvidenceDocument,
  ScalingEfficiencyContract
} from './scaling-campaign.js';
import { evaluateScalingCurve } from './scaling-curve.js';

export interface CapacityPlatformScalingReference {
  campaign_id: string;
  submission_sha256: string;
  evidence_sha256: string;
}

export interface CapacityPlatformEndpointReference {
  run_id: string;
  manifest_sha256: string;
  evidence_manifest_sha256: string;
}

export interface CapacityPlatformCampaignSubmission {
  schema_version: '1.0.0';
  platform_campaign_id: string;
  contract_id: string;
  contract_sha256: string;
  mode: 'controlled' | 'production';
  profile_id: string;
  profile_sha256: string;
  scaling_campaigns: CapacityPlatformScalingReference[];
  endpoint_run: CapacityPlatformEndpointReference;
}

export interface CapacityPlatformCampaignResult {
  schema_version: '1.0.0';
  platform_campaign_id: string;
  contract_id: string;
  contract_sha256: string;
  submission_sha256: string;
  mode: 'controlled' | 'production';
  profile_id: string;
  profile_sha256: string;
  outcome: 'passed' | 'failed' | 'not_run';
  capacity_claim: 'none' | 'platform_pass';
  component_roles: string[];
  scaling_campaign_count: number;
  endpoint_run_id: string;
  endpoint_interactions: number;
  source_evidence_sha256: string[];
  reasons: string[];
}

export async function finalizeCapacityPlatformCampaign(input: {
  contract: ScalingEfficiencyContract;
  submission: CapacityPlatformCampaignSubmission;
  load_scaling_campaign(
    reference: CapacityPlatformScalingReference
  ): Promise<CapacityScalingCampaignResult>;
  load_endpoint_run(
    reference: CapacityPlatformEndpointReference
  ): Promise<CapacityScalingRunEvidenceDocument>;
}): Promise<CapacityPlatformCampaignResult> {
  const context = validateSubmission(input.contract, input.submission);
  const curves = await Promise.all(input.submission.scaling_campaigns.map(
    (reference) => input.load_scaling_campaign(reference).then((result) => ({ reference, result }))
  ));
  const endpoint = await input.load_endpoint_run(input.submission.endpoint_run);
  const componentRoles = new Set<string>();
  let cell: CapacityScalingCampaignResult | undefined;
  let sharedData: CapacityScalingCampaignResult | undefined;
  const reasons: string[] = [];

  for (const source of curves) {
    validateScalingResult(source.reference, source.result, input.contract, input.submission);
    if (source.result.scope === 'component') {
      const role = source.result.identity.component_role!;
      if (componentRoles.has(role)) throw new Error(`platform campaign duplicates component role ${role}`);
      componentRoles.add(role);
    } else if (source.result.scope === 'cell') {
      if (cell) throw new Error('platform campaign contains multiple cell curves');
      cell = source.result;
    } else {
      if (sharedData) throw new Error('platform campaign contains multiple shared-data curves');
      sharedData = source.result;
    }
    if (source.result.outcome !== 'passed') {
      const label = source.result.identity.component_role || source.result.scope;
      reasons.push(`${label} curve ${source.result.outcome}: ${source.result.reasons.join('; ') || 'no passing evidence'}`);
    }
  }

  const requiredRoles = [...input.contract.single_node.required_component_roles].sort();
  const actualRoles = [...componentRoles].sort();
  if (JSON.stringify(actualRoles) !== JSON.stringify(requiredRoles) || !cell || !sharedData) {
    throw new Error('platform campaign required scaling curves are incomplete');
  }
  validateCommonReleaseIdentity(curves.map(({ result }) => result));
  validateEndpoint(
    input.submission.endpoint_run,
    endpoint,
    input.contract,
    input.submission,
    cell,
    context.cell_units
  );
  if (endpoint.validation.outcome !== 'passed') {
    reasons.push(`endpoint run ${endpoint.validation.outcome}: ${endpoint.validation.reasons.join('; ') || 'no passing evidence'}`);
  }

  const hasFailure = curves.some(({ result }) =>
    result.outcome === 'failed' || result.outcome === 'invalid_generator_capacity'
  ) || endpoint.validation.outcome === 'failed' ||
    endpoint.validation.outcome === 'invalid_generator_capacity';
  const hasNotRun = curves.some(({ result }) => result.outcome === 'not_run') ||
    endpoint.validation.outcome === 'not_run';
  const outcome = hasFailure ? 'failed' : hasNotRun ? 'not_run' : 'passed';
  return {
    schema_version: '1.0.0',
    platform_campaign_id: input.submission.platform_campaign_id,
    contract_id: input.submission.contract_id,
    contract_sha256: input.submission.contract_sha256,
    submission_sha256: canonicalSha256(input.submission),
    mode: input.submission.mode,
    profile_id: input.submission.profile_id,
    profile_sha256: input.submission.profile_sha256,
    outcome,
    capacity_claim: input.submission.mode === 'production' && outcome === 'passed'
      ? 'platform_pass'
      : 'none',
    component_roles: actualRoles,
    scaling_campaign_count: curves.length,
    endpoint_run_id: endpoint.run_id,
    endpoint_interactions: endpoint.manifest.expected_totals.interactions,
    source_evidence_sha256: [
      ...input.submission.scaling_campaigns.map((reference) => reference.evidence_sha256),
      input.submission.endpoint_run.evidence_manifest_sha256
    ],
    reasons
  };
}

function validateSubmission(
  contract: ScalingEfficiencyContract,
  submission: CapacityPlatformCampaignSubmission
): { cell_units: number } {
  if (!contract || contract.schema_version !== '1.0.0' ||
      submission.schema_version !== '1.0.0' ||
      submission.contract_id !== contract.contract_id ||
      submission.contract_sha256 !== canonicalSha256(contract)) {
    throw new Error('platform campaign contract SHA-256 binding is invalid');
  }
  safeId(submission.platform_campaign_id, 'platform_campaign_id');
  if (!['controlled', 'production'].includes(submission.mode) ||
      submission.profile_id !== contract.workload_profile_id ||
      !/^[a-f0-9]{64}$/.test(submission.profile_sha256)) {
    throw new Error('platform campaign identity is invalid');
  }
  const expectedCount = contract.single_node.required_component_roles.length + 2;
  if (submission.scaling_campaigns.length !== expectedCount) {
    throw new Error(`platform campaign requires ${expectedCount} scaling curves`);
  }
  const campaigns = new Set<string>();
  for (const reference of submission.scaling_campaigns) {
    safeId(reference.campaign_id, 'scaling campaign reference');
    hashes(reference.submission_sha256, reference.evidence_sha256);
    if (campaigns.has(reference.campaign_id)) throw new Error('platform campaign has duplicate campaign reference');
    campaigns.add(reference.campaign_id);
  }
  safeId(submission.endpoint_run.run_id, 'endpoint run reference');
  hashes(submission.endpoint_run.manifest_sha256, submission.endpoint_run.evidence_manifest_sha256);
  const cellCurve = uniqueCurve(contract, 'cell');
  return { cell_units: Math.max(...cellCurve.node_or_unit_points) };
}

function validateScalingResult(
  reference: CapacityPlatformScalingReference,
  result: CapacityScalingCampaignResult,
  contract: ScalingEfficiencyContract,
  submission: CapacityPlatformCampaignSubmission
): void {
  if (!result || result.schema_version !== '1.0.0' ||
      canonicalSha256(result) !== reference.evidence_sha256 ||
      result.campaign_id !== reference.campaign_id ||
      result.submission_sha256 !== reference.submission_sha256 ||
      result.contract_id !== submission.contract_id ||
      result.contract_sha256 !== submission.contract_sha256 ||
      result.mode !== submission.mode ||
      result.identity.profile_id !== submission.profile_id ||
      result.identity.profile_sha256 !== submission.profile_sha256) {
    throw new Error(`platform scaling campaign ${reference.campaign_id} identity mismatch`);
  }
  const contractScope = result.scope === 'component'
    ? 'component_node_pool'
    : result.scope === 'shared_data'
      ? 'shared_data_plane'
      : 'cell';
  const curve = uniqueCurve(contract, contractScope);
  if (result.curve_id !== curve.curve_id ||
      (result.curve && (result.curve.scope !== result.scope || result.curve.outcome !== result.outcome)) ||
      (!result.curve && result.outcome === 'passed')) {
    throw new Error(`platform scaling campaign ${reference.campaign_id} curve mismatch`);
  }
  const expectedUnits = curve.node_or_unit_points.join(',');
  const frontierUnits = result.frontiers.map((frontier) => frontier.units);
  if (result.curve) {
    if (frontierUnits.join(',') !== expectedUnits ||
        result.frontiers.some((frontier) => frontier.outcome !== 'passed')) {
      throw new Error(`platform scaling campaign ${reference.campaign_id} has incomplete frontier evidence`);
    }
    const recomputed = evaluateScalingCurve({
      scope: result.scope,
      gates: {
        aggregate_linearity_floors: Object.fromEntries(
          curve.aggregate_linearity_floors.map((entry) => [entry.point, entry.minimum_ratio])
        ),
        segment_marginal_efficiency_floor: curve.segment_marginal_efficiency_floor,
        maximum_adjacent_segment_drop_ratio: curve.maximum_adjacent_segment_drop_ratio
      },
      points: result.frontiers.map((frontier) => ({
        units: frontier.units,
        profile_id: result.identity.profile_id,
        profile_sha256: result.identity.profile_sha256,
        hardware_class: result.identity.hardware_class,
        hardware_sha256: result.identity.hardware_sha256,
        configuration_class: result.identity.configuration_class,
        configuration_sha256: result.identity.configuration_sha256,
        failure_reserve_sha256: result.identity.failure_reserve_sha256,
        fork_manifest_sha256: result.identity.fork_manifest_sha256,
        sut_release_id: result.identity.sut_release_id,
        generator_release_id: result.identity.generator_release_id,
        successful_safe_capacity_repeats: frontier.successful_repeat_safe_capacities
      }))
    });
    if (canonicalSha256(recomputed) !== canonicalSha256(result.curve)) {
      throw new Error(`platform scaling campaign ${reference.campaign_id} curve evidence does not recompute`);
    }
  } else {
    const expectedPrefix = curve.node_or_unit_points.slice(0, frontierUnits.length).join(',');
    const terminal = result.frontiers.at(-1);
    if (!terminal || frontierUnits.join(',') !== expectedPrefix || terminal.outcome !== result.outcome ||
        result.frontiers.slice(0, -1).some((frontier) => frontier.outcome !== 'passed')) {
      throw new Error(`platform scaling campaign ${reference.campaign_id} terminal frontier mismatch`);
    }
  }
  const expectedClaim = submission.mode === 'production' && result.outcome === 'passed'
    ? result.scope === 'cell' ? 'cell_pass' : 'component_pass'
    : 'none';
  if (result.capacity_claim !== expectedClaim) {
    throw new Error(`platform scaling campaign ${reference.campaign_id} claim mismatch`);
  }
  if (result.scope === 'component') {
    const role = result.identity.component_role;
    if (!role || !contract.single_node.required_component_roles.includes(role)) {
      throw new Error(`platform scaling campaign ${reference.campaign_id} component role mismatch`);
    }
  } else if (result.identity.component_role != null) {
    throw new Error(`platform scaling campaign ${reference.campaign_id} has an invalid component role`);
  }
}

function validateCommonReleaseIdentity(results: CapacityScalingCampaignResult[]): void {
  const baseline = results[0].identity;
  for (const result of results.slice(1)) {
    for (const field of [
      'profile_id',
      'profile_sha256',
      'fork_manifest_id',
      'fork_manifest_sha256',
      'sut_release_id',
      'generator_release_id'
    ] as const) {
      if (result.identity[field] !== baseline[field]) {
        throw new Error(`platform scaling campaigns have mismatched ${field}`);
      }
    }
  }
}

function validateEndpoint(
  reference: CapacityPlatformEndpointReference,
  document: CapacityScalingRunEvidenceDocument,
  contract: ScalingEfficiencyContract,
  submission: CapacityPlatformCampaignSubmission,
  cell: CapacityScalingCampaignResult,
  expectedUnits: number
): void {
  if (!document || document.schema_version !== '1.0.0' ||
      canonicalSha256(document) !== reference.evidence_manifest_sha256 ||
      document.run_id !== reference.run_id || document.manifest.run_id !== reference.run_id ||
      document.manifest_sha256 !== reference.manifest_sha256 ||
      canonicalSha256(document.manifest) !== reference.manifest_sha256 ||
      document.mode !== submission.mode || document.profile_id !== submission.profile_id ||
      document.manifest.profile_id !== submission.profile_id ||
      document.manifest.profile_sha256 !== submission.profile_sha256) {
    throw new Error('platform endpoint run identity mismatch');
  }
  if (!['passed', 'failed', 'invalid_generator_capacity', 'not_run'].includes(
    document.validation.outcome
  )) {
    throw new Error('platform endpoint outcome is invalid');
  }
  for (const field of [
    'fork_manifest_id',
    'fork_manifest_sha256',
    'sut_release_id',
    'generator_release_id'
  ] as const) {
    if (String(document.manifest[field]) !== String(cell.identity[field])) {
      throw new Error(`platform endpoint run has mismatched ${field}`);
    }
  }
  const load = document.manifest.profile_load;
  const context = document.manifest.capacity_context;
  if (!Number.isSafeInteger(contract.endpoint_target_interactions) ||
      contract.endpoint_target_interactions < 1 ||
      !load || load.target_interactions !== contract.endpoint_target_interactions ||
      document.manifest.expected_totals.interactions !== contract.endpoint_target_interactions ||
      !context || context.scope !== 'cell' || context.units !== expectedUnits ||
      context.component_role != null) {
    throw new Error('platform endpoint run is not the contract endpoint load');
  }
  for (const field of [
    'hardware_class',
    'hardware_sha256',
    'configuration_class',
    'configuration_sha256',
    'failure_reserve_sha256'
  ] as const) {
    if (context[field] !== cell.identity[field]) {
      throw new Error(`platform endpoint run has mismatched ${field}`);
    }
  }
  if (submission.mode === 'production' && document.external_dependencies.some(
    (dependency) => dependency.required_for_production_pass && dependency.status === 'not_run'
  )) {
    throw new Error('platform endpoint run has a required production dependency not_run');
  }
  if (document.validation.outcome === 'passed') {
    const reconciliation = document.validation.reconciliation;
    if (reconciliation.expected !== contract.endpoint_target_interactions ||
        reconciliation.accepted !== contract.endpoint_target_interactions ||
        reconciliation.sut_observed !== contract.endpoint_target_interactions ||
        reconciliation.independent_observed !== contract.endpoint_target_interactions) {
      throw new Error('platform endpoint passed without exact three-plane reconciliation');
    }
  }
}

function uniqueCurve(
  contract: ScalingEfficiencyContract,
  scope: ScalingEfficiencyContract['scaling_curves'][number]['scope']
): ScalingEfficiencyContract['scaling_curves'][number] {
  const curves = contract.scaling_curves.filter((curve) => curve.scope === scope);
  if (curves.length !== 1) throw new Error(`platform contract requires exactly one ${scope} curve`);
  return curves[0];
}

function hashes(...values: string[]): void {
  if (values.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error('platform campaign SHA-256 reference is invalid');
  }
}

function safeId(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/.test(value)) {
    throw new Error(`platform campaign ${field} is invalid`);
  }
}
