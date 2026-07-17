import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { canonicalSha256 } from '../scripts/capacity/canonical-json.js';
import {
  finalizeCapacityPlatformCampaign,
  type CapacityPlatformCampaignSubmission
} from '../scripts/capacity/platform-campaign.js';
import type {
  CapacityScalingCampaignResult,
  CapacityScalingRunEvidenceDocument
} from '../scripts/capacity/scaling-campaign.js';
import { evaluateScalingCurve } from '../scripts/capacity/scaling-curve.js';

const contract = JSON.parse(
  readFileSync('docs/capacity/targets/mix-100k-efficiency-v1.json', 'utf8')
);

test('platform campaign requires every component, cell, shared-data and 100K endpoint gate', async () => {
  const fixture = platformFixture('production');
  const result = await finalizeCapacityPlatformCampaign({
    contract,
    submission: fixture.submission,
    load_scaling_campaign: async (reference) => fixture.curves.get(reference.campaign_id)!,
    load_endpoint_run: async () => fixture.endpoint
  });

  assert.equal(result.outcome, 'passed');
  assert.equal(result.capacity_claim, 'platform_pass');
  assert.deepEqual(result.component_roles, [...contract.single_node.required_component_roles].sort());
  assert.equal(result.endpoint_interactions, 100_000);
});

test('100K endpoint success cannot override a failed component efficiency curve', async () => {
  const fixture = platformFixture('production');
  const role = contract.single_node.required_component_roles[0];
  const curve = [...fixture.curves.values()].find(
    (candidate) => candidate.identity.component_role === role
  )!;
  curve.outcome = 'failed';
  curve.capacity_claim = 'none';
  const terminal = curve.frontiers.at(-1)!;
  terminal.hard_capacity = 6_250;
  terminal.safe_capacity = 5_000;
  terminal.successful_repeat_safe_capacities = [5_000, 5_000, 5_000];
  curve.curve = recomputeCurve(curve);
  curve.reasons = [...curve.curve.reasons];
  fixture.submission.scaling_campaigns.find(
    (reference) => reference.campaign_id === curve.campaign_id
  )!.evidence_sha256 = canonicalSha256(curve);

  const result = await finalizeCapacityPlatformCampaign({
    contract,
    submission: fixture.submission,
    load_scaling_campaign: async (reference) => fixture.curves.get(reference.campaign_id)!,
    load_endpoint_run: async () => fixture.endpoint
  });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.capacity_claim, 'none');
  assert.match(result.reasons.join(' '), new RegExp(role));
});

test('platform campaign rejects a missing or duplicated required component role', async () => {
  const fixture = platformFixture('production');
  fixture.submission.scaling_campaigns.pop();
  await assert.rejects(
    () => finalizeCapacityPlatformCampaign({
      contract,
      submission: fixture.submission,
      load_scaling_campaign: async (reference) => fixture.curves.get(reference.campaign_id)!,
      load_endpoint_run: async () => fixture.endpoint
    }),
    /require|count|complete/i
  );

  const duplicated = platformFixture('production');
  const componentCurves = [...duplicated.curves.values()].filter(
    (candidate) => candidate.scope === 'component'
  );
  componentCurves[1].identity.component_role = componentCurves[0].identity.component_role;
  duplicated.submission.scaling_campaigns.find(
    (reference) => reference.campaign_id === componentCurves[1].campaign_id
  )!.evidence_sha256 = canonicalSha256(componentCurves[1]);
  await assert.rejects(
    () => finalizeCapacityPlatformCampaign({
      contract,
      submission: duplicated.submission,
      load_scaling_campaign: async (reference) => duplicated.curves.get(reference.campaign_id)!,
      load_endpoint_run: async () => duplicated.endpoint
    }),
    /duplicate|complete/i
  );
});

test('a verified not-run source keeps the whole platform not_run without a claim', async () => {
  const fixture = platformFixture('production');
  const curve = [...fixture.curves.values()].find((candidate) => candidate.scope === 'component')!;
  curve.outcome = 'not_run';
  curve.capacity_claim = 'none';
  curve.curve = null;
  curve.reasons = ['physical generator is unavailable'];
  const terminal = curve.frontiers.at(-1)!;
  terminal.outcome = 'not_run';
  terminal.hard_capacity = null;
  terminal.safe_capacity = null;
  terminal.successful_repeat_safe_capacities = [];
  terminal.reasons = [...curve.reasons];
  fixture.submission.scaling_campaigns.find(
    (reference) => reference.campaign_id === curve.campaign_id
  )!.evidence_sha256 = canonicalSha256(curve);

  const result = await finalizeCapacityPlatformCampaign({
    contract,
    submission: fixture.submission,
    load_scaling_campaign: async (reference) => fixture.curves.get(reference.campaign_id)!,
    load_endpoint_run: async () => fixture.endpoint
  });
  assert.equal(result.outcome, 'not_run');
  assert.equal(result.capacity_claim, 'none');
});

