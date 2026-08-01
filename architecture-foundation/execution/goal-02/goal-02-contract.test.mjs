import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

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

test('required design, threat, recovery, mapping, plan and review artifacts exist', () => {
  for (const path of requiredMarkdown) {
    assert.ok(existsSync(join(goalDirectory, path)), `missing required artifact: ${path}`);
    const text = readFileSync(join(goalDirectory, path), 'utf8');
    assert.doesNotMatch(text, /\b(?:TBD|TODO|FIXME)\b/u, `${path} contains a placeholder`);
  }
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
      assert.deepEqual(entry.evidence_uris, [
        'architecture-foundation/execution/goal-02/evidence/local-verification-2026-08-02.md',
      ]);
      assert.match(entry.non_claim, /does not prove controlled or production behavior/i);
    } else if (entry.evidence_class !== 'document_contract') {
      assert.equal(entry.status, 'not_run');
    }
  }
  assert.equal(evidence.summary.production_eligible_entries, 0);
  assert.equal(evidence.summary.verified_local_entries, verifiedLocal.size);
  assert.ok(evidence.entries.some((entry) => entry.evidence_class === 'real_dependency'));
  assert.ok(evidence.entries.some((entry) => entry.evidence_class === 'long_media_fault'));
  assert.ok(evidence.entries.some((entry) => entry.evidence_class === 'region_recovery'));
});
