import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import {
  buildBackupRestoreEvidence,
  buildDrainEvidence,
} from '../../../services/converact-service/acceptance/platform-fault-matrix/campaign-evidence.mjs';

const goalDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(resolve(goalDirectory, '../../..'));
const goalPath = 'goals/goal-02-platform-foundation-security-observability.md';
const goalSha = '742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9';

const documents = {
  identity: ['identity-consent-policy-v1.schema.json', 'identity-consent-policy-v1.json'],
  event: ['event-audit-billing-contract-v1.schema.json', 'event-audit-billing-contract-v1.json'],
  observability: ['observability-correlation-contract-v1.schema.json', 'observability-correlation-contract-v1.json'],
  fault: ['fault-matrix-v1.schema.json', 'fault-matrix-v1.json'],
  evidence: ['evidence-index-v1.schema.json', 'evidence-index-v1.json'],
  trace: ['traceability-v1.schema.json', 'traceability-v1.json'],
};

const requiredMarkdown = [
  'platform-foundation-design.md',
  'platform-authority-and-data-classification.md',
  'threat-model.md',
  'recovery-drain-and-dr-plan.md',
  'source-test-path-map.md',
  '2026-07-31-goal-02-platform-foundation-tdd-plan.md',
  'independent-review.md',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function compile(schemaName) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(readJson(join(goalDirectory, schemaName)));
}

function assertInvalid(validate, value, label) {
  assert.equal(validate(value), false, `${label} must be rejected`);
  assert.ok(validate.errors?.length, `${label} must return schema errors`);
}

test('G02 binding and prerequisites are immutable', () => {
  assert.equal(sha256File(join(repositoryRoot, goalPath)), goalSha);
  for (const commit of [
    'c10a3a2c636fa0f62f8108a113a729138e367929',
    '051ad988edcc204fbd716f6ea73ce92ec08ab4b2',
  ]) {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
  }
});

test('all required machine contracts validate and reject drift', () => {
  for (const [name, [schemaName, documentName]] of Object.entries(documents)) {
    const validate = compile(schemaName);
    const document = readJson(join(goalDirectory, documentName));
    assert.equal(
      validate(document),
      true,
      `${name} must validate: ${JSON.stringify(validate.errors)}`,
    );
    assertInvalid(validate, { ...document, undeclared_field: true }, `${name} unknown field`);
    const { contract_id: _removed, ...missingId } = document;
    assertInvalid(validate, missingId, `${name} missing contract_id`);
  }
});

test('machine schemas freeze authority and media hot-path semantics', () => {
  const mutations = [
    ['identity', ['identity', 'authority'], 'Other Identity Authority'],
    ['identity', ['consent', 'authority'], 'Other Consent Authority'],
    ['identity', ['key_lifecycle', 'authority'], 'Other Key Authority'],
    ['event', ['event', 'authority'], 'Other Event Authority'],
    ['event', ['audit', 'authority'], 'Other Audit Authority'],
    ['event', ['billing', 'authority'], 'Other Billing Authority'],
    ['event', ['outbox', 'media_hot_path'], 'allowed'],
    ['observability', ['media_hot_path', 'global_lock'], 'allowed'],
    ['observability', ['media_hot_path', 'task_per_packet'], 'allowed'],
  ];
  for (const [name, path, replacement] of mutations) {
    const [schemaName, documentName] = documents[name];
    const validate = compile(schemaName);
    const mutated = structuredClone(readJson(join(goalDirectory, documentName)));
    let target = mutated;
    for (const segment of path.slice(0, -1)) target = target[segment];
    target[path.at(-1)] = replacement;
    assertInvalid(validate, mutated, `${name} ${path.join('.')}`);
  }
});

test('required design, threat, recovery, mapping, plan and review artifacts exist', () => {
  for (const path of requiredMarkdown) {
    assert.ok(existsSync(join(goalDirectory, path)), `missing required artifact: ${path}`);
    const text = readFileSync(join(goalDirectory, path), 'utf8');
    assert.doesNotMatch(text, /\b(?:TBD|TODO|FIXME)\b/u, `${path} contains a placeholder`);
  }
});

