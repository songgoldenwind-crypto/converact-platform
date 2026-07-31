import { createHash } from 'node:crypto';

import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import { IveKitTenantEventJournal } from '../../tenant-event-store.js';
import { NotificationError } from '../errors.js';
import type {
  NotificationDeliveryRepository,
  NotificationAdministrationRepository,
  NotificationEndpointAdminRepository,
  NotificationEndpointGovernanceRepository,
  NotificationInboxRepository,
  NotificationReceiptRepository,
  NotificationReceiptReconciliationRepository
} from '../ports.js';
import type {
  CreateNotificationRecord,
  NotificationCreateResult,
  NotificationDeliveryClaimInput,
  NotificationDeliveryFinishInput,
  NotificationDeliveryRecord,
  NotificationRecord,
  NotificationInboxItem,
  NotificationInboxListInput,
  NotificationInboxMutationInput,
  NotificationPage,
  NotificationEndpoint,
  NotificationEndpointChannel,
  NotificationEndpointCreateResult,
  NotificationEndpointReservation,
  NotificationPreference,
  NotificationReceipt,
  NotificationReceiptReconciliation,
  NotificationQueueMetric,
  RecordNotificationEndpointResultInput,
  ReserveNotificationEndpointInput,
  NotificationTemplate,
  NotificationTemplateSnapshot,
  NotificationTemplateVersion
} from '../types.js';
import type { NotificationOperationsRepository } from '../operations-service.js';
import type {
  NotificationEndpointHealthRepository,
  NotificationEndpointProbeResult
} from '../health-types.js';
import type {
  ArchiveNotificationTemplateInput,
  NotificationDeliveryListInput,
  NotificationEndpointListInput,
  NotificationTemplateListInput,
  NotificationTemplateVersionListInput,
  RetryNotificationDeliveryInput
} from '../types.js';

type NotificationPgRow = Record<string, unknown>;

export interface NotificationTenantEvent {
  tenant_id: string;
  type:
    | 'notification.created'
    | 'notification.delivery.updated'
    | 'notification.inbox.created'
    | 'notification.inbox.updated';
  data: Readonly<Record<string, unknown>>;
  audience_user_ids: string[];
  idempotency_key: string;
}

export interface PostgresNotificationStoreOptions {
  publish_event?: (event: NotificationTenantEvent) => void | Promise<void>;
}

