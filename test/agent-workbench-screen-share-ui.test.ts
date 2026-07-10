import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const hookSource = readFileSync('frontend/src/hooks/useAgentWorkbench.ts', 'utf8');
const pageSource = readFileSync('frontend/src/pages/AgentWorkbenchPage.tsx', 'utf8');
const customerVideoSource = readFileSync('frontend/src/pages/VideoCallPage.tsx', 'utf8');
const customerVideoJoinSource = readFileSync('frontend/src/pages/video-call-join.ts', 'utf8');

test('agent workbench exposes LiveKit screen share controls', () => {
  assert.match(hookSource, /screenShareActive/);
  assert.match(hookSource, /toggleScreenShare/);
  assert.match(hookSource, /setScreenShareEnabled/);
  assert.match(pageSource, /toggleScreenShare/);
  assert.match(pageSource, /共享屏幕/);
  assert.match(pageSource, /停止共享/);
});

test('video pages render screen share as a separate remote track pane', () => {
  assert.match(hookSource, /remoteScreenShareRef/);
  assert.match(hookSource, /remoteScreenShareActive/);
  assert.match(hookSource, /publication\.source === Track\.Source\.ScreenShare/);
  assert.match(pageSource, /remoteScreenShareRef/);
  assert.match(customerVideoSource, /remoteScreenShareRef/);
  assert.match(customerVideoSource, /screenShareActive/);
  assert.match(customerVideoSource, /publication\.source === Track\.Source\.ScreenShare/);
});

test('agent and customer media pages reconcile LiveKit reconnect and disconnect states', () => {
  assert.match(hookSource, /RoomEvent\.Reconnecting/);
  assert.match(hookSource, /RoomEvent\.Reconnected/);
  assert.match(hookSource, /RoomEvent\.Disconnected/);
  assert.match(customerVideoSource, /RoomEvent\.Reconnecting/);
  assert.match(customerVideoSource, /RoomEvent\.Reconnected/);
  assert.match(customerVideoSource, /RoomEvent\.Disconnected/);
});

test('customer video page forwards signed invite parameters to media join', () => {
  assert.match(customerVideoSource, /params\.get\('invite'\)/);
  assert.match(customerVideoSource, /params\.get\('expires_at'\)/);
  assert.match(customerVideoSource, /fetchCustomerMediaJoinPlan/);
  assert.match(customerVideoSource, /invite,/);
  assert.match(customerVideoSource, /expiresAt/);
  assert.match(customerVideoJoinSource, /params\.set\('invite', input\.invite\)/);
  assert.match(customerVideoJoinSource, /params\.set\('expires_at', input\.expiresAt\)/);
});
