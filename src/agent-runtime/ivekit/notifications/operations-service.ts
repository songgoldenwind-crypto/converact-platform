import { randomUUID } from 'node:crypto';

import { NotificationError } from './errors.js';
import type {
  ArchiveNotificationTemplateInput,
  NotificationDeliveryListInput,
  NotificationDeliveryRecord,
  NotificationEndpoint,
  NotificationEndpointListInput,
  NotificationPage,
  NotificationTemplate,
  NotificationTemplateListInput,
  NotificationTemplateVersion,
  NotificationTemplateVersionListInput,
  RetryNotificationDeliveryInput
} from './types.js';

export interface NotificationOperationsRepository {
  listEndpoints(input: NotificationEndpointListInput): Promise<NotificationPage<NotificationEndpoint>>;
  listTemplates(input: NotificationTemplateListInput): Promise<NotificationPage<NotificationTemplate>>;
  listTemplateVersions(
    input: NotificationTemplateVersionListInput
  ): Promise<NotificationPage<NotificationTemplateVersion>>;
  listDeliveries(
    input: NotificationDeliveryListInput
  ): Promise<NotificationPage<NotificationDeliveryRecord>>;
  retryDelivery(input: RetryNotificationDeliveryInput): Promise<NotificationDeliveryRecord | null>;
  archiveTemplate(input: ArchiveNotificationTemplateInput): Promise<NotificationTemplate | null>;
}

export class NotificationOperationsService {
  constructor(
    private readonly repository: NotificationOperationsRepository,
    private readonly id: () => string = randomUUID
  ) {}

  listEndpoints(input: NotificationEndpointListInput): Promise<NotificationPage<NotificationEndpoint>> {
    return this.repository.listEndpoints(input);
  }

  listTemplates(input: NotificationTemplateListInput): Promise<NotificationPage<NotificationTemplate>> {
    return this.repository.listTemplates(input);
  }

  listTemplateVersions(
    input: NotificationTemplateVersionListInput
  ): Promise<NotificationPage<NotificationTemplateVersion>> {
    return this.repository.listTemplateVersions(input);
  }

  listDeliveries(
    input: NotificationDeliveryListInput
  ): Promise<NotificationPage<NotificationDeliveryRecord>> {
    return this.repository.listDeliveries(input);
  }

  async retryDelivery(
    input: Omit<RetryNotificationDeliveryInput, 'operation_id'>
  ): Promise<NotificationDeliveryRecord> {
    if (input.expected_state === 'uncertain' && !input.allow_uncertain) {
      throw new NotificationError({ code: 'compliance_denied', status: 403 });
    }
    const delivery = await this.repository.retryDelivery({ ...input, operation_id: this.id() });
    if (!delivery) throw new NotificationError({ code: 'revision_conflict', status: 409 });
    return delivery;
  }

  async archiveTemplate(input: ArchiveNotificationTemplateInput): Promise<NotificationTemplate> {
    const template = await this.repository.archiveTemplate(input);
    if (!template) throw new NotificationError({ code: 'revision_conflict', status: 409 });
    return template;
  }
}