export class PostgresNotificationStore implements
  NotificationDeliveryRepository,
  NotificationInboxRepository,
  NotificationEndpointAdminRepository,
  NotificationAdministrationRepository,
  NotificationReceiptRepository,
  NotificationReceiptReconciliationRepository,
  NotificationEndpointGovernanceRepository,
  NotificationOperationsRepository,
  NotificationEndpointHealthRepository {
  constructor(
    private readonly pg: PgQueryable,
    private readonly options: PostgresNotificationStoreOptions = {}
  ) {}

  async create(input: CreateNotificationRecord): Promise<NotificationCreateResult> {
    const events: NotificationTenantEvent[] = [];
    const created = await withPgTenant(this.pg, input.notification.tenant_id, async (pg) => {
      const notificationResult = await pg.query<NotificationPgRow>(
        `INSERT INTO ivekit_notifications
          (id, tenant_id, event_type, recipient_kind, recipient_ref, channels, locale,
           template_id, template_revision, content_ciphertext, content_projection, priority,
           force_delivery, business_ref_type, business_ref_id, requested_by, correlation_id,
           idempotency_key, payload_hash, policy, state, scheduled_at, retention_until,
           created_at, updated_at, completed_at)
         VALUES
          ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11::jsonb, $12,
           $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21, $22, $23,
           $24, $25, $26)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        notificationParams(input.notification)
      );
      const inserted = notificationResult.rows[0];
      if (!inserted) return this.#reloadIdempotent(pg, input);

      const deliveries: NotificationDeliveryRecord[] = [];
      for (const delivery of input.deliveries) {
        const result = await pg.query<NotificationPgRow>(
          `INSERT INTO ivekit_notification_deliveries
            (id, tenant_id, notification_id, channel, endpoint_id, provider_kind,
             provider_profile_id, recipient_ciphertext, recipient_hmac, recipient_redacted,
             payload_ciphertext, payload_hash, provider_idempotency_key, state, attempt_count,
             max_attempts, next_attempt_at, lease_token_hash, lease_until, worker_id,
             provider_request_id, provider_message_id, provider_receipt_projection,
             error_code, error_projection, created_at, updated_at, accepted_at,
             delivered_at, completed_at)
           VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, $20, $21, $22, $23::jsonb, $24, $25::jsonb,
             $26, $27, $28, $29, $30)
           RETURNING *`,
          deliveryParams(delivery)
        );
        deliveries.push(decodeDelivery(requiredRow(result.rows[0])));
      }
      const notification = decodeNotification(inserted);
      const event = notificationCreatedEvent(notification);
      if (event) {
        await appendNotificationEvent(pg, event);
        events.push(event);
      }
      return {
        notification,
        deliveries,
        created: true
      };
    });
    await this.publishEvents(events);
    return created;
  }

  async listWorkerTenants(
    now: Date,
    limit: number,
    shardIds?: readonly number[]
  ): Promise<string[]> {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
    const shards = workerShards(shardIds);
    const result = await this.pg.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM opc_notification_worker_tenant_ids($1, $2, $3::smallint[])',
      [now.toISOString(), boundedLimit, shards]
    );
    return result.rows.map((row) => String(row.tenant_id));
  }

  getNotification(tenantId: string, notificationId: string): Promise<NotificationRecord | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `SELECT notification.* FROM ivekit_notifications notification
         WHERE notification.tenant_id = $1 AND notification.id = $2`,
        [tenantId, notificationId]
      );
      return result.rows[0] ? decodeNotification(result.rows[0]) : null;
    });
  }

  claimDue(input: NotificationDeliveryClaimInput): Promise<NotificationDeliveryRecord[]> {
    const limit = Math.max(1, Math.min(Math.floor(input.limit), 200));
    const shards = workerShards(input.shard_ids);
    if (!Number.isInteger(input.lease_ms) || input.lease_ms < 1_000 || input.lease_ms > 900_000
      || !/^[a-f0-9]{64}$/.test(input.lease_token_hash)) {
      throw new NotificationError({ code: 'validation_failed', status: 422 });
    }
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `WITH candidate AS (
           SELECT delivery.id
           FROM ivekit_notification_deliveries delivery
           WHERE delivery.tenant_id = $1
             AND delivery.worker_shard = ANY($7::smallint[])
             AND (
               (delivery.state IN ('pending', 'retry_wait')
                 AND (delivery.next_attempt_at IS NULL OR delivery.next_attempt_at <= $2))
               OR (delivery.state = 'processing'
                 AND (delivery.lease_until IS NULL OR delivery.lease_until <= $2))
             )
           ORDER BY delivery.next_attempt_at NULLS FIRST, delivery.updated_at, delivery.id
           FOR UPDATE SKIP LOCKED
           LIMIT $3
         )
         UPDATE ivekit_notification_deliveries delivery
         SET state = 'processing', attempt_count = delivery.attempt_count + 1,
             worker_id = $4, lease_token_hash = $5,
             lease_until = $2::timestamptz + ($6 * INTERVAL '1 millisecond'),
             updated_at = $2
         FROM candidate
         WHERE delivery.tenant_id = $1 AND delivery.id = candidate.id
         RETURNING delivery.*`,
        [
          input.tenant_id, input.now.toISOString(), limit, input.worker_id,
          input.lease_token_hash, input.lease_ms, shards
        ]
      );
      return result.rows.map(decodeDelivery);
    });
  }

  async finishDelivery(input: NotificationDeliveryFinishInput): Promise<NotificationDeliveryRecord> {
    const events: NotificationTenantEvent[] = [];
    const delivery = await withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const terminal = ['delivered', 'failed', 'dead_letter'].includes(input.state);
      const accepted = input.state === 'accepted' || input.state === 'delivered';
      const result = await pg.query<NotificationPgRow>(
        `UPDATE ivekit_notification_deliveries
         SET state = $4,
             provider_kind = COALESCE(NULLIF($5, ''), provider_kind),
             provider_profile_id = COALESCE(NULLIF($6, ''), provider_profile_id),
             provider_request_id = $7,
             provider_message_id = $8,
             provider_receipt_projection = $9::jsonb,
             error_code = $10,
             error_projection = $11::jsonb,
             next_attempt_at = $12,
             accepted_at = CASE WHEN $13 THEN COALESCE(accepted_at, $14) ELSE accepted_at END,
             delivered_at = CASE WHEN $4 = 'delivered' THEN COALESCE(delivered_at, $14) ELSE delivered_at END,
             completed_at = CASE WHEN $15 THEN COALESCE(completed_at, $14) ELSE NULL END,
             worker_id = '', lease_token_hash = '', lease_until = NULL, updated_at = $14
         WHERE tenant_id = $1 AND id = $2 AND worker_id = $3 AND state = 'processing'
         RETURNING *`,
        [
          input.tenant_id, input.delivery_id, input.worker_id, input.state,
          input.provider_kind || '', input.provider_profile_id || '',
          input.provider_request_id || '', input.provider_message_id || '',
          JSON.stringify(input.receipt_projection || {}), input.error_code || '',
          JSON.stringify(input.error_projection || {}),
          input.next_attempt_at?.toISOString() || null, accepted,
          input.now.toISOString(), terminal
        ]
      );
      if (!result.rows[0]) {
        throw new NotificationError({ code: 'lease_lost', retryable: true, status: 409 });
      }
      const delivery = decodeDelivery(result.rows[0]);
      await convergeNotification(pg, delivery.tenant_id, delivery.notification_id, input.now);
      const event = await deliveryUpdatedEvent(pg, delivery);
      if (event) {
        await appendNotificationEvent(pg, event);
        events.push(event);
      }
      return delivery;
    });
    await this.publishEvents(events);
    return delivery;
  }

  getDelivery(tenantId: string, deliveryId: string): Promise<NotificationDeliveryRecord | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `SELECT delivery.* FROM ivekit_notification_deliveries delivery
         WHERE delivery.tenant_id = $1 AND delivery.id = $2`,
        [tenantId, deliveryId]
      );
      return result.rows[0] ? decodeDelivery(result.rows[0]) : null;
    });
  }

  listDeliveries(
    input: NotificationDeliveryListInput
  ): Promise<NotificationPage<NotificationDeliveryRecord>> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const limit = listLimit(input.limit);
      const filter = listFilter('delivery', input.tenant_id, {
        notification_id: input.notification_id || '', endpoint_id: input.endpoint_id || '',
        channel: input.channel || '', state: input.state || ''
      });
      const cursor = decodeTimeCursor(input.cursor, filter);
      const result = await pg.query<NotificationPgRow>(
        `SELECT delivery.* FROM ivekit_notification_deliveries delivery
         WHERE delivery.tenant_id = $1
           AND ($2::text = '' OR delivery.notification_id = $2)
           AND ($3::text = '' OR delivery.endpoint_id = $3)
           AND ($4::text = '' OR delivery.channel = $4)
           AND ($5::text = '' OR delivery.state = $5)
           AND (delivery.created_at, delivery.id) < ($6::timestamptz, $7)
         ORDER BY delivery.created_at DESC, delivery.id DESC
         LIMIT $8`,
        [
          input.tenant_id, input.notification_id || '', input.endpoint_id || '',
          input.channel || '', input.state || '', cursor.created_at, cursor.id, limit + 1
        ]
      );
      return timePage(result.rows.map(decodeDelivery), limit, filter);
    });
  }

  async retryDelivery(input: RetryNotificationDeliveryInput): Promise<NotificationDeliveryRecord | null> {
    const events: NotificationTenantEvent[] = [];
    const delivery = await withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `WITH current AS (
           SELECT delivery.* FROM ivekit_notification_deliveries delivery
           WHERE delivery.tenant_id = $1 AND delivery.id = $2 AND delivery.state = $3
           FOR UPDATE
         ), changed AS (
           UPDATE ivekit_notification_deliveries delivery
           SET state = 'retry_wait', next_attempt_at = $6,
               worker_id = '', lease_token_hash = '', lease_until = NULL,
               error_code = '', error_projection = '{}'::jsonb,
               completed_at = NULL, updated_at = $6
           FROM current
           WHERE delivery.tenant_id = current.tenant_id AND delivery.id = current.id
             AND (current.state <> 'uncertain' OR $7::boolean)
           RETURNING delivery.*
         ), operation AS (
           INSERT INTO ivekit_notification_delivery_operations
             (id, tenant_id, delivery_id, operation, previous_state, next_state,
              previous_error_code, actor, occurred_at)
           SELECT $4, current.tenant_id, current.id, 'manual_retry', current.state,
             changed.state, current.error_code, $5, $6
           FROM current JOIN changed ON changed.id = current.id
           RETURNING id
         ), notification_update AS (
           UPDATE ivekit_notifications notification
           SET state = 'pending', completed_at = NULL, updated_at = $6
           FROM changed, operation
           WHERE notification.tenant_id = changed.tenant_id
             AND notification.id = changed.notification_id
           RETURNING notification.id
         )
         SELECT changed.* FROM changed, operation, notification_update`,
        [
          input.tenant_id, input.delivery_id, input.expected_state, input.operation_id,
          input.actor, input.now.toISOString(), input.allow_uncertain
        ]
      );
      if (!result.rows[0]) return null;
      const delivery = decodeDelivery(result.rows[0]);
      const event = await deliveryUpdatedEvent(pg, delivery);
      if (event) {
        await appendNotificationEvent(pg, event);
        events.push(event);
      }
      return delivery;
    });
    await this.publishEvents(events);
    return delivery;
  }

  insertReceipt(
    receipt: NotificationReceipt
  ): Promise<{ receipt: NotificationReceipt; created: boolean } | null> {
    return withPgTenant(this.pg, receipt.tenant_id, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `INSERT INTO ivekit_notification_receipts
          (id, tenant_id, delivery_id, provider_kind, provider_event_id,
           receipt_status, canonical_hash, projection, occurred_at, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
         ON CONFLICT (tenant_id, provider_kind, provider_event_id) DO NOTHING
         RETURNING *`,
        receiptParams(receipt)
      );
      if (result.rows[0]) return { receipt: decodeReceipt(result.rows[0]), created: true };
      const existing = await pg.query<NotificationPgRow>(
        `SELECT receipt.* FROM ivekit_notification_receipts receipt
         WHERE receipt.tenant_id = $1 AND receipt.provider_kind = $2
           AND receipt.provider_event_id = $3`,
        [receipt.tenant_id, receipt.provider_kind, receipt.provider_event_id]
      );
      if (!existing.rows[0]) return null;
      const decoded = decodeReceipt(existing.rows[0]);
      return decoded.canonical_hash === receipt.canonical_hash
        ? { receipt: decoded, created: false }
        : null;
    });
  }

  async listReceiptTenants(limit: number): Promise<string[]> {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
    const result = await this.pg.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM opc_notification_receipt_tenant_ids($1)',
      [boundedLimit]
    );
    return result.rows.map((row) => String(row.tenant_id));
  }

  async getQueueMetrics(now: Date): Promise<NotificationQueueMetric[]> {
    const result = await this.pg.query<{
      state: string;
      depth: string | number;
      oldest_age_seconds: string | number;
    }>('SELECT state, depth, oldest_age_seconds FROM opc_notification_queue_metrics($1)', [
      now.toISOString()
    ]);
    return result.rows.map((row) => ({
      state: row.state as NotificationQueueMetric['state'],
      depth: numberValue(row.depth),
      oldest_age_seconds: numberValue(row.oldest_age_seconds)
    }));
  }

  listPendingReceipts(tenantId: string, limit: number): Promise<NotificationReceipt[]> {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 500));
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `SELECT receipt.*
         FROM ivekit_notification_receipts receipt
         JOIN ivekit_notification_deliveries delivery
           ON delivery.tenant_id = receipt.tenant_id AND delivery.id = receipt.delivery_id
         WHERE receipt.tenant_id = $1
           AND receipt.receipt_status IN ('delivered', 'failed')
           AND delivery.state IN ('processing', 'accepted', 'retry_wait', 'uncertain')
         ORDER BY receipt.received_at, receipt.id
         LIMIT $2`,
        [tenantId, boundedLimit]
      );
      return result.rows.map(decodeReceipt);
    });
  }

  async reconcileReceipt(receipt: NotificationReceipt): Promise<NotificationReceiptReconciliation> {
    if (!['delivered', 'failed'].includes(receipt.receipt_status)) return Promise.resolve('pending');
    const events: NotificationTenantEvent[] = [];
    const reconciliation = await withPgTenant(this.pg, receipt.tenant_id, async (pg) => {
      const completedAt = receipt.occurred_at || receipt.received_at;
      const result = await pg.query<NotificationPgRow>(
        `WITH receipt_input AS (
           SELECT $3::text AS receipt_status, $4::jsonb AS projection, $5::timestamptz AS completed_at
         )
         UPDATE ivekit_notification_deliveries delivery
         SET state = CASE WHEN receipt_input.receipt_status = 'delivered' THEN 'delivered' ELSE 'failed' END,
             provider_receipt_projection = receipt_input.projection,
             error_code = CASE WHEN receipt_input.receipt_status = 'failed'
               THEN 'provider_delivery_failed' ELSE '' END,
             delivered_at = CASE WHEN receipt_input.receipt_status = 'delivered'
               THEN receipt_input.completed_at ELSE delivery.delivered_at END,
             completed_at = receipt_input.completed_at,
             next_attempt_at = NULL, worker_id = '', lease_token_hash = '', lease_until = NULL,
             updated_at = $6
         FROM receipt_input
         WHERE delivery.tenant_id = $1 AND delivery.id = $2
           AND delivery.state IN ('accepted', 'retry_wait', 'uncertain')
         RETURNING delivery.*`,
        [
          receipt.tenant_id, receipt.delivery_id, receipt.receipt_status,
          JSON.stringify(receipt.projection), completedAt, receipt.received_at
        ]
      );
      if (result.rows[0]) {
        await convergeNotification(
          pg, receipt.tenant_id, text(result.rows[0].notification_id), new Date(receipt.received_at)
        );
        if (result.rows[0].id && result.rows[0].notification_id && result.rows[0].tenant_id) {
          const event = await deliveryUpdatedEvent(pg, decodeDelivery(result.rows[0]));
          if (event) {
            await appendNotificationEvent(pg, event);
            events.push(event);
          }
        }
      }
      if (result.rows[0]?.state === 'delivered') return 'delivered';
      if (result.rows[0]?.state === 'failed') return 'failed';
      const existing = await pg.query<{ state: string }>(
        `SELECT delivery.state FROM ivekit_notification_deliveries delivery
         WHERE delivery.tenant_id = $1 AND delivery.id = $2`,
        [receipt.tenant_id, receipt.delivery_id]
      );
      if (!existing.rows[0]) throw new NotificationError({ code: 'not_found', status: 404 });
      return existing.rows[0].state === receipt.receipt_status ? 'unchanged' : 'pending';
    });
    await this.publishEvents(events);
    return reconciliation;
  }

  async upsertInboxItem(item: NotificationInboxItem): Promise<NotificationInboxItem> {
    const events: NotificationTenantEvent[] = [];
    const inboxItem = await withPgTenant(this.pg, item.tenant_id, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `INSERT INTO ivekit_notification_inbox_items
          (id, tenant_id, notification_id, user_id, projection, priority,
           read_at, archived_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, notification_id, user_id) DO NOTHING
         RETURNING *`,
        [
          item.id, item.tenant_id, item.notification_id, item.user_id,
          JSON.stringify(item.projection), item.priority, item.read_at, item.archived_at,
          item.created_at, item.updated_at
        ]
      );
      if (result.rows[0]) {
        const inserted = decodeInboxItem(result.rows[0]);
        const event = inboxEvent('notification.inbox.created', inserted);
        await appendNotificationEvent(pg, event);
        events.push(event);
        return inserted;
      }
      const existing = await pg.query<NotificationPgRow>(
        `SELECT inbox.* FROM ivekit_notification_inbox_items inbox
         WHERE inbox.tenant_id = $1 AND inbox.notification_id = $2 AND inbox.user_id = $3`,
        [item.tenant_id, item.notification_id, item.user_id]
      );
      const decoded = decodeInboxItem(requiredRow(existing.rows[0]));
      if (JSON.stringify(decoded.projection) !== JSON.stringify(item.projection)
        || decoded.priority !== item.priority) {
        throw new NotificationError({ code: 'idempotency_conflict', status: 409 });
      }
      return decoded;
    });
    await this.publishEvents(events);
    return inboxItem;
  }

  listInbox(input: NotificationInboxListInput): Promise<NotificationPage<NotificationInboxItem>> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const limit = Math.max(1, Math.min(Math.floor(input.limit || 50), 200));
      const cursor = decodeInboxCursor(input.cursor);
      const result = await pg.query<NotificationPgRow>(
        `SELECT inbox.* FROM ivekit_notification_inbox_items inbox
         WHERE inbox.tenant_id = $1 AND inbox.user_id = $2
           AND (inbox.created_at, inbox.id) < ($3::timestamptz, $4)
           AND ($5::boolean OR inbox.archived_at IS NULL)
         ORDER BY inbox.created_at DESC, inbox.id DESC
         LIMIT $6`,
        [
          input.tenant_id, input.user_id, cursor.created_at, cursor.id,
          input.include_archived === true, limit + 1
        ]
      );
      const decoded = result.rows.map(decodeInboxItem);
      const hasMore = decoded.length > limit;
      const items = decoded.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        next_cursor: hasMore && last ? encodeInboxCursor(last) : null
      };
    });
  }

  countUnread(tenantId: string, userId: string): Promise<number> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<{ unread_count: string | number }>(
        `SELECT COUNT(*) AS unread_count
         FROM ivekit_notification_inbox_items
         WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL AND archived_at IS NULL`,
        [tenantId, userId]
      );
      return Math.max(0, numberValue(result.rows[0]?.unread_count || 0));
    });
  }

  async mutateInbox(input: NotificationInboxMutationInput): Promise<NotificationInboxItem | null> {
    if (!['read', 'unread', 'archive', 'unarchive'].includes(input.action)) {
      throw new NotificationError({ code: 'validation_failed', status: 422 });
    }
    const events: NotificationTenantEvent[] = [];
    const inboxItem = await withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `UPDATE ivekit_notification_inbox_items
         SET read_at = CASE
               WHEN $4 = 'read' THEN $5::timestamptz
               WHEN $4 = 'unread' THEN NULL
               ELSE read_at
             END,
             archived_at = CASE
               WHEN $4 = 'archive' THEN $5::timestamptz
               WHEN $4 = 'unarchive' THEN NULL
               ELSE archived_at
             END,
             updated_at = $5
         WHERE tenant_id = $1 AND id = $2 AND user_id = $3
         RETURNING *`,
        [input.tenant_id, input.item_id, input.user_id, input.action, input.now.toISOString()]
      );
      if (!result.rows[0]) return null;
      const item = decodeInboxItem(result.rows[0]);
      const event = inboxEvent('notification.inbox.updated', item, input.action);
      await appendNotificationEvent(pg, event);
      events.push(event);
      return item;
    });
    await this.publishEvents(events);
    return inboxItem;
  }

  getEndpoint(tenantId: string, endpointId: string): Promise<NotificationEndpoint | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `SELECT endpoint.* FROM ivekit_notification_endpoints endpoint
         WHERE endpoint.tenant_id = $1 AND endpoint.id = $2`,
        [tenantId, endpointId]
      );
      return result.rows[0] ? decodeEndpoint(result.rows[0]) : null;
    });
  }

  listEndpoints(input: NotificationEndpointListInput): Promise<NotificationPage<NotificationEndpoint>> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const limit = listLimit(input.limit);
      const filter = listFilter('endpoint', input.tenant_id, {
        channel: input.channel || '', status: input.status || ''
      });
      const cursor = decodeTimeCursor(input.cursor, filter);
      const result = await pg.query<NotificationPgRow>(
        `SELECT endpoint.* FROM ivekit_notification_endpoints endpoint
         WHERE endpoint.tenant_id = $1
           AND ($2::text = '' OR endpoint.channel = $2)
           AND ($3::text = '' OR endpoint.status = $3)
           AND (endpoint.created_at, endpoint.id) < ($4::timestamptz, $5)
         ORDER BY endpoint.created_at DESC, endpoint.id DESC
         LIMIT $6`,
        [
          input.tenant_id, input.channel || '', input.status || '',
          cursor.created_at, cursor.id, limit + 1
        ]
      );
      return timePage(result.rows.map(decodeEndpoint), limit, filter);
    });
  }

  listActiveEndpoints(
    tenantId: string,
    channel: NotificationEndpointChannel
  ): Promise<NotificationEndpoint[]> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `SELECT endpoint.* FROM ivekit_notification_endpoints endpoint
         WHERE endpoint.tenant_id = $1 AND endpoint.channel = $2 AND endpoint.status = 'active'
         ORDER BY endpoint.priority, endpoint.id`,
        [tenantId, channel]
      );
      return result.rows.map(decodeEndpoint);
    });
  }

  insertEndpoint(endpoint: NotificationEndpoint): Promise<NotificationEndpointCreateResult> {
    return withPgTenant(this.pg, endpoint.tenant_id, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `INSERT INTO ivekit_notification_endpoints
          (id, tenant_id, name, channel, provider_kind, status, endpoint_url,
           secret_ref, signing_secret_ref, event_allowlist, config, failover_group,
           priority, quota_per_minute, quota_per_day, health_status, last_health_at,
           revision, idempotency_key, payload_hash, created_by, updated_by, created_at, updated_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::jsonb, $12,
           $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        endpointParams(endpoint)
      );
      if (result.rows[0]) return { endpoint: decodeEndpoint(result.rows[0]), created: true };
      const existing = await pg.query<NotificationPgRow>(
        `SELECT endpoint.* FROM ivekit_notification_endpoints endpoint
         WHERE endpoint.tenant_id = $1 AND endpoint.idempotency_key = $2
         FOR UPDATE`,
        [endpoint.tenant_id, endpoint.idempotency_key]
      );
      const decoded = decodeEndpoint(requiredRow(existing.rows[0]));
      if (decoded.payload_hash !== endpoint.payload_hash) {
        throw new NotificationError({ code: 'idempotency_conflict', status: 409 });
      }
      return { endpoint: decoded, created: false };
    });
  }

  updateEndpoint(endpoint: NotificationEndpoint, expectedRevision: number): Promise<NotificationEndpoint> {
    return withPgTenant(this.pg, endpoint.tenant_id, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `UPDATE ivekit_notification_endpoints
         SET name = $3, channel = $4, provider_kind = $5, status = $6,
             endpoint_url = $7, secret_ref = $8, signing_secret_ref = $9,
             event_allowlist = $10::text[], config = $11::jsonb, failover_group = $12,
             priority = $13, quota_per_minute = $14, quota_per_day = $15,
             health_status = $16, last_health_at = $17, updated_by = $18,
             updated_at = $19, revision = revision + 1
         WHERE tenant_id = $1 AND id = $2 AND revision = $20
         RETURNING *`,
        [
          endpoint.tenant_id, endpoint.id, endpoint.name, endpoint.channel,
          endpoint.provider_kind, endpoint.status, endpoint.endpoint_url,
          endpoint.secret_ref, endpoint.signing_secret_ref, endpoint.event_allowlist,
          JSON.stringify(endpoint.config), endpoint.failover_group, endpoint.priority,
          endpoint.quota_per_minute, endpoint.quota_per_day, endpoint.health_status,
          endpoint.last_health_at, endpoint.updated_by, endpoint.updated_at, expectedRevision
        ]
      );
      if (!result.rows[0]) {
        throw new NotificationError({ code: 'revision_conflict', status: 409 });
      }
      return decodeEndpoint(result.rows[0]);
    });
  }

  reserveEndpoint(input: ReserveNotificationEndpointInput): Promise<NotificationEndpointReservation> {
    const { endpoint, now } = input;
    const probeLeaseMs = endpointConfigInteger(
      endpoint, 'circuit_probe_lease_ms', 30_000, 1_000, 300_000
    );
    return withPgTenant(this.pg, endpoint.tenant_id, async (pg) => {
      await pg.query(
        `INSERT INTO ivekit_notification_endpoint_runtime (tenant_id, endpoint_id)
         VALUES ($1, $2)
         ON CONFLICT (tenant_id, endpoint_id) DO NOTHING`,
        [endpoint.tenant_id, endpoint.id]
      );
      const reserved = await pg.query<NotificationPgRow>(
        `UPDATE ivekit_notification_endpoint_runtime runtime
         SET minute_used = CASE
               WHEN runtime.minute_bucket = date_trunc('minute', $3::timestamptz)
                 THEN runtime.minute_used + 1 ELSE 1 END,
             minute_bucket = date_trunc('minute', $3::timestamptz),
             day_used = CASE
               WHEN runtime.day_bucket = ($3::timestamptz AT TIME ZONE 'UTC')::date
                 THEN runtime.day_used + 1 ELSE 1 END,
             day_bucket = ($3::timestamptz AT TIME ZONE 'UTC')::date,
             circuit_state = CASE
               WHEN runtime.circuit_state IN ('open', 'half_open')
                 AND runtime.circuit_open_until <= $3
                 THEN 'half_open' ELSE runtime.circuit_state END,
             circuit_open_until = CASE
               WHEN runtime.circuit_state IN ('open', 'half_open')
                 AND runtime.circuit_open_until <= $3
                 THEN $3::timestamptz + ($6 * INTERVAL '1 millisecond')
               ELSE runtime.circuit_open_until END,
             updated_at = $3
         WHERE runtime.tenant_id = $1 AND runtime.endpoint_id = $2
           AND (runtime.circuit_state = 'closed'
             OR (runtime.circuit_state IN ('open', 'half_open')
               AND runtime.circuit_open_until <= $3))
           AND ($4::integer IS NULL OR
             (CASE WHEN runtime.minute_bucket = date_trunc('minute', $3::timestamptz)
               THEN runtime.minute_used ELSE 0 END) < $4)
           AND ($5::integer IS NULL OR
             (CASE WHEN runtime.day_bucket = ($3::timestamptz AT TIME ZONE 'UTC')::date
               THEN runtime.day_used ELSE 0 END) < $5)
         RETURNING runtime.*`,
        [
          endpoint.tenant_id, endpoint.id, now.toISOString(),
          endpoint.quota_per_minute, endpoint.quota_per_day, probeLeaseMs
        ]
      );
      if (reserved.rows[0]) return { allowed: true, reason: null, retry_at: null };
      const blocked = await pg.query<NotificationPgRow>(
        `SELECT runtime.*,
           CASE
             WHEN runtime.circuit_state IN ('open', 'half_open') AND runtime.circuit_open_until > $3
               THEN runtime.circuit_open_until
             WHEN $4::integer IS NOT NULL
               AND runtime.minute_bucket = date_trunc('minute', $3::timestamptz)
               AND runtime.minute_used >= $4
               THEN date_trunc('minute', $3::timestamptz) + INTERVAL '1 minute'
             WHEN $5::integer IS NOT NULL
               AND runtime.day_bucket = ($3::timestamptz AT TIME ZONE 'UTC')::date
               AND runtime.day_used >= $5
               THEN (($3::timestamptz AT TIME ZONE 'UTC')::date + 1)::timestamptz
             ELSE NULL
           END AS retry_at
         FROM ivekit_notification_endpoint_runtime runtime
         WHERE runtime.tenant_id = $1 AND runtime.endpoint_id = $2`,
        [
          endpoint.tenant_id, endpoint.id, now.toISOString(),
          endpoint.quota_per_minute, endpoint.quota_per_day
        ]
      );
      const row = requiredRow(blocked.rows[0]);
      const circuitOpen = ['open', 'half_open'].includes(text(row.circuit_state))
        && row.circuit_open_until != null
        && Date.parse(timestamp(row.circuit_open_until)) > now.getTime();
      return {
        allowed: false,
        reason: circuitOpen ? 'circuit_open' : 'quota_exhausted',
        retry_at: nullableTimestamp(row.retry_at)
      };
    });
  }

  recordEndpointResult(input: RecordNotificationEndpointResultInput): Promise<void> {
    const { endpoint, now } = input;
    return withPgTenant(this.pg, endpoint.tenant_id, async (pg) => {
      await pg.query(
        `INSERT INTO ivekit_notification_endpoint_runtime (tenant_id, endpoint_id)
         VALUES ($1, $2)
         ON CONFLICT (tenant_id, endpoint_id) DO NOTHING`,
        [endpoint.tenant_id, endpoint.id]
      );
      if (input.outcome === 'success') {
        await pg.query(
          `UPDATE ivekit_notification_endpoint_runtime runtime
           SET consecutive_failures = 0, circuit_state = 'closed', circuit_open_until = NULL,
               last_error_code = '', last_success_at = $3, updated_at = $3
           WHERE runtime.tenant_id = $1 AND runtime.endpoint_id = $2`,
          [endpoint.tenant_id, endpoint.id, now.toISOString()]
        );
        await updateEndpointHealth(pg, endpoint, 'healthy', now);
        return;
      }
      const threshold = endpointConfigInteger(endpoint, 'circuit_failure_threshold', 5, 1, 20);
      const openMs = endpointConfigInteger(endpoint, 'circuit_open_ms', 60_000, 1_000, 3_600_000);
      const result = await pg.query<{ circuit_state: string }>(
        `UPDATE ivekit_notification_endpoint_runtime runtime
         SET consecutive_failures = runtime.consecutive_failures + 1,
             circuit_state = CASE
               WHEN runtime.circuit_state = 'half_open'
                 OR runtime.consecutive_failures + 1 >= $3 THEN 'open'
               ELSE runtime.circuit_state END,
             circuit_open_until = CASE
               WHEN runtime.circuit_state = 'half_open'
                 OR runtime.consecutive_failures + 1 >= $3
                 THEN $4::timestamptz + ($5 * INTERVAL '1 millisecond')
               ELSE runtime.circuit_open_until END,
             last_error_code = 'provider_delivery_failed',
             last_failure_at = $4, updated_at = $4
         WHERE runtime.tenant_id = $1 AND runtime.endpoint_id = $2
         RETURNING runtime.consecutive_failures, runtime.circuit_state`,
        [endpoint.tenant_id, endpoint.id, threshold, now.toISOString(), openMs]
      );
      await updateEndpointHealth(
        pg, endpoint, result.rows[0]?.circuit_state === 'open' ? 'unhealthy' : 'degraded', now
      );
    });
  }

  async listHealthTenants(now: Date, staleBefore: Date, limit: number): Promise<string[]> {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
    const result = await this.pg.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM opc_notification_health_tenant_ids($1, $2, $3)',
      [now.toISOString(), staleBefore.toISOString(), boundedLimit]
    );
    return result.rows.map((row) => String(row.tenant_id));
  }

  claimHealthEndpoints(input: {
    tenant_id: string;
    worker_id: string;
    lease_token_hash: string;
    now: Date;
    stale_before: Date;
    lease_ms: number;
    limit: number;
  }): Promise<NotificationEndpoint[]> {
    const limit = Math.max(1, Math.min(Math.floor(input.limit), 200));
    if (!/^[a-f0-9]{64}$/.test(input.lease_token_hash)
      || input.lease_ms < 1_000 || input.lease_ms > 300_000
      || !input.worker_id || input.worker_id.length > 255) {
      throw new NotificationError({ code: 'validation_failed', status: 422 });
    }
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      await pg.query(
        `INSERT INTO ivekit_notification_endpoint_runtime (tenant_id, endpoint_id)
         SELECT endpoint.tenant_id, endpoint.id
         FROM ivekit_notification_endpoints endpoint
         WHERE endpoint.tenant_id = $1 AND endpoint.status IN ('active', 'degraded')
         ON CONFLICT (tenant_id, endpoint_id) DO NOTHING`,
        [input.tenant_id]
      );
      const result = await pg.query<NotificationPgRow>(
        `WITH candidate AS (
           SELECT runtime.endpoint_id
           FROM ivekit_notification_endpoint_runtime runtime
           JOIN ivekit_notification_endpoints endpoint
             ON endpoint.tenant_id = runtime.tenant_id AND endpoint.id = runtime.endpoint_id
           WHERE runtime.tenant_id = $1 AND endpoint.status IN ('active', 'degraded')
             AND (endpoint.last_health_at IS NULL OR endpoint.last_health_at <= $2)
             AND (runtime.health_lease_until IS NULL OR runtime.health_lease_until <= $3)
           ORDER BY endpoint.last_health_at NULLS FIRST, endpoint.id
           FOR UPDATE OF runtime SKIP LOCKED
           LIMIT $4
         ), claimed AS (
           UPDATE ivekit_notification_endpoint_runtime runtime
           SET health_worker_id = $5, health_lease_token_hash = $6,
               health_lease_until = $3::timestamptz + ($7 * INTERVAL '1 millisecond'),
               updated_at = $3
           FROM candidate
           WHERE runtime.tenant_id = $1 AND runtime.endpoint_id = candidate.endpoint_id
           RETURNING runtime.endpoint_id
         )
         SELECT endpoint.* FROM ivekit_notification_endpoints endpoint
         JOIN claimed ON claimed.endpoint_id = endpoint.id
         WHERE endpoint.tenant_id = $1
         ORDER BY endpoint.last_health_at NULLS FIRST, endpoint.id`,
        [
          input.tenant_id, input.stale_before.toISOString(), input.now.toISOString(), limit,
          input.worker_id, input.lease_token_hash, input.lease_ms
        ]
      );
      return result.rows.map(decodeEndpoint);
    });
  }

  finishHealthProbe(input: {
    endpoint: NotificationEndpoint;
    worker_id: string;
    lease_token_hash: string;
    result: NotificationEndpointProbeResult;
    now: Date;
  }): Promise<void> {
    const { endpoint, result, now } = input;
    if (!/^[a-f0-9]{64}$/.test(input.lease_token_hash)
      || !/^[a-z0-9_]{1,100}$/.test(result.code)
      || !['healthy', 'degraded', 'unhealthy'].includes(result.outcome)) {
      throw new NotificationError({ code: 'validation_failed', status: 422 });
    }
    const threshold = endpointConfigInteger(endpoint, 'circuit_failure_threshold', 5, 1, 20);
    const openMs = endpointConfigInteger(endpoint, 'circuit_open_ms', 60_000, 1_000, 3_600_000);
    return withPgTenant(this.pg, endpoint.tenant_id, async (pg) => {
      const updated = await pg.query<{ id: string }>(
        `WITH runtime_update AS (
           UPDATE ivekit_notification_endpoint_runtime runtime
           SET consecutive_failures = CASE
                 WHEN $5 = 'healthy' THEN 0
                 WHEN $5 = 'unhealthy' THEN runtime.consecutive_failures + 1
                 ELSE runtime.consecutive_failures END,
               circuit_state = CASE
                 WHEN $5 = 'healthy' THEN 'closed'
                 WHEN $5 = 'unhealthy' AND runtime.consecutive_failures + 1 >= $7 THEN 'open'
                 ELSE runtime.circuit_state END,
               circuit_open_until = CASE
                 WHEN $5 = 'healthy' THEN NULL
                 WHEN $5 = 'unhealthy' AND runtime.consecutive_failures + 1 >= $7
                   THEN $6::timestamptz + ($8 * INTERVAL '1 millisecond')
                 ELSE runtime.circuit_open_until END,
               last_error_code = CASE WHEN $5 = 'healthy' THEN '' ELSE $9 END,
               last_success_at = CASE WHEN $5 = 'healthy' THEN $6 ELSE runtime.last_success_at END,
               last_failure_at = CASE WHEN $5 = 'unhealthy' THEN $6 ELSE runtime.last_failure_at END,
               health_worker_id = '', health_lease_token_hash = '', health_lease_until = NULL,
               updated_at = $6
           WHERE runtime.tenant_id = $1 AND runtime.endpoint_id = $2
             AND runtime.health_worker_id = $3 AND runtime.health_lease_token_hash = $4
           RETURNING runtime.endpoint_id
         )
         UPDATE ivekit_notification_endpoints endpoint
         SET health_status = $5, last_health_at = $6, updated_at = $6
         FROM runtime_update
         WHERE endpoint.tenant_id = $1 AND endpoint.id = runtime_update.endpoint_id
         RETURNING endpoint.id`,
        [
          endpoint.tenant_id, endpoint.id, input.worker_id, input.lease_token_hash,
          result.outcome, now.toISOString(), threshold, openMs, result.code
        ]
      );
      if (!updated.rows[0]) {
        throw new NotificationError({ code: 'lease_lost', retryable: true, status: 409 });
      }
    });
  }

  createTemplate(
    template: NotificationTemplate,
    version: NotificationTemplateVersion
  ): Promise<NotificationTemplateSnapshot | null> {
    return withPgTenant(this.pg, template.tenant_id, async (pg) => {
      const inserted = await pg.query<NotificationPgRow>(
        `INSERT INTO ivekit_notification_templates
          (id, tenant_id, template_key, description, status, draft_revision,
           published_revision, created_by, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, template_key) DO NOTHING
         RETURNING *`,
        templateParams(template)
      );
      if (!inserted.rows[0]) return null;
      const versionResult = await pg.query<NotificationPgRow>(
        templateVersionInsertSql(), templateVersionParams(version)
      );
      return {
        template: decodeTemplate(inserted.rows[0]),
        version: decodeTemplateVersion(requiredRow(versionResult.rows[0]))
      };
    });
  }

  getTemplate(tenantId: string, templateId: string): Promise<NotificationTemplate | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `SELECT template.* FROM ivekit_notification_templates template
         WHERE template.tenant_id = $1 AND template.id = $2`,
        [tenantId, templateId]
      );
      return result.rows[0] ? decodeTemplate(result.rows[0]) : null;
    });
  }

  listTemplates(input: NotificationTemplateListInput): Promise<NotificationPage<NotificationTemplate>> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const limit = listLimit(input.limit);
      const filter = listFilter('template', input.tenant_id, { status: input.status || '' });
      const cursor = decodeTimeCursor(input.cursor, filter);
      const result = await pg.query<NotificationPgRow>(
        `SELECT template.* FROM ivekit_notification_templates template
         WHERE template.tenant_id = $1
           AND ($2::text = '' OR template.status = $2)
           AND (template.created_at, template.id) < ($3::timestamptz, $4)
         ORDER BY template.created_at DESC, template.id DESC
         LIMIT $5`,
        [input.tenant_id, input.status || '', cursor.created_at, cursor.id, limit + 1]
      );
      return timePage(result.rows.map(decodeTemplate), limit, filter);
    });
  }

  listTemplateVersions(
    input: NotificationTemplateVersionListInput
  ): Promise<NotificationPage<NotificationTemplateVersion>> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const limit = listLimit(input.limit);
      const filter = listFilter('template_version', input.tenant_id, {
        template_id: input.template_id, locale: input.locale || ''
      });
      const cursor = decodeVersionCursor(input.cursor, filter);
      const result = await pg.query<NotificationPgRow>(
        `SELECT version.* FROM ivekit_notification_template_versions version
         WHERE version.tenant_id = $1 AND version.template_id = $2
           AND ($3::text = '' OR version.locale = $3)
           AND (version.revision, version.locale) < ($4::integer, $5)
         ORDER BY version.revision DESC, version.locale DESC
         LIMIT $6`,
        [
          input.tenant_id, input.template_id, input.locale || '',
          cursor.revision, cursor.locale, limit + 1
        ]
      );
      const decoded = result.rows.map(decodeTemplateVersion);
      const items = decoded.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        next_cursor: decoded.length > limit && last
          ? encodeListCursor(filter, { revision: last.revision, locale: last.locale })
          : null
      };
    });
  }

  archiveTemplate(input: ArchiveNotificationTemplateInput): Promise<NotificationTemplate | null> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `UPDATE ivekit_notification_templates template
         SET status = 'archived', updated_by = $3, updated_at = CURRENT_TIMESTAMP
         WHERE template.tenant_id = $1 AND template.id = $2
           AND template.status <> 'archived'
           AND GREATEST(template.draft_revision, COALESCE(template.published_revision, 0)) = $4
         RETURNING template.*`,
        [input.tenant_id, input.template_id, input.actor, input.expected_revision]
      );
      return result.rows[0] ? decodeTemplate(result.rows[0]) : null;
    });
  }

  getTemplateByKey(tenantId: string, templateKey: string): Promise<NotificationTemplate | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `SELECT template.* FROM ivekit_notification_templates template
         WHERE template.tenant_id = $1 AND template.template_key = $2`,
        [tenantId, templateKey]
      );
      return result.rows[0] ? decodeTemplate(result.rows[0]) : null;
    });
  }

  getTemplateVersion(
    tenantId: string,
    templateId: string,
    revision: number,
    locale: string
  ): Promise<NotificationTemplateVersion | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `SELECT version.* FROM ivekit_notification_template_versions version
         WHERE version.tenant_id = $1 AND version.template_id = $2
           AND version.revision = $3 AND version.locale = $4`,
        [tenantId, templateId, revision, locale]
      );
      return result.rows[0] ? decodeTemplateVersion(result.rows[0]) : null;
    });
  }

  appendTemplateVersion(
    template: NotificationTemplate,
    version: NotificationTemplateVersion,
    expectedRevision: number
  ): Promise<NotificationTemplateSnapshot | null> {
    return withPgTenant(this.pg, template.tenant_id, async (pg) => {
      const updated = await pg.query<NotificationPgRow>(
        `UPDATE ivekit_notification_templates
         SET description = $3, status = $4, draft_revision = $5,
             published_revision = $6, updated_by = $7, updated_at = $8
         WHERE tenant_id = $1 AND id = $2
           AND GREATEST(draft_revision, COALESCE(published_revision, 0)) = $9
         RETURNING *`,
        [
          template.tenant_id, template.id, template.description, template.status,
          template.draft_revision, template.published_revision, template.updated_by,
          template.updated_at, expectedRevision
        ]
      );
      if (!updated.rows[0]) return null;
      const versionResult = await pg.query<NotificationPgRow>(
        templateVersionInsertSql(), templateVersionParams(version)
      );
      return {
        template: decodeTemplate(updated.rows[0]),
        version: decodeTemplateVersion(requiredRow(versionResult.rows[0]))
      };
    });
  }

  listPreferences(tenantId: string, userId: string): Promise<NotificationPreference[]> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `SELECT preference.* FROM ivekit_notification_preferences preference
         WHERE preference.tenant_id = $1 AND preference.user_id = $2
         ORDER BY preference.event_type, preference.channel`,
        [tenantId, userId]
      );
      return result.rows.map(decodePreference);
    });
  }

  putPreference(
    preference: NotificationPreference,
    expectedRevision: number
  ): Promise<NotificationPreference | null> {
    return withPgTenant(this.pg, preference.tenant_id, async (pg) => {
      const result = await pg.query<NotificationPgRow>(
        `INSERT INTO ivekit_notification_preferences
          (tenant_id, user_id, event_type, channel, enabled, locale, quiet_hours,
           revision, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
         ON CONFLICT (tenant_id, user_id, event_type, channel) DO UPDATE
         SET enabled = EXCLUDED.enabled, locale = EXCLUDED.locale,
             quiet_hours = EXCLUDED.quiet_hours, revision = $8, updated_at = $10
         WHERE ivekit_notification_preferences.revision = $11
         RETURNING *`,
        [
          preference.tenant_id, preference.user_id, preference.event_type,
          preference.channel, preference.enabled, preference.locale,
          JSON.stringify(preference.quiet_hours), preference.revision,
          preference.created_at, preference.updated_at, expectedRevision
        ]
      );
      return result.rows[0] ? decodePreference(result.rows[0]) : null;
    });
  }

  private async publishEvents(events: readonly NotificationTenantEvent[]): Promise<void> {
    if (!this.options.publish_event) return;
    for (const event of events) {
      try {
        await this.options.publish_event(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[notification] realtime event publish failed:', message.slice(0, 300));
      }
    }
  }

  async #reloadIdempotent(
    pg: PgQueryable,
    input: CreateNotificationRecord
  ): Promise<NotificationCreateResult> {
    const existing = await pg.query<NotificationPgRow>(
      `SELECT notification.* FROM ivekit_notifications notification
       WHERE notification.tenant_id = $1 AND notification.idempotency_key = $2
       FOR UPDATE`,
      [input.notification.tenant_id, input.notification.idempotency_key]
    );
    const notification = decodeNotification(requiredRow(existing.rows[0]));
    if (notification.payload_hash !== input.notification.payload_hash) {
      throw new NotificationError({ code: 'idempotency_conflict', status: 409 });
    }
    const deliveries = await pg.query<NotificationPgRow>(
      `SELECT delivery.* FROM ivekit_notification_deliveries delivery
       WHERE delivery.tenant_id = $1 AND delivery.notification_id = $2
       ORDER BY delivery.created_at, delivery.id`,
      [notification.tenant_id, notification.id]
    );
    return {
      notification,
      deliveries: deliveries.rows.map(decodeDelivery),
      created: false
    };
  }
}

