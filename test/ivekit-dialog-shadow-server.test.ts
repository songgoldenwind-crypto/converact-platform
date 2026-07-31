import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import {
  createDialogShadowHttpServer
} from '../src/agent-runtime/converact/voice/dialog-shadow-server.js';
import type {
  DialogShadowHttpCoordinator
} from '../src/agent-runtime/converact/voice/dialog-shadow-http.js';

const SERVICE_TOKEN = 'dialog-shadow-service-token-aa';
const PEER = {
  spiffe_id:
    'spiffe://ivekit.internal/cells/cell-a/fault-domains/zone-a-rack-1/nodes/rustpbx-a',
  cell_id: 'cell-a',
  node_id: 'rustpbx-a',
  fault_domain: 'zone-a-rack-1'
};

class Coordinator implements DialogShadowHttpCoordinator {
  async commit() {
    return { status: 'not_required' as const };
  }

  async assertAdmission() {
    return { status: 'not_required' as const };
  }
}

const takeoverCoordinator = {
  async heartbeatNode() {
    return lease();
  },
  async assertNodeLease() {
    return lease();
  },
  async observeCommittedPair() {
    return {} as any;
  },
  async claimByDialog() {
    throw new Error('not used');
  },
  async consume() {
    throw new Error('not used');
  },
  async checkAuthority() {
    throw new Error('not used');
  }
};

test('dialog shadow server exposes health and bridges bounded HTTP requests', async (t) => {
  let ready = false;
  const server = createDialogShadowHttpServer({
    coordinator: new Coordinator(),
    service_token: SERVICE_TOKEN,
    production: false,
    takeover_coordinator: takeoverCoordinator,
    development_peer_identity: PEER,
    ready: () => ready
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}`;

  const live = await fetch(`${endpoint}/livez`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: 'alive' });

  const unavailable = await fetch(`${endpoint}/readyz`);
  assert.equal(unavailable.status, 503);
  ready = true;
  const available = await fetch(`${endpoint}/readyz`);
  assert.equal(available.status, 200);

  const admission = await fetch(
    `${endpoint}/internal/ivekit/v1/dialog-shadow/admission`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ profile: 'VOICE-ORDINARY' })
    }
  );
  assert.equal(admission.status, 200);
  assert.deepEqual(await admission.json(), { status: 'not_required' });
});

function lease() {
  return {
    ...PEER,
    heartbeat_at: '2026-07-26T01:00:00.000Z',
    lease_expires_at: '2026-07-26T01:00:03.000Z',
    revision: 1
  };
}

test('dialog shadow production server fails closed without mTLS', () => {
  assert.throws(
    () => createDialogShadowHttpServer({
      coordinator: new Coordinator(),
      service_token: SERVICE_TOKEN,
      production: true
    }),
    /production mTLS is required/
  );
});
