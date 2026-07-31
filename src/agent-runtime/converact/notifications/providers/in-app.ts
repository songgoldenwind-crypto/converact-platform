import { canonicalNotificationJson } from '../canonical.js';
import type {
  NotificationDeliveryProvider,
  NotificationInboxRepository,
  NotificationProviderDeliveryInput,
  NotificationProviderDeliveryResult
} from '../ports.js';
import type { NotificationInboxItem } from '../types.js';

export class InAppNotificationProvider implements NotificationDeliveryProvider {
  readonly kind = 'in_app';
  readonly channel = 'in_app' as const;

  constructor(private readonly input: {
    repository: Pick<NotificationInboxRepository, 'upsertInboxItem'>;
  }) {}

  async deliver(input: NotificationProviderDeliveryInput): Promise<NotificationProviderDeliveryResult> {
    if (input.notification.recipient_kind !== 'user'
      || input.notification.recipient_ref !== input.recipient) {
      return { status: 'terminal_failure', error_code: 'recipient_mismatch' };
    }
    const item: NotificationInboxItem = {
      id: input.delivery.id,
      tenant_id: input.delivery.tenant_id,
      notification_id: input.notification.id,
      user_id: input.recipient,
      projection: safeProjection(input.notification),
      priority: input.notification.priority,
      read_at: null,
      archived_at: null,
      created_at: input.notification.created_at,
      updated_at: input.notification.created_at
    };
    await this.input.repository.upsertInboxItem(item);
    return {
      status: 'delivered',
      provider_message_id: item.id,
      receipt: { inbox_item_id: item.id }
    };
  }
}

function safeProjection(
  notification: NotificationProviderDeliveryInput['notification']
): Readonly<Record<string, unknown>> {
  const value = {
    ...notification.content_projection,
    event_type: notification.event_type,
    business_ref: {
      type: notification.business_ref_type,
      id: notification.business_ref_id
    },
    correlation_id: notification.correlation_id
  };
  return JSON.parse(canonicalNotificationJson(value)) as Record<string, unknown>;
}