test('final independent review is accepted only with explicit external evidence blockers', () => {
  const reviewUri = 'architecture-foundation/execution/goal-02/independent-review.md';
  const review = readFileSync(join(repositoryRoot, reviewUri), 'utf8');
  assert.match(review, /Review status: `accepted_with_external_evidence_blockers`/);
  assert.match(review, /Reviewer task: `\/root\/g02_final_independent_review`/);
  assert.match(review, /Reviewed commit: `c920d7a59e02daba38118491217630fef94ce393`/);
  assert.match(review, /Binary diff SHA-256: `341e2bbb844e3bbf705c1f6e6faec670a258434a1d489de2dd2fc0d8a2781cae`/);
  assert.match(review, /Latest incremental reviewed commit: `1efcfc553602a29b17abc5565505645385ff3529`/);
  assert.match(review, /Latest accepted capacity run: `capacity-b263a55-01`/);
  assert.match(review, /Latest accepted restore run: `restore-a517cf3-01`/);
  assert.match(review, /Latest accepted drain run: `drain-1efcfc5-04`/);
  assert.match(review, /Critical: `0`/);
  assert.match(review, /High: `0`/);
  assert.match(review, /Important: `0`/);
  assert.match(review, /Minor: `0`/);
  assert.match(review, /Production eligibility: `false`/);
  assert.match(review, /2,000,000 immediate decisions/);
  assert.match(review, /Important 0 \/ Minor 0/);
  assert.match(review, /monotonic RTO 5,777 ms/);
  assert.match(review, /superseded_rejected_wall_clock_rto/);

  const evidence = readJson(join(goalDirectory, documents.evidence[1]));
  const reviewEntry = evidence.entries.find((entry) => entry.evidence_id === 'G02-E16-REVIEW');
  assert.equal(reviewEntry?.status, 'verified_local');
  assert.deepEqual(reviewEntry?.evidence_uris, [reviewUri]);
  assert.equal(reviewEntry?.production_eligible, false);

  const capacityEntry = evidence.entries.find((entry) => entry.evidence_id === 'G02-E13-CAPACITY');
  assert.equal(capacityEntry?.status, 'verified_controlled');
  assert.deepEqual(capacityEntry?.evidence_uris, [
    'architecture-foundation/execution/goal-02/evidence/capacity-b263a55-01.md',
    'architecture-foundation/execution/goal-02/evidence/raw/capacity-b263a55-01/raw-output.sha256',
    'architecture-foundation/execution/goal-02/evidence/raw/capacity-b263a55-01/supplemental-manifest.sha256',
  ]);
  assert.equal(capacityEntry?.production_eligible, false);

  const restoreEntry = evidence.entries.find((entry) => entry.evidence_id === 'G02-E10-RESTORE');
  assert.equal(restoreEntry?.status, 'verified_controlled');
  assert.deepEqual(restoreEntry?.evidence_uris, [
    'architecture-foundation/execution/goal-02/evidence/restore-a517cf3-01.md',
    'architecture-foundation/execution/goal-02/evidence/raw/restore-a517cf3-01/raw-output.sha256',
    'architecture-foundation/execution/goal-02/evidence/raw/restore-a517cf3-01/supplemental-manifest.sha256',
  ]);
  assert.equal(restoreEntry?.production_eligible, false);

  const remainingNotRun = new Set([
    'G02-E09-DEPENDENCY',
    'G02-E12-LONG-MEDIA',
    'G02-E14-REGION',
    'G02-E15-NATIVE',
  ]);
  assert.deepEqual(
    new Set(evidence.entries.filter((entry) => entry.status === 'not_run').map((entry) => entry.evidence_id)),
    remainingNotRun,
  );
  const manifest = readJson(join(repositoryRoot, 'goals/manifest.json'));
  assert.equal(manifest.goals.find((goal) => goal.id === 'G02')?.status, 'blocked_external');
});

test('identity and consent contract is fail closed and separates every capability', () => {
  const contract = readJson(join(goalDirectory, documents.identity[1]));
  assert.deepEqual(contract.identity.kinds, ['human', 'service', 'workload', 'edge', 'provider']);
  assert.ok(contract.identity.required_claims.includes('audience'));
  assert.ok(contract.identity.required_claims.includes('token_id'));
  assert.equal(contract.identity.production_dev_fallback, 'forbidden');
  assert.equal(contract.authorization.default_decision, 'deny');
  assert.deepEqual(
    contract.consent.scopes.map((scope) => scope.scope),
    [
      'phone_audio', 'video', 'recording', 'transcription', 'translation',
      'ai_processing', 'tool_action', 'remote_control',
    ],
  );
  assert.equal(contract.consent.lease.expiry_behavior, 'detach_capability_keep_human_media');
  assert.ok(contract.invariants.includes('cross_tenant_unknown_or_mismatch_denies'));
  assert.equal(contract.status.production_eligible, false);
});

test('event, receipt and billing contract preserves idempotency and one writer', () => {
  const contract = readJson(join(goalDirectory, documents.event[1]));
  assert.equal(contract.event.write_version, 2);
  assert.deepEqual(contract.event.read_versions, [2, 1]);
  assert.equal(contract.event.unknown_major, 'quarantine_fail_closed');
  assert.equal(contract.inbox.same_id_different_digest, 'conflict');
  assert.deepEqual(contract.effect_receipt.stages, ['accepted', 'completed', 'state_observed']);
  assert.equal(contract.effect_receipt.unknown_effect, 'query_reconcile_no_blind_retry');
  assert.deepEqual(
    contract.billing.sources.map((source) => source.source),
    ['directed_media_edge_generation', 'ai_run_generation', 'recording_segment', 'external_action_attempt'],
  );
  assert.equal(contract.billing.writer_policy, 'one_writer_identity_and_epoch_per_billing_key');
  assert.equal(contract.status.production_eligible, false);
});

