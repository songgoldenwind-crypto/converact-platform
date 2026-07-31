import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NotificationAdministrationService,
  type NotificationAdministrationRepository,
  type NotificationPreference,
  type NotificationTemplate,
  type NotificationTemplateVersion
} from '../src/agent-runtime/converact/notifications/index.js';

class MemoryAdministrationRepository implements NotificationAdministrationRepository {
  templates = new Map<string, NotificationTemplate>();
  versions: NotificationTemplateVersion[] = [];
  preferences = new Map<string, NotificationPreference>();

  async createTemplate(template: NotificationTemplate, version: NotificationTemplateVersion) {
    if ([...this.templates.values()].some((item) =>
      item.tenant_id === template.tenant_id && item.template_key === template.template_key)) {
      return null;
    }
    this.templates.set(template.id, template);
    this.versions.push(version);
    return { template, version };
  }

  async getTemplate(tenantId: string, templateId: string) {
    const template = this.templates.get(templateId);
    return template?.tenant_id === tenantId ? template : null;
  }

  async getTemplateByKey(tenantId: string, templateKey: string) {
    return [...this.templates.values()].find((item) =>
      item.tenant_id === tenantId && item.template_key === templateKey) || null;
  }

  async getTemplateVersion(tenantId: string, templateId: string, revision: number, locale: string) {
    return this.versions.find((item) => item.tenant_id === tenantId
      && item.template_id === templateId && item.revision === revision
      && item.locale === locale) || null;
  }

  async appendTemplateVersion(
    template: NotificationTemplate,
    version: NotificationTemplateVersion,
    expectedRevision: number
  ) {
    const current = await this.getTemplate(template.tenant_id, template.id);
    if (!current || Math.max(current.draft_revision, current.published_revision || 0) !== expectedRevision) {
      return null;
    }
    this.templates.set(template.id, template);
    this.versions.push(version);
    return { template, version };
  }

  async listPreferences(tenantId: string, userId: string) {
    return [...this.preferences.values()].filter((item) =>
      item.tenant_id === tenantId && item.user_id === userId);
  }

  async putPreference(preference: NotificationPreference, expectedRevision: number) {
    const key = `${preference.tenant_id}:${preference.user_id}:${preference.event_type}:${preference.channel}`;
    const current = this.preferences.get(key);
    if ((!current && expectedRevision !== 0) || (current && current.revision !== expectedRevision)) return null;
    this.preferences.set(key, preference);
    return preference;
  }
}

test('notification templates append immutable revisions and publish a separate snapshot', async () => {
  const repository = new MemoryAdministrationRepository();
  const service = new NotificationAdministrationService({ repository, now: fixedNow });
  const created = await service.createTemplate({
    tenant_id: 'tenant-a', actor: 'admin-1', template_key: 'call.missed',
    description: 'Missed call', locale: 'zh-CN', channels: ['in_app', 'sms'],
    content: { title: '未接来电', body: '{{caller}}' }
  });

  assert.equal(created.template.draft_revision, 1);
  assert.equal(created.version.published, false);

  const edited = await service.updateTemplate({
    tenant_id: 'tenant-a', actor: 'admin-2', template_id: created.template.id,
    expected_revision: 1, locale: 'zh-CN', channels: ['in_app'],
    content: { title: '未接听', body: '{{caller}}' }
  });
  assert.equal(edited.version.revision, 2);

  const published = await service.publishTemplate({
    tenant_id: 'tenant-a', actor: 'admin-2', template_id: created.template.id,
    expected_revision: 2, locale: 'zh-CN'
  });
  assert.equal(published.version.revision, 3);
  assert.equal(published.version.published, true);
  assert.equal(published.template.published_revision, 3);
  assert.equal(repository.versions.length, 3);

  await assert.rejects(() => service.updateTemplate({
    tenant_id: 'tenant-a', actor: 'admin-3', template_id: created.template.id,
    expected_revision: 2, locale: 'zh-CN', channels: ['sms'], content: { body: 'stale' }
  }), (error: unknown) => hasCode(error, 'revision_conflict'));
});

test('notification preferences require optimistic revisions and remain tenant/user scoped', async () => {
  const repository = new MemoryAdministrationRepository();
  const service = new NotificationAdministrationService({ repository, now: fixedNow });
  const created = await service.putPreference({
    tenant_id: 'tenant-a', user_id: 'user-1', event_type: 'call.missed', channel: 'sms',
    enabled: false, locale: 'zh-CN', quiet_hours: { start: '22:00', end: '08:00', timezone: 'Asia/Shanghai' },
    expected_revision: 0
  });
  assert.equal(created.revision, 1);

  const updated = await service.putPreference({
    tenant_id: 'tenant-a', user_id: 'user-1', event_type: 'call.missed', channel: 'sms',
    enabled: true, locale: 'zh-CN', quiet_hours: {}, expected_revision: 1
  });
  assert.equal(updated.revision, 2);
  assert.equal((await service.listPreferences('tenant-a', 'user-1')).length, 1);
  assert.equal((await service.listPreferences('tenant-b', 'user-1')).length, 0);

  await assert.rejects(() => service.putPreference({
    tenant_id: 'tenant-a', user_id: 'user-1', event_type: 'call.missed', channel: 'sms',
    enabled: false, locale: '', quiet_hours: {}, expected_revision: 1
  }), (error: unknown) => hasCode(error, 'revision_conflict'));
});

function fixedNow(): Date {
  return new Date('2026-07-15T08:00:00.000Z');
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && (error as { code: string }).code === code);
}
