import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RustPbxRouterAdapter,
  VoiceError,
  type VoiceCapability
} from '../src/agent-runtime/ivekit/voice/index.js';

test('RustPBX Router normalization keeps routing fields and drops unsafe payloads', () => {
  const adapter = new RustPbxRouterAdapter();
  const normalized = adapter.normalizeRequest({
    call_id: 'call-a',
    from: '+8613800138000',
    to: '+8613900139000',
    source_addr: '10.0.0.8:5060',
    direction: 'inbound',
    method: 'INVITE',
    uri: 'sip:+8613900139000@pbx.test',
    route_snapshot_revision: 42,
    headers: {
      'User-Agent': 'controlled-phone',
      'X-Request-Id': 'request-a',
      Authorization: 'Bearer private',
      Cookie: 'private-cookie',
      Contact: 'sip:+8613800138000@private.test'
    },
    sdp: 'v=0 private SDP',
    body: '+8613800138000 private body',
    password: 'private-password'
  });

  assert.equal(normalized.call_id, 'call-a');
  assert.equal(normalized.from, '+8613800138000');
  assert.equal(normalized.to, '+8613900139000');
  assert.equal(normalized.route_snapshot_revision, 42);
  assert.deepEqual(normalized.headers, {
    'user-agent': 'controlled-phone',
    'x-request-id': 'request-a'
  });
  const safe = JSON.stringify(normalized.safe_payload);
  for (const value of ['private SDP', 'private body', 'Bearer private', 'private-cookie', 'private-password']) {
    assert.equal(safe.includes(value), false, value);
  }
  assert.equal(safe.includes('+8613800138000'), false);
  assert.equal(normalized.safe_payload.route_snapshot_revision, 42);
  assert.throws(
    () => adapter.normalizeRequest({
      call_id: 'call-a',
      from: '+8613800138000',
      to: '+8613900139000',
      source_addr: '10.0.0.8:5060',
      direction: 'inbound',
      method: 'INVITE',
      uri: 'sip:+8613900139000@pbx.test',
      route_snapshot_revision: 0
    }),
    hasVoiceCode('validation_failed')
  );
});

test('RustPBX Router maps portable forwarding decisions only through explicit SIP targets', () => {
  const adapter = new RustPbxRouterAdapter();
  assert.deepEqual(adapter.mapDecision({
    action: 'forward_sip', targets: ['sip:1001@pbx.internal'], strategy: 'parallel',
    record: true, timeout: 90, max_ring_time: 30, headers: { 'X-Route-Id': 'route-a' }
  }, capabilities()), {
    action: 'forward', targets: ['sip:1001@pbx.internal'], strategy: 'parallel',
    record: true, timeout: 90, max_ring_time: 30, headers: { 'x-route-id': 'route-a' }
  });
  assert.equal(adapter.mapDecision({
    action: 'start_ivr', target: 'sip:ivr-main@pbx.internal', timeout: 20
  }, capabilities({ step_ivr: true })).action, 'forward');
  assert.equal(adapter.mapDecision({
    action: 'enqueue', target: 'sip:queue-support@pbx.internal', timeout: 45
  }, capabilities({ queue: true })).action, 'forward');
  assert.equal(adapter.mapDecision({
    action: 'bridge_livekit', target: 'sip:livekit-room@livekit-sip:5061', timeout: 30
  }, capabilities({ sipflow: true })).action, 'forward');
  assert.equal(adapter.mapDecision({
    action: 'voicemail', target: 'sip:voicemail@pbx.internal', timeout: 60
  }, capabilities({ recording: true })).action, 'forward');
});

test('RustPBX Router rejects unavailable portable actions and unsafe targets', () => {
  const adapter = new RustPbxRouterAdapter();
  for (const decision of [
    { action: 'start_ivr', target: 'sip:ivr@pbx.internal' },
    { action: 'enqueue', target: 'sip:queue@pbx.internal' },
    { action: 'bridge_livekit', target: 'sip:livekit@pbx.internal' },
    { action: 'voicemail', target: 'sip:voicemail@pbx.internal' }
  ] as const) {
    assert.throws(() => adapter.mapDecision(decision, capabilities()), hasVoiceCode('capability_unavailable'));
  }
  assert.throws(
    () => adapter.mapDecision({ action: 'forward_sip', targets: ['https://attacker.test'] }, capabilities()),
    hasVoiceCode('validation_failed')
  );
  assert.throws(
    () => adapter.mapDecision({
      action: 'forward_sip', targets: ['sip:1001@pbx.internal'],
      headers: { Authorization: 'private' }
    }, capabilities()),
    hasVoiceCode('validation_failed')
  );
  assert.throws(
    () => adapter.mapDecision({
      action: 'forward_sip', targets: ['sip:1001@pbx.internal'], max_ring_time: 29
    }, capabilities()),
    hasVoiceCode('validation_failed')
  );
});

test('RustPBX Router maps terminal decisions without inventing actions', () => {
  const adapter = new RustPbxRouterAdapter();
  assert.deepEqual(adapter.mapDecision({ action: 'reject', code: 486, reason: 'busy' }, capabilities()), {
    action: 'reject', status: 486, reason: 'busy'
  });
  assert.deepEqual(adapter.mapDecision({ action: 'abort', reason: 'policy' }, capabilities()), {
    action: 'abort', reason: 'policy'
  });
  assert.deepEqual(adapter.mapDecision({ action: 'spam' }, capabilities()), { action: 'spam' });
  assert.deepEqual(adapter.mapDecision({ action: 'not_handled' }, capabilities()), { action: 'not_handled' });
});

function capabilities(overrides: Partial<Record<VoiceCapability, boolean>> = {}): Record<VoiceCapability, boolean> {
  return {
    management_http: false, json_rpc_routing: true, step_ivr: false, rwi: false,
    webrtc_extension: false, recording: false, sipflow: false, queue: false,
    postgres_backend: false, ...overrides
  };
}

function hasVoiceCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof VoiceError && error.code === code;
}
