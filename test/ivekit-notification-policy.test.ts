import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NotificationPreferencePolicy,
  NotificationTemplateRenderer,
  type CreateNotificationInput,
  type NotificationPreference,
  type NotificationTemplate,
  type NotificationTemplateVersion
} from '../src/agent-runtime/converact/notifications/index.js';

test('published notification templates render variables and reject unpublished or missing values', async () => {
  const repository = repositoryStub();
  const renderer = new NotificationTemplateRenderer({ repository });
  const rendered = await renderer.apply(notificationInput({
    content: { caller: '138****1234' },
    locale: 'zh-CN',
    template: { id: 'template-a', revision: 3 }
  }));
  assert.deepEqual(rendered.content, {
    title: '未接来电', body: '来自 138****1234 的呼叫', nested: { action: '回拨 138****1234' }
  });
  assert.equal(rendered.locale, 'zh-CN');

  await assert.rejects(
    renderer.apply(notificationInput({ content: {}, locale: 'zh-CN', template: { id: 'template-a', revision: 3 } })),
    (error: unknown) => hasCode(error, 'validation_failed')
  );
  repository.version = { ...repository.version, published: false };
  await assert.rejects(
    renderer.apply(notificationInput({
      content: { caller: 'x' }, locale: 'zh-CN', template: { id: 'template-a', revision: 3 }
    })),
    (error: unknown) => hasCode(error, 'compliance_denied')
  );
});

test('notification preference policy filters disabled channels and schedules after quiet hours', async () => {
  const preferences: NotificationPreference[] = [
    preference({ channel: 'sms', enabled: false }),
    preference({
      channel: 'email', enabled: true,
      quiet_hours: { start: '22:00', end: '08:00', timezone: 'Asia/Shanghai' }
    })
  ];
  const policy = new NotificationPreferencePolicy({
    repository: { async listPreferences() { return preferences; } },
    now: () => new Date('2026-07-15T15:30:00.000Z')
  });
  const prepared = await policy.apply(notificationInput());
  assert.deepEqual(prepared.targets.map((target) => target.channel), ['email']);
  assert.equal(prepared.scheduled_at, '2026-07-16T00:00:00.000Z');

  const forced = await policy.apply(notificationInput({ force_delivery: true }));
  assert.deepEqual(forced.targets.map((target) => target.channel), ['email', 'sms']);
});

function repositoryStub() {
  const template: NotificationTemplate = {
    id: 'template-a', tenant_id: 'tenant-a', template_key: 'call.missed', description: '',
    status: 'published', draft_revision: 2, published_revision: 3,
    created_by: 'admin-a', updated_by: 'admin-a', created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z'
  };
  const repository = {
    version: {
      tenant_id: 'tenant-a', template_id: 'template-a', revision: 3, locale: 'zh-CN',
      channels: ['email', 'sms'],
      content: {
        title: '未接来电', body: '来自 {{caller}} 的呼叫', nested: { action: '回拨 {{caller}}' }
      },
      content_hash: 'a'.repeat(64), published: true, created_by: 'admin-a',
      created_at: '2026-07-15T00:00:00.000Z', published_at: '2026-07-15T00:00:00.000Z'
    } as NotificationTemplateVersion,
    async getTemplate() { return template; },
    async getTemplateVersion() { return repository.version; }
  };
  return repository;
}

function notificationInput(overrides: Partial<CreateNotificationInput> = {}): CreateNotificationInput {
  return {
    tenant_id: 'tenant-a', event_type: 'call.missed', recipient: { kind: 'user', ref: 'user-a' },
    targets: [
      { channel: 'email', recipient: 'user@example.com' },
      { channel: 'sms', recipient: '+8613800001234' }
    ],
    content: { title: 'Missed call' }, business_ref: { type: 'call', id: 'call-a' },
    requested_by: 'operator-a', idempotency_key: 'call-missed-a', ...overrides
  };
}

function preference(overrides: Partial<NotificationPreference>): NotificationPreference {
  return {
    tenant_id: 'tenant-a', user_id: 'user-a', event_type: 'call.missed', channel: 'email',
    enabled: true, locale: 'zh-CN', quiet_hours: {}, revision: 1,
    created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
    ...overrides
  };
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && (error as { code: string }).code === code);
}
