import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IveKitAuditService,
  type IveKitAuditAppendInput,
  type IveKitAuditEvent,
  type IveKitAuditRepository
} from '../src/agent-runtime/ivekit/operations/audit/index.js';

class MemoryAuditRepository implements IveKitAuditRepository {
  events: IveKitAuditEvent[] = [];
  async append(input: IveKitAuditAppendInput) {
    const existing = this.events.find((item) => item.tenant_id === input.tenant_id
      && item.idempotency_key === input.idempotency_key);
    if (existing) return { event: existing, created: false };
    const previous = this.events.at(-1)?.event_hash || '0'.repeat(64);
    const event = { ...input, id: `audit-${this.events.length + 1}`, previous_hash: previous,
      event_hash: String(this.events.length + 1).padStart(64, 'a') } as IveKitAuditEvent;
    this.events.push(event);
    return { event, created: true };
  }
  async list(input: any) {
    return { items: this.events.filter((item) => item.tenant_id === input.tenant_id), next_cursor: null };
  }
}

test('audit service HMACs source IP, normalizes safe metadata and is idempotent', async () => {
  const repository = new MemoryAuditRepository();
  const service = new IveKitAuditService({
    repository, ip_hmac_key: Buffer.alloc(32, 4).toString('base64'),
    now: () => new Date('2026-07-15T08:00:00.000Z')
  });
  const input = {
    tenant_id: 'tenant-a', actor_id: 'admin-a', actor_role: 'admin',
    action: 'notification.endpoint.create', resource_type: 'notification_endpoint',
    resource_id: 'endpoint-a', business_ref: { type: 'endpoint', id: 'endpoint-a' },
    request_id: 'request-a', result: 'succeeded', policy_decision: 'allow',
    source_ip: '203.0.113.10', metadata: { channel: 'sms', status: 'active' },
    idempotency_key: 'audit-request-a'
  } as const;
  const first = await service.append(input);
  const replay = await service.append(input);
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.match(first.event.source_ip_hmac, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(first.event).includes('203.0.113.10'), false);
  assert.deepEqual(first.event.metadata, { channel: 'sms', status: 'active' });
});

test('audit service rejects secrets and direct PII in metadata', async () => {
  const service = new IveKitAuditService({
    repository: new MemoryAuditRepository(),
    ip_hmac_key: Buffer.alloc(32, 4).toString('base64')
  });
  for (const metadata of [
    { access_token: 'secret' },
    { phone_number: '+8613800001234' },
    { nested: { email: 'user@example.com' } }
  ]) {
    await assert.rejects(() => service.append({
      tenant_id: 'tenant-a', actor_id: 'admin-a', actor_role: 'admin', action: 'test',
      resource_type: 'test', resource_id: 'test-a', business_ref: { type: 'test', id: 'test-a' },
      request_id: 'request-a', result: 'failed', policy_decision: 'deny', source_ip: '', metadata,
      idempotency_key: `audit-${Object.keys(metadata)[0]}`
    }), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
      && (error as { code: string }).code === 'validation_failed'));
  }
});
