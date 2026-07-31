import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EncryptedNotificationProtector,
  NotificationError,
  NotificationService,
  type CreateNotificationRecord,
  type NotificationCreateResult,
  type NotificationRepository
} from '../src/agent-runtime/converact/notifications/index.js';

const encryptionKey = Buffer.alloc(32, 11).toString('base64');
const hmacKey = Buffer.alloc(32, 13).toString('base64');

class MemoryRepository implements NotificationRepository {
  readonly records: CreateNotificationRecord[] = [];

  async create(input: CreateNotificationRecord): Promise<NotificationCreateResult> {
    const found = this.records.find((item) =>
      item.notification.tenant_id === input.notification.tenant_id
      && item.notification.idempotency_key === input.notification.idempotency_key
    );
    if (found) {
      if (found.notification.payload_hash !== input.notification.payload_hash) {
        throw new NotificationError({ code: 'idempotency_conflict', status: 409 });
      }
      return { ...found, created: false };
    }
    this.records.push(input);
    return { ...input, created: true };
  }
}

function service(repository: NotificationRepository): NotificationService {
  let id = 0;
  return new NotificationService({
    repository,
    protector: new EncryptedNotificationProtector({
      encryption_key: encryptionKey,
      hmac_key: hmacKey
    }),
    id: () => `id-${++id}`,
    now: () => new Date('2026-07-15T00:00:00.000Z')
  });
}

test('notification service creates one logical notification with encrypted channel deliveries', async () => {
  const repository = new MemoryRepository();
  const result = await service(repository).create({
    tenant_id: 'tenant-a',
    event_type: 'collaboration.session.invited',
    recipient: { kind: 'user', ref: 'user-42' },
    targets: [
      { channel: 'in_app', recipient: 'user-42' },
      { channel: 'email', recipient: 'Alice@Example.com' }
    ],
    content: { title: 'Invitation', body: 'Secret body' },
    content_projection: { title: 'Invitation', category: 'collaboration' },
    business_ref: { type: 'session', id: 'session-7' },
    requested_by: 'agent-9',
    idempotency_key: 'notify-invite-7'
  });

  assert.equal(result.created, true);
  assert.deepEqual(result.notification.channels, ['email', 'in_app']);
  assert.equal(result.deliveries.length, 2);
  assert.deepEqual(result.deliveries.map((item) => item.channel).sort(), ['email', 'in_app']);
  assert.equal(result.deliveries.every((item) => item.state === 'pending'), true);
  assert.equal(result.deliveries.every((item) => item.provider_kind === 'unresolved'), true);
  assert.equal(result.notification.content_ciphertext.includes('Secret body'), false);
  assert.equal(JSON.stringify(result).includes('Alice@Example.com'), false);
  assert.match(result.deliveries[0].recipient_hmac, /^[a-f0-9]{64}$/);
  assert.match(result.deliveries[0].provider_idempotency_key, /^notify_[a-f0-9]{64}$/);
});

test('notification service reuses idempotency keys for identical requests and rejects conflicts', async () => {
  const repository = new MemoryRepository();
  const notifications = service(repository);
  const input = {
    tenant_id: 'tenant-a',
    event_type: 'security.alert',
    recipient: { kind: 'user' as const, ref: 'user-1' },
    targets: [{ channel: 'in_app' as const, recipient: 'user-1' }],
    content: { title: 'Alert' },
    content_projection: { title: 'Alert' },
    business_ref: { type: 'audit', id: 'audit-1' },
    requested_by: 'system',
    idempotency_key: 'security-alert-1'
  };

  const first = await notifications.create(input);
  const duplicate = await notifications.create(input);
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.notification.id, first.notification.id);
  assert.equal(repository.records.length, 1);

  await assert.rejects(
    notifications.create({ ...input, content: { title: 'Changed' } }),
    (error: unknown) => error instanceof NotificationError
      && error.code === 'idempotency_conflict'
  );
});

test('notification service rejects duplicate targets and cross-kind recipients', async () => {
  const notifications = service(new MemoryRepository());
  const base = {
    tenant_id: 'tenant-a',
    event_type: 'example.event',
    recipient: { kind: 'user' as const, ref: 'user-1' },
    content: { title: 'Notice' },
    content_projection: { title: 'Notice' },
    business_ref: { type: 'example', id: 'example-1' },
    requested_by: 'operator-1',
    idempotency_key: 'example-1'
  };

  await assert.rejects(
    notifications.create({
      ...base,
      targets: [
        { channel: 'in_app', recipient: 'user-1' },
        { channel: 'in_app', recipient: 'user-1' }
      ]
    }),
    (error: unknown) => error instanceof NotificationError
      && error.code === 'validation_failed'
  );
  await assert.rejects(
    notifications.create({
      ...base,
      recipient: { kind: 'external', ref: 'contact-1' },
      targets: [{ channel: 'in_app', recipient: 'contact-1' }]
    }),
    (error: unknown) => error instanceof NotificationError
      && error.code === 'validation_failed'
  );
});

test('notification service prepares template and preference policy before encryption and hashing', async () => {
  const repository = new MemoryRepository();
  const protector = new EncryptedNotificationProtector({
    encryption_key: encryptionKey,
    hmac_key: hmacKey
  });
  const notifications = new NotificationService({
    repository,
    protector,
    prepare: async (input) => ({
      ...input,
      content: { title: 'Rendered' },
      targets: [input.targets[0]],
      scheduled_at: '2026-07-15T08:00:00.000Z'
    }),
    id: (() => { let id = 0; return () => `prepared-${++id}`; })(),
    now: () => new Date('2026-07-15T00:00:00.000Z')
  });
  const result = await notifications.create({
    tenant_id: 'tenant-a', event_type: 'call.missed',
    recipient: { kind: 'user', ref: 'user-a' },
    targets: [
      { channel: 'email', recipient: 'user@example.com' },
      { channel: 'sms', recipient: '+8613800001234' }
    ],
    content: { caller: 'Alice' }, business_ref: { type: 'call', id: 'call-a' },
    requested_by: 'operator-a', idempotency_key: 'prepared-a'
  });
  assert.deepEqual(result.notification.channels, ['email']);
  assert.equal(result.notification.scheduled_at, '2026-07-15T08:00:00.000Z');
  assert.deepEqual(
    await protector.revealContent('tenant-a', result.notification.content_ciphertext),
    { title: 'Rendered' }
  );
});
