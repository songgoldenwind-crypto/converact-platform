import { canonicalNotificationJson } from './canonical.js';
import { NotificationError } from './errors.js';
import type { NotificationAdministrationRepository } from './ports.js';
import type { CreateNotificationInput } from './types.js';

export class NotificationTemplateRenderer {
  readonly #repository: Pick<
    NotificationAdministrationRepository,
    'getTemplate' | 'getTemplateVersion'
  >;

  constructor(input: {
    repository: Pick<NotificationAdministrationRepository, 'getTemplate' | 'getTemplateVersion'>;
  }) {
    this.#repository = input.repository;
  }

  async apply(input: CreateNotificationInput): Promise<CreateNotificationInput> {
    if (!input.template) return input;
    const locale = requiredText(input.locale, 35);
    const template = await this.#repository.getTemplate(input.tenant_id, input.template.id);
    if (!template) throw new NotificationError({ code: 'not_found', status: 404 });
    if (template.status !== 'published' || template.published_revision !== input.template.revision) {
      throw new NotificationError({ code: 'compliance_denied', status: 409 });
    }
    const version = await this.#repository.getTemplateVersion(
      input.tenant_id, template.id, input.template.revision, locale
    );
    if (!version || !version.published) {
      throw new NotificationError({ code: 'compliance_denied', status: 409 });
    }
    if (input.targets.some((target) => !version.channels.includes(target.channel))) {
      throw validationError();
    }
    const variables = variableRecord(input.content);
    const content = renderValue(version.content, variables);
    canonicalNotificationJson(content);
    return { ...input, locale: version.locale, content };
  }
}

function renderValue(value: unknown, variables: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([A-Za-z0-9_.-]{1,100})\s*\}\}/g, (_match, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(variables, key)) throw validationError();
      return variables[key];
    });
  }
  if (Array.isArray(value)) return value.map((item) => renderValue(item, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, renderValue(item, variables)]));
  }
  return value;
}

function variableRecord(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw validationError();
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key)
      || !['string', 'number', 'boolean'].includes(typeof item)) throw validationError();
    const rendered = String(item);
    if (rendered.length > 8_192 || /[\r\n]/.test(rendered)) throw validationError();
    result[key] = rendered;
  }
  return result;
}

function requiredText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw validationError();
  return value.trim();
}

function validationError(): NotificationError {
  return new NotificationError({ code: 'validation_failed', status: 422 });
}
