import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  capacityPlatformFinalizerConfig,
  readCapacityPlatformCampaignInput
} from '../scripts/ivekit-capacity-platform-finalizer.js';

test('platform finalizer requires explicit database S3 contract and campaign inputs', () => {
  const config = capacityPlatformFinalizerConfig({
    CONVERACT_DATABASE_URL: 'postgresql://opc@postgres/ivekit',
    CONVERACT_FABRIC_CAPACITY_PLATFORM_FINALIZER_ID: 'platform-finalizer-a',
    CONVERACT_FABRIC_CAPACITY_PLATFORM_CONTRACT_PATH: '/run/capacity/contract.json',
    CONVERACT_FABRIC_CAPACITY_PLATFORM_SUBMISSION_PATH: '/run/capacity/submission.json',
    CONVERACT_FABRIC_CAPACITY_PLATFORM_FINALIZER_LEASE_MS: '15000',
    CONVERACT_FABRIC_CAPACITY_PLATFORM_EVIDENCE_PREFIX: 'capacity/platform',
    CONVERACT_FABRIC_CAPACITY_EVIDENCE_S3_BUCKET: 'capacity-evidence',
    CONVERACT_FABRIC_CAPACITY_EVIDENCE_S3_REGION: 'ap-southeast-1'
  });

  assert.equal(config.finalizer_id, 'platform-finalizer-a');
  assert.equal(config.evidence_s3.bucket, 'capacity-evidence');
  assert.throws(() => capacityPlatformFinalizerConfig({}), /CONVERACT_DATABASE_URL/);
});

test('platform finalizer reads only bounded schema-bound input files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-platform-finalizer-'));
  try {
    const contractPath = join(directory, 'contract.json');
    const submissionPath = join(directory, 'submission.json');
    writeFileSync(contractPath, JSON.stringify({
      schema_version: '1.0.0',
      contract_id: 'mix-100k-efficiency-v1'
    }));
    writeFileSync(submissionPath, JSON.stringify({
      schema_version: '1.0.0',
      platform_campaign_id: 'mix-100k-platform-001'
    }));
    const loaded = readCapacityPlatformCampaignInput(contractPath, submissionPath);
    assert.equal(loaded.contract.contract_id, 'mix-100k-efficiency-v1');
    assert.equal(loaded.submission.platform_campaign_id, 'mix-100k-platform-001');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