async function appendNotificationEvent(
  pg: PgQueryable,
  event: NotificationTenantEvent
): Promise<void> {
  await new IveKitTenantEventJournal(pg).append(event);
}

function notificationCreatedEvent(
  notification: NotificationRecord
): NotificationTenantEvent | null {
  if (notification.recipient_kind !== 'user' || !notification.recipient_ref) return null;
  return {
    tenant_id: notification.tenant_id,
    type: 'notification.created',
    data: {
      notification_id: notification.id,
      event_type: notification.event_type,
      channels: notification.channels,
      priority: notification.priority,
      state: notification.state,
      scheduled_at: notification.scheduled_at,
      business_ref: {
        type: notification.business_ref_type,
        id: notification.business_ref_id
      },
      created_at: notification.created_at
    },
    audience_user_ids: [notification.recipient_ref],
    idempotency_key: notificationEventKey('created', notification.id)
  };
}

async function deliveryUpdatedEvent(
  pg: PgQueryable,
  delivery: NotificationDeliveryRecord
): Promise<NotificationTenantEvent | null> {
  const recipient = await pg.query<{ recipient_kind: string; recipient_ref: string }>(
    `SELECT notification.recipient_kind, notification.recipient_ref
     FROM ivekit_notifications notification
     WHERE notification.tenant_id = $1 AND notification.id = $2`,
    [delivery.tenant_id, delivery.notification_id]
  );
  const audience = recipient.rows[0];
  if (audience?.recipient_kind !== 'user' || !audience.recipient_ref) return null;
  return {
    tenant_id: delivery.tenant_id,
    type: 'notification.delivery.updated',
    data: {
      notification_id: delivery.notification_id,
      delivery_id: delivery.id,
      channel: delivery.channel,
      state: delivery.state,
      attempt_count: delivery.attempt_count,
      max_attempts: delivery.max_attempts,
      next_attempt_at: delivery.next_attempt_at,
      error_code: delivery.error_code,
      accepted_at: delivery.accepted_at,
      delivered_at: delivery.delivered_at,
      completed_at: delivery.completed_at,
      updated_at: delivery.updated_at
    },
    audience_user_ids: [audience.recipient_ref],
    idempotency_key: notificationEventKey(
      'delivery', delivery.id, delivery.state, delivery.attempt_count, delivery.updated_at
    )
  };
}

