import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import { resolveEffectiveGoal } from './resolve-effective-goal.mjs';

const goalsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(goalsDirectory);
const amendmentDirectory = join(goalsDirectory, 'amendments');
const amendmentPath = join(amendmentDirectory, '2026-08-02-g02-g03-gate-split-v1.json');
const schemaPath = join(amendmentDirectory, 'goal-gate-amendment-v1.schema.json');
const manifestPath = join(goalsDirectory, 'manifest.json');
const goal02Path = join(goalsDirectory, 'goal-02-platform-foundation-security-observability.md');
const goal03Path = join(goalsDirectory, 'goal-03-sip-call-durable-foundation.md');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('gate split validates without rewriting frozen Goal identities', () => {
  const schema = readJson(schemaPath);
  const amendment = readJson(amendmentPath);
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(amendment), true, JSON.stringify(validate.errors));

  assert.equal(sha256(goal02Path), '742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9');
  assert.equal(sha256(goal03Path), '05ce7f940782ab0efcd013d413220d068a7d3be1bab981f2c2c4f6a6f2a217af');
  assert.equal(amendment.frozen_inputs.manifest_sha256, sha256(manifestPath));
  assert.equal(amendment.frozen_inputs.goal_02_sha256, sha256(goal02Path));
  assert.equal(amendment.frozen_inputs.goal_03_sha256, sha256(goal03Path));
});

test('development gate is evidence-backed while production gates remain blocked', () => {
  const amendment = readJson(amendmentPath);
  const evidence = readJson(join(
    repositoryRoot,
    'architecture-foundation/execution/goal-02/evidence-index-v1.json',
  ));
  const review = readFileSync(join(
    repositoryRoot,
    'architecture-foundation/execution/goal-02/independent-review.md',
  ), 'utf8');

  assert.equal(amendment.development_gate.gate_id, 'G02_PLATFORM_FOUNDATION_GATE');
  assert.equal(amendment.development_gate.status, 'completed');
  assert.equal(amendment.development_gate.closure_commit, '16ab4af98c5f3b453ad3d9bdd1ae5fe959a37720');
  assert.deepEqual(amendment.development_gate.review_findings, {
    critical: 0,
    high: 0,
    important: 0,
    minor: 0,
  });
  assert.match(review, /Review status: `accepted_with_external_evidence_blockers`/u);
  assert.match(review, /Critical: `0`[\s\S]*High: `0`[\s\S]*Important: `0`[\s\S]*Minor: `0`/u);

  const notRun = evidence.entries
    .filter((entry) => entry.status === 'not_run')
    .map((entry) => entry.evidence_id)
    .sort();
  assert.deepEqual(notRun, ['G02-E09-DEPENDENCY', 'G02-E12-LONG-MEDIA', 'G02-E14-REGION', 'G02-E15-NATIVE']);
  assert.deepEqual([...amendment.production_gate.not_run_evidence_ids].sort(), notRun);
  assert.equal(amendment.production_gate.status, 'blocked_external');
  assert.equal(amendment.production_gate.production_eligible, false);
  assert.equal(evidence.summary.production_eligible_entries, 0);
});

test('effective resolver changes only the G03 development dependency', () => {
  const manifest = readJson(manifestPath);
  const manifestBytes = readFileSync(manifestPath);
  const amendment = readJson(amendmentPath);
  const original = manifest.goals.find((goal) => goal.id === 'G03');
  const effective = resolveEffectiveGoal({
    manifest_bytes: manifestBytes,
    amendment,
    goal_id: 'G03',
  });

  assert.equal(original.dependencies.find((dependency) => dependency.goal_id === 'G02').gate, 'completed');
  assert.equal(
    effective.dependencies.find((dependency) => dependency.goal_id === 'G02').gate,
    'platform_foundation_gate_completed',
  );
  assert.deepEqual(
    effective.dependencies.filter((dependency) => dependency.goal_id !== 'G02'),
    original.dependencies.filter((dependency) => dependency.goal_id !== 'G02'),
  );
  assert.equal(effective.sha256, original.sha256);
  assert.equal(effective.status, original.status);
  assert.equal(effective.production_eligible, false);
  assert.deepEqual(
    manifest.goals.find((goal) => goal.id === 'G03'),
    original,
    'resolver must not mutate the frozen manifest',
  );
  assert.throws(
    () => resolveEffectiveGoal({ manifest_bytes: manifestBytes, amendment: { ...amendment, production_gate: {
      ...amendment.production_gate,
      production_eligible: true,
    } }, goal_id: 'G03' }),
    /gate_amendment_invalid/u,
  );
});

test('resolver rejects amendment drift even when JSON still looks plausible', () => {
  const manifest = readJson(manifestPath);
  const manifestBytes = readFileSync(manifestPath);
  const amendment = readJson(amendmentPath);
  const cases = [
    { ...amendment, undeclared_field: true },
    { ...amendment, authorization_basis: 'operator_override' },
    { ...amendment, frozen_inputs: { ...amendment.frozen_inputs, manifest_sha256: '0'.repeat(64) } },
    { ...amendment, development_gate: { ...amendment.development_gate, closure_commit: '0'.repeat(40) } },
    { ...amendment, invariants: amendment.invariants.slice(0, -1) },
    { ...amendment, scope: { ...amendment.scope, changes: ['G02_production_gate'] } },
  ];
  for (const drifted of cases) {
    assert.throws(
      () => resolveEffectiveGoal({
        manifest_bytes: manifestBytes,
        amendment: drifted,
        goal_id: 'G03',
      }),
      /gate_amendment_invalid/u,
    );
  }
});

test('resolver binds the exact manifest bytes instead of trusting caller identity strings', () => {
  const manifest = readJson(manifestPath);
  const amendment = readJson(amendmentPath);
  const forgedManifest = structuredClone(manifest);
  const forgedG03 = forgedManifest.goals.find((goal) => goal.id === 'G03');
  forgedG03.title = 'Forged Goal';
  forgedG03.path = 'goals/goal-04-g729-exact-source-codec.md';
  forgedG03.entry_gate = 'operator override';
  forgedG03.unlocks = ['G17'];
  assert.throws(
    () => resolveEffectiveGoal({
      manifest_bytes: Buffer.from(JSON.stringify(forgedManifest)),
      amendment,
      goal_id: 'G03',
    }),
    /gate_amendment_invalid/u,
  );

  const forgedIdentityManifest = structuredClone(manifest);
  forgedIdentityManifest.goals.find((goal) => goal.id === 'G02').sha256 = 'a'.repeat(64);
  forgedIdentityManifest.goals.find((goal) => goal.id === 'G03').sha256 = 'b'.repeat(64);
  const forgedBytes = Buffer.from(JSON.stringify(forgedIdentityManifest));
  const forgedAmendment = {
    ...amendment,
    frozen_inputs: {
      ...amendment.frozen_inputs,
      manifest_sha256: sha256Bytes(forgedBytes),
      goal_02_sha256: 'a'.repeat(64),
      goal_03_sha256: 'b'.repeat(64),
    },
  };
  assert.throws(
    () => resolveEffectiveGoal({
      manifest_bytes: forgedBytes,
      amendment: forgedAmendment,
      goal_id: 'G03',
    }),
    /gate_amendment_invalid/u,
  );
});
