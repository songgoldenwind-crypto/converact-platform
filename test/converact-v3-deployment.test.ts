import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const composeFiles = [
  'infra/converact/docker-compose.yml',
  'infra/docker-compose.production.yml'
];

const providerTokenNames = [
  'CONVERACT_FABRIC_OCR_TOKEN',
  'CONVERACT_FABRIC_ASR_TOKEN',
  'CONVERACT_FABRIC_QUALITY_TOKEN',
  'CONVERACT_FABRIC_TRANSLATION_TOKEN'
];

const translationWorkerNames = [
  'CONVERACT_TRANSLATION_WORKER_ENABLED',
  'CONVERACT_TRANSLATION_INTERVAL_MS',
  'CONVERACT_TRANSLATION_BATCH_SIZE',
  'CONVERACT_TRANSLATION_MAX_ATTEMPTS',
  'CONVERACT_TRANSLATION_CLAIM_LEASE_MS',
  'CONVERACT_TRANSLATION_RETRY_DELAYS_MS'
];

test('Compose deployments expose V3 provider profiles, secret refs, and bounded workers', () => {
  for (const path of composeFiles) {
    const compose = readFileSync(path, 'utf8');
    assert.match(compose, /CONVERACT_FABRIC_PROVIDER_PROFILES_JSON:/, path);
    for (const name of [...providerTokenNames, ...translationWorkerNames]) {
      assert.match(compose, new RegExp(`${name}:`), `${path}: ${name}`);
    }
    assert.match(compose, /CONVERACT_ATTACHMENT_PROCESSING_CLAIM_LEASE_MS:/, path);
    assert.match(compose, /CONVERACT_ATTACHMENT_PROCESSING_RETRY_DELAYS_MS:/, path);
    assert.match(compose, /CONVERACT_QUALITY_REVIEW_CLAIM_LEASE_MS:/, path);
    assert.match(compose, /CONVERACT_QUALITY_REVIEW_RETRY_DELAYS_MS:/, path);
  }

  const standalone = readFileSync('infra/converact/docker-compose.yml', 'utf8');
  assert.match(standalone, /CONVERACT_ATTACHMENT_PROCESSING_WORKER_ENABLED: \$\{CONVERACT_ATTACHMENT_PROCESSING_WORKER_ENABLED:-0\}/);
  assert.match(standalone, /CONVERACT_QUALITY_REVIEW_WORKER_ENABLED: \$\{CONVERACT_QUALITY_REVIEW_WORKER_ENABLED:-0\}/);
  assert.match(standalone, /CONVERACT_TRANSLATION_WORKER_ENABLED: \$\{CONVERACT_TRANSLATION_WORKER_ENABLED:-0\}/);
  const controlled = standalone.match(
    /^  controlled-intelligence-provider:\n([\s\S]*?)(?=^  [a-zA-Z0-9_-]+:\n|^volumes:)/m
  )?.[0] || '';
  assert.match(controlled, /profiles: \["acceptance"\]/);
  assert.match(controlled, /command: \["npm", "run", "converact:controlled-provider"\]/);
  assert.match(controlled, /CONVERACT_FABRIC_CONTROLLED_HOST: 0\.0\.0\.0/);
  assert.match(controlled, /CONVERACT_FABRIC_CONTROLLED_PORT: "8790"/);
  assert.doesNotMatch(controlled, /ports:/);
  const standaloneEnv = readFileSync('infra/converact/env.example', 'utf8');
  assert.match(standaloneEnv, /^CONVERACT_FABRIC_CONTROLLED_TOKEN=/m);
  assert.match(standaloneEnv, /^CONVERACT_FABRIC_CONTROL_TOKEN=/m);
});

test('Helm keeps V3 provider tokens in Secret and renders all worker controls', () => {
  const values = readFileSync('infra/k8s/values.yaml', 'utf8');
  const deployment = readFileSync('infra/k8s/templates/converact-deployment.yaml', 'utf8');
  const secrets = readFileSync('infra/k8s/templates/secrets.yaml', 'utf8');

  assert.match(values, /^intelligence:$/m);
  assert.match(values, /^  providerProfilesJson: "\[\]"$/m);
  assert.match(values, /^  translationWorker:$/m);
  assert.match(values, /^    enabled: "0"$/m);
  assert.match(deployment, /- name: CONVERACT_FABRIC_PROVIDER_PROFILES_JSON\n\s+value: \{\{ \.Values\.intelligence\.providerProfilesJson/);
  for (const name of [...providerTokenNames, ...translationWorkerNames]) {
    assert.match(deployment, new RegExp(`- name: ${name}`), name);
  }

  const secretKeys = [
    'converact-ocr-provider-token',
    'converact-asr-provider-token',
    'converact-quality-provider-token',
    'converact-translation-provider-token'
  ];
  for (const key of secretKeys) {
    assert.match(secrets, new RegExp(`^  ${key}:`, 'm'), key);
    assert.match(deployment, new RegExp(`key: ${key}`), key);
  }
  assert.doesNotMatch(secrets, /providerProfilesJson/);
  for (const name of providerTokenNames) {
    const block = deployment.match(new RegExp(`- name: ${name}\\n([\\s\\S]*?)(?=\\n\\s+- name:)`))?.[0] || '';
    assert.match(block, /valueFrom:/, name);
    assert.doesNotMatch(block, /\n\s+value:/, name);
  }
});

test('V3 operations and LED handoff docs preserve deployment and validation boundaries', () => {
  const operations = readFileSync('docs/converact-fabric-v3-intelligence-operations.md', 'utf8');
  const openapi = readFileSync('docs/converact-openapi.md', 'utf8');
  const led = readFileSync('docs/converact-led-integration-guide.md', 'utf8');
  const joined = `${operations}\n${openapi}\n${led}`;

  for (const phrase of [
    'self_hosted',
    'third_party',
    'CONVERACT_FABRIC_PROVIDER_PROFILES_JSON',
    'RBAC',
    '重试',
    '告警',
    '升级',
    '回滚',
    'not_run'
  ]) {
    assert.match(joined, new RegExp(phrase, 'i'), phrase);
  }
  assert.match(operations, /converact:controlled-provider/);
  assert.match(operations, /converact:intelligence-preflight/);
  assert.match(openapi, /\/api\/ivekit\/intelligence\/policy/);
  assert.match(openapi, /\/api\/ivekit\/chat\/sessions\/:session_id\/messages\/:message_id\/translations/);
  assert.match(led, /LED[^\n]*(SDK|@opc\/ivekit-sdk)/i);
  assert.match(led, /不得[^\n]*直连[^\n]*(PostgreSQL|provider)/i);
});
