import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWebAssistJoinPath,
  verifyWebAssistJoinToken,
} from '../src/agent-runtime/converact/remote-assist-token.js';

const INPUT = {
  tenant_id: 'tenant-a',
  remote_session_id: 'remote-a',
  actor_identity: 'engineer-a',
  role: 'engineer' as const,
  expires_at: '2099-01-01T00:00:00.000Z',
};

test('Web Assist accepts the direct legacy Fabric secret compatibility key', () => {
  withWebAssistEnvironment({ IVEKIT_WEB_ASSIST_SECRET: 'legacy-web-assist-secret' }, () => {
    const path = createWebAssistJoinPath(INPUT);
    const token = new URL(`http://localhost${path}`).searchParams.get('token') || '';

    assert.equal(verifyWebAssistJoinToken({
      token,
      tenant_id: INPUT.tenant_id,
      remote_session_id: INPUT.remote_session_id,
      now: new Date('2026-07-31T00:00:00.000Z'),
    }).actor_identity, INPUT.actor_identity);
  });
});

test('Web Assist fails closed when current and compatibility secrets conflict', () => {
  withWebAssistEnvironment({
    CONVERACT_FABRIC_WEB_ASSIST_SECRET: 'current-web-assist-secret',
    IVEKIT_WEB_ASSIST_SECRET: 'different-legacy-web-assist-secret',
  }, () => {
    assert.throws(
      () => createWebAssistJoinPath(INPUT),
      /conflicting branded environment variables/,
    );
  });
});

function withWebAssistEnvironment(
  values: Record<string, string>,
  run: () => void,
): void {
  const keys = [
    'CONVERACT_FABRIC_WEB_ASSIST_SECRET',
    'OPC_IVEKIT_WEB_ASSIST_SECRET',
    'IVEKIT_WEB_ASSIST_SECRET',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    run();
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