test('observability contract excludes high-cardinality IDs and media hot path', () => {
  const contract = readJson(join(goalDirectory, documents.observability[1]));
  assert.equal(contract.media_hot_path.external_io_per_packet, 0);
  assert.equal(contract.media_hot_path.observability_dependency, 'forbidden');
  for (const id of ['tenant_id', 'profile_type', 'call_id', 'room_id', 'engagement_id']) {
    assert.ok(contract.metrics.prohibited_unbounded_labels.includes(id));
  }
  assert.equal(contract.exporter.failure_behavior, 'drop_bounded_telemetry_never_backpressure_media');
  assert.equal(contract.status.production_eligible, false);
});

test('fault matrix covers every dependency and keeps established human media causal isolation explicit', () => {
  const contract = readJson(join(goalDirectory, documents.fault[1]));
  const expected = [
    'database', 'event_system', 'object_store', 'pki_kms', 'dns', 'configuration',
    'wall_clock', 'ai_gpu', 'recording_upload', 'provider', 'observability', 'node_crash',
  ];
  assert.deepEqual(contract.dependencies.map((entry) => entry.dependency), expected);
  for (const entry of contract.dependencies) {
    assert.ok(
      ['continue', 'continue_if_external_edge_owner'].includes(entry.established_human_media),
      `${entry.dependency} may not claim causal call termination`,
    );
    assert.equal(entry.evidence.status, 'not_run');
    assert.equal(entry.evidence.production_eligible, false);
  }
  assert.equal(contract.status.production_eligible, false);
});

test('G00 to G02 traceability preserves every source row exactly once without evidence promotion', () => {
  const g00 = readJson(join(
    repositoryRoot,
    'architecture-foundation/execution/goal-00/requirement-traceability-v1.json',
  ));
  const expected = g00.requirements.filter((row) => row.target_goals.includes('G02'));
  const trace = readJson(join(goalDirectory, documents.trace[1]));
  assert.equal(trace.rows.length, 543);
  assert.equal(trace.rows.length, expected.length);
  assert.equal(new Set(trace.rows.map((row) => row.requirement_id)).size, trace.rows.length);
  const expectedById = new Map(expected.map((row) => [row.requirement_id, row]));
  for (const row of trace.rows) {
    const source = expectedById.get(row.requirement_id);
    assert.ok(source, `unexpected trace row: ${row.requirement_id}`);
    assert.equal(row.source_id, source.source_id);
    assert.equal(row.source_path, source.source_path);
    assert.equal(row.source_pointer, source.source_pointer);
    assert.equal(row.source_evidence_status, source.evidence_status);
    assert.equal(row.status, 'not_run');
    assert.equal(row.production_eligible, false);
    assert.ok(row.test_paths.length > 0);
  }
  assert.equal(trace.summary.source_rows, 543);
  assert.equal(trace.summary.unmapped_rows, 0);
  assert.equal(trace.summary.production_eligible_rows, 0);
});

