import { createHash, randomUUID } from 'node:crypto';

import { canonicalNotificationJson } from './canonical.js';
import { NotificationError } from './errors.js';
import type { NotificationAdministrationRepository } from './ports.js';
import type {
  CreateNotificationTemplateInput,
  NotificationChannel,
  NotificationPreference,
  NotificationTemplate,
  NotificationTemplateSnapshot,
  NotificationTemplateVersion,
  PublishNotificationTemplateInput,
  PutNotificationPreferenceInput,
  UpdateNotificationTemplateInput
} from './types.js';

export class NotificationAdministrationService {
  readonly #repository: NotificationAdministrationRepository;
  readonly #now: () => Date;

  constructor(input: { repository: NotificationAdministrationRepository; now?: () => Date }) {
    this.#repository = input.repository;
    this.#now = input.now || (() => new Date());
  }

  async createTemplate(input: CreateNotificationTemplateInput): Promise<NotificationTemplateSnapshot> {
    const now = this.#now().toISOString();
    const templateKey = boundedText(input.template_key, 128);
    const actor = boundedText(input.actor, 255);
    const template: NotificationTemplate = {
      id: randomUUID(), tenant_id: boundedText(input.tenant_id, 255), template_key: templateKey,
      description: optionalBoundedText(input.description, 1000), status: 'draft',
      draft_revision: 1, published_revision: null, created_by: actor, updated_by: actor,
      created_at: now, updated_at: now
    };
    const version = templateVersion({
      tenant_id: template.tenant_id, template_id: template.id, revision: 1,
      locale: input.locale, channels: input.channels, content: input.content,
      published: false, actor, now
    });
    const created = await this.#repository.createTemplate(template, version);
    if (!created) throw revisionConflict();
    return created;
  }

  async updateTemplate(input: UpdateNotificationTemplateInput): Promise<NotificationTemplateSnapshot> {
    const current = await this.#requiredTemplate(input.tenant_id, input.template_id);
    const currentRevision = latestRevision(current);
    if (input.expected_revision !== currentRevision) throw revisionConflict();
    const now = this.#now().toISOString();
    const revision = currentRevision + 1;
    const template: NotificationTemplate = {
      ...current,
      description: input.description === undefined
        ? current.description
        : optionalBoundedText(input.description, 1000),
      status: 'draft', draft_revision: revision,
      updated_by: boundedText(input.actor, 255), updated_at: now
    };
    const version = templateVersion({
      tenant_id: current.tenant_id, template_id: current.id, revision,
      locale: input.locale, channels: input.channels, content: input.content,
      published: false, actor: template.updated_by, now
    });
    const result = await this.#repository.appendTemplateVersion(template, version, currentRevision);
    if (!result) throw revisionConflict();
    return result;
  }

  async publishTemplate(input: PublishNotificationTemplateInput): Promise<NotificationTemplateSnapshot> {
    const current = await this.#requiredTemplate(input.tenant_id, input.template_id);
    const currentRevision = latestRevision(current);
    if (input.expected_revision !== currentRevision) throw revisionConflict();
    const source = await this.#repository.getTemplateVersion(
      current.tenant_id, current.id, currentRevision, boundedText(input.locale, 35)
    );
    if (!source || source.published) {
      throw new NotificationError({ code: 'not_found', status: 404 });
    }
    const now = this.#now().toISOString();
    const revision = currentRevision + 1;
    const actor = boundedText(input.actor, 255);
    const template: NotificationTemplate = {
      ...current, status: 'published', published_revision: revision,
      updated_by: actor, updated_at: now
    };
    const version: NotificationTemplateVersion = {
      ...source, revision, published: true, created_by: actor,
      created_at: now, published_at: now
    };
    const result = await this.#repository.appendTemplateVersion(template, version, currentRevision);
    if (!result) throw revisionConflict();
    return result;
  }

  listPreferences(tenantId: string, userId: string): Promise<NotificationPreference[]> {
    return this.#repository.listPreferences(boundedText(tenantId, 255), boundedText(userId, 255));
  }

  async putPreference(input: PutNotificationPreferenceInput): Promise<NotificationPreference> {
    if (!Number.isInteger(input.expected_revision) || input.expected_revision < 0) throw validationError();
    const now = this.#now().toISOString();
    const preference: NotificationPreference = {
      tenant_id: boundedText(input.tenant_id, 255), user_id: boundedText(input.user_id, 255),
      event_type: boundedText(input.event_type, 255), channel: channel(input.channel),
      enabled: input.enabled === true, locale: optionalBoundedText(input.locale, 35),
      quiet_hours: plainRecord(input.quiet_hours || {}), revision: input.expected_revision + 1,
      created_at: now, updated_at: now
    };
    const result = await this.#repository.putPreference(preference, input.expected_revision);
    if (!result) throw revisionConflict();
    return result;
  }

  async #requiredTemplate(tenantId: string, templateId: string): Promise<NotificationTemplate> {
    const template = await this.#repository.getTemplate(
      boundedText(tenantId, 255), boundedText(templateId, 255)
    );
    if (!template) throw new NotificationError({ code: 'not_found', status: 404 });
    return template;
  }
}

function templateVersion(input: {
  tenant_id: string;
  template_id: string;
  revision: number;
  locale: string;
  channels: readonly NotificationChannel[];
  content: Readonly<Record<string, unknown>>;
  published: boolean;
  actor: string;
  now: string;
}): NotificationTemplateVersion {
  const content = plainRecord(input.content);
  return {
    tenant_id: input.tenant_id, template_id: input.template_id, revision: input.revision,
    locale: boundedText(input.locale, 35), channels: channels(input.channels), content,
    content_hash: createHash('sha256').update(canonicalNotificationJson(content)).digest('hex'),
    published: input.published, created_by: input.actor, created_at: input.now,
    published_at: input.published ? input.now : null
  };
}

function latestRevision(template: NotificationTemplate): number {
  return Math.max(template.draft_revision, template.published_revision || 0);
}

function channels(value: readonly NotificationChannel[]): NotificationChannel[] {
  const normalized = [...new Set(value.map(channel))];
  if (!normalized.length || normalized.length > 4) throw validationError();
  return normalized;
}

function channel(value: string): NotificationChannel {
  if (!['in_app', 'webhook', 'email', 'sms'].includes(value)) throw validationError();
  return value as NotificationChannel;
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw validationError();
  try {
    canonicalNotificationJson(value);
  } catch {
    throw validationError();
  }
  return value as Readonly<Record<string, unknown>>;
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw validationError();
  return value.trim();
}

function optionalBoundedText(value: unknown, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw validationError();
  return value.trim();
}

function validationError(): NotificationError {
  return new NotificationError({ code: 'validation_failed', status: 422 });
}

function revisionConflict(): NotificationError {
  return new NotificationError({ code: 'revision_conflict', status: 409 });
}
