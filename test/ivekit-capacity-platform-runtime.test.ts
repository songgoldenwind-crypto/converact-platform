import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, canonicalSha256 } from '../scripts/capacity/canonical-json.js';
import {
  PostgresVerifiedCapacityScalingCampaignSource
} from '../scripts/capacity/platform-campaign-runtime.js';
import type { CapacityPlatformScalingReference } from '../scripts/capacity/platform-campaign.js';
import type { CapacityScalingCampaignResult } from '../scripts/capacity/scaling-campaign.js';

test('platform source reloads only terminal SHA-bound scaling campaign evidence', async () => {
  const fixture = sourceFixture();
  const source = new PostgresVerifiedCapacityScalingCampaignSource(
    new FakePg([fixture.row]),
    new FakeReader(Buffer.from(canonicalJson(fixture.document)))
  );

  assert.deepEqual(await source.load(fixture.reference), fixture.document);
});

test('platform source rejects scaling evidence not completed by its fenced campaign', async () => {
  const fixture = sourceFixture();
  fixture.row.state = 'finalizing';
  const source = new PostgresVerifiedCapacityScalingCampaignSource(
    new FakePg([fixture.row]),
    new FakeReader(Buffer.from(canonicalJson(fixture.document)))
  );

  await assert.rejects(() => source.load(fixture.reference), /terminal|completed/i);
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
  document: CapacityScalingCampaignResult;
  reference: CapacityPlatformScalingReference;
  row: Record<string, any>;
} {
  const document: CapacityScalingCampaignResult = {
    schema_version: '1.0.0',
    campaign_id: 'curve-tinode-im',
    contract_id: 'mix-100k-efficiency-v1',
    contract_sha256: 'a'.repeat(64),
    submission_sha256: 'b'.repeat(64),
    curve_id: 'homogeneous-component-pool-1-8',
    scope: 'component',
    mode: 'production',
    identity: {
      profile_id: 'mix-100k-v1',
      profile_sha256: 'c'.repeat(64),
      component_role: 'tinode_im',
      hardware_class: 'c32-64g-25gbe',
      hardware_sha256: 'd'.repeat(64),
      configuration_class: 'tinode-v1',
      configuration_sha256: 'e'.repeat(64),
      failure_reserve_sha256: 'f'.repeat(64),
      fork_manifest_id: 'ivekit-forks-v1',
      fork_manifest_sha256: '1'.repeat(64),
      sut_release_id: 'ivekit@0123456789abcdef0123456789abcdef01234567',
      generator_release_id: 'loadgen@fedcba9876543210fedcba9876543210fedcba98'
    },
    outcome: 'passed',
    capacity_claim: 'component_pass',
    source_run_count: 3,
    source_evidence_sha256: ['2'.repeat(64)],
    frontiers: [],
    curve: {
      outcome: 'passed',
      scope: 'component',
      points: [],
      segments: [],
      reasons: []
    },
    reasons: []
  };
  const evidenceSha = canonicalSha256(document);
  return {
    document,
    reference: {
      campaign_id: document.campaign_id,
      submission_sha256: document.submission_sha256,
      evidence_sha256: evidenceSha
    },
    row: {
      campaign_id: document.campaign_id,
      state: 'completed',
      outcome: 'passed',
      capacity_claim: 'component_pass',
      submission_sha256: document.submission_sha256,
      evidence_object_uri: 's3://capacity-evidence/platform/curve-tinode-im.json',
      evidence_sha256: evidenceSha,
      evidence_byte_size: Buffer.byteLength(canonicalJson(document))
    }
  };
}
