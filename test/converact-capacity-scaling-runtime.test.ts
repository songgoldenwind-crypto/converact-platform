import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { canonicalJson, canonicalSha256 } from '../scripts/capacity/canonical-json.js';
import {
  PostgresVerifiedCapacityRunEvidenceSource
} from '../scripts/capacity/scaling-campaign-runtime.js';
import type {
  CapacityScalingProbeReference,
  CapacityScalingRunEvidenceDocument
} from '../scripts/capacity/scaling-campaign.js';
import { createPassingRtcPerformanceEvidence } from './helpers/rtc-performance-fixture.js';

const performanceContract = JSON.parse(
  readFileSync('docs/capacity/profiles/mix-100k-v1.json', 'utf8')
).performance_contract;

test('scaling source reloads only a database-verified hash-bound run evidence object', async () => {
  const fixture = sourceFixture();
  const source = new PostgresVerifiedCapacityRunEvidenceSource(
    new FakePg([fixture.row]),
    new FakeReader(Buffer.from(canonicalJson(fixture.document)))
  );

  assert.deepEqual(await source.load(fixture.reference), fixture.document);
});

test('scaling source rejects an uploaded but unverified run evidence object', async () => {
  const fixture = sourceFixture();
  fixture.row.evidence_state = 'uploaded';
  const source = new PostgresVerifiedCapacityRunEvidenceSource(
    new FakePg([fixture.row]),
    new FakeReader(Buffer.from(canonicalJson(fixture.document)))
  );

  await assert.rejects(() => source.load(fixture.reference), /verified/i);
});

class FakePg {
  constructor(private readonly rows: Record<string, unknown>[]) {}
  async query(): Promise<{ rows: Record<string, unknown>[] }> {
    return { rows: structuredClone(this.rows) };
  }
}

class FakeReader {
  constructor(private readonly body: Uint8Array) {}
  async get(): Promise<Uint8Array> {
    return this.body;
  }
}

function sourceFixture(): {
  document: CapacityScalingRunEvidenceDocument;
  reference: CapacityScalingProbeReference;
  row: Record<string, any>;
} {
  const manifest: any = {
    schema_version: '1.0.0',
    run_id: 'curve-u1-a1',
    profile_id: 'mix-100k-v1',
    profile_sha256: 'a'.repeat(64),
    fork_manifest_id: 'ivekit-forks-v1',
    fork_manifest_sha256: 'b'.repeat(64),
    sut_release_id: 'converact@0123456789abcdef0123456789abcdef01234567',
    generator_release_id: 'loadgen@fedcba9876543210fedcba9876543210fedcba98',
    seed: 'seed-curve-u1-a1',
    run_epoch: '2026-07-17T08:00:00.000Z',
    topology: { fleets: [] },
    shards: [],
    phases: [],
    faults: [],
    expected_totals: { interactions: 100, connections: 0, by_workload: {} },
    performance_contract: performanceContract,
    external_dependencies: [],
    start_not_before: '2026-07-17T08:00:00.000Z',
    evidence_prefix: 'capacity/curve-u1-a1'
  };
  const document: CapacityScalingRunEvidenceDocument = {
    schema_version: '1.0.0',
    run_id: manifest.run_id,
    manifest,
    manifest_sha256: canonicalSha256(manifest),
    profile_id: manifest.profile_id,
    fork_manifest_id: manifest.fork_manifest_id,
    sut_release_id: manifest.sut_release_id,
    generator_release_id: manifest.generator_release_id,
    mode: 'production',
    fleet_qualifications: [],
    shard_evidence: [],
    performance_evidence: createPassingRtcPerformanceEvidence(performanceContract),
    external_dependencies: [],
    validation: {
      outcome: 'passed',
      reasons: [],
      external_not_run: [],
      reconciliation: {
        expected: 100,
        attempted: 100,
        accepted: 100,
        sut_observed: 100,
        independent_observed: 100,
        by_workload: {}
      }
    }
  };
  const reference: CapacityScalingProbeReference = {
    units: 1,
    attempt: 1,
    phase: 'ramp',
    requested_load: 100,
    run_id: manifest.run_id,
    manifest_sha256: document.manifest_sha256,
    evidence_manifest_sha256: canonicalSha256(document),
    dominant_resource: 'cpu'
  };
  return {
    document,
    reference,
    row: {
      run_id: manifest.run_id,
      run_state: 'completed',
      run_outcome: 'passed',
      manifest,
      manifest_sha256: reference.manifest_sha256,
      run_evidence_manifest_sha256: reference.evidence_manifest_sha256,
      evidence_state: 'verified',
      evidence_object_uri: 's3://capacity-evidence/capacity/curve-u1-a1.json',
      evidence_sha256: reference.evidence_manifest_sha256,
      evidence_byte_size: Buffer.byteLength(canonicalJson(document))
    }
  };
}