function inboxEvent(
  type: 'notification.inbox.created' | 'notification.inbox.updated',
  item: NotificationInboxItem,
  action = ''
): NotificationTenantEvent {
  return {
    tenant_id: item.tenant_id,
    type,
    data: {
      item_id: item.id,
      notification_id: item.notification_id,
      projection: item.projection,
      priority: item.priority,
      read_at: item.read_at,
      archived_at: item.archived_at,
      created_at: item.created_at,
      updated_at: item.updated_at,
      ...(action ? { action } : {})
    },
    audience_user_ids: [item.user_id],
    idempotency_key: notificationEventKey(
      type === 'notification.inbox.created' ? 'inbox-created' : 'inbox-updated',
      item.id,
      action,
      item.updated_at
    )
  };
}

function notificationEventKey(kind: string, ...parts: Array<string | number>): string {
  const digest = createHash('sha256')
    .update([kind, ...parts.map(String)].join('\u0000'))
    .digest('hex');
  return `notification:${kind}:${digest}`;
}

function notificationParams(row: NotificationRecord): unknown[] {
  return [
    row.id, row.tenant_id, row.event_type, row.recipient_kind, row.recipient_ref,
    row.channels, row.locale, row.template_id, row.template_revision, row.content_ciphertext,
    JSON.stringify(row.content_projection), row.priority, row.force_delivery,
    row.business_ref_type, row.business_ref_id, row.requested_by, row.correlation_id,
    row.idempotency_key, row.payload_hash, JSON.stringify(row.policy), row.state,
    row.scheduled_at, row.retention_until, row.created_at, row.updated_at, row.completed_at
  ];
}

