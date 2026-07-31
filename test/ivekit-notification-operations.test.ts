import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NotificationError,
  NotificationOperationsService,
  type NotificationOperationsRepository
} from '../src/agent-runtime/ivekit/notifications/index.js';

function repository(overrides: Partial<NotificationOperationsRepository> = {}): NotificationOperationsRepository {
  return {
    async listEndpoints() { return { items: [], next_cursor: null }; },
    async listTemplates() { return { items: [], next_cursor: null }; },
    async listTemplateVersions() { return { items: [], next_cursor: null }; },
    async listDeliveries() { return { items: [], next_cursor: null }; },
    async retryDelivery() { return null; },
    async archiveTemplate() { return null; },
    ...overrides
  };
}

test('notification operations assigns server operation IDs and fences uncertain retry', async () => {
  let captured: any;
  const service = new NotificationOperationsService(repository({
    async retryDelivery(input) {
      captured = input;
      return { id: 'delivery-a' } as any;
    }
  }), () => 'operation-a');
  await assert.rejects(() => service.retryDelivery({
    tenant_id: 'tenant-a', delivery_id: 'delivery-a', actor: 'admin-a',
    expected_state: 'uncertain', allow_uncertain: false,
    now: new Date('2026-07-15T00:00:00.000Z')
  }), (error: unknown) => error instanceof NotificationError && error.code === 'compliance_denied');
  assert.equal(captured, undefined);

  await service.retryDelivery({
    tenant_id: 'tenant-a', delivery_id: 'delivery-a', actor: 'admin-a',
    expected_state: 'failed', allow_uncertain: false,
    now: new Date('2026-07-15T00:00:00.000Z')
  });
  assert.equal(captured.operation_id, 'operation-a');
});

test('notification operations reports optimistic conflicts for retry and archive', async () => {
  const service = new NotificationOperationsService(repository(), () => 'operation-a');
  await assert.rejects(() => service.retryDelivery({
    tenant_id: 'tenant-a', delivery_id: 'delivery-a', actor: 'admin-a',
    expected_state: 'failed', allow_uncertain: false, now: new Date()
  }), (error: unknown) => error instanceof NotificationError && error.code === 'revision_conflict');
  await assert.rejects(() => service.archiveTemplate({
    tenant_id: 'tenant-a', template_id: 'template-a', actor: 'admin-a', expected_revision: 2
  }), (error: unknown) => error instanceof NotificationError && error.code === 'revision_conflict');
});
