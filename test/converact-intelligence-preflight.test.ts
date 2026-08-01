import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { inspectConveractFabricIntelligenceEnv } from '../scripts/converact-intelligence-preflight.js';

test('intelligence preflight validates PostgreSQL, profiles, storage, credentials, and lease budgets', () => {
  const missing = inspectConveractFabricIntelligenceEnv({});
  assert.equal(missing.ready, false);
  assert.equal(missing.issues.some((issue) => issue.includes('PostgreSQL')), true);
  assert.equal(missing.issues.some((issue) => issue.includes('provider profile')), true);

  const configured = inspectConveractFabricIntelligenceEnv({
    DATABASE_URL: 'postgres://opc:database-secret@postgres:5432/opc',
    S3_BUCKET: 'converact-evidence',
    S3_SECRET_ACCESS_KEY: 'storage-secret',
    CONVERACT_FABRIC_PROVIDER_PROFILES_JSON: JSON.stringify([
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
    CONVERACT_ATTACHMENT_PROCESSING_CLAIM_LEASE_MS: '60000',
    CONVERACT_QUALITY_REVIEW_CLAIM_LEASE_MS: '120000'
  });
  assert.equal(configured.ready, true);
  assert.deepEqual(configured.profiles.map((profile) => profile.id), ['ocr-internal', 'quality-cloud']);
  const serialized = JSON.stringify(configured);
  assert.doesNotMatch(
    serialized,
    /database-secret|storage-secret|ocr-super-secret|quality-super-secret|example\.test|token_env/i
  );

  const unsafeBudget = inspectConveractFabricIntelligenceEnv({
    DATABASE_URL: 'postgres://postgres/converact',
    S3_BUCKET: 'converact-evidence',
    CONVERACT_FABRIC_PROVIDER_PROFILES_JSON: JSON.stringify([{
      id: 'asr-slow',
      capability: 'asr',
      mode: 'third_party',
      base_url: 'https://asr.example.test',
      timeout_ms: 60_000
    }]),
    CONVERACT_ATTACHMENT_PROCESSING_CLAIM_LEASE_MS: '30000'
  });
  assert.equal(unsafeBudget.ready, false);
  assert.equal(unsafeBudget.issues.some((issue) => issue.includes('claim lease')), true);
});

test('intelligence preflight reports missing token refs and invalid profile JSON without echoing secrets', () => {
  const missingToken = inspectConveractFabricIntelligenceEnv({
    DATABASE_URL: 'postgres://postgres/converact',
    CONVERACT_FABRIC_PROVIDER_PROFILES_JSON: JSON.stringify([{
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

  const invalid = inspectConveractFabricIntelligenceEnv({
    DATABASE_URL: 'postgres://postgres/converact',
    CONVERACT_FABRIC_PROVIDER_PROFILES_JSON: '[{"token":"inline-super-secret"}]'
  });
  assert.equal(invalid.ready, false);
  assert.doesNotMatch(JSON.stringify(invalid), /inline-super-secret/i);
});

test('package exposes the unified intelligence preflight command', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts['converact:intelligence-preflight'], 'tsx scripts/converact-intelligence-preflight.ts');
  const standalone = JSON.parse(readFileSync('services/converact-service/package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(standalone.scripts['preflight:intelligence'], 'node dist/converact-intelligence-preflight.js');
});