function deliveryParams(row: NotificationDeliveryRecord): unknown[] {
  return [
    row.id, row.tenant_id, row.notification_id, row.channel, row.endpoint_id,
    row.provider_kind, row.provider_profile_id, row.recipient_ciphertext, row.recipient_hmac,
    row.recipient_redacted, row.payload_ciphertext, row.payload_hash,
    row.provider_idempotency_key, row.state, row.attempt_count, row.max_attempts,
    row.next_attempt_at, row.lease_token_hash, row.lease_until, row.worker_id,
    row.provider_request_id, row.provider_message_id,
    JSON.stringify(row.provider_receipt_projection), row.error_code,
    JSON.stringify(row.error_projection), row.created_at, row.updated_at,
    row.accepted_at, row.delivered_at, row.completed_at
  ];
}

function decodeNotification(row: NotificationPgRow): NotificationRecord {
  return {
    id: text(row.id), tenant_id: text(row.tenant_id), event_type: text(row.event_type),
    recipient_kind: text(row.recipient_kind) as NotificationRecord['recipient_kind'],
    recipient_ref: text(row.recipient_ref), channels: textArray(row.channels) as NotificationRecord['channels'],
    locale: text(row.locale), template_id: nullableText(row.template_id),
    template_revision: nullableNumber(row.template_revision),
    content_ciphertext: text(row.content_ciphertext),
    content_projection: jsonRecord(row.content_projection),
    priority: text(row.priority) as NotificationRecord['priority'],
    force_delivery: booleanValue(row.force_delivery),
    business_ref_type: text(row.business_ref_type), business_ref_id: text(row.business_ref_id),
    requested_by: text(row.requested_by), correlation_id: text(row.correlation_id),
    idempotency_key: text(row.idempotency_key), payload_hash: text(row.payload_hash),
    policy: jsonRecord(row.policy), state: text(row.state) as NotificationRecord['state'],
    scheduled_at: timestamp(row.scheduled_at), retention_until: nullableTimestamp(row.retention_until),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at),
    completed_at: nullableTimestamp(row.completed_at)
  };
}

