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
const goalPath = 'goals/goal-03-sip-call-durable-foundation.md';
const goalSha = '05ce7f940782ab0efcd013d413220d068a7d3be1bab981f2c2c4f6a6f2a217af';
const amendmentPath = 'goals/amendments/2026-08-02-g02-g03-gate-split-v1.json';
const amendmentSha = '3f55c9afdc2af68d8a93a5cfe19311cb9aaefb63192c85475d479af98fa2049b';
const manifestPath = 'goals/manifest.json';
const manifestSha = '11b026b5014dc344d4e5b2459aafc0b251190075a212fc68f40dce62fbbda912';

const documents = {
  sip: ['sip-foundation-contract-v1.schema.json', 'sip-foundation-contract-v1.json'],
  call: ['call-leg-state-machine-v1.schema.json', 'call-leg-state-machine-v1.json'],
  effect: ['sip-effect-receipt-contract-v1.schema.json', 'sip-effect-receipt-contract-v1.json'],
  wire: ['wire-freeze-corpus-manifest-v1.schema.json', 'wire-freeze-corpus-manifest-v1.json'],
  evidence: ['evidence-index-v1.schema.json', 'evidence-index-v1.json'],
  trace: ['traceability-v1.schema.json', 'traceability-v1.json'],
};

const requiredMarkdown = [
  'current-state-audit.md',
  'sip-call-foundation-design.md',
  'recovery-clock-drain-contract.md',
  'fault-and-threat-review.md',
  'source-test-path-map.md',
  '2026-07-31-goal-03-sip-call-tdd-plan.md',
  'independent-review.md',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function compile(schemaName) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    formats: { 'date-time': true },
  });
  return ajv.compile(readJson(join(goalDirectory, schemaName)));
}

function assertInvalid(validate, value, label) {
  assert.equal(validate(value), false, `${label} must be rejected`);
  assert.ok(validate.errors?.length, `${label} must expose schema errors`);
}

test('G03 binding, manifest and gate-only amendment are immutable', () => {
  assert.equal(sha256File(join(repositoryRoot, goalPath)), goalSha);
  assert.equal(sha256File(join(repositoryRoot, amendmentPath)), amendmentSha);
  assert.equal(sha256File(join(repositoryRoot, manifestPath)), manifestSha);
  for (const commit of [
    '16ab4af98c5f3b453ad3d9bdd1ae5fe959a37720',
    'e5f4c81e8eb796131313aab8f5b3a47231fe41b7',
  ]) {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
  }
  const amendment = readJson(join(repositoryRoot, amendmentPath));
  assert.equal(amendment.development_gate.status, 'completed');
  assert.equal(amendment.production_gate.status, 'blocked_external');
  assert.equal(amendment.effective_dependency.dependent_goal, 'G03');
  assert.equal(
    amendment.effective_dependency.effective_gate,
    'platform_foundation_gate_completed',
  );
  assert.equal(amendment.development_gate.production_eligible, false);
  assert.equal(amendment.production_gate.production_eligible, false);
});

test('all G03 machine documents validate as closed versioned contracts', () => {
  for (const [name, [schemaName, documentName]] of Object.entries(documents)) {
    const validate = compile(schemaName);
    const document = readJson(join(goalDirectory, documentName));
    assert.equal(
      validate(document),
      true,
      `${name}: ${JSON.stringify(validate.errors)}`,
    );
    assertInvalid(
      validate,
      { ...document, undeclared_field: true },
      `${name} unknown root field`,
    );
  }
});

