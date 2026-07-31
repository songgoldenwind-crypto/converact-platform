import { wsBroadcastToUsers } from '../../../ws.js';
import type { NotificationTenantEvent } from './postgres/store.js';

type NotificationBroadcast = typeof wsBroadcastToUsers;

export function publishNotificationTenantEvent(
  event: NotificationTenantEvent,
  broadcast: NotificationBroadcast = wsBroadcastToUsers
): Promise<void> {
  return broadcast(
    event.tenant_id,
    event.audience_user_ids,
    event.type,
    event.data,
    { idempotency_key: event.idempotency_key }
  );
}
