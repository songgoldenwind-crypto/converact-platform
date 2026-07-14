import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ALPINE_ACCEPTANCE_IMAGE,
  SIPP_BINARY_SHA256,
  createRustPbxSippScenarios,
  countIncomingInviteRetransmissions,
  parseSippStatistics,
  renderSippCallIdTemplate,
  renderRustPbxSippJUnit,
  selectRustPbxSippScenarios
} from '../scripts/ivekit-rustpbx-sipp-acceptance.js';

test('RustPBX SIPp acceptance pins tools and covers the complete signaling matrix', () => {
  assert.match(ALPINE_ACCEPTANCE_IMAGE, /^alpine@sha256:[a-f0-9]{64}$/);
  assert.match(SIPP_BINARY_SHA256, /^[a-f0-9]{64}$/);

  const scenarios = createRustPbxSippScenarios('acceptance-password');
  assert.deepEqual(scenarios.map((scenario) => scenario.id), [
    'route-reject',
    'answer-udp',
    'early-cancel',
    'downstream-busy',
    'downstream-unavailable',
    'no-answer-timeout',
    'answer-tcp',
    'answer-tcp-reconnect',
    'udp-retransmission',
    'concurrent-udp-10',
    'register-digest',
    'register-invalid-password'
  ]);
  assert.equal(scenarios.find((scenario) => scenario.id === 'udp-retransmission')?.minimum_retransmissions, 1);
  assert.equal(scenarios.find((scenario) => scenario.id === 'concurrent-udp-10')?.calls, 10);
  assert.equal(scenarios.filter((scenario) => scenario.service?.startsWith('180055502')).length, 9);
  assert.equal(scenarios.find((scenario) => scenario.id === 'register-digest')?.uac_ip, '172.30.44.21');
  assert.equal(scenarios.find((scenario) => scenario.id === 'register-invalid-password')?.uac_ip, '172.30.44.29');
  assert.deepEqual(
    selectRustPbxSippScenarios(scenarios, 'register-digest,udp-retransmission').map((entry) => entry.id),
    ['udp-retransmission', 'register-digest']
  );
  assert.deepEqual(
    selectRustPbxSippScenarios(scenarios, 'answer-tcp-reconnect').map((entry) => entry.id),
    ['answer-tcp', 'answer-tcp-reconnect']
  );
  assert.throws(() => selectRustPbxSippScenarios(scenarios, 'missing'), /unknown/i);

  const tcpUac = readFileSync(new URL(
    '../services/ivekit-service/acceptance/sipp/answer-bye-uac.xml',
    import.meta.url
  ), 'utf8');
  assert.equal(tcpUac.match(/<recv response="100" optional="true" \/>/g)?.length, 2);
});

test('RustPBX SIPp acceptance counts duplicate inbound INVITEs as retransmissions', () => {
  const messages = [
    'INVITE sip:uas@172.30.44.28:5060 SIP/2.0',
    'SIP/2.0 100 Trying',
    'INVITE sip:uas@172.30.44.28:5060 SIP/2.0'
  ].join('\n');
  assert.equal(countIncomingInviteRetransmissions(messages, 1), 1);
  assert.equal(countIncomingInviteRetransmissions(messages, 2), 0);
});

test('RustPBX SIPp acceptance gives each isolated UAC a unique Call-ID namespace', () => {
  assert.equal(
    renderSippCallIdTemplate('answer-tcp-reconnect', '1784029000-42', '172.30.44.20'),
    'answer-tcp-reconnect-1784029000-42-%u@172.30.44.20'
  );
});

test('RustPBX SIPp acceptance parses the final cumulative statistics row', () => {
  const csv = [
    'StartTime;SuccessfulCall(C);FailedCall(C);Retransmissions(C);',
    'start;0;0;0;',
    'start;10;0;3;'
  ].join('\n');

  assert.deepEqual(parseSippStatistics(csv), {
    successful_calls: 10,
    failed_calls: 0,
    retransmissions: 3
  });
  assert.throws(() => parseSippStatistics('broken'), /statistics/i);
});

test('RustPBX SIPp JUnit report contains failures without leaking command details', () => {
  const xml = renderRustPbxSippJUnit({
    status: 'failed',
    generated_at: '2026-07-14T00:00:00.000Z',
    duration_ms: 1200,
    scenarios: [
      {
        id: 'answer-udp',
        status: 'passed',
        duration_ms: 200,
        calls: 1,
        transport: 'udp',
        uac: { successful_calls: 1, failed_calls: 0, retransmissions: 0 },
        uas: { successful_calls: 1, failed_calls: 0, retransmissions: 0 }
      },
      {
        id: 'register-digest',
        status: 'failed',
        duration_ms: 1000,
        calls: 1,
        transport: 'udp',
        error_code: 'uac_failed'
      }
    ]
  });

  assert.match(xml, /tests="2" failures="1"/);
  assert.match(xml, /<failure message="uac_failed"/);
  assert.doesNotMatch(xml, /password|docker run/i);
});