test('SipFoundation freezes one authority, exact current pins and bounded SLOs', () => {
  const contract = readJson(join(goalDirectory, documents.sip[1]));
  assert.equal(contract.authority.sip_edge, 'Kamailio');
  assert.equal(contract.authority.call_leg_business_dialog, 'Unified RustPBX');
  assert.equal(
    contract.authority.protocol_transaction_dialog,
    'selected_SipFoundation_adapter',
  );
  assert.deepEqual(contract.source_identity, {
    rustpbx_commit: '6c49ee76baa54fdbf8f98020cc9bee158c7c15de',
    rsipstack_commit: '8318e97b1170de4e5245b120afec1cdf53e3d716',
    rustrtc_commit: '166c6d22984429eb6b509920c14fcd69f974f0b3',
    patchset: 'ivekit.40',
    current_adapter: 'rsipstack',
    target_adapter: 'rvoip_low_level_slices_after_separate_gates',
  });
  assert.equal(contract.admission_and_store_slo.trying_p99_budget_ms, 100);
  assert.equal(contract.admission_and_store_slo.trying_hard_deadline_ms, 200);
  assert.equal(contract.admission_and_store_slo.durable_transaction_p99_budget_ms, 20);
  assert.equal(contract.admission_and_store_slo.store_write_timeout_ms, 250);
  assert.equal(contract.admission_and_store_slo.queue_depth_ceiling, 1024);
  assert.equal(contract.boundedness.global_hot_lock, 'forbidden');
  assert.equal(contract.boundedness.unbounded_queue, 'forbidden');
  assert.equal(contract.deletion_gate.rsipstack_delete_before_g06, false);

  const build = readFileSync(join(repositoryRoot, 'infra/converact/rustpbx/build.sh'), 'utf8');
  assert.match(build, /RUSTPBX_COMMIT="6c49ee76baa54fdbf8f98020cc9bee158c7c15de"/u);
  assert.match(build, /RSIPSTACK_COMMIT="8318e97b1170de4e5245b120afec1cdf53e3d716"/u);
  assert.match(build, /RUSTRTC_COMMIT="166c6d22984429eb6b509920c14fcd69f974f0b3"/u);
  assert.match(build, /PATCHSET="ivekit\.40"/u);
});

test('Call/Leg and effect contracts distinguish identities, races and receipt meanings', () => {
  const call = readJson(join(goalDirectory, documents.call[1]));
  assert.equal(call.authority, 'Unified RustPBX Call Core');
  assert.deepEqual(
    call.identifiers.types.map((item) => item.type),
    [
      'CallId', 'LegId', 'ProtocolDialogId', 'TransactionId',
      'MediaSessionId', 'InteractionId',
    ],
  );
  assert.ok(call.identifiers.invariants.includes('sip_call_id_is_not_CallId'));
  assert.equal(call.race_policy.cancel_races_2xx, 'ACK_2xx_then_BYE_without_second_CDR');
  assert.equal(call.race_policy.late_fork_2xx, 'ACK_then_BYE_non_winner');
  assert.equal(call.complexity.transition, 'O(1)');
  assert.equal(call.complexity.global_active_call_scan_on_hot_path, 'forbidden');

  const effect = readJson(join(goalDirectory, documents.effect[1]));
  assert.equal(effect.semantic_receipt_classes.accepted.level, 'transport_accepted');
  assert.deepEqual(
    effect.semantic_receipt_classes.completed.from_states,
    ['send_attempted', 'transport_accepted'],
  );
  assert.equal(effect.semantic_receipt_classes.state_observed.from_state, 'unknown');
  assert.equal(
    effect.network_claim,
    'idempotent_effect_plus_observation_not_exactly_once',
  );
  assert.equal(effect.retry_after.jitter, 'forbidden');
});

test('wire corpus hashes exact bytes and covers every mandatory G03 feature', () => {
  const manifest = readJson(join(goalDirectory, documents.wire[1]));
  assert.equal(manifest.cases.length, 22);
  assert.equal(manifest.corpus_policy.baseline_semantic_capture_status, 'not_run');
  assert.deepEqual(new Set(manifest.required_feature_coverage), new Set([
    'INVITE', 'ACK', 'BYE', 'CANCEL', 'REGISTER', 'OPTIONS',
    're-INVITE', 'UPDATE', 'PRACK', 'REFER', 'NOTIFY', '100rel',
    'fork', 'auth', 'DTMF', 'malformed',
  ]));
  const ids = new Set();
  for (const item of manifest.cases) {
    assert.equal(ids.has(item.id), false, `duplicate case ${item.id}`);
    ids.add(item.id);
    const path = join(goalDirectory, item.file);
    const bytes = readFileSync(path);
    assert.equal(bytes.byteLength, item.byte_length, item.id);
    assert.equal(sha256(bytes), item.sha256, item.id);
    assert.equal(item.current_adapter_result, 'not_run');
    assert.equal(item.target_adapter_result, 'not_run');
    assert.equal(item.production_eligible, false);
    assert.doesNotMatch(bytes.toString('utf8'), /(?:BEGIN [A-Z ]*PRIVATE KEY|Bearer [A-Za-z0-9._~-]{20,})/u);
  }
  assert.ok(ids.has('reinvite-hold'));
  assert.ok(ids.has('reliable-provisional-183'));
  assert.ok(ids.has('fork-final-b-late'));
  assert.ok(ids.has('dtmf-info'));
  assert.ok(ids.has('malformed-conflicting-content-length'));
  assert.ok(ids.has('malformed-oversized-header'));
});

