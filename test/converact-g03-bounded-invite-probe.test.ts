import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseSipResponse,
  renderBoundedInvite,
  renderNon2xxAck
} from '../scripts/g03/bounded-invite-probe.js';

const request = Object.freeze({
  service: '+18005550999',
  target_ip: '172.30.44.10',
  target_port: 5060,
  local_ip: '172.30.44.21',
  local_port: 5060,
  call_id: 'g03-blocking-probe-1@172.30.44.21',
  branch: 'z9hG4bK-g03-blocking-probe-1',
  from_tag: 'g03-probe-1'
});

test('G03 bounded INVITE probe renders one closed zero-body transaction', () => {
  const wire = renderBoundedInvite(request);
  assert.equal(wire.endsWith('\r\n\r\n'), true);
  assert.equal(wire.match(/^INVITE /gm)?.length, 1);
  assert.match(wire, /^INVITE sip:\+18005550999@172\.30\.44\.10:5060 SIP\/2\.0\r$/m);
  assert.match(wire, /^Via: SIP\/2\.0\/UDP 172\.30\.44\.21:5060;branch=z9hG4bK-g03-blocking-probe-1\r$/m);
  assert.match(wire, /^Content-Length: 0\r$/m);
  assert.doesNotMatch(wire, /Authorization|Proxy-Authorization|X-PBX-Key/i);
  assert.throws(
    () => renderBoundedInvite({ ...request, service: 'bad service' }),
    /service/u
  );
});

test('G03 bounded INVITE probe parses a closed final response', () => {
  const parsed = parseSipResponse([
    'SIP/2.0 503 Service Unavailable',
    'Via: SIP/2.0/UDP 172.30.44.21:5060;branch=z9hG4bK-g03-blocking-probe-1',
    'From: <sip:g03-probe@172.30.44.21>;tag=g03-probe-1',
    'To: <sip:+18005550999@172.30.44.10>;tag=server-tag',
    'Call-ID: g03-blocking-probe-1@172.30.44.21',
    'CSeq: 1 INVITE',
    'Retry-After: 1',
    'Content-Length: 0',
    '',
    ''
  ].join('\r\n'));

  assert.deepEqual(parsed, {
    status: 503,
    reason: 'Service Unavailable',
    to: '<sip:+18005550999@172.30.44.10>;tag=server-tag',
    retry_after_seconds: 1
  });
  assert.throws(() => parseSipResponse('INVITE sip:x SIP/2.0\r\n\r\n'), /response/u);
  assert.throws(
    () => parseSipResponse('SIP/2.0 503 Service Unavailable\r\nTo: x\r\nRetry-After: 0\r\n\r\n'),
    /Retry-After/u
  );
});

test('G03 bounded INVITE probe ACKs a non-2xx final on the original transaction', () => {
  const wire = renderNon2xxAck(request, '<sip:+18005550999@172.30.44.10>;tag=server-tag');
  assert.match(wire, /^ACK sip:\+18005550999@172\.30\.44\.10:5060 SIP\/2\.0\r$/m);
  assert.match(wire, /^CSeq: 1 ACK\r$/m);
  assert.match(wire, /^To: <sip:\+18005550999@172\.30\.44\.10>;tag=server-tag\r$/m);
  assert.equal(wire.endsWith('\r\n\r\n'), true);
});
