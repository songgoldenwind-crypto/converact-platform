/**
 * Optional NATS event bus (Sprint 11).
 * When NATS_URL is unset, publish is a no-op.
 */

import { publishNatsMessage, isNatsConnected, connectNats } from '../../../infra/nats-client.js';

export interface BusMessage {
  subject: string;
  tenant_id: string;
  payload: Record<string, unknown>;
}

export async function publishEvent(msg: BusMessage): Promise<boolean> {
  if (!process.env.NATS_URL) return false;
  return publishNatsMessage({
    subject: msg.subject,
    payload: { tenant_id: msg.tenant_id, ...msg.payload }
  });
}

export function isEventBusConnected(): boolean {
  return isNatsConnected();
}

export async function ensureEventBusConnected(): Promise<boolean> {
  if (!process.env.NATS_URL) return false;
  return connectNats();
}

export async function publishCallCenterEvent(
  tenantId: string,
  event: string,
  data: Record<string, unknown>
): Promise<void> {
  if (!process.env.NATS_URL) return;
  await publishEvent({
    subject: `opc.callcenter.${event}`,
    tenant_id: tenantId,
    payload: data
  });
}