test('platform campaign rejects an unknown endpoint outcome', async () => {
  const fixture = platformFixture('production');
  (fixture.endpoint.validation as any).outcome = 'unknown';
  fixture.submission.endpoint_run.evidence_manifest_sha256 = canonicalSha256(fixture.endpoint);
  await assert.rejects(
    () => finalizeCapacityPlatformCampaign({
      contract,
      submission: fixture.submission,
      load_scaling_campaign: async (reference) => fixture.curves.get(reference.campaign_id)!,
      load_endpoint_run: async () => fixture.endpoint
    }),
    /endpoint.*outcome/i
  );
});

test('platform campaign recomputes curve evidence instead of trusting a passed label', async () => {
  const fixture = platformFixture('production');
  const curve = [...fixture.curves.values()].find((candidate) => candidate.scope === 'component')!;
  curve.curve!.points.at(-1)!.safe_capacity = 1;
  fixture.submission.scaling_campaigns.find(
    (reference) => reference.campaign_id === curve.campaign_id
  )!.evidence_sha256 = canonicalSha256(curve);
  await assert.rejects(
    () => finalizeCapacityPlatformCampaign({
      contract,
      submission: fixture.submission,
      load_scaling_campaign: async (reference) => fixture.curves.get(reference.campaign_id)!,
      load_endpoint_run: async () => fixture.endpoint
    }),
    /recomput|curve.*evidence|curve mismatch/i
  );
});

test('controlled platform campaign exercises every gate without issuing a capacity claim', async () => {
  const fixture = platformFixture('controlled');
  const result = await finalizeCapacityPlatformCampaign({
    contract,
    submission: fixture.submission,
    load_scaling_campaign: async (reference) => fixture.curves.get(reference.campaign_id)!,
    load_endpoint_run: async () => fixture.endpoint
  });

  assert.equal(result.outcome, 'passed');
  assert.equal(result.capacity_claim, 'none');
});