function decodeDelivery(row: NotificationPgRow): NotificationDeliveryRecord {
  return {
    id: text(row.id), tenant_id: text(row.tenant_id), notification_id: text(row.notification_id),
    channel: text(row.channel) as NotificationDeliveryRecord['channel'],
    endpoint_id: nullableText(row.endpoint_id), provider_kind: text(row.provider_kind),
    provider_profile_id: text(row.provider_profile_id),
    recipient_ciphertext: text(row.recipient_ciphertext), recipient_hmac: text(row.recipient_hmac),
    recipient_redacted: text(row.recipient_redacted), payload_ciphertext: text(row.payload_ciphertext),
    payload_hash: text(row.payload_hash), provider_idempotency_key: text(row.provider_idempotency_key),
    state: text(row.state) as NotificationDeliveryRecord['state'],
    attempt_count: numberValue(row.attempt_count), max_attempts: numberValue(row.max_attempts),
    next_attempt_at: nullableTimestamp(row.next_attempt_at), lease_token_hash: text(row.lease_token_hash),
    lease_until: nullableTimestamp(row.lease_until), worker_id: text(row.worker_id),
    provider_request_id: text(row.provider_request_id), provider_message_id: text(row.provider_message_id),
    provider_receipt_projection: jsonRecord(row.provider_receipt_projection),
    error_code: text(row.error_code), error_projection: jsonRecord(row.error_projection),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at),
    accepted_at: nullableTimestamp(row.accepted_at), delivered_at: nullableTimestamp(row.delivered_at),
    completed_at: nullableTimestamp(row.completed_at)
  };
}

