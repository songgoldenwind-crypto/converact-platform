import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWireDifferential,
  type WireCorpusManifest,
  type WireReplayRecord
} from '../scripts/converact-g03-wire-differential.js';

const ACCEPT_HASH = 'a'.repeat(64);
const REJECT_HASH = 'b'.repeat(64);

test('wire differential preserves accepted semantics and versions security tightening', () => {
  const manifest = fixtureManifest();
  const accepted = replay({
    wire_sha256: ACCEPT_HASH,
    wire_length_bytes: 100,
    parse_status: 'accept',
    message_kind: 'request',
    method_or_status: 'OPTIONS',
    request_uri_sha256: 'c'.repeat(64),
    header_names: ['via', "x.!%*+_`'~-token", 'content-length'],
    header_value_sha256: ['d'.repeat(64), '9'.repeat(64), 'e'.repeat(64)],
    body_length_bytes: 0,
    body_sha256: 'f'.repeat(64),
    reserialized_sha256: ACCEPT_HASH,
    parser_error_class: null
  });
  const baselineMalformed = replay({
    wire_sha256: REJECT_HASH,
    wire_length_bytes: 120,
    parse_status: 'accept',
    message_kind: 'request',
    method_or_status: 'INVITE',
    request_uri_sha256: '1'.repeat(64),
    header_names: ['via', 'content-length', 'content-length'],
    header_value_sha256: ['2'.repeat(64), '3'.repeat(64), '4'.repeat(64)],
    body_length_bytes: 0,
    body_sha256: 'f'.repeat(64),
    reserialized_sha256: REJECT_HASH,
    parser_error_class: null
  });
  const currentMalformed = replay({
    wire_sha256: REJECT_HASH,
    wire_length_bytes: 120,
    parse_status: 'reject',
    message_kind: null,
    method_or_status: null,
    request_uri_sha256: null,
    header_names: [],
    header_value_sha256: [],
    body_length_bytes: null,
    body_sha256: null,
    reserialized_sha256: null,
    parser_error_class: 'parse_error'
  });

  const report = buildWireDifferential({
    manifest,
    baseline_records: [accepted, baselineMalformed],
    current_records: [accepted, currentMalformed],
    identity: identity()
  });

  assert.equal(report.status, 'passed');
  assert.deepEqual(report.summary, {
    total_cases: 2,
    current_matches_contract: 2,
    unchanged_accepted_semantics: 1,
    security_tightenings: 1,
    unexplained_differences: 0
  });
  assert.deepEqual(report.cases.map((entry) => entry.compatibility_decision_id), [
    null,
    'G03-WIRE-SECURITY-001'
  ]);
  assert.doesNotMatch(JSON.stringify(report), /Digest username|Authorization:|sip:alice@/);
});

test('wire differential fails closed on accepted semantic drift', () => {
  const manifest = fixtureManifest();
  const baseline = replay({
    wire_sha256: ACCEPT_HASH,
    wire_length_bytes: 100,
    parse_status: 'accept',
    message_kind: 'request',
    method_or_status: 'OPTIONS',
    request_uri_sha256: 'c'.repeat(64),
    header_names: ['via', 'content-length'],
    header_value_sha256: ['d'.repeat(64), 'e'.repeat(64)],
    body_length_bytes: 0,
    body_sha256: 'f'.repeat(64),
    reserialized_sha256: ACCEPT_HASH,
    parser_error_class: null
  });
  const drift = { ...baseline, header_names: ['content-length', 'via'] };

  assert.throws(
    () => buildWireDifferential({
      manifest: { ...manifest, cases: [manifest.cases[0]!] },
      baseline_records: [baseline],
      current_records: [drift],
      identity: identity()
    }),
    /semantic drift/i
  );
});

function fixtureManifest(): WireCorpusManifest {
  return {
    contract_id: 'converact-wire-freeze-corpus-manifest-v1',
    version: '1.0.0',
    cases: [
      {
        id: 'options',
        file: 'wire-corpus/options.sip',
        method_or_status: 'OPTIONS',
        expected_disposition: 'accept',
        byte_length: 100,
        sha256: ACCEPT_HASH
      },
      {
        id: 'malformed-conflicting-content-length',
        file: 'wire-corpus/malformed-conflicting-content-length.sip',
        method_or_status: 'INVITE',
        expected_disposition: 'reject',
        byte_length: 120,
        sha256: REJECT_HASH
      }
    ]
  };
}

function replay(
  overrides: Omit<WireReplayRecord, 'schema_id' | 'schema_version'>
): WireReplayRecord {
  return {
    schema_id: 'converact-rsipstack-wire-replay-v1',
    schema_version: '1.0.0',
    ...overrides
  };
}

function identity() {
  return {
    generated_at: '2026-08-02T00:00:00.000Z',
    source_commit: '5'.repeat(40),
    rsipstack_commit: '8318e97b1170de4e5245b120afec1cdf53e3d716',
    baseline_patchset: 'ivekit.40',
    current_patchset: 'ivekit.41',
    baseline_binary_sha256: '6'.repeat(64),
    current_binary_sha256: '7'.repeat(64),
    patch_set_sha256: '8'.repeat(64)
  };
}
