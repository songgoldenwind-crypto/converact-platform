import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DialogShadowError,
  dialogShadowRecordHash,
  type DialogShadowRecord
} from '../src/agent-runtime/ivekit/voice/dialog-shadow.js';
import {
  HttpDialogShadowClient,
  handleDialogShadowRequest,
  type DialogShadowHttpCoordinator
} from '../src/agent-runtime/ivekit/voice/dialog-shadow-http.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const SERVICE_TOKEN = 'service-token-aa';

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

test('dialog shadow HTTP endpoint authenticates and bounds commit requests', async () => {
  const coordinator = new Coordinator();
  const unauthorized = await handleDialogShadowRequest(
    request('/commit', { profile: 'VOICE-HA-T1', record: record() }, 'service-token-zz'),
    { service_token: SERVICE_TOKEN, coordinator }
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(coordinator.commitCalls, 0);

  const accepted = await handleDialogShadowRequest(
    request('/commit', { profile: 'VOICE-HA-T1', record: record() }),
    { service_token: SERVICE_TOKEN, coordinator }
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
    new Request('https://shadow.internal/internal/ivekit/v1/dialog-shadow/commit', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ padding: 'x'.repeat(48 * 1024) })
    }),
    { service_token: SERVICE_TOKEN, coordinator, max_body_bytes: 32 * 1024 }
  );
  assert.equal(oversized.status, 413);
  assert.equal(coordinator.commitCalls, 1);
});

test('dialog shadow HTTP maps T1 unavailability without exposing record data', async () => {
  const coordinator = new Coordinator();
  coordinator.fail = true;
  const response = await handleDialogShadowRequest(
    request('/admission', { profile: 'VOICE-HA-T1' }),
    { service_token: SERVICE_TOKEN, coordinator }
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: 'dialog_shadow_quorum_unavailable'
  });
  assert.equal(coordinator.admissionCalls, 1);
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
    '/internal/ivekit/v1/dialog-shadow/commit'
  );
});

function request(
  operation: '/commit' | '/admission',
  body: unknown,
  token = SERVICE_TOKEN
): Request {
  return new Request(
    `https://shadow.internal/internal/ivekit/v1/dialog-shadow${operation}`,
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
