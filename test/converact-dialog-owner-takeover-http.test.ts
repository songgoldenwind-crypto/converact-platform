import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DialogOwnerTakeoverError,
  type DialogOwnerTakeoverCoordinator
} from '../src/agent-runtime/converact/voice/dialog-owner-takeover.js';
import {
  handleDialogShadowRequest,
  type DialogOwnerTakeoverHttpCoordinator
} from '../src/agent-runtime/converact/voice/dialog-shadow-http.js';

const SERVICE_TOKEN = 'dialog-takeover-service-token-aa';
const PEER = {
  spiffe_id:
    'spiffe://ivekit.internal/cells/cell-a/fault-domains/zone-b-rack-1/nodes/rustpbx-b',
  cell_id: 'cell-a',
  node_id: 'rustpbx-b',
  fault_domain: 'zone-b-rack-1'
};

class TakeoverCoordinator implements DialogOwnerTakeoverHttpCoordinator {
  claims = 0;
  consumes = 0;
  authorityChecks = 0;
  heartbeats = 0;
  leaseChecks = 0;
  observedPairs = 0;

  async heartbeatNode(identity: typeof PEER) {
    this.heartbeats += 1;
    assert.deepEqual(identity, PEER);
    return lease(identity);
  }

  async assertNodeLease(identity: typeof PEER) {
    this.leaseChecks += 1;
    assert.deepEqual(identity, PEER);
    return lease(identity);
  }

  async observeCommittedPair() {
    this.observedPairs += 1;
    return {} as any;
  }

  async claimByDialog(
    input: Parameters<DialogOwnerTakeoverCoordinator['claimByDialog']>[0]
  ) {
    this.claims += 1;
    assert.deepEqual(input, {
      profile: 'VOICE-HA-T1',
      tenant_id: 'tenant-a',
      cell_id: 'cell-a',
      dialog_id: 'dialog-caller',
      caller: PEER,
      idempotency_key: 'takeover-request-a',
      reason: 'owner_heartbeat_expired'
    });
    return {
      status: 'claimed' as const,
      recovery_mode: 'resume' as const,
      takeover_id: 'takeover-a',
      owner_node_id: 'rustpbx-b',
      owner_epoch: 8,
      takeover_token: Buffer.alloc(32, 0x77).toString('base64url'),
      token_expires_at: '2026-07-26T01:00:05.000Z',
      shadow_records: [{}, {}] as any
    };
  }

  async consume() {
    this.consumes += 1;
    return {
      status: 'active' as const,
      owner_node_id: 'rustpbx-b',
      owner_epoch: 8,
      revision: 3
    };
  }

  async checkAuthority() {
    this.authorityChecks += 1;
    return {
      status: 'stale' as const,
      active_owner_node_id: 'rustpbx-b',
      active_owner_epoch: 8
    };
  }
}

test('cell-local takeover HTTP routes claim, consume and authority checks', async () => {
  const coordinator = new TakeoverCoordinator();
  const claim = await request('/claim', claimBody(), coordinator);
  assert.equal(claim.status, 200);
  const claimBodyResult = await claim.json() as any;
  assert.equal(claimBodyResult.owner_epoch, 8);
  assert.equal(claimBodyResult.recovery_mode, 'resume');

  const consume = await request('/consume', {
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    call_session_ref: 'call-session-a',
    takeover_id: 'takeover-a',
    owner_epoch: 8,
    takeover_token: Buffer.alloc(32, 0x77).toString('base64url')
  }, coordinator);
  assert.equal(consume.status, 200);
  assert.equal((await consume.json() as any).status, 'active');

  const authority = await request('/authority', {
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    call_session_ref: 'call-session-a',
    owner_epoch: 7
  }, coordinator);
  assert.equal(authority.status, 200);
  assert.equal((await authority.json() as any).status, 'stale');
  assert.deepEqual(
    [coordinator.claims, coordinator.consumes, coordinator.authorityChecks],
    [1, 1, 1]
  );
});

test('takeover HTTP fails closed when coordinator is absent or rejects CAS', async () => {
  const unavailable = await handleDialogShadowRequest(
    httpRequest('/claim', claimBody()),
    {
      service_token: SERVICE_TOKEN,
      coordinator: shadowCoordinator(),
      peer_identity: PEER
    }
  );
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    error: 'dialog_owner_takeover_unavailable'
  });

  const conflict = new TakeoverCoordinator();
  conflict.claimByDialog = async () => {
    throw new DialogOwnerTakeoverError(
      'dialog_owner_takeover_stale_owner',
      409
    );
  };
  const rejected = await request('/claim', claimBody(), conflict);
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), {
    error: 'dialog_owner_takeover_stale_owner'
  });
});

async function request(
  operation: '/claim' | '/consume' | '/authority',
  body: unknown,
  coordinator: DialogOwnerTakeoverHttpCoordinator
): Promise<Response> {
  return handleDialogShadowRequest(httpRequest(operation, body), {
    service_token: SERVICE_TOKEN,
    coordinator: shadowCoordinator(),
    takeover_coordinator: coordinator,
    peer_identity: PEER
  });
}

function httpRequest(
  operation: '/claim' | '/consume' | '/authority',
  body: unknown
): Request {
  return new Request(
    `https://shadow.internal/internal/converact/v1/dialog-owner${operation}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );
}

function shadowCoordinator() {
  return {
    async commit() {
      return { status: 'not_required' as const };
    },
    async assertAdmission() {
      return { status: 'not_required' as const };
    }
  };
}

function claimBody() {
  return {
    profile: 'VOICE-HA-T1',
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    dialog_id: 'dialog-caller',
    idempotency_key: 'takeover-request-a',
    reason: 'owner_heartbeat_expired'
  };
}

function lease(identity: typeof PEER) {
  return {
    ...identity,
    heartbeat_at: '2026-07-26T01:00:00.000Z',
    lease_expires_at: '2026-07-26T01:00:03.000Z',
    revision: 1
  };
}

test('takeover claim rejects client-supplied authority and shadow fields', async () => {
  const coordinator = new TakeoverCoordinator();
  for (const forbidden of [
    { call_session_ref: 'call-session-a' },
    { previous_owner_node_id: 'rustpbx-a' },
    { expected_owner_epoch: 7 },
    { shadow_records: [{}, {}] }
  ]) {
    const response = await request('/claim', {
      ...claimBody(),
      ...forbidden
    }, coordinator);
    assert.equal(response.status, 400);
  }
  assert.equal(coordinator.claims, 0);
});