test('evidence registry never promotes historical or unexecuted acceptance', () => {
  const evidence = readJson(join(goalDirectory, documents.evidence[1]));
  const controlledDatabaseEvidence =
    'architecture-foundation/execution/goal-02/evidence/database-restart-db-4f9ea6f-01.md';
  const controlledDatabaseRawManifest =
    'architecture-foundation/execution/goal-02/evidence/raw/database-restart-db-4f9ea6f-01/raw-output.sha256';
  const controlledDatabaseSupplementalManifest =
    'architecture-foundation/execution/goal-02/evidence/raw/database-restart-db-4f9ea6f-01/supplemental-manifest.sha256';
  const controlledCapacityEvidence =
    'architecture-foundation/execution/goal-02/evidence/capacity-b263a55-01.md';
  const controlledCapacityRawManifest =
    'architecture-foundation/execution/goal-02/evidence/raw/capacity-b263a55-01/raw-output.sha256';
  const controlledCapacitySupplementalManifest =
    'architecture-foundation/execution/goal-02/evidence/raw/capacity-b263a55-01/supplemental-manifest.sha256';
  const controlledRestoreEvidence =
    'architecture-foundation/execution/goal-02/evidence/restore-a517cf3-01.md';
  const controlledRestoreRawManifest =
    'architecture-foundation/execution/goal-02/evidence/raw/restore-a517cf3-01/raw-output.sha256';
  const controlledRestoreSupplementalManifest =
    'architecture-foundation/execution/goal-02/evidence/raw/restore-a517cf3-01/supplemental-manifest.sha256';
  const controlledDrainEvidence =
    'architecture-foundation/execution/goal-02/evidence/drain-1efcfc5-04.md';
  const controlledDrainRawManifest =
    'architecture-foundation/execution/goal-02/evidence/raw/drain-1efcfc5-04/raw-output.sha256';
  const controlledDrainSupplementalManifest =
    'architecture-foundation/execution/goal-02/evidence/raw/drain-1efcfc5-04/supplemental-manifest.sha256';
  const controlledDrainPostTransferManifest =
    'architecture-foundation/execution/goal-02/evidence/raw/drain-1efcfc5-04/post-transfer-secret-scan.sha256';
  const rejectedRestoreEvidence =
    'architecture-foundation/execution/goal-02/evidence/restore-7a46401-01.md';
  const rejectedRestoreRawManifest =
    'architecture-foundation/execution/goal-02/evidence/raw/restore-7a46401-01/raw-output.sha256';
  const rejectedRestoreSupplementalManifest =
    'architecture-foundation/execution/goal-02/evidence/raw/restore-7a46401-01/supplemental-manifest.sha256';
  const localEvidence =
    'architecture-foundation/execution/goal-02/evidence/local-verification-2026-08-02-final-source.md';
  const localRawManifest =
    'architecture-foundation/execution/goal-02/evidence/raw/local-verification-4f9ea6f/part-manifest.sha256';
  const supersededDatabaseEvidence =
    'architecture-foundation/execution/goal-02/evidence/database-restart-db-4fc7b59-01.md';
  const verifiedLocal = new Set([
    'G02-E01-IDENTITY',
    'G02-E02-CONSENT',
    'G02-E03-EVENT',
    'G02-E04-RECEIPT',
    'G02-E05-BILLING',
    'G02-E06-KEY',
    'G02-E07-OBSERVABILITY',
    'G02-E08-CLOCK',
  ]);
  for (const entry of evidence.entries) {
    assert.equal(entry.production_eligible, false);
    if (verifiedLocal.has(entry.evidence_id)) {
      assert.equal(entry.status, 'verified_local');
      assert.deepEqual(entry.evidence_uris, [localEvidence, localRawManifest]);
      assert.match(entry.non_claim, /does not prove controlled or production behavior/i);
    } else if (entry.evidence_id === 'G02-E09A-DATABASE-RESTART') {
      assert.equal(entry.status, 'verified_controlled');
      assert.deepEqual(entry.evidence_uris, [
        controlledDatabaseEvidence,
        controlledDatabaseRawManifest,
        controlledDatabaseSupplementalManifest,
      ]);
      assert.match(entry.non_claim, /synthetic.*not.*real human media/is);
    } else if (entry.evidence_id === 'G02-E13-CAPACITY') {
      assert.equal(entry.status, 'verified_controlled');
      assert.deepEqual(entry.evidence_uris, [
        controlledCapacityEvidence,
        controlledCapacityRawManifest,
        controlledCapacitySupplementalManifest,
      ]);
      assert.match(entry.non_claim, /control-plane.*does not prove media/is);
    } else if (entry.evidence_id === 'G02-E10-RESTORE') {
      assert.equal(entry.status, 'verified_controlled');
      assert.deepEqual(entry.evidence_uris, [
        controlledRestoreEvidence,
        controlledRestoreRawManifest,
        controlledRestoreSupplementalManifest,
      ]);
      assert.match(entry.non_claim, /frozen-checkpoint.*does not prove continuous-write PITR/is);
    } else if (entry.evidence_id === 'G02-E11-DRAIN') {
      assert.equal(entry.status, 'verified_controlled');
      assert.deepEqual(entry.evidence_uris, [
        controlledDrainEvidence,
        controlledDrainRawManifest,
        controlledDrainSupplementalManifest,
        controlledDrainPostTransferManifest,
      ]);
      assert.match(entry.non_claim, /self-generated.*does not prove.*SIP.*media/is);
    } else if (entry.evidence_id === 'G02-E16-REVIEW') {
      assert.equal(entry.status, 'verified_local');
      assert.deepEqual(entry.evidence_uris, [
        'architecture-foundation/execution/goal-02/independent-review.md',
      ]);
      assert.match(entry.non_claim, /external.*production.*unproved/is);
    } else if (entry.evidence_class !== 'document_contract') {
      assert.equal(entry.status, 'not_run');
    }
  }
  assert.equal(
    evidence.entries.find((entry) => entry.evidence_id === 'G02-E09-DEPENDENCY')?.status,
    'not_run',
  );
  assert.equal(evidence.summary.production_eligible_entries, 0);
  assert.equal(evidence.summary.verified_local_entries, verifiedLocal.size + 1);
  assert.equal(evidence.summary.verified_controlled_entries, 4);
  const localVerificationRecord = readFileSync(
    join(repositoryRoot, localEvidence),
    'utf8',
  );
  assert.match(localVerificationRecord, /4f9ea6f94a8e0740975c801aff5a6a180124a62b/);
  assert.match(localVerificationRecord, /4,911 tests; 4,896 passed; 0 failed; 15 skipped/);
  assert.match(localVerificationRecord, /ffc569ed594e55af67c5a5e4e7b14d01fceedc9bc3e51f753ba9c442ece3100c/);
  assert.match(localVerificationRecord, /database-restart-db-4f9ea6f-01\.md/);
  const localRawEntries = readFileSync(join(repositoryRoot, localRawManifest), 'utf8').trim().split('\n');
  assert.equal(localRawEntries.length, 4);
  for (const line of localRawEntries) {
    const match = /^([a-f0-9]{64})  (full-suite\.log\.xz\.b64\.part-[0-9]{2})$/u.exec(line);
    assert.ok(match, `invalid full-suite evidence manifest entry: ${line}`);
    const rawPath = join(dirname(join(repositoryRoot, localRawManifest)), match[2]);
    assert.equal(sha256File(rawPath), match[1], `full-suite evidence digest mismatch: ${match[2]}`);
  }
  const encodedFullSuite = localRawEntries
    .map((line) => line.split('  ')[1])
    .map((name) => readFileSync(join(dirname(join(repositoryRoot, localRawManifest)), name), 'utf8'))
    .join('')
    .replace(/\s/gu, '');
  assert.equal(
    createHash('sha256').update(Buffer.from(encodedFullSuite, 'base64')).digest('hex'),
    '3bf89d55eaec390fbbd21013b3680e89a42b5fd617989533076381982ca91a5d',
  );
  const controlledDatabaseRecord = readFileSync(
    join(repositoryRoot, controlledDatabaseEvidence),
    'utf8',
  );
  assert.match(controlledDatabaseRecord, /4f9ea6f94a8e0740975c801aff5a6a180124a62b/);
  assert.match(controlledDatabaseRecord, /c095c7a7c026cfd0b87e432f2037ccd6414368431dc607d652716f856442ea98/);
  assert.match(controlledDatabaseRecord, /383719938e86665993cb9d42fe27c7eb259f91408ff4b2119e600a28bcd57384/);
  assert.match(controlledDatabaseRecord, /migration_head.*112_converact_platform_history_receipt_integrity/is);
  assert.match(controlledDatabaseRecord, /completed receipt.*usage/is);
  assert.match(controlledDatabaseRecord, /production_eligible.*false/is);
  assert.match(controlledDatabaseRecord, /real_human_media.*false/is);
  const rawManifest = readFileSync(join(repositoryRoot, controlledDatabaseRawManifest), 'utf8');
  const rawEntries = rawManifest.trim().split('\n');
  assert.equal(rawEntries.length, 21);
  for (const line of rawEntries) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u.exec(line);
    assert.ok(match, `invalid raw evidence manifest entry: ${line}`);
    const rawPath = join(dirname(join(repositoryRoot, controlledDatabaseRawManifest)), match[2]);
    assert.equal(sha256File(rawPath), match[1], `raw evidence digest mismatch: ${match[2]}`);
  }
  const supplementalEntries = readFileSync(
    join(repositoryRoot, controlledDatabaseSupplementalManifest),
    'utf8',
  ).trim().split('\n');
  assert.equal(supplementalEntries.length, 2);
  for (const line of supplementalEntries) {
    const match = /^([a-f0-9]{64})  (database-controlled-evidence\.json|evidence-identity\.json)$/u.exec(line);
    assert.ok(match, `invalid supplemental evidence manifest entry: ${line}`);
    const rawPath = join(dirname(join(repositoryRoot, controlledDatabaseSupplementalManifest)), match[2]);
    assert.equal(sha256File(rawPath), match[1], `supplemental evidence digest mismatch: ${match[2]}`);
  }
  const controlledResult = readJson(join(
    dirname(join(repositoryRoot, controlledDatabaseSupplementalManifest)),
    'database-controlled-evidence.json',
  ));
  assert.equal(controlledResult.status, 'verified_controlled');
  assert.equal(controlledResult.production_eligible, false);
  assert.equal(controlledResult.real_human_media, false);
  assert.equal(controlledResult.evidence.identity.source_commit, '4f9ea6f94a8e0740975c801aff5a6a180124a62b');
  assert.equal(controlledResult.evidence.checks.every((check) => check.passed === true), true);
  const controlledCapacityRecord = readFileSync(
    join(repositoryRoot, controlledCapacityEvidence),
    'utf8',
  );
  assert.match(controlledCapacityRecord, /b263a55a975704f852b53a3da6eaba711307b07b/);
  assert.match(controlledCapacityRecord, /0afc449f460f015d0e6d9e952af2aefbb31882eaebe83743ed9cfa1ddbe0b826/);
  assert.match(controlledCapacityRecord, /production_eligible.*false/is);
  assert.match(controlledCapacityRecord, /not SIP, RTP, media/is);
  const capacityRawEntries = readFileSync(
    join(repositoryRoot, controlledCapacityRawManifest),
    'utf8',
  ).trim().split('\n');
  assert.equal(capacityRawEntries.length, 4);
  for (const line of capacityRawEntries) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u.exec(line);
    assert.ok(match, `invalid capacity raw evidence manifest entry: ${line}`);
    assert.equal(
      sha256File(join(dirname(join(repositoryRoot, controlledCapacityRawManifest)), match[2])),
      match[1],
      `capacity raw evidence digest mismatch: ${match[2]}`,
    );
  }
  const capacitySupplementalEntries = readFileSync(
    join(repositoryRoot, controlledCapacitySupplementalManifest),
    'utf8',
  ).trim().split('\n');
  assert.equal(capacitySupplementalEntries.length, 8);
  for (const line of capacitySupplementalEntries) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u.exec(line);
    assert.ok(match, `invalid capacity supplemental manifest entry: ${line}`);
    assert.equal(
      sha256File(join(dirname(join(repositoryRoot, controlledCapacitySupplementalManifest)), match[2])),
      match[1],
      `capacity supplemental evidence digest mismatch: ${match[2]}`,
    );
  }
  const capacityResult = readJson(join(
    dirname(join(repositoryRoot, controlledCapacitySupplementalManifest)),
    'capacity-controlled-evidence.json',
  ));
  assert.equal(capacityResult.status, 'verified_controlled');
  assert.equal(capacityResult.production_eligible, false);
  assert.equal(capacityResult.evidence.identity.source_commit, 'b263a55a975704f852b53a3da6eaba711307b07b');
  assert.equal(capacityResult.evidence.operations, 2_000_000);
  assert.equal(capacityResult.evidence.accepted, 1_400_000);
  assert.equal(capacityResult.evidence.overloaded, 600_000);
  assert.equal(capacityResult.evidence.rejected_overloaded, 400_000);
  assert.equal(capacityResult.evidence.rejected_retry_exhausted, 100_000);
  assert.equal(capacityResult.evidence.rejected_fanout_exceeded, 100_000);
  assert.equal(capacityResult.evidence.observed_max_active, 64);
  assert.equal(capacityResult.evidence.observed_max_pending, 256);
  assert.equal(capacityResult.evidence.observed_max_retry, 3);
  assert.equal(capacityResult.evidence.observed_max_fanout, 8);
  assert.equal(capacityResult.evidence.attempted_max_retry, 4);
  assert.equal(capacityResult.evidence.attempted_max_fanout, 9);
  assert.equal(capacityResult.evidence.configured_retained_lease_limit, 320);
  assert.equal(capacityResult.evidence.observed_max_retained_leases, 320);
  assert.equal(capacityResult.evidence.queued_requests_at_completion, 0);
  assert.equal(capacityResult.evidence.policy_rejections_preserved_admission_counters, true);
  assert.equal(capacityResult.evidence.counter_integrity, true);
  const rejectedCapacityRecord = readFileSync(join(
    repositoryRoot,
    'architecture-foundation/execution/goal-02/evidence/capacity-b5c500d-01.md',
  ), 'utf8');
  assert.match(rejectedCapacityRecord, /superseded_rejected/);
  assert.match(rejectedCapacityRecord, /not accepted evidence/i);
  const controlledRestoreRecord = readFileSync(
    join(repositoryRoot, controlledRestoreEvidence),
    'utf8',
  );
  assert.match(controlledRestoreRecord, /a517cf368bc25417c0f51870091e3306592b6fc4/);
  assert.match(controlledRestoreRecord, /b742d246dfdbcd1ee0765f9179d0d474583cfca2404773072f0a0feaf66a2f3a/);
  assert.match(controlledRestoreRecord, /Measured RPO.*0 ms/is);
  assert.match(controlledRestoreRecord, /Measured monotonic RTO.*5,777 ms/is);
  const restoreRawEntries = readFileSync(
    join(repositoryRoot, controlledRestoreRawManifest),
    'utf8',
  ).trim().split('\n');
  assert.equal(restoreRawEntries.length, 23);
  for (const line of restoreRawEntries) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u.exec(line);
    assert.ok(match, `invalid restore raw evidence manifest entry: ${line}`);
    assert.equal(
      sha256File(join(dirname(join(repositoryRoot, controlledRestoreRawManifest)), match[2])),
      match[1],
      `restore raw evidence digest mismatch: ${match[2]}`,
    );
  }
  const restoreSupplementalEntries = readFileSync(
    join(repositoryRoot, controlledRestoreSupplementalManifest),
    'utf8',
  ).trim().split('\n');
  assert.equal(restoreSupplementalEntries.length, 27);
  for (const line of restoreSupplementalEntries) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u.exec(line);
    assert.ok(match, `invalid restore supplemental manifest entry: ${line}`);
    assert.equal(
      sha256File(join(dirname(join(repositoryRoot, controlledRestoreSupplementalManifest)), match[2])),
      match[1],
      `restore supplemental evidence digest mismatch: ${match[2]}`,
    );
  }
  const restoreResult = readJson(join(
    dirname(join(repositoryRoot, controlledRestoreSupplementalManifest)),
    'restore-controlled-evidence.json',
  ));
  assert.equal(restoreResult.status, 'verified_controlled');
  assert.equal(restoreResult.production_eligible, false);
  assert.equal(restoreResult.evidence.identity.source_commit, 'a517cf368bc25417c0f51870091e3306592b6fc4');
  assert.equal(restoreResult.measured_rpo_ms, 0);
  assert.equal(restoreResult.measured_rto_ms, 5_777);
  assert.notEqual(
    restoreResult.evidence.backup.source_database_id,
    restoreResult.evidence.restore.target_database_id,
  );
  assert.notEqual(
    restoreResult.evidence.backup.process_pid,
    restoreResult.evidence.restore.restore_process_pid,
  );
  assert.notEqual(
    restoreResult.evidence.restore.restore_process_pid,
    restoreResult.evidence.restore.fresh_process_pid,
  );
  assert.equal(restoreResult.evidence.backup.backup_id, restoreResult.evidence.restore.backup_id);
  assert.equal(restoreResult.evidence.restore.rto_clock_domain, 'monotonic');
  assert.equal(
    restoreResult.evidence.restore.rto_measurement_scope,
    'restore_runtime_role_fresh_process_verify',
  );
  assert.equal(restoreResult.evidence.backup.checkpoint_records, 6);
  assert.equal(restoreResult.evidence.restore.restored_records, 6);
  assert.equal(restoreResult.evidence.restore.target_was_empty, true);
  assert.equal(restoreResult.evidence.restore.runtime_rls_verified, true);
  assert.equal(restoreResult.evidence.restore.append_only_verified, true);
  assert.equal(restoreResult.evidence.restore.validation_resources_remaining, 0);
  assert.equal(buildBackupRestoreEvidence({
    identity: restoreResult.evidence.identity,
    backup: restoreResult.evidence.backup,
    restore: restoreResult.evidence.restore,
  }).status, 'verified_controlled');
  const controlledDrainRecord = readFileSync(
    join(repositoryRoot, controlledDrainEvidence),
    'utf8',
  );
  assert.match(controlledDrainRecord, /1efcfc553602a29b17abc5565505645385ff3529/);
  assert.match(controlledDrainRecord, /a57f05fe9689ad7febc0e5a98ed4b4734f3ccc24f0957cd90beac75a607dee68/);
  assert.match(controlledDrainRecord, /14\/14 Ed25519 signatures/);
  assert.match(controlledDrainRecord, /production_eligible.*false/is);
  assert.match(controlledDrainRecord, /does not prove.*SIP.*media/is);
  const drainRawEntries = readFileSync(
    join(repositoryRoot, controlledDrainRawManifest),
    'utf8',
  ).trim().split('\n');
  assert.equal(drainRawEntries.length, 6);
  for (const line of drainRawEntries) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u.exec(line);
    assert.ok(match, `invalid drain raw manifest entry: ${line}`);
    assert.equal(
      sha256File(join(dirname(join(repositoryRoot, controlledDrainRawManifest)), match[2])),
      match[1],
      `drain raw digest mismatch: ${match[2]}`,
    );
  }
  const drainSupplementalEntries = readFileSync(
    join(repositoryRoot, controlledDrainSupplementalManifest),
    'utf8',
  ).trim().split('\n');
  assert.equal(drainSupplementalEntries.length, 10);
  for (const line of drainSupplementalEntries) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u.exec(line);
    assert.ok(match, `invalid drain supplemental manifest entry: ${line}`);
    assert.equal(
      sha256File(join(dirname(join(repositoryRoot, controlledDrainSupplementalManifest)), match[2])),
      match[1],
      `drain supplemental digest mismatch: ${match[2]}`,
    );
  }
  const drainPostTransferEntries = readFileSync(
    join(repositoryRoot, controlledDrainPostTransferManifest),
    'utf8',
  ).trim().split('\n');
  assert.equal(drainPostTransferEntries.length, 11);
  for (const line of drainPostTransferEntries) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u.exec(line);
    assert.ok(match, `invalid drain post-transfer manifest entry: ${line}`);
    assert.equal(
      sha256File(join(dirname(join(repositoryRoot, controlledDrainPostTransferManifest)), match[2])),
      match[1],
      `drain post-transfer digest mismatch: ${match[2]}`,
    );
  }
  const drainRawDirectory = dirname(join(repositoryRoot, controlledDrainRawManifest));
  const drainResult = readJson(join(drainRawDirectory, 'drain-controlled-evidence.json'));
  const rebuiltDrain = buildDrainEvidence({
    identity: readJson(join(drainRawDirectory, 'evidence-identity.json')),
    raw_manifest: readFileSync(join(drainRawDirectory, 'raw-output.sha256'), 'utf8'),
    raw_artifacts: Object.fromEntries([
      'drain-public-keys.json',
      'drain-receipts.json',
      'drain-result.json',
      'drain-run.log',
      'unrelated-containers-after.tsv',
      'unrelated-containers-before.tsv',
    ].map((name) => [name, readFileSync(join(drainRawDirectory, name), 'utf8')])),
  });
  assert.deepEqual(rebuiltDrain, drainResult);
  assert.equal(drainResult.status, 'verified_controlled');
  assert.equal(drainResult.production_eligible, false);
  assert.equal(drainResult.evidence.identity.source_commit, '1efcfc553602a29b17abc5565505645385ff3529');
  assert.equal(drainResult.evidence.initial_nonzero_receipts.length, 7);
  assert.equal(drainResult.evidence.active_zero_receipts.length, 7);
  assert.equal(drainResult.evidence.initial_nonzero_receipts.find(
    (receipt) => receipt.authority === 'communication_attached_generations',
  )?.active_count, '1');
  assert.equal(drainResult.evidence.active_zero_receipts.every(
    (receipt) => receipt.active_count === '0',
  ), true);
  const rejectedRestoreRecord = readFileSync(
    join(repositoryRoot, rejectedRestoreEvidence),
    'utf8',
  );
  assert.match(rejectedRestoreRecord, /superseded_rejected_wall_clock_rto/);
  assert.match(rejectedRestoreRecord, /not accepted\s+evidence/i);
  const rejectedRestoreRawEntries = readFileSync(
    join(repositoryRoot, rejectedRestoreRawManifest),
    'utf8',
  ).trim().split('\n');
  assert.equal(rejectedRestoreRawEntries.length, 25);
  for (const line of rejectedRestoreRawEntries) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u.exec(line);
    assert.ok(match, `invalid rejected restore raw manifest entry: ${line}`);
    assert.equal(
      sha256File(join(dirname(join(repositoryRoot, rejectedRestoreRawManifest)), match[2])),
      match[1],
      `rejected restore raw digest mismatch: ${match[2]}`,
    );
  }
  const rejectedRestoreSupplementalEntries = readFileSync(
    join(repositoryRoot, rejectedRestoreSupplementalManifest),
    'utf8',
  ).trim().split('\n');
  assert.equal(rejectedRestoreSupplementalEntries.length, 29);
  for (const line of rejectedRestoreSupplementalEntries) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u.exec(line);
    assert.ok(match, `invalid rejected restore supplemental manifest entry: ${line}`);
    assert.equal(
      sha256File(join(dirname(join(repositoryRoot, rejectedRestoreSupplementalManifest)), match[2])),
      match[1],
      `rejected restore supplemental digest mismatch: ${match[2]}`,
    );
  }
  const rejectedRestoreResult = readJson(join(
    dirname(join(repositoryRoot, rejectedRestoreSupplementalManifest)),
    'restore-controlled-evidence.json',
  ));
  assert.equal(buildBackupRestoreEvidence({
    identity: rejectedRestoreResult.evidence.identity,
    backup: rejectedRestoreResult.evidence.backup,
    restore: rejectedRestoreResult.evidence.restore,
  }).status, 'failed');
  const supersededDatabaseRecord = readFileSync(
    join(repositoryRoot, supersededDatabaseEvidence),
    'utf8',
  );
  assert.match(supersededDatabaseRecord, /4fc7b59b57958a2db0077a91c96bd68ac233f255/);
  assert.match(supersededDatabaseRecord, /superseded_invalid_receipt_linkage/);
  assert.match(supersededDatabaseRecord, /production_eligible.*false/is);
  assert.match(supersededDatabaseRecord, /real_human_media.*false/is);
  assert.ok(evidence.entries.some((entry) => entry.evidence_class === 'real_dependency'));
  assert.ok(evidence.entries.some((entry) => entry.evidence_class === 'long_media_fault'));
  assert.ok(evidence.entries.some((entry) => entry.evidence_class === 'region_recovery'));
});
