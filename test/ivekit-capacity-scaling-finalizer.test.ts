import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  capacityScalingFinalizerConfig,
  readCapacityScalingCampaignInput
} from '../scripts/ivekit-capacity-scaling-finalizer.js';

test('scaling finalizer requires explicit database S3 contract and campaign inputs', () => {
  const config = capacityScalingFinalizerConfig({
    CONVERACT_DATABASE_URL: 'postgresql://opc@postgres/ivekit',
    CONVERACT_FABRIC_CAPACITY_SCALING_FINALIZER_ID: 'scaling-finalizer-a',
    CONVERACT_FABRIC_CAPACITY_SCALING_CONTRACT_PATH: '/run/capacity/contract.json',
    CONVERACT_FABRIC_CAPACITY_SCALING_SUBMISSION_PATH: '/run/capacity/submission.json',
    CONVERACT_FABRIC_CAPACITY_SCALING_FINALIZER_LEASE_MS: '15000',
    CONVERACT_FABRIC_CAPACITY_SCALING_EVIDENCE_PREFIX: 'capacity/scaling',
    CONVERACT_FABRIC_CAPACITY_EVIDENCE_S3_BUCKET: 'capacity-evidence',
    CONVERACT_FABRIC_CAPACITY_EVIDENCE_S3_REGION: 'ap-southeast-1'
  });

  assert.equal(config.finalizer_id, 'scaling-finalizer-a');
  assert.equal(config.evidence_s3.bucket, 'capacity-evidence');
  assert.throws(
    () => capacityScalingFinalizerConfig({}),
    /CONVERACT_DATABASE_URL/
  );
});

test('scaling finalizer reads only bounded schema-bound input files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-scaling-finalizer-'));
  try {
    const contractPath = join(directory, 'contract.json');
    const submissionPath = join(directory, 'submission.json');
    writeFileSync(contractPath, JSON.stringify({
      schema_version: '1.0.0',
      contract_id: 'mix-100k-efficiency-v1'
    }));
    writeFileSync(submissionPath, JSON.stringify({
      schema_version: '1.0.0',
      campaign_id: 'component-curve-001'
    }));
    const loaded = readCapacityScalingCampaignInput(contractPath, submissionPath);
    assert.equal(loaded.contract.contract_id, 'mix-100k-efficiency-v1');
    assert.equal(loaded.submission.campaign_id, 'component-curve-001');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
