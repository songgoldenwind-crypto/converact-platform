import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConveractFabricOperationsError,
  routeConveractFabricAuditApi,
  type ConveractFabricAuditHttpModule,
  type ConveractFabricAuditListInput
} from '../src/agent-runtime/converact/operations/audit/index.js';

const adminHeaders = {
  'x-tenant-id': 'tenant-a', 'x-user-id': 'admin-a', 'x-role': 'admin'
};

test('audit HTTP lists tenant-bound events with filters and pagination', async () => {
  let captured: ConveractFabricAuditListInput | null = null;
  const result = await routeConveractFabricAuditApi(
    null, 'GET', '/api/ivekit/audit/events',
    new URL('http://localhost/api/ivekit/audit/events?action=notification.created&limit=20'),
    adminHeaders,
    { module: moduleStub({
      async list(input) {
        captured = input;
        return { items: [eventRow()], next_cursor: 'next-a' };
      }
    }) }
  );
  assert.equal(captured?.tenant_id, 'tenant-a');
  assert.equal(captured?.action, 'notification.created');
  assert.equal(captured?.limit, 20);
  assert.equal((result as any).data.items[0].source_ip_hmac, 'b'.repeat(64));
});

test('audit HTTP exports JSONL and denies non-administrative roles', async () => {
  const result = await routeConveractFabricAuditApi(
    null, 'GET', '/api/ivekit/audit/export',
    new URL('http://localhost/api/ivekit/audit/export?max_events=200'),
    adminHeaders,
    { module: moduleStub({ async exportJsonl() { return '{"id":"audit-a"}\n'; } }) }
  );
  assert.equal((result as any).contentType, 'application/x-ndjson; charset=utf-8');
  assert.equal((result as any).data, '{"id":"audit-a"}\n');

  await assert.rejects(
    routeConveractFabricAuditApi(
      null, 'GET', '/api/ivekit/audit/events',
      new URL('http://localhost/api/ivekit/audit/events'),
      { 'x-tenant-id': 'tenant-a', 'x-user-id': 'viewer-a', 'x-role': 'viewer' },
      { module: moduleStub() }
    ),
    (error: unknown) => error instanceof ConveractFabricOperationsError
      && error.code === 'compliance_denied'
  );
});

function moduleStub(overrides: Partial<ConveractFabricAuditHttpModule> = {}): ConveractFabricAuditHttpModule {
  return {
    async list() { return { items: [], next_cursor: null }; },
    async exportJsonl() { return ''; },
    ...overrides
  };
}

function eventRow(): any {
  return {
    id: 'audit-a', tenant_id: 'tenant-a', actor_id: 'admin-a', actor_role: 'admin',
    action: 'notification.created', resource_type: 'notification', resource_id: 'notification-a',
    business_ref_type: 'order', business_ref_id: 'order-a', request_id: 'request-a',
    idempotency_key: 'idem-a', result: 'succeeded', policy_decision: 'allow',
    source_ip_hmac: 'b'.repeat(64), metadata: {}, previous_hash: '0'.repeat(64),
    event_hash: 'a'.repeat(64), occurred_at: '2026-07-15T08:00:00.000Z',
    retention_until: null, legal_hold: false, created_at: '2026-07-15T08:00:00.000Z'
  };
}
