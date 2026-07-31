import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IveKitRetentionAdministrationService,
  type IveKitRetentionPolicyRepository
} from '../src/agent-runtime/ivekit/operations/retention/index.js';

test('retention administration validates policy bounds and legal hold reason codes', async () => {
  const calls: any[] = [];
  const repository = repositoryStub({
    async putPolicy(input) { calls.push(input); return input as any; },
    async placeLegalHold(input) { calls.push(input); return { hold: input as any, created: true }; }
  });
  const service = new IveKitRetentionAdministrationService(
    repository,
    () => new Date('2026-07-15T08:00:00.000Z')
  );
  await service.putPolicy({
    tenant_id: 'tenant-a', category: 'audit', enabled: true, retention_days: 365,
    batch_size: 100, interval_seconds: 3600, expected_revision: 0, actor: 'admin-a'
  });
  await service.placeLegalHold({
    tenant_id: 'tenant-a', category: 'audit', resource_type: 'audit_event',
    resource_id: 'audit-a', reason_code: 'legal_case', idempotency_key: 'hold-a', actor: 'admin-a'
  });
  assert.equal(calls[0].now, '2026-07-15T08:00:00.000Z');
  assert.equal(calls[1].reason_code, 'legal_case');
  await assert.rejects(async () => service.placeLegalHold({
    tenant_id: 'tenant-a', category: 'audit', resource_type: 'audit_event',
    resource_id: 'audit-a', reason_code: 'private free form reason',
    idempotency_key: 'hold-b', actor: 'admin-a'
  }));
});

function repositoryStub(
  overrides: Partial<IveKitRetentionPolicyRepository> = {}
): IveKitRetentionPolicyRepository {
  return {
    async listPolicies() { return []; },
    async putPolicy() { throw new Error('not implemented'); },
    async listLegalHolds() { return []; },
    async placeLegalHold() { throw new Error('not implemented'); },
    async releaseLegalHold() { throw new Error('not implemented'); },
    ...overrides
  };
}
