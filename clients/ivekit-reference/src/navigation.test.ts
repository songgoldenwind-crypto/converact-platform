import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readIveKitLocation, sessionLocationPatch, updateIveKitLocation } from './navigation.js';

test('iveKit navigation parses complete resource deep links and call fallback', () => {
  assert.deepEqual(readIveKitLocation(
    'https://led.example/support?workspace=remote&business_ref_type=service_order&business_ref_id=SO-1&session_id=chat-1&call_id=call-1&voice_call_id=voice-1&remote_session_id=remote-1'
  ), {
    workspace: 'remote',
    businessRef: { type: 'service_order', id: 'SO-1' },
    sessionId: 'chat-1',
    callId: 'call-1',
    voiceCallId: 'voice-1',
    remoteSessionId: 'remote-1'
  });
  assert.equal(readIveKitLocation('https://led.example/support?call_id=call-2').workspace, 'calls');
  assert.equal(readIveKitLocation('https://led.example/support?voice_call_id=voice-2').workspace, 'voice');
  assert.equal(readIveKitLocation('https://led.example/support?workspace=quality').workspace, 'quality');
  assert.equal(readIveKitLocation('https://led.example/support?workspace=unknown').workspace, 'messages');
});

test('iveKit navigation updates only patched fields and removes empty resources', () => {
  const source = 'https://led.example/support?host=embedded&session_id=chat-1&call_id=call-1';
  const next = updateIveKitLocation(source, {
    workspace: 'remote',
    businessRef: { type: 'service_order', id: 'SO-2' },
    sessionId: '',
    voiceCallId: 'voice-2',
    remoteSessionId: 'remote-2'
  });
  assert.equal(next.searchParams.get('host'), 'embedded');
  assert.equal(next.searchParams.get('workspace'), 'remote');
  assert.equal(next.searchParams.get('business_ref_type'), 'service_order');
  assert.equal(next.searchParams.get('business_ref_id'), 'SO-2');
  assert.equal(next.searchParams.has('session_id'), false);
  assert.equal(next.searchParams.get('call_id'), 'call-1');
  assert.equal(next.searchParams.get('voice_call_id'), 'voice-2');
  assert.equal(next.searchParams.get('remote_session_id'), 'remote-2');
});

test('iveKit navigation rejects incomplete business references', () => {
  assert.equal(readIveKitLocation('https://led.example/?business_ref_type=service_order').businessRef, null);
  const next = updateIveKitLocation('https://led.example/?business_ref_type=old&business_ref_id=1', {
    businessRef: null
  });
  assert.equal(next.searchParams.has('business_ref_type'), false);
  assert.equal(next.searchParams.has('business_ref_id'), false);
});

test('session navigation clears resource ids only when the business context changes', () => {
  assert.deepEqual(sessionLocationPatch(
    { type: 'service_order', id: 'SO-1' },
    { type: 'service_order', id: 'SO-2' },
    'chat-2'
  ), {
    businessRef: { type: 'service_order', id: 'SO-2' },
    sessionId: 'chat-2',
    callId: '',
    voiceCallId: '',
    remoteSessionId: ''
  });
  assert.deepEqual(sessionLocationPatch(
    { type: 'service_order', id: 'SO-1' },
    { type: 'service_order', id: 'SO-1' },
    'chat-2'
  ), {
    businessRef: { type: 'service_order', id: 'SO-1' },
    sessionId: 'chat-2'
  });
});