function decodeInboxItem(row: NotificationPgRow): NotificationInboxItem {
  return {
    id: text(row.id), tenant_id: text(row.tenant_id),
    notification_id: text(row.notification_id), user_id: text(row.user_id),
    projection: jsonRecord(row.projection),
    priority: text(row.priority) as NotificationInboxItem['priority'],
    read_at: nullableTimestamp(row.read_at), archived_at: nullableTimestamp(row.archived_at),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at)
  };
}

function decodeEndpoint(row: NotificationPgRow): NotificationEndpoint {
  return {
    id: text(row.id), tenant_id: text(row.tenant_id), name: text(row.name),
    channel: text(row.channel) as NotificationEndpoint['channel'],
    provider_kind: text(row.provider_kind) as NotificationEndpoint['provider_kind'],
    status: text(row.status) as NotificationEndpoint['status'],
    endpoint_url: text(row.endpoint_url), secret_ref: text(row.secret_ref),
    signing_secret_ref: text(row.signing_secret_ref), event_allowlist: textArray(row.event_allowlist),
    config: jsonRecord(row.config), failover_group: text(row.failover_group),
    priority: numberValue(row.priority), quota_per_minute: nullableNumber(row.quota_per_minute),
    quota_per_day: nullableNumber(row.quota_per_day),
    health_status: text(row.health_status) as NotificationEndpoint['health_status'],
    last_health_at: nullableTimestamp(row.last_health_at), revision: numberValue(row.revision),
    idempotency_key: text(row.idempotency_key), payload_hash: text(row.payload_hash),
    created_by: text(row.created_by), updated_by: text(row.updated_by),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at)
  };
}

function endpointParams(endpoint: NotificationEndpoint): unknown[] {
  return [
    endpoint.id, endpoint.tenant_id, endpoint.name, endpoint.channel, endpoint.provider_kind,
    endpoint.status, endpoint.endpoint_url, endpoint.secret_ref, endpoint.signing_secret_ref,
    endpoint.event_allowlist, JSON.stringify(endpoint.config), endpoint.failover_group,
    endpoint.priority, endpoint.quota_per_minute, endpoint.quota_per_day,
    endpoint.health_status, endpoint.last_health_at, endpoint.revision, endpoint.idempotency_key,
    endpoint.payload_hash, endpoint.created_by, endpoint.updated_by,
    endpoint.created_at, endpoint.updated_at
  ];
}

function receiptParams(receipt: NotificationReceipt): unknown[] {
  return [
    receipt.id, receipt.tenant_id, receipt.delivery_id, receipt.provider_kind,
    receipt.provider_event_id, receipt.receipt_status, receipt.canonical_hash,
    JSON.stringify(receipt.projection), receipt.occurred_at, receipt.received_at
  ];
}

function decodeReceipt(row: NotificationPgRow): NotificationReceipt {
  return {
    id: text(row.id), tenant_id: text(row.tenant_id), delivery_id: text(row.delivery_id),
    provider_kind: text(row.provider_kind), provider_event_id: text(row.provider_event_id),
    receipt_status: text(row.receipt_status) as NotificationReceipt['receipt_status'],
    canonical_hash: text(row.canonical_hash), projection: jsonRecord(row.projection),
    occurred_at: nullableTimestamp(row.occurred_at), received_at: timestamp(row.received_at)
  };
}

