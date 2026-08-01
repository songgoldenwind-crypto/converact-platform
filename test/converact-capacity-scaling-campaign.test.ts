import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { canonicalSha256 } from '../scripts/capacity/canonical-json.js';
import { runCapacityFrontier } from '../scripts/capacity/frontier-runner.js';
import {
  finalizeCapacityScalingCampaign,
  type CapacityScalingCampaignSubmission,
  type CapacityScalingRunEvidenceDocument
} from '../scripts/capacity/scaling-campaign.js';
import { createPassingRtcPerformanceEvidence } from './helpers/rtc-performance-fixture.js';

const contract = JSON.parse(
  readFileSync('docs/capacity/targets/mix-100k-efficiency-v1.json', 'utf8')
);
const performanceContract = JSON.parse(
  readFileSync('docs/capacity/profiles/mix-100k-v1.json', 'utf8')
).performance_contract;

test('scaling campaign replays every source-bound frontier before issuing a curve result', async () => {
  const fixture = await campaignFixture();
  const result = await finalizeCapacityScalingCampaign({
    contract,
    submission: fixture.submission,
    load_run_evidence: async (reference) => structuredClone(
      fixture.documents.get(reference.run_id)!
    )
  });

  assert.equal(result.outcome, 'passed');
  assert.equal(result.capacity_claim, 'component_pass');
  assert.deepEqual(result.frontiers.map((frontier) => frontier.units), [1, 2, 4, 8]);
  assert.equal(result.curve?.outcome, 'passed');
  assert.equal(result.source_run_count, fixture.submission.probes.length);
});

test('scaling campaign rejects evidence hash drift identity drift and reordered frontier runs', async () => {
  const fixture = await campaignFixture();
  const hashDrift = structuredClone(fixture.submission);
  hashDrift.probes[0].evidence_manifest_sha256 = '0'.repeat(64);
  await assert.rejects(
    () => finalizeCapacityScalingCampaign({
      contract,
      submission: hashDrift,
      load_run_evidence: async (reference) => fixture.documents.get(reference.run_id)!
    }),
    /evidence.*SHA-256/i
  );

  const identityDrift = structuredClone(fixture.documents.get(fixture.submission.probes[1].run_id)!);
  identityDrift.manifest.capacity_context!.hardware_sha256 = '9'.repeat(64);
  identityDrift.manifest_sha256 = canonicalSha256(identityDrift.manifest);
  const identitySubmission = structuredClone(fixture.submission);
  identitySubmission.probes[1].manifest_sha256 = identityDrift.manifest_sha256;
  identitySubmission.probes[1].evidence_manifest_sha256 = canonicalSha256(identityDrift);
  await assert.rejects(
    () => finalizeCapacityScalingCampaign({
      contract,
      submission: identitySubmission,
      load_run_evidence: async (reference) => reference.run_id === identityDrift.run_id
        ? identityDrift
        : fixture.documents.get(reference.run_id)!
    }),
    /hardware_sha256/i
  );

  const reordered = structuredClone(fixture.submission);
  [reordered.probes[0], reordered.probes[1]] = [reordered.probes[1], reordered.probes[0]];
  await assert.rejects(
    () => finalizeCapacityScalingCampaign({
      contract,
      submission: reordered,
      load_run_evidence: async (reference) => fixture.documents.get(reference.run_id)!
    }),
    /history|attempt|requested_load/i
  );
});

test('controlled scaling evidence can exercise the verifier but cannot create a capacity claim', async () => {
  const fixture = await campaignFixture();
  fixture.submission.mode = 'controlled';
  for (const document of fixture.documents.values()) document.mode = 'controlled';
  for (const probe of fixture.submission.probes) {
    probe.evidence_manifest_sha256 = canonicalSha256(fixture.documents.get(probe.run_id)!);
  }

  const result = await finalizeCapacityScalingCampaign({
    contract,
    submission: fixture.submission,
    load_run_evidence: async (reference) => fixture.documents.get(reference.run_id)!
  });

  assert.equal(result.outcome, 'passed');
  assert.equal(result.capacity_claim, 'none');
});

