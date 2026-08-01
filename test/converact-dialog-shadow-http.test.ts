import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DialogShadowError,
  dialogShadowPairHash,
  dialogShadowRecordHash,
  type DialogShadowRecord
} from '../src/agent-runtime/converact/voice/dialog-shadow.js';
import {
  HttpDialogShadowClient,
  handleDialogShadowRequest,
  type DialogShadowHttpCoordinator
} from '../src/agent-runtime/converact/voice/dialog-shadow-http.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const SERVICE_TOKEN = 'service-token-aa';
const PEER = {
  spiffe_id:
    'spiffe://ivekit.internal/cells/cell-a/fault-domains/zone-a-rack-1/nodes/rustpbx-a',
  cell_id: 'cell-a',
  node_id: 'rustpbx-a',
  fault_domain: 'zone-a-rack-1'
};

function record(): DialogShadowRecord {
  return {
    schema_version: 1,
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    dialog_id: 'dialog-a',
    call_id_hash: HASH_A,
    owner_node_id: 'rustpbx-a',
    owner_fault_domain: 'zone-a-rack-1',
    owner_epoch: 7,
    sequence: 1,
    state: 'early',
    local_tag: 'caller-tag',
    remote_tag: 'callee-tag',
    route_set: ['sip:edge-a.internal:5061;transport=tls;lr'],
    local_cseq: 1,
    remote_cseq: 1,
    branch_hash: HASH_B,
    final_response_hash: null,
    auth_context_ref: 'auth-context-a',
    logical_offer_hash: HASH_C,
    logical_answer_hash: null,
    media_reservation_id: 'reservation-a-caller',
    provider_session_ref: null,
    cdr_sequence: 1,
    recorded_at: '2026-07-26T00:00:01.000Z',
    terminal: false
  };
}

class Coordinator implements DialogShadowHttpCoordinator {
  commitCalls = 0;
  commitPairCalls = 0;
  admissionCalls = 0;
  fail = false;

  async commit() {
    this.commitCalls += 1;
    if (this.fail) {
      throw new DialogShadowError('dialog_shadow_quorum_unavailable', 503);
    }
    return {
      status: 'committed' as const,
      record_hash: dialogShadowRecordHash(record()),
      fault_domains: ['zone-a-rack-1', 'zone-b-rack-1'],
      owner_epoch: 7,
      sequence: 1
    };
  }

  async commitPair(
    _profile: string,
    values: readonly [DialogShadowRecord, DialogShadowRecord]
  ) {
    this.commitPairCalls += 1;
    return {
      status: 'committed' as const,
      pair_hash: dialogShadowPairHash(values),
      record_hashes: values.map(dialogShadowRecordHash).sort() as [string, string],
      fault_domains: ['zone-a-rack-1', 'zone-b-rack-1'],
      owner_epoch: 7,
      sequence: 1
    };
  }

  async assertAdmission() {
    this.admissionCalls += 1;
    if (this.fail) {
      throw new DialogShadowError('dialog_shadow_quorum_unavailable', 503);
    }
    return {
      status: 'ready' as const,
      fault_domains: ['zone-a-rack-1', 'zone-b-rack-1']
    };
  }
}

class TakeoverCoordinator {
  leaseChecks = 0;
  observedPairs = 0;

  async heartbeatNode() {
    return lease();
  }

  async assertNodeLease() {
    this.leaseChecks += 1;
    return lease();
  }

  async observeCommittedPair() {
    this.observedPairs += 1;
    return {} as any;
  }

  async claimByDialog(): Promise<any> {
    throw new Error('not used');
  }

  async consume(): Promise<any> {
    throw new Error('not used');
  }

  async checkAuthority(): Promise<any> {
    throw new Error('not used');
  }
}

function recoveryPair(): [DialogShadowRecord, DialogShadowRecord] {
  return ['dialog-caller', 'dialog-callee'].map((dialogId) => ({
    ...record(),
    schema_version: 2,
    dialog_id: dialogId,
    provider_session_ref: 'call-session-a',
    recovery_capsule: {
      schema_version: 1,
      algorithm: 'A256GCM',
      key_id: 'recovery-2026-07',
      nonce: Buffer.alloc(12, 0x11).toString('base64url'),
      ciphertext: Buffer.from('opaque').toString('base64url'),
      auth_tag: Buffer.alloc(16, 0x22).toString('base64url')
    }
  })) as [DialogShadowRecord, DialogShadowRecord];
}