function templateParams(template: NotificationTemplate): unknown[] {
  return [
    template.id, template.tenant_id, template.template_key, template.description,
    template.status, template.draft_revision, template.published_revision,
    template.created_by, template.updated_by, template.created_at, template.updated_at
  ];
}

function templateVersionInsertSql(): string {
  return `INSERT INTO ivekit_notification_template_versions
    (tenant_id, template_id, revision, locale, channels, content, content_hash,
     published, created_by, created_at, published_at)
   VALUES ($1, $2, $3, $4, $5::text[], $6::jsonb, $7, $8, $9, $10, $11)
   RETURNING *`;
}

function templateVersionParams(version: NotificationTemplateVersion): unknown[] {
  return [
    version.tenant_id, version.template_id, version.revision, version.locale,
    version.channels, JSON.stringify(version.content), version.content_hash,
    version.published, version.created_by, version.created_at, version.published_at
  ];
}

function decodeTemplate(row: NotificationPgRow): NotificationTemplate {
  return {
    id: text(row.id), tenant_id: text(row.tenant_id), template_key: text(row.template_key),
    description: text(row.description), status: text(row.status) as NotificationTemplate['status'],
    draft_revision: numberValue(row.draft_revision),
    published_revision: nullableNumber(row.published_revision), created_by: text(row.created_by),
    updated_by: text(row.updated_by), created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at)
  };
}

function decodeTemplateVersion(row: NotificationPgRow): NotificationTemplateVersion {
  return {
    tenant_id: text(row.tenant_id), template_id: text(row.template_id),
    revision: numberValue(row.revision), locale: text(row.locale),
    channels: textArray(row.channels) as NotificationTemplateVersion['channels'],
    content: jsonRecord(row.content), content_hash: text(row.content_hash),
    published: booleanValue(row.published), created_by: text(row.created_by),
    created_at: timestamp(row.created_at), published_at: nullableTimestamp(row.published_at)
  };
}

function decodePreference(row: NotificationPgRow): NotificationPreference {
  return {
    tenant_id: text(row.tenant_id), user_id: text(row.user_id),
    event_type: text(row.event_type), channel: text(row.channel) as NotificationPreference['channel'],
    enabled: booleanValue(row.enabled), locale: text(row.locale), quiet_hours: jsonRecord(row.quiet_hours),
    revision: numberValue(row.revision), created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at)
  };
}

function encodeInboxCursor(item: NotificationInboxItem): string {
  return Buffer.from(JSON.stringify({ created_at: item.created_at, id: item.id }), 'utf8').toString('base64url');
}

function decodeInboxCursor(value: string | undefined): { created_at: string; id: string } {
  if (!value) return { created_at: '9999-12-31T23:59:59.999Z', id: '\uffff' };
  try {
    const raw = Buffer.from(value, 'base64url');
    if (raw.toString('base64url') !== value) throw new Error();
    const decoded = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    const createdAt = timestamp(decoded.created_at);
    const id = text(decoded.id);
    if (!id || id.length > 255) throw new Error();
    return { created_at: createdAt, id };
  } catch {
    throw new NotificationError({ code: 'validation_failed', status: 422 });
  }
}

function listLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new NotificationError({ code: 'validation_failed', status: 422 });
  }
  return value;
}

function listFilter(
  scope: string,
  tenantId: string,
  filters: Record<string, string>
): string {
  const canonical = JSON.stringify({
    scope,
    tenant_id: tenantId,
    filters: Object.fromEntries(Object.entries(filters).sort(([left], [right]) => left.localeCompare(right)))
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function timePage<T extends { id: string; created_at: string }>(
  decoded: T[],
  limit: number,
  filter: string
): NotificationPage<T> {
  const items = decoded.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    next_cursor: decoded.length > limit && last
      ? encodeListCursor(filter, { created_at: last.created_at, id: last.id })
      : null
  };
}

function encodeListCursor(filter: string, position: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify({ filter, ...position }), 'utf8').toString('base64url');
}

function decodeTimeCursor(
  value: string | undefined,
  expectedFilter: string
): { created_at: string; id: string } {
  if (!value) return { created_at: '9999-12-31T23:59:59.999Z', id: '\uffff' };
  const decoded = decodeListCursor(value, expectedFilter);
  const createdAt = timestamp(decoded.created_at);
  const id = text(decoded.id);
  if (!id || id.length > 255) throw invalidCursor();
  return { created_at: createdAt, id };
}

function decodeVersionCursor(
  value: string | undefined,
  expectedFilter: string
): { revision: number; locale: string } {
  if (!value) return { revision: 2_147_483_647, locale: '\uffff' };
  const decoded = decodeListCursor(value, expectedFilter);
  const revision = Number(decoded.revision);
  const locale = text(decoded.locale);
  if (!Number.isInteger(revision) || revision < 1 || !locale || locale.length > 35) {
    throw invalidCursor();
  }
  return { revision, locale };
}

function decodeListCursor(value: string, expectedFilter: string): Record<string, unknown> {
  try {
    if (!value || value.length > 2048) throw new Error();
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!decoded || Array.isArray(decoded) || decoded.filter !== expectedFilter) throw new Error();
    return decoded;
  } catch {
    throw invalidCursor();
  }
}

function invalidCursor(): NotificationError {
  return new NotificationError({ code: 'validation_failed', status: 422 });
}

function requiredRow(row: NotificationPgRow | undefined): NotificationPgRow {
  if (!row) throw new NotificationError({ code: 'not_found', status: 404 });
  return row;
}

function text(value: unknown): string {
  return String(value ?? '');
}

function nullableText(value: unknown): string | null {
  return value == null ? null : String(value);
}

function numberValue(value: unknown): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new NotificationError({ code: 'validation_failed', status: 500 });
  return result;
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : numberValue(value);
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true' || value === 1;
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new NotificationError({ code: 'validation_failed', status: 500 });
  return date.toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value == null ? null : timestamp(value);
}

function textArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NotificationError({ code: 'validation_failed', status: 500 });
  }
  return parsed as Record<string, unknown>;
}

async function updateEndpointHealth(
  pg: PgQueryable,
  endpoint: NotificationEndpoint,
  health: NotificationEndpoint['health_status'],
  now: Date
): Promise<void> {
  await pg.query(
    `UPDATE ivekit_notification_endpoints
     SET health_status = $3, last_health_at = $4, updated_at = $4
     WHERE tenant_id = $1 AND id = $2`,
    [endpoint.tenant_id, endpoint.id, health, now.toISOString()]
  );
}

async function convergeNotification(
  pg: PgQueryable,
  tenantId: string,
  notificationId: string,
  now: Date
): Promise<void> {
  await pg.query(
    `WITH delivery_summary AS (
       SELECT COUNT(*)::integer AS total,
         COUNT(*) FILTER (WHERE state = 'delivered')::integer AS delivered,
         COUNT(*) FILTER (WHERE state NOT IN ('delivered', 'failed', 'cancelled', 'dead_letter'))::integer
           AS active
       FROM ivekit_notification_deliveries
       WHERE tenant_id = $1 AND notification_id = $2
     )
     UPDATE ivekit_notifications notification
     SET state = CASE
           WHEN delivery_summary.active > 0 THEN 'processing'
           WHEN delivery_summary.delivered = delivery_summary.total THEN 'completed'
           WHEN delivery_summary.delivered > 0 THEN 'partial_failed'
           ELSE 'failed'
         END,
         completed_at = CASE WHEN delivery_summary.active = 0
           THEN COALESCE(notification.completed_at, $3::timestamptz) ELSE NULL END,
         updated_at = $3
     FROM delivery_summary
     WHERE notification.tenant_id = $1 AND notification.id = $2
       AND delivery_summary.total > 0`,
    [tenantId, notificationId, now.toISOString()]
  );
}

function endpointConfigInteger(
  endpoint: NotificationEndpoint,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = endpoint.config[key];
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new NotificationError({ code: 'validation_failed', status: 422 });
  }
  return parsed;
}

function workerShards(value: readonly number[] | undefined): number[] {
  const shards = value?.length
    ? [...new Set(value.map(Number))]
    : Array.from({ length: 1024 }, (_, index) => index);
  if (
    shards.length < 1 ||
    shards.length > 1024 ||
    shards.some((shard) =>
      !Number.isInteger(shard) || shard < 0 || shard > 1023
    )
  ) {
    throw new NotificationError({ code: 'validation_failed', status: 422 });
  }
  return shards.sort((left, right) => left - right);
}
