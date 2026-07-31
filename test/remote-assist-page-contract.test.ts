import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const appSource = readFileSync('frontend/src/App.tsx', 'utf8');
const pageSource = readFileSync('frontend/src/pages/RemoteAssistPage.tsx', 'utf8');

test('remote assist session is exposed as a public browser route', () => {
  assert.match(appSource, /RemoteAssistPage/);
  assert.match(appSource, /path="\/remote-assist\/session"/);
});

test('remote assist page verifies token and prepares screen assist controls', () => {
  assert.match(pageSource, /fetchRemoteAssistJoinVerification/);
  assert.match(pageSource, /fetchRemoteAssistMediaJoinPlan/);
  assert.match(pageSource, /postRemoteAssistConsentGrant/);
  assert.match(pageSource, /postRemoteAssistConsentRevoke/);
  assert.match(pageSource, /postRemoteAssistEvent/);
  assert.match(pageSource, /postRemoteAssistRecordingStart/);
  assert.match(pageSource, /postRemoteAssistRecordingStop/);
  assert.match(pageSource, /startAssistRecording/);
  assert.match(pageSource, /stopAssistRecording/);
  assert.match(pageSource, /setRecordingState\('starting'\)/);
  assert.match(pageSource, /setRecordingState\('recording'\)/);
  assert.match(pageSource, /setRecordingState\('stopping'\)/);
  assert.match(pageSource, /data-testid="remote-assist-recording-status"/);
  assert.match(pageSource, /CONTROL_RESULT_EVENT_TYPE = 'control\.result'/);
  assert.match(pageSource, /buildRemoteAssistControlResultPayload/);
  assert.match(pageSource, /emitAssistControlResult/);
  assert.match(pageSource, /eventType: CONTROL_RESULT_EVENT_TYPE/);
  assert.match(pageSource, /reliable: true/);
  assert.match(pageSource, /transport_fallback: 'http'/);
  assert.match(pageSource, /new Room\(\)/);
  assert.match(pageSource, /setScreenShareEnabled\(true\)/);
  assert.match(pageSource, /Track\.Source\.ScreenShare/);
  assert.match(pageSource, /params\.get\('tenant_id'\)/);
  assert.match(pageSource, /params\.get\('remote_session_id'\)/);
  assert.match(pageSource, /params\.get\('token'\)/);
  assert.match(pageSource, /navigator\.mediaDevices\.getDisplayMedia/);
  assert.match(pageSource, /mediaModeRef\.current === 'development'/);
  assert.match(pageSource, /mediaStreamTrack\.addEventListener\(\s*'ended'/);
  assert.match(pageSource, /screen\.share_started/);
  assert.match(pageSource, /screen\.share_stopped/);
  assert.match(pageSource, /授权协助/);
  assert.match(pageSource, /撤销授权/);
  assert.match(pageSource, /data-testid="remote-assist-screen"/);
  assert.match(pageSource, /data-testid="remote-assist-pointer-layer"/);
  assert.match(pageSource, /data-testid="remote-assist-annotation-layer"/);
});
