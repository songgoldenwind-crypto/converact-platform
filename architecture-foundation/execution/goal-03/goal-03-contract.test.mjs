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
    formats: { 'date-time': validateRfc3339UtcDateTime },
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
  assert.deepEqual(
    Object.keys(contract.control_interface.commands),
    ['originate', 'answer', 'terminate'],
  );
  assert.equal(
    contract.control_interface.implementation_status,
    'interface_frozen_adapter_activation_not_run',
  );
  assert.equal(contract.sdp_interface.parser_types_exposed, false);
  assert.equal(contract.sdp_interface.maximum_bytes, 32768);
  assert.equal(contract.timer_interface.runtime_deadlines, 'monotonic_clock_only');
  assert.equal(
    contract.hangup_cause_interface.raw_backend_error_as_business_cause,
    'forbidden',
  );
  assert.equal(contract.error_interface.secret_or_raw_wire_details, 'forbidden');
  assert.equal(contract.boundedness.global_hot_lock, 'forbidden');
  assert.equal(contract.boundedness.unbounded_queue, 'forbidden');
  assert.equal(
    contract.protocol_session_lifecycle.open_reservation,
    'counts_as_active_before_adapter_identity_or_create_callback',
  );
  assert.equal(
    contract.protocol_session_lifecycle.drain_active_zero,
    'sessions_plus_opening_reservations_must_equal_zero',
  );
  assert.equal(contract.deletion_gate.rsipstack_delete_before_g06, false);

  const build = readFileSync(join(repositoryRoot, 'infra/converact/rustpbx/build.sh'), 'utf8');
  assert.match(build, /RUSTPBX_COMMIT="6c49ee76baa54fdbf8f98020cc9bee158c7c15de"/u);
  assert.match(build, /RSIPSTACK_COMMIT="8318e97b1170de4e5245b120afec1cdf53e3d716"/u);
  assert.match(build, /RUSTRTC_COMMIT="166c6d22984429eb6b509920c14fcd69f974f0b3"/u);
  assert.match(build, /PATCHSET="ivekit\.40"/u);
});