async function campaignFixture(): Promise<{
  submission: CapacityScalingCampaignSubmission;
  documents: Map<string, CapacityScalingRunEvidenceDocument>;
}> {
  const profileSha = 'a'.repeat(64);
  const identity = {
    profile_id: 'mix-100k-v1',
    profile_sha256: profileSha,
    component_role: 'tinode_im',
    hardware_class: 'c32-64g-25gbe',
    hardware_sha256: 'b'.repeat(64),
    configuration_class: 'component-default-v1',
    configuration_sha256: 'c'.repeat(64),
    failure_reserve_sha256: 'd'.repeat(64),
    fork_manifest_id: 'ivekit-forks-v1',
    fork_manifest_sha256: 'e'.repeat(64),
    sut_release_id: 'converact@0123456789abcdef0123456789abcdef01234567',
    generator_release_id: 'loadgen@fedcba9876543210fedcba9876543210fedcba98'
  };
  const limits: Record<number, number> = { 1: 880, 2: 1740, 4: 3420, 8: 6740 };
  const documents = new Map<string, CapacityScalingRunEvidenceDocument>();
  const probes: CapacityScalingCampaignSubmission['probes'] = [];
  const frontier_bounds: CapacityScalingCampaignSubmission['frontier_bounds'] = [];
  for (const units of [1, 2, 4, 8]) {
    frontier_bounds.push({
      units,
      minimum_load: 100 * units,
      maximum_load: 1000 * units,
      resolution: 10
    });
    const frontier = await runCapacityFrontier({
      units,
      minimum_load: 100 * units,
      maximum_load: 1000 * units,
      resolution: 10,
      production_headroom_ratio: 0.2,
      final_repeat_count: 3,
      probe: async ({ requested_load }) => ({
        outcome: requested_load <= limits[units] ? 'passed' : 'failed',
        achieved_load: requested_load,
        slo_passed: requested_load <= limits[units],
        generator_qualified: true,
        dominant_resource: 'cpu'
      })
    });
    for (const entry of frontier.history) {
      const runId = `curve-u${units}-a${entry.attempt}`;
      const manifest = loadManifest({ run_id: runId, units, load: entry.requested_load, identity });
      const document: CapacityScalingRunEvidenceDocument = {
        schema_version: '1.0.0',
        run_id: runId,
        manifest,
        manifest_sha256: canonicalSha256(manifest),
        profile_id: identity.profile_id,
        fork_manifest_id: identity.fork_manifest_id,
        sut_release_id: identity.sut_release_id,
        generator_release_id: identity.generator_release_id,
        mode: 'production',
        fleet_qualifications: [],
        shard_evidence: [],
        performance_evidence: createPassingRtcPerformanceEvidence(performanceContract),
        external_dependencies: [],
        validation: {
          outcome: entry.outcome,
          reasons: entry.reasons || [],
          external_not_run: [],
          reconciliation: {
            expected: entry.requested_load,
            attempted: entry.requested_load,
            accepted: entry.outcome === 'passed' ? entry.requested_load : 0,
            sut_observed: entry.outcome === 'passed' ? entry.requested_load : 0,
            independent_observed: entry.outcome === 'passed' ? entry.requested_load : 0,
            by_workload: {}
          }
        }
      };
      documents.set(runId, document);
      probes.push({
        units,
        attempt: entry.attempt,
        phase: entry.phase,
        requested_load: entry.requested_load,
        run_id: runId,
        manifest_sha256: document.manifest_sha256,
        evidence_manifest_sha256: canonicalSha256(document),
        dominant_resource: entry.dominant_resource
      });
    }
  }
  return {
    submission: {
      schema_version: '1.0.0',
      campaign_id: 'component-curve-20260717-001',
      contract_id: contract.contract_id,
      contract_sha256: canonicalSha256(contract),
      curve_id: 'homogeneous-component-pool-1-8',
      mode: 'production',
      identity,
      frontier_bounds,
      ramp_ratios: [0.25, 0.5, 0.7, 0.85, 0.95],
      probes
    },
    documents
  };
}

function loadManifest(input: {
  run_id: string;
  units: number;
  load: number;
  identity: CapacityScalingCampaignSubmission['identity'];
}): CapacityScalingRunEvidenceDocument['manifest'] {
  return {
    schema_version: '1.0.0',
    run_id: input.run_id,
    profile_id: input.identity.profile_id,
    profile_sha256: input.identity.profile_sha256,
    fork_manifest_id: input.identity.fork_manifest_id,
    fork_manifest_sha256: input.identity.fork_manifest_sha256,
    sut_release_id: input.identity.sut_release_id,
    generator_release_id: input.identity.generator_release_id,
    seed: `seed-${input.run_id}`,
    run_epoch: '2026-07-17T08:00:00.000Z',
    profile_load: {
      base_interactions: 100_000,
      target_interactions: input.load,
      scale_numerator: input.load,
      scale_denominator: 100_000,
      apportionment: 'largest_remainder_v1'
    },
    capacity_context: {
      scope: 'component',
      component_role: input.identity.component_role,
      units: input.units,
      hardware_class: input.identity.hardware_class,
      hardware_sha256: input.identity.hardware_sha256,
      configuration_class: input.identity.configuration_class,
      configuration_sha256: input.identity.configuration_sha256,
      failure_reserve_sha256: input.identity.failure_reserve_sha256
    },
    topology: { fleets: [] },
    shards: [],
    phases: [],
    faults: [],
    expected_totals: {
      interactions: input.load,
      connections: 0,
      by_workload: {}
    },
    performance_contract: performanceContract,
    external_dependencies: [],
    start_not_before: '2026-07-17T08:00:00.000Z',
    evidence_prefix: `capacity/${input.run_id}`
  };
}
