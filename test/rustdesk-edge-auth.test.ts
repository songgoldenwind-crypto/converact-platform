import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createRustDeskEdgeCommandToken,
  verifyRustDeskEdgeCommandToken
} from '../src/agent-runtime/collaboration/rustdesk-edge-auth.js';

const secret = 'rustdesk-edge-auth-test-secret-at-least-32-bytes';

test('RustDesk edge command token derives a device-bound identity', () => {
  const token = createRustDeskEdgeCommandToken({
    tenant_id: 'tenant_edge_auth',
    rustdesk_id: '123456789',
    edge_instance_id: 'edge-auth-1',
    issued_at: '2026-07-10T12:00:00.000Z',
    expires_at: '2026-07-11T12:00:00.000Z'
  }, secret);

  assert.deepEqual(
    verifyRustDeskEdgeCommandToken(token, secret, '2026-07-10T12:01:00.000Z'),
    {
      tenant_id: 'tenant_edge_auth',
      rustdesk_id: '123456789',
      edge_instance_id: 'edge-auth-1',
      issued_at: '2026-07-10T12:00:00.000Z',
      expires_at: '2026-07-11T12:00:00.000Z'
    }
  );
  assert.throws(
    () => verifyRustDeskEdgeCommandToken(`${token}x`, secret, '2026-07-10T12:01:00.000Z'),
    /invalid RustDesk edge command token/
  );
  assert.throws(
    () => verifyRustDeskEdgeCommandToken(token, `${secret}-wrong`, '2026-07-10T12:01:00.000Z'),
    /invalid RustDesk edge command token/
  );
  assert.throws(
    () => verifyRustDeskEdgeCommandToken(token, secret, '2026-07-11T12:00:00.000Z'),
    /RustDesk edge command token is expired/
  );
});

test('RustDesk edge command token validates bounded claims and signing secret', () => {
  assert.throws(
    () => createRustDeskEdgeCommandToken({
      tenant_id: '',
      rustdesk_id: '123456789',
      edge_instance_id: 'edge-auth-1',
      issued_at: '2026-07-10T12:00:00.000Z',
      expires_at: '2026-07-11T12:00:00.000Z'
    }, secret),
    /tenant_id is required/
  );
  assert.throws(
    () => createRustDeskEdgeCommandToken({
      tenant_id: 'tenant_edge_auth',
      rustdesk_id: '123456789',
      edge_instance_id: 'edge-auth-1',
      issued_at: '2026-07-10T12:00:00.000Z',
      expires_at: '2026-07-11T12:00:00.000Z'
    }, 'short'),
    /RustDesk edge token secret must contain at least 32 characters/
  );
});