test('SipFoundation control messages have one compiled closed wire schema', () => {
  const contract = readJson(join(goalDirectory, documents.sip[1]));
  const schema = contract.control_interface.message_schema;
  assert.equal(
    schema.$id,
    'https://converact.invalid/schemas/sip-foundation-control-message-v1.schema.json',
  );
  assert.equal(schema.unevaluatedProperties, false);
  for (const command of Object.values(contract.control_interface.commands)) {
    for (const ref of Object.values(command)) {
      assert.match(ref, new RegExp(`^${schema.$id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}#`));
    }
  }
  for (const definition of [
    'SdpDocument',
    'HangupCause',
    'SipFoundationError',
    'OriginateRequest',
    'AnswerRequest',
    'TerminateRequest',
    'EgressEventEnvelope',
  ]) {
    assert.equal(schema.$defs[definition].additionalProperties, false, definition);
  }

  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    formats: { 'date-time': validateRfc3339UtcDateTime },
  });
  const validate = ajv.compile(schema);
  const examples = contract.control_interface.message_examples;
  assert.deepEqual(
    Object.keys(examples),
    [
      'originate_request', 'answer_request', 'terminate_request',
      'originate_result', 'answer_result', 'terminate_result',
      'command_error', 'request_received', 'response_received',
      'provisional_received', 'final_received', 'transport_accepted',
      'transport_failed', 'transaction_timed_out',
      'protocol_dialog_changed', 'dns_candidate_exhausted',
    ],
  );
  for (const [name, example] of Object.entries(examples)) {
    assert.equal(
      validate(example),
      true,
      `${name}: ${JSON.stringify(validate.errors)}`,
    );
    if (example.message_kind === 'egress_event') {
      assert.equal(
        example.event.event_hash,
        egressEventHash(example.event),
        `${name}: canonical event hash`,
      );
    }
  }

  assert.equal(
    contract.egress_events.event_hash_canonicalization,
    'sha256_lowercase_hex_of_rfc8785_jcs_utf8_event_without_event_hash',
  );

  const unknownRequestField = structuredClone(examples.originate_request);
  unknownRequestField.request.undeclared = true;
  assertInvalid(validate, unknownRequestField, 'unknown originate request field');
  const missingSdpHash = structuredClone(examples.answer_request);
  delete missingSdpHash.request.answer.sha256;
  assertInvalid(validate, missingSdpHash, 'missing SDP hash');
  const wrongSdpRole = structuredClone(examples.originate_request);
  wrongSdpRole.request.offer.role = 'answer';
  assertInvalid(validate, wrongSdpRole, 'originate with answer-role SDP');
  const uint64Overflow = structuredClone(examples.originate_request);
  uint64Overflow.request.owner_epoch = '18446744073709551616';
  assertInvalid(validate, uint64Overflow, 'owner epoch above uint64');
  const unknownEventPayload = structuredClone(examples.provisional_received);
  unknownEventPayload.event.payload.undeclared = true;
  assertInvalid(validate, unknownEventPayload, 'unknown event payload field');
  const missingEventHash = structuredClone(examples.transport_accepted);
  delete missingEventHash.event.event_hash;
  assertInvalid(validate, missingEventHash, 'missing event hash');
  const malformedEventHash = structuredClone(examples.transport_accepted);
  malformedEventHash.event.event_hash = 'not-a-sha256';
  assertInvalid(validate, malformedEventHash, 'malformed event hash');
  const invalidWallClock = structuredClone(examples.transport_accepted);
  invalidWallClock.event.observed_at_wall_clock = 'not-a-date';
  assertInvalid(validate, invalidWallClock, 'invalid RFC3339 wall clock');
  const invalidCalendarDate = structuredClone(examples.transport_accepted);
  invalidCalendarDate.event.observed_at_wall_clock = '2026-02-30T00:00:00Z';
  assertInvalid(validate, invalidCalendarDate, 'invalid RFC3339 calendar date');
  const malformedHash = structuredClone(examples.originate_result);
  malformedHash.result.request_hash = 'not-a-sha256';
  assertInvalid(validate, malformedHash, 'malformed request hash');
  const ambiguousError = structuredClone(examples.command_error);
  ambiguousError.error.raw_backend_error = 'secret';
  assertInvalid(validate, ambiguousError, 'raw backend error');
  const ambiguousTerminate = structuredClone(examples.terminate_result);
  ambiguousTerminate.result.effect_id = 'effect-also-present';
  assertInvalid(validate, ambiguousTerminate, 'ambiguous terminate result');
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
  assert.equal(
    call.identifiers.legacy_call_id_import.authority,
    'exact_PostgresVoiceCallStore_composition_binding_and_tenant_id_match',
  );
  assert.equal(
    call.identifiers.legacy_call_id_import.credential,
    'module_private_issuer_no_caller_supplied_lookup_or_record',
  );
  assert.equal(
    call.identifiers.legacy_call_id_import.runtime_brand,
    'constructor_issued_module_private_WeakSet_membership',
  );
  assert.equal(
    call.identifiers.legacy_call_id_import.repository_composition,
    'native_private_field_not_structurally_replaceable',
  );
  assert.equal(
    call.identifiers.legacy_call_id_import.query_dispatch,
    'captured_trusted_prototype_method_ignores_own_override',
  );
  assert.equal(
    call.identifiers.legacy_call_id_import.raw_sip_call_id_or_plain_object,
    'rejected',
  );
  assert.equal(call.race_policy.cancel_races_2xx, 'ACK_2xx_then_BYE_without_second_CDR');
  assert.equal(call.race_policy.late_fork_2xx, 'ACK_then_BYE_non_winner');
  assert.equal(call.race_policy.already_acked_late_fork_2xx, 'BYE_without_duplicate_ACK');
  assert.equal(
    call.race_policy.terminating_winner_retransmitted_2xx,
    'remain_terminating_and_emit_idempotent_ACK_then_BYE',
  );
  assert.equal(call.race_policy.fork_selection_sip_status, 'integer_200_through_299_only');
  assert.equal(call.race_policy.transfer_abort, 'restore_pre_transfer_confirmed_or_held_state');
  assert.equal(
    call.atomic_operations.transfer_commit_selection.generic_leg_event,
    'forbidden',
  );
  assert.equal(
    call.concurrency.mailbox_and_timer_mutation,
    'same_tenant_owner_generation_revision_fence_as_leg_mutation',
  );
  assert.equal(call.concurrency.call_work_dispatch, 'dequeue_only_no_callback_execution');
  assert.equal(call.race_policy.fork_branch_registration, 'before_start_invite');
  assert.equal(
    call.race_policy.remaining_early_forks,
    'bounded_per_leg_send_cancel_effects_in_winner_receipt',
  );
  assert.equal(call.events.includes('transfer_commit'), false);
  assert.equal(call.complexity.transition, 'O(1)_except_fork_winner');
  assert.equal(call.complexity.fork_winner, 'O(branches_in_attempt)_hard_ceiling_32');
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
  assert.match(review, /Review status: `third_review_remediation_complete_re_review_pending`/u);
  assert.match(review, /Critical 0 \/ High 1 \/ Important 2 \/ Minor 2/u);
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

function egressEventHash(event) {
  const { event_hash: ignored, ...hashInput } = event;
  return sha256(Buffer.from(canonicalJson(hashInput), 'utf8'));
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' ||
      typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function validateRfc3339UtcDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31, leapYear ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31,
  ][month - 1];
  return day >= 1 && day <= daysInMonth;
}
