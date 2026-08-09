import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import { buildFutureGoalObjective, resolveFutureGoal } from './resolve-future-goal.mjs';

const goalsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(goalsDirectory);
const manifestPath = join(goalsDirectory, 'manifest.json');
const amendmentDirectory = join(goalsDirectory, 'amendments');
const amendmentPath = join(
  amendmentDirectory,
  '2026-08-09-ai-speech-action-program-amendment-v1.json',
);
const amendmentDocumentPath = join(
  amendmentDirectory,
  '2026-08-09-ai-speech-action-program-amendment-v1.md',
);
const schemaPath = join(amendmentDirectory, 'future-goal-amendment-v1.schema.json');
const BASE_MANIFEST_SHA256 = '11b026b5014dc344d4e5b2459aafc0b251190075a212fc68f40dce62fbbda912';
const AMENDMENT_SHA256 = 'bf261120ed3d70fbdf78926bb59abfb3c86c1e00dea6bfd637654475e3b5c6ea';
const EXPECTED_TARGETS = new Map([
  ['G10', ['goals/goal-10-human-ai-collaboration-overlay.md', 'e7ca4d7e5cd48ae9bef8bfe2824cc5c185b8c2107e94942b5913992d77959dde']],
  ['G12', ['goals/goal-12-speech-runtime-hf-translation.md', 'b813b031b36a452ace4e054e5fa1cc3c224250a56172e312846b4bce5a66bbf9']],
  ['G13', ['goals/goal-13-agent-orchestrator-cross-channel-handoff.md', '54e194f092ff7c17e1995280e9742264162e789fe2ded39749aa0d37c749bb40']],
  ['G14', ['goals/goal-14-action-durable-workflow.md', 'b5020125b6eb1ef646a2f6f5f03196a336aeb0cfe2935d40b4573c8787261926']],
  ['G15', ['goals/goal-15-context-knowledge-studio-governance.md', '560810993a5363ba8e9d3fb5d61f73313ca788bf3357e2366e289ccfd3aa4cc8']],
  ['G16', ['goals/goal-16-v1-pilot-commercial-production.md', 'c20f8b775f90009f767761077f6f278ea489eaadd7dfda621a41e57ad601a6c7']],
]);
const EXPECTED_SUPPLEMENTAL_CLAUSES = new Map([
  ['G10', ['G10-A07']],
  ['G12', ['G12-A09']],
  ['G13', ['G13-A07']],
  ['G15', ['G15-A07', 'G15-A08']],
  ['G16', ['G16-A09']],
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

test('future-goal amendment binds the frozen manifest and exact future goals', () => {
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const amendment = readJson(amendmentPath);

  assert.equal(sha256Bytes(manifestBytes), BASE_MANIFEST_SHA256);
  assert.equal(sha256File(amendmentPath), AMENDMENT_SHA256);
  assert.match(readFileSync(amendmentDocumentPath, 'utf8'), new RegExp(AMENDMENT_SHA256, 'u'));
  assert.equal(amendment.frozen_inputs.manifest_sha256, BASE_MANIFEST_SHA256);
  assert.equal(amendment.frozen_inputs.targets.length, EXPECTED_TARGETS.size);

  for (const target of amendment.frozen_inputs.targets) {
    const expected = EXPECTED_TARGETS.get(target.goal_id);
    assert.ok(expected, `unexpected target ${target.goal_id}`);
    assert.deepEqual([target.path, target.sha256], expected);
    assert.equal(sha256File(join(repositoryRoot, target.path)), target.sha256);
    const manifestGoal = manifest.goals.find((goal) => goal.id === target.goal_id);
    assert.equal(manifestGoal.path, target.path);
    assert.equal(manifestGoal.sha256, target.sha256);
  }
});

test('future-goal amendment and decision artifacts validate against their schema', () => {
  const schema = readJson(schemaPath);
  const amendment = readJson(amendmentPath);
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  assert.equal(validate(amendment), true, JSON.stringify(validate.errors));
  assert.equal(amendment.source_review.upstream_claim_status, 'not_run');
  assert.equal(amendment.source_review.supplemental_source_file_name, 'pasted-text.txt');
  assert.equal(
    amendment.source_review.supplemental_source_sha256,
    'fc1c98fb7936ff40bfc6957006a73dd435939e4a31ab64fbcdefaabbe8a7094a',
  );
  for (const artifact of amendment.decision_artifacts) {
    assert.equal(sha256File(join(repositoryRoot, artifact.path)), artifact.sha256);
  }
});

test('resolver adds clauses without mutating the frozen base goal', () => {
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const amendmentBytes = readFileSync(amendmentPath);
  const amendment = JSON.parse(amendmentBytes.toString('utf8'));

  for (const goalId of EXPECTED_TARGETS.keys()) {
    const original = structuredClone(manifest.goals.find((goal) => goal.id === goalId));
    const goalBytes = readFileSync(join(repositoryRoot, original.path));
    const effective = resolveFutureGoal({
      manifest_bytes: manifestBytes,
      amendment_bytes: amendmentBytes,
      goal_bytes: goalBytes,
      goal_id: goalId,
    });

    assert.deepEqual(effective.base_goal, original);
    assert.equal(effective.amendment_id, amendment.amendment_id);
    assert.ok(effective.binding_clauses.length > 0);
    assert.deepEqual(
      manifest.goals.find((goal) => goal.id === goalId),
      original,
      'resolver must not mutate the frozen manifest',
    );
    assert.equal(effective.base_goal.status, original.status);
    assert.deepEqual(effective.base_goal.dependencies, original.dependencies);
    assert.equal(effective.base_goal.sha256, original.sha256);
    assert.equal(effective.amendment_path, 'goals/amendments/2026-08-09-ai-speech-action-program-amendment-v1.json');
    assert.equal(effective.amendment_sha256, AMENDMENT_SHA256);
  }
});

test('objective builder binds actual goal bytes and both exact identities', () => {
  const manifestBytes = readFileSync(manifestPath);
  const amendmentBytes = readFileSync(amendmentPath);
  const [goalPath, goalSha256] = EXPECTED_TARGETS.get('G12');
  const goalBytes = readFileSync(join(repositoryRoot, goalPath));
  const objective = buildFutureGoalObjective({
    manifest_bytes: manifestBytes,
    amendment_bytes: amendmentBytes,
    goal_bytes: goalBytes,
    goal_id: 'G12',
  });

  assert.match(objective, new RegExp(goalPath.replaceAll('/', '\\/'), 'u'));
  assert.match(objective, new RegExp(goalSha256, 'u'));
  assert.match(objective, /goals\/amendments\/2026-08-09-ai-speech-action-program-amendment-v1\.json/u);
  assert.match(objective, new RegExp(AMENDMENT_SHA256, 'u'));
  assert.match(objective, /Build five-mode SpeechModePolicy/u);
});

test('all clause identities are unique, target-scoped and keep external claims not_run', () => {
  const amendment = readJson(amendmentPath);
  const ids = new Set();

  for (const target of amendment.target_goal_clauses) {
    assert.ok(EXPECTED_TARGETS.has(target.goal_id));
    for (const clause of target.clauses) {
      assert.match(clause.id, new RegExp(`^${target.goal_id}-A[0-9]{2}$`, 'u'));
      assert.equal(ids.has(clause.id), false, `duplicate clause ${clause.id}`);
      ids.add(clause.id);
      assert.notEqual(clause.evidence_status, 'passed');
    }
  }
  assert.equal(amendment.source_review.upstream_claim_status, 'not_run');
  assert.ok(amendment.global_invariants.includes('upstream_claims_never_become_converact_evidence'));
  assert.ok(amendment.global_invariants.includes('G03_through_G08_scope_and_execution_unchanged'));
  assert.ok(amendment.global_invariants.includes('interaction_path_changes_require_a_new_fenced_generation'));
  assert.ok(amendment.global_invariants.includes('perception_observations_never_become_business_facts_without_confirmation'));
  for (const [goalId, clauseIds] of EXPECTED_SUPPLEMENTAL_CLAUSES) {
    const target = amendment.target_goal_clauses.find((candidate) => candidate.goal_id === goalId);
    for (const clauseId of clauseIds) {
      assert.ok(target.clauses.some((clause) => clause.id === clauseId), `missing ${clauseId}`);
    }
  }
});

test('schema rejects semantic, target and authority drift', () => {
  const schema = readJson(schemaPath);
  const amendment = readJson(amendmentPath);
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const rejects = (mutate) => {
    const candidate = structuredClone(amendment);
    mutate(candidate);
    assert.equal(validate(candidate), false, 'schema accepted binding drift');
  };

  rejects((candidate) => {
    candidate.scope.does_not_change = candidate.scope.does_not_change.filter(
      (item) => item !== 'domain_authorities',
    );
  });
  rejects((candidate) => {
    candidate.frozen_inputs.targets.push(structuredClone(candidate.frozen_inputs.targets[0]));
  });
  rejects((candidate) => {
    [candidate.target_goal_clauses[0], candidate.target_goal_clauses[1]] =
      [candidate.target_goal_clauses[1], candidate.target_goal_clauses[0]];
  });
  rejects((candidate) => {
    candidate.target_goal_clauses[0].clauses[0].id = 'G16-A99';
  });
  rejects((candidate) => {
    candidate.target_goal_clauses[3].clauses[0].text =
      'MCP owns ActionIntent, Authorization, Ledger and external effect truth.';
  });
});

test('resolver rejects frozen-input drift, undeclared goals and authority weakening', () => {
  const manifestBytes = readFileSync(manifestPath);
  const amendmentBytes = readFileSync(amendmentPath);
  const amendment = JSON.parse(amendmentBytes.toString('utf8'));
  const g10Bytes = readFileSync(join(repositoryRoot, EXPECTED_TARGETS.get('G10')[0]));
  const g12Bytes = readFileSync(join(repositoryRoot, EXPECTED_TARGETS.get('G12')[0]));
  const g03Bytes = readFileSync(join(repositoryRoot, 'goals/goal-03-sip-call-durable-foundation.md'));
  const driftedManifest = Buffer.from(manifestBytes.toString('utf8').replace(
    'HF SpeechRuntime Core、VAD 资格与 Resolve B1 翻译',
    'Forged Speech Goal',
  ));

  assert.throws(
    () => resolveFutureGoal({ manifest_bytes: driftedManifest, amendment_bytes: amendmentBytes, goal_bytes: g12Bytes, goal_id: 'G12' }),
    /future_goal_amendment_invalid/u,
  );
  assert.throws(
    () => resolveFutureGoal({ manifest_bytes: manifestBytes, amendment_bytes: amendmentBytes, goal_bytes: g03Bytes, goal_id: 'G03' }),
    /future_goal_amendment_invalid/u,
  );
  assert.throws(
    () => resolveFutureGoal({ manifest_bytes: manifestBytes, amendment_bytes: amendmentBytes, goal_id: 'G10' }),
    /future_goal_amendment_invalid/u,
  );
  const driftedGoal = Buffer.from(g10Bytes);
  driftedGoal[driftedGoal.byteLength - 1] ^= 1;
  assert.throws(
    () => resolveFutureGoal({
      manifest_bytes: manifestBytes,
      amendment_bytes: amendmentBytes,
      goal_bytes: driftedGoal,
      goal_id: 'G10',
    }),
    /future_goal_amendment_invalid/u,
  );

  const hashDrift = structuredClone(amendment);
  hashDrift.frozen_inputs.targets[0].sha256 = '0'.repeat(64);
  assert.throws(
    () => resolveFutureGoal({
      manifest_bytes: manifestBytes,
      amendment_bytes: Buffer.from(JSON.stringify(hashDrift)),
      goal_bytes: g10Bytes,
      goal_id: 'G10',
    }),
    /future_goal_amendment_invalid/u,
  );

  const authorityDrift = structuredClone(amendment);
  authorityDrift.scope.does_not_change = authorityDrift.scope.does_not_change.filter(
    (item) => item !== 'domain_authorities',
  );
  assert.throws(
    () => resolveFutureGoal({
      manifest_bytes: manifestBytes,
      amendment_bytes: Buffer.from(JSON.stringify(authorityDrift)),
      goal_bytes: readFileSync(join(repositoryRoot, EXPECTED_TARGETS.get('G14')[0])),
      goal_id: 'G14',
    }),
    /future_goal_amendment_invalid/u,
  );
});