test('all 143 source rows targeting G03 map once without evidence promotion', () => {
  const source = readJson(join(
    repositoryRoot,
    'architecture-foundation/execution/goal-00/requirement-traceability-v1.json',
  ));
  const expected = source.requirements
    .filter((row) => row.target_goals.includes('G03'))
    .map((row) => row.requirement_id)
    .sort();
  const trace = readJson(join(goalDirectory, documents.trace[1]));
  const actual = trace.requirements.map((row) => row.requirement_id).sort();
  assert.equal(expected.length, 143);
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, actual.length);
  assert.equal(trace.closure.mapped_exactly_once, 143);
  assert.equal(trace.closure.unmapped, 0);
  assert.equal(trace.closure.production_eligible, 0);
  for (const row of trace.requirements) {
    assert.equal(row.status, 'not_run', row.requirement_id);
    assert.deepEqual(row.evidence_uris, [], row.requirement_id);
    assert.equal(row.production_eligible, false, row.requirement_id);
  }
});

test('evidence starts honest and no required design artifact contains placeholders', () => {
  const evidence = readJson(join(goalDirectory, documents.evidence[1]));
  assert.equal(evidence.production_eligible, false);
  assert.deepEqual(evidence.inherited_claims, []);
  assert.equal(evidence.entries.length, 15);
  assert.equal(new Set(evidence.entries.map((entry) => entry.evidence_id)).size, 15);
  for (const entry of evidence.entries) {
    assert.equal(entry.status, 'not_run');
    assert.deepEqual(entry.evidence_uris, []);
    assert.equal(entry.source_commit, null);
    assert.equal(entry.raw_output_sha256, null);
    assert.equal(entry.production_eligible, false);
  }
  for (const path of requiredMarkdown) {
    const absolute = join(goalDirectory, path);
    assert.ok(existsSync(absolute), `missing ${path}`);
    const value = readFileSync(absolute, 'utf8');
    assert.doesNotMatch(value, /\b(?:TBD|TODO|FIXME)\b/u, path);
  }
  const review = readFileSync(join(goalDirectory, 'independent-review.md'), 'utf8');
  assert.match(review, /Review status: `pending`/u);
  assert.match(review, /Production eligibility: `false`/u);
});

test('generator is deterministic and the seam imports no rvoip implementation type', () => {
  const tracked = [
    ...Object.values(documents).flat(),
    ...readJson(join(goalDirectory, documents.wire[1])).cases.map((item) => item.file),
  ];
  const before = new Map(tracked.map((path) => [path, sha256File(join(goalDirectory, path))]));
  execFileSync('node', [join(goalDirectory, 'generate-goal-03.mjs')], {
    cwd: repositoryRoot,
    stdio: 'ignore',
  });
  for (const [path, digest] of before) {
    assert.equal(sha256File(join(goalDirectory, path)), digest, path);
  }
  const seamPaths = execFileSync(
    'rg',
    ['--files', 'src/agent-runtime/converact/voice/sip-foundation'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  ).trim().split('\n');
  for (const path of seamPaths) {
    const value = readFileSync(join(repositoryRoot, path), 'utf8');
    assert.doesNotMatch(value, /from\s+['"](?:rvoip|@?rvoip|rvoip_)/u, path);
  }
});
