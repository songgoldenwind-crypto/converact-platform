import { all, id, one, run } from '../../../db.js';

export interface WebhookDelivery {
  id: string;
  subscription_id: string;
  tenant_id: string;
  event: string;
  payload_id: string;
  status: 'pending' | 'success' | 'failed' | 'retrying';
  attempt_count: number;
  max_attempts: number;
  next_retry_at: string | null;
  http_status: number | null;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export class WebhookDeliveryStore {
  constructor(private readonly db: unknown) {}

  createDelivery(input: {
    subscription_id: string;
    tenant_id: string;
    event: string;
    payload_id: string;
    max_attempts?: number;
  }): WebhookDelivery {
    const deliveryId = id('whdel');
    run(
      this.db,
      `INSERT INTO webhook_deliveries
        (id, subscription_id, tenant_id, event, payload_id, status, max_attempts, next_retry_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, datetime('now'))`,
      [
        deliveryId,
        input.subscription_id,
        input.tenant_id,
        input.event,
        input.payload_id,
        input.max_attempts ?? 3
      ]
    );
    return this.get(deliveryId)!;
  }

  get(deliveryId: string): WebhookDelivery | null {
    const row = one(this.db, 'SELECT * FROM webhook_deliveries WHERE id = ?', [deliveryId]);
    return row ? decode(row) : null;
  }

  list(tenantId: string, limit = 100): WebhookDelivery[] {
    return all(
      this.db,
      'SELECT * FROM webhook_deliveries WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?',
      [tenantId, limit]
    ).map(decode);
  }

  markSuccess(deliveryId: string, httpStatus: number): void {
    run(
      this.db,
      `UPDATE webhook_deliveries SET status = 'success', http_status = ?, attempt_count = attempt_count + 1, delivered_at = CURRENT_TIMESTAMP, error = NULL WHERE id = ?`,
      [httpStatus, deliveryId]
    );
  }

  markFailure(deliveryId: string, httpStatus: number | null, error: string, retryAt: string | null): void {
    const status = retryAt ? 'retrying' : 'failed';
    run(
      this.db,
      `UPDATE webhook_deliveries SET status = ?, http_status = ?, error = ?, attempt_count = attempt_count + 1, next_retry_at = ? WHERE id = ?`,
      [status, httpStatus, error, retryAt, deliveryId]
    );
  }

  pickDueRetries(limit = 50): WebhookDelivery[] {
    return all(
      this.db,
      `SELECT * FROM webhook_deliveries
       WHERE status = 'retrying' AND next_retry_at IS NOT NULL AND datetime(next_retry_at) <= datetime('now')
       ORDER BY next_retry_at ASC LIMIT ?`,
      [limit]
    ).map(decode);
  }
}

function decode(row: Record<string, unknown>): WebhookDelivery {
  return {
    id: String(row.id),
    subscription_id: String(row.subscription_id),
    tenant_id: String(row.tenant_id),
    event: String(row.event),
    payload_id: String(row.payload_id),
    status: String(row.status) as WebhookDelivery['status'],
    attempt_count: Number(row.attempt_count || 0),
    max_attempts: Number(row.max_attempts || 3),
    next_retry_at: row.next_retry_at ? String(row.next_retry_at) : null,
    http_status: row.http_status != null ? Number(row.http_status) : null,
    error: row.error ? String(row.error) : null,
    created_at: String(row.created_at),
    delivered_at: row.delivered_at ? String(row.delivered_at) : null
  };
}