test('dialog shadow HTTP endpoint authenticates and bounds commit requests', async () => {
  const coordinator = new Coordinator();
  const takeover = new TakeoverCoordinator();
  const unauthorized = await handleDialogShadowRequest(
    request('/commit', { profile: 'VOICE-HA-T1', record: record() }, 'service-token-zz'),
    { service_token: SERVICE_TOKEN, coordinator }
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(coordinator.commitCalls, 0);

  const accepted = await handleDialogShadowRequest(
    request('/commit', { profile: 'VOICE-HA-T1', record: record() }),
    requestContext(coordinator, takeover)
  );
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), {
    status: 'committed',
    record_hash: dialogShadowRecordHash(record()),
    fault_domains: ['zone-a-rack-1', 'zone-b-rack-1'],
    owner_epoch: 7,
    sequence: 1
  });
  assert.equal(coordinator.commitCalls, 1);

  const oversized = await handleDialogShadowRequest(
    new Request('https://shadow.internal/internal/converact/v1/dialog-shadow/commit', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ padding: 'x'.repeat(48 * 1024) })
    }),
    {
      ...requestContext(coordinator, takeover),
      max_body_bytes: 32 * 1024
    }
  );
  assert.equal(oversized.status, 413);
  assert.equal(coordinator.commitCalls, 1);
});

test('dialog shadow HTTP maps T1 unavailability without exposing record data', async () => {
  const coordinator = new Coordinator();
  const takeover = new TakeoverCoordinator();
  coordinator.fail = true;
  const response = await handleDialogShadowRequest(
    request('/admission', { profile: 'VOICE-HA-T1' }),
    requestContext(coordinator, takeover)
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: 'dialog_shadow_quorum_unavailable'
  });
  assert.equal(coordinator.admissionCalls, 1);
});

test('dialog shadow HTTP commits and proves the recovery pair as one operation', async () => {
  const coordinator = new Coordinator();
  const takeover = new TakeoverCoordinator();
  const pair = recoveryPair();
  const response = await handleDialogShadowRequest(
    request('/commit-pair', { profile: 'VOICE-HA-T1', records: pair }),
    requestContext(coordinator, takeover)
  );

  assert.equal(response.status, 200);
  assert.equal(coordinator.commitPairCalls, 1);
  assert.equal(takeover.observedPairs, 1);
  assert.deepEqual(await response.json(), {
    status: 'committed',
    pair_hash: dialogShadowPairHash(pair),
    record_hashes: pair.map(dialogShadowRecordHash).sort(),
    fault_domains: ['zone-a-rack-1', 'zone-b-rack-1'],
    owner_epoch: 7,
    sequence: 1
  });
});

test('RustPBX HTTP client sends bounded authenticated requests and validates proof', async () => {
  let captured: Request | null = null;
  const client = new HttpDialogShadowClient({
    endpoint: 'https://shadow.internal',
    service_token: SERVICE_TOKEN,
    timeout_ms: 250,
    fetch: async (input, init) => {
      captured = new Request(input, init);
      return Response.json({
        status: 'committed',
        record_hash: dialogShadowRecordHash(record()),
        fault_domains: ['zone-a-rack-1', 'zone-b-rack-1'],
        owner_epoch: 7,
        sequence: 1
      });
    }
  });

  const proof = await client.commit('VOICE-HA-T1', record());
  assert.equal(proof.status, 'committed');
  assert.ok(captured);
  assert.equal(captured.headers.get('authorization'), `Bearer ${SERVICE_TOKEN}`);
  assert.equal(
    new URL(captured.url).pathname,
    '/internal/converact/v1/dialog-shadow/commit'
  );
});

test('RustPBX HTTP client validates an atomic pair proof', async () => {
  const pair = recoveryPair();
  let captured: Request | null = null;
  const client = new HttpDialogShadowClient({
    endpoint: 'https://shadow.internal',
    service_token: SERVICE_TOKEN,
    fetch: async (input, init) => {
      captured = new Request(input, init);
      return Response.json({
        status: 'committed',
        pair_hash: dialogShadowPairHash(pair),
        record_hashes: pair.map(dialogShadowRecordHash).sort(),
        fault_domains: ['zone-a-rack-1', 'zone-b-rack-1'],
        owner_epoch: 7,
        sequence: 1
      });
    }
  });

  const proof = await client.commitPair('VOICE-HA-T1', pair);
  assert.equal(proof.status, 'committed');
  if (proof.status === 'committed') {
    assert.equal(proof.pair_hash, dialogShadowPairHash(pair));
  }
  assert.ok(captured);
  assert.equal(
    new URL(captured.url).pathname,
    '/internal/converact/v1/dialog-shadow/commit-pair'
  );
});

function request(
  operation: '/commit' | '/commit-pair' | '/admission',
  body: unknown,
  token = SERVICE_TOKEN
): Request {
  return new Request(
    `https://shadow.internal/internal/converact/v1/dialog-shadow${operation}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );
}

function requestContext(
  coordinator: Coordinator,
  takeover = new TakeoverCoordinator()
) {
  return {
    service_token: SERVICE_TOKEN,
    coordinator,
    takeover_coordinator: takeover,
    peer_identity: PEER
  };
}

function lease() {
  return {
    ...PEER,
    heartbeat_at: '2026-07-26T01:00:00.000Z',
    lease_expires_at: '2026-07-26T01:00:03.000Z',
    revision: 1
  };
}