function platformFixture(mode: 'controlled' | 'production'): {
  submission: CapacityPlatformCampaignSubmission;
  curves: Map<string, CapacityScalingCampaignResult>;
  endpoint: CapacityScalingRunEvidenceDocument;
} {
  const profileSha = 'a'.repeat(64);
  const common = {
    profile_id: contract.workload_profile_id,
    profile_sha256: profileSha,
    hardware_class: 'c32-64g-25gbe',
    hardware_sha256: 'b'.repeat(64),
    configuration_class: 'mix-v1',
    configuration_sha256: 'c'.repeat(64),
    failure_reserve_sha256: 'd'.repeat(64),
    fork_manifest_id: 'ivekit-forks-v1',
    fork_manifest_sha256: 'e'.repeat(64),
    sut_release_id: 'ivekit@0123456789abcdef0123456789abcdef01234567',
    generator_release_id: 'loadgen@fedcba9876543210fedcba9876543210fedcba98'
  };
  const curves = new Map<string, CapacityScalingCampaignResult>();
  for (const role of contract.single_node.required_component_roles as string[]) {
    const id = `curve-${role}`;
    curves.set(id, scalingResult({
      id,
      mode,
      curve_id: 'homogeneous-component-pool-1-8',
      scope: 'component',
      claim: mode === 'production' ? 'component_pass' : 'none',
      identity: { ...common, component_role: role }
    }));
  }
  curves.set('curve-cell', scalingResult({
    id: 'curve-cell',
    mode,
    curve_id: 'cell-addition-to-100k',
    scope: 'cell',
    claim: mode === 'production' ? 'cell_pass' : 'none',
    identity: common
  }));
  curves.set('curve-shared-data', scalingResult({
    id: 'curve-shared-data',
    mode,
    curve_id: 'shared-data-plane-per-cell-load',
    scope: 'shared_data',
    claim: mode === 'production' ? 'component_pass' : 'none',
    identity: common
  }));

  const manifest: any = {
    schema_version: '1.0.0',
    run_id: 'mix-100k-endpoint-run',
    profile_id: common.profile_id,
    profile_sha256: common.profile_sha256,
    fork_manifest_id: common.fork_manifest_id,
    fork_manifest_sha256: common.fork_manifest_sha256,
    sut_release_id: common.sut_release_id,
    generator_release_id: common.generator_release_id,
    seed: 'mix-100k-endpoint-seed',
    run_epoch: '2026-07-17T08:00:00.000Z',
    profile_load: {
      base_interactions: 100_000,
      target_interactions: 100_000,
      scale_numerator: 100_000,
      scale_denominator: 100_000,
      apportionment: 'largest_remainder_v1'
    },
    capacity_context: {
      scope: 'cell',
      units: 10,
      hardware_class: common.hardware_class,
      hardware_sha256: common.hardware_sha256,
      configuration_class: common.configuration_class,
      configuration_sha256: common.configuration_sha256,
      failure_reserve_sha256: common.failure_reserve_sha256
    },
    topology: { fleets: [] },
    shards: [],
    phases: [],
    faults: [],
    expected_totals: { interactions: 100_000, connections: 0, by_workload: {} },
    external_dependencies: [],
    start_not_before: '2026-07-17T08:00:00.000Z',
    evidence_prefix: 'capacity/mix-100k-endpoint-run'
  };
  const endpoint: CapacityScalingRunEvidenceDocument = {
    schema_version: '1.0.0',
    run_id: manifest.run_id,
    manifest,
    manifest_sha256: canonicalSha256(manifest),
    profile_id: common.profile_id,
    fork_manifest_id: common.fork_manifest_id,
    sut_release_id: common.sut_release_id,
    generator_release_id: common.generator_release_id,
    mode,
    fleet_qualifications: [],
    shard_evidence: [],
    external_dependencies: [],
    validation: {
      outcome: 'passed',
      reasons: [],
      external_not_run: [],
      reconciliation: {
        expected: 100_000,
        attempted: 100_000,
        accepted: 100_000,
        sut_observed: 100_000,
        independent_observed: 100_000
      }
    }
  };
  const scaling_campaigns = [...curves.values()].map((curve) => ({
    campaign_id: curve.campaign_id,
    submission_sha256: curve.submission_sha256,
    evidence_sha256: canonicalSha256(curve)
  }));
  return {
    curves,
    endpoint,
    submission: {
      schema_version: '1.0.0',
      platform_campaign_id: `platform-${mode}-20260717`,
      contract_id: contract.contract_id,
      contract_sha256: canonicalSha256(contract),
      mode,
      profile_id: common.profile_id,
      profile_sha256: common.profile_sha256,
      scaling_campaigns,
      endpoint_run: {
        run_id: endpoint.run_id,
        manifest_sha256: endpoint.manifest_sha256,
        evidence_manifest_sha256: canonicalSha256(endpoint)
      }
    }
  };
}

function scalingResult(input: {
  id: string;
  mode: 'controlled' | 'production';
  curve_id: string;
  scope: 'component' | 'cell' | 'shared_data';
  claim: 'none' | 'component_pass' | 'cell_pass';
  identity: CapacityScalingCampaignResult['identity'];
}): CapacityScalingCampaignResult {
  const units = input.scope === 'component' ? [1, 2, 4, 8] : [1, 2, 4, 8, 10];
  const result: CapacityScalingCampaignResult = {
    schema_version: '1.0.0',
    campaign_id: input.id,
    contract_id: contract.contract_id,
    contract_sha256: canonicalSha256(contract),
    submission_sha256: canonicalSha256({ id: input.id }),
    curve_id: input.curve_id,
    scope: input.scope,
    mode: input.mode,
    identity: input.identity,
    outcome: 'passed',
    capacity_claim: input.claim,
    source_run_count: 1,
    source_evidence_sha256: ['f'.repeat(64)],
    frontiers: units.map((point) => ({
      outcome: 'passed',
      units: point,
      hard_capacity: point * 1250,
      safe_capacity: point * 1000,
      successful_repeat_safe_capacities: [point * 1000, point * 1000, point * 1000],
      dominant_resource: 'cpu',
      history: [],
      reasons: []
    })),
    curve: null,
    reasons: []
  };
  result.curve = recomputeCurve(result);
  return result;
}

function recomputeCurve(result: CapacityScalingCampaignResult) {
  const curveContract = contract.scaling_curves.find(
    (candidate: any) => candidate.curve_id === result.curve_id
  );
  return evaluateScalingCurve({
    scope: result.scope,
    gates: {
      aggregate_linearity_floors: Object.fromEntries(
        curveContract.aggregate_linearity_floors.map((entry: any) => [entry.point, entry.minimum_ratio])
      ),
      segment_marginal_efficiency_floor: curveContract.segment_marginal_efficiency_floor,
      maximum_adjacent_segment_drop_ratio: curveContract.maximum_adjacent_segment_drop_ratio
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
}
