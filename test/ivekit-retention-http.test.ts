import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IveKitRetentionError,
  routeIveKitRetentionApi,
  type IveKitRetentionHttpModule
} from '../src/agent-runtime/ivekit/operations/retention/index.js';

const adminHeaders = {
  'x-tenant-id': 'tenant-a', 'x-user-id': 'admin-a', 'x-role': 'admin',
  'idempotency-key': 'hold-a', 'x-opc-request-id': 'request-a'
};

test('retention HTTP manages optimistic policies and records safe audit metadata', async () => {
  const audits: any[] = [];
  let captured: any = null;
  const result = await routeIveKitRetentionApi(
    null, 'PUT', '/api/ivekit/retention/policies/audit',
    new URL('http://localhost/api/ivekit/retention/policies/audit'),
    {
      enabled: true, retention_days: 365, batch_size: 100,
      interval_seconds: 3600, expected_revision: 0
    }, adminHeaders, {
      module: moduleStub({ async putPolicy(input) { captured = input; return policyRow(); } }),
      audit: { async append(input) { audits.push(input); return {} as any; } }
    }
  );
  assert.equal(captured.tenant_id, 'tenant-a');
  assert.equal(captured.actor, 'admin-a');
  assert.equal((result as any).data.policy.retention_days, 365);
  assert.equal(audits[0].action, 'retention.policy.update');
  assert.equal(audits[0].metadata.revision, 1);
});

test('retention HTTP creates legal holds idempotently and hides idempotency internals', async () => {
  const result = await routeIveKitRetentionApi(
    null, 'POST', '/api/ivekit/retention/legal-holds',
    new URL('http://localhost/api/ivekit/retention/legal-holds'),
    {
      category: 'notifications', resource_type: 'notification',
      resource_id: 'notification-a', reason_code: 'legal_case'
    }, adminHeaders, {
      module: moduleStub({
        async placeLegalHold(input) {
          assert.equal(input.idempotency_key, 'hold-a');
          return { hold: holdRow(), created: true };
        }
      }),
      audit: null
    }
  );
  assert.equal((result as any).status, 201);
  assert.equal(JSON.stringify(result).includes('idempotency_key'), false);

  await assert.rejects(
    routeIveKitRetentionApi(
      null, 'GET', '/api/ivekit/retention/policies',
      new URL('http://localhost/api/ivekit/retention/policies'), null,
      { 'x-tenant-id': 'tenant-a', 'x-user-id': 'viewer-a', 'x-role': 'viewer' },
      { module: moduleStub() }
    ),
    (error: unknown) => error instanceof IveKitRetentionError
      && error.code === 'compliance_denied'
  );
});

function moduleStub(overrides: Partial<IveKitRetentionHttpModule> = {}): IveKitRetentionHttpModule {
  return {
    async listPolicies() { return []; },
    async putPolicy() { return policyRow(); },
    async listLegalHolds() { return []; },
    async placeLegalHold() { return { hold: holdRow(), created: true }; },
    async releaseLegalHold() { return { ...holdRow(), status: 'released' }; },
    ...overrides
  };
}

function policyRow(): any {
  return {
    tenant_id: 'tenant-a', category: 'audit', enabled: true, retention_days: 365,
    batch_size: 100, interval_seconds: 3600, next_run_at: '2026-07-15T08:00:00.000Z',
    lease_owner: null, lease_expires_at: null, revision: 1,
    created_by: 'admin-a', updated_by: 'admin-a',
    created_at: '2026-07-15T08:00:00.000Z', updated_at: '2026-07-15T08:00:00.000Z'
  };
}

function holdRow(): any {
  return {
    id: 'hold-a', tenant_id: 'tenant-a', category: 'notifications',
    resource_type: 'notification', resource_id: 'notification-a', reason_code: 'legal_case',
    idempotency_key: 'hold-a', status: 'active', placed_by: 'admin-a', released_by: null,
    placed_at: '2026-07-15T08:00:00.000Z', released_at: null
  };
}
