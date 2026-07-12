import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { inspectIveKitIntelligenceEnv } from '../scripts/ivekit-intelligence-preflight.js';

test('intelligence preflight validates PostgreSQL, profiles, storage, credentials, and lease budgets', () => {
  const missing = inspectIveKitIntelligenceEnv({});
  assert.equal(missing.ready, false);
  assert.equal(missing.issues.some((issue) => issue.includes('PostgreSQL')), true);
  assert.equal(missing.issues.some((issue) => issue.includes('provider profile')), true);

  const configured = inspectIveKitIntelligenceEnv({
    DATABASE_URL: 'postgres://opc:database-secret@postgres:5432/opc',
    S3_BUCKET: 'ivekit-evidence',
    S3_SECRET_ACCESS_KEY: 'storage-secret',
    OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify([
      {
        id: 'ocr-internal',
        capability: 'ocr',
        mode: 'self_hosted',
        base_url: 'http://ocr-worker:8080',
        token_env: 'OCR_INTERNAL_TOKEN',
        timeout_ms: 10_000
      },
      {
        id: 'quality-cloud',
        capability: 'quality_review',
        mode: 'third_party',
        base_url: 'https://quality.example.test',
        token_env: 'QUALITY_CLOUD_TOKEN',
        timeout_ms: 15_000
      }
    ]),
    OCR_INTERNAL_TOKEN: 'ocr-super-secret',
    QUALITY_CLOUD_TOKEN: 'quality-super-secret',
    OPC_ATTACHMENT_PROCESSING_CLAIM_LEASE_MS: '60000',
    OPC_QUALITY_REVIEW_CLAIM_LEASE_MS: '120000'
  });
  assert.equal(configured.ready, true);
  assert.deepEqual(configured.profiles.map((profile) => profile.id), ['ocr-internal', 'quality-cloud']);
  const serialized = JSON.stringify(configured);
  assert.doesNotMatch(
    serialized,
    /database-secret|storage-secret|ocr-super-secret|quality-super-secret|example\.test|token_env/i
  );

  const unsafeBudget = inspectIveKitIntelligenceEnv({
    DATABASE_URL: 'postgres://postgres/ivekit',
    S3_BUCKET: 'ivekit-evidence',
    OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify([{
      id: 'asr-slow',
      capability: 'asr',
      mode: 'third_party',
      base_url: 'https://asr.example.test',
      timeout_ms: 60_000
    }]),
    OPC_ATTACHMENT_PROCESSING_CLAIM_LEASE_MS: '30000'
  });
  assert.equal(unsafeBudget.ready, false);
  assert.equal(unsafeBudget.issues.some((issue) => issue.includes('claim lease')), true);
});

test('intelligence preflight reports missing token refs and invalid profile JSON without echoing secrets', () => {
  const missingToken = inspectIveKitIntelligenceEnv({
    DATABASE_URL: 'postgres://postgres/ivekit',
    OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify([{
      id: 'translation-cloud',
      capability: 'translation',
      mode: 'third_party',
      base_url: 'https://translation.example.test',
      token_env: 'TRANSLATION_TOKEN'
    }])
  });
  assert.equal(missingToken.ready, false);
  assert.equal(missingToken.issues.some((issue) => issue.includes('translation-cloud credential')), true);
  assert.doesNotMatch(JSON.stringify(missingToken), /TRANSLATION_TOKEN|translation\.example/i);

  const invalid = inspectIveKitIntelligenceEnv({
    DATABASE_URL: 'postgres://postgres/ivekit',
    OPC_IVEKIT_PROVIDER_PROFILES_JSON: '[{"token":"inline-super-secret"}]'
  });
  assert.equal(invalid.ready, false);
  assert.doesNotMatch(JSON.stringify(invalid), /inline-super-secret/i);
});

test('package exposes the unified intelligence preflight command', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts['ivekit:intelligence-preflight'], 'tsx scripts/ivekit-intelligence-preflight.ts');
});
