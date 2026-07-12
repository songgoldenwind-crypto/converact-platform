import { createHmac, timingSafeEqual } from 'node:crypto';

import type { PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import type { AuthRole } from '../../middleware/auth.js';

export type IveKitEventVisibilityScope = 'tenant' | 'chat_session' | 'media_call' | 'remote_session';

export interface IveKitTenantEvent {
  event_id: string;
  cursor: string;
  tenant_id: string;
  type: string;
  data: unknown;
  timestamp: string;
  expires_at: string;
  visibility_scope: IveKitEventVisibilityScope;
  visibility_ref_id: string;
  audience_user_ids: string[];
}

export interface IveKitTenantEventPage {
  items: IveKitTenantEvent[];
  next_cursor: string;
  has_more: boolean;
  snapshot_required: boolean;
  reason?: 'invalid_cursor' | 'cursor_tenant_mismatch' | 'cursor_expired';
}

export interface IveKitTenantEventStoreOptions {
  cursor_secret?: string;
  retention_ms?: number;
  max_payload_bytes?: number;
  now?: () => Date;
}

export interface IveKitTenantEventRetentionSummary {
  tenants: number;
  deleted: number;
}

interface EventCursorPayload {
  v: 1;
  tenant_id: string;
  event_id: string;
  issued_at: string;
}

interface EventRow extends Record<string, unknown> {
  id: string | number | bigint;
  tenant_id: string;
  event_type: string;
  visibility_scope: IveKitEventVisibilityScope;
  visibility_ref_id: string;
  audience_user_ids: string[];
  payload: unknown;
  occurred_at: string | Date;
  expires_at: string | Date;
  visible?: boolean;
}

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1_024;
const MAX_AUDIENCE_USERS = 200;
const MAX_SCAN_EVENTS = 2_000;

export class IveKitTenantEventStore {
  private readonly cursorSecret: string;
  private readonly retentionMs: number;
  private readonly maxPayloadBytes: number;
  private readonly now: () => Date;

  constructor(
    private readonly pg: PgQueryable,
    options: IveKitTenantEventStoreOptions = {}
  ) {
    this.cursorSecret = String(
      options.cursor_secret || process.env.OPC_IVEKIT_EVENT_CURSOR_SECRET || process.env.OPC_JWT_SECRET || ''
    );
    if (!this.cursorSecret) throw new Error('iveKit event cursor secret is required');
    this.retentionMs = positiveInteger(
      options.retention_ms ?? envNumber('OPC_IVEKIT_EVENT_RETENTION_MS', DEFAULT_RETENTION_MS),
      DEFAULT_RETENTION_MS,
      'retention_ms'
    );
    this.maxPayloadBytes = positiveInteger(
      options.max_payload_bytes ?? envNumber('OPC_IVEKIT_EVENT_MAX_PAYLOAD_BYTES', DEFAULT_MAX_PAYLOAD_BYTES),
      DEFAULT_MAX_PAYLOAD_BYTES,
      'max_payload_bytes'
    );
    this.now = options.now || (() => new Date());
  }

  async append(input: {
    tenant_id: string;
    type: string;
    data: unknown;
    audience_user_ids?: string[];
  }): Promise<IveKitTenantEvent> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const type = requiredText(input.type, 'type');
    const data = safeReplayPayload(input.data);
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized, 'utf8') > this.maxPayloadBytes) {
      throw Object.assign(new Error('tenant event payload exceeds configured size limit'), { status: 413 });
    }
    const audience = uniqueTexts(input.audience_user_ids || [], MAX_AUDIENCE_USERS);
    const visibility = inferIveKitEventVisibility(data);
    const occurredAt = this.now();
    const expiresAt = new Date(occurredAt.getTime() + this.retentionMs);
    const result = await withPgTenant(this.pg, tenantId, (pg) => pg.query<EventRow>(
        `INSERT INTO ivekit_tenant_events
          (tenant_id, event_type, visibility_scope, visibility_ref_id,
           audience_user_ids, payload, occurred_at, expires_at)
         VALUES ($1, $2, $3, $4, $5::text[], $6::jsonb, $7, $8)
         RETURNING *`,
        [
          tenantId,
          type,
          visibility.scope,
          visibility.ref_id,
          audience,
          serialized,
          occurredAt.toISOString(),
          expiresAt.toISOString()
        ]
      ));
    if (!result.rows[0]) throw new Error('tenant event was not persisted');
    return this.decodeEvent(result.rows[0]);
  }

  async headCursor(tenantIdInput: string): Promise<string> {
    const tenantId = requiredText(tenantIdInput, 'tenant_id');
    const result = await withPgTenant(this.pg, tenantId, (pg) => pg.query<{ head_event_id: string }>(
        `SELECT COALESCE(MAX(id), 0)::text AS head_event_id
         FROM ivekit_tenant_events
         WHERE tenant_id = $1`,
        [tenantId]
      ));
    return this.encodeCursor(tenantId, String(result.rows[0]?.head_event_id || '0'));
  }

  async list(input: {
    tenant_id: string;
    user_id: string;
    role: AuthRole;
    cursor: string;
    limit?: number;
  }): Promise<IveKitTenantEventPage> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const userId = requiredText(input.user_id, 'user_id');
    const cursor = this.decodeCursor(input.cursor, tenantId);
    if ('reason' in cursor) {
      return {
        items: [],
        next_cursor: '',
        has_more: false,
        snapshot_required: true,
        reason: cursor.reason
      };
    }

    return withPgTenant(this.pg, tenantId, async (pg) => {
      const limit = boundedInteger(input.limit, 50, 1, 200);
      const privileged = input.role === 'owner' || input.role === 'admin' || input.role === 'system';
      const now = this.now().toISOString();
      const items: IveKitTenantEvent[] = [];
      let scannedId = cursor.event_id;
      let scanned = 0;
      let hasMore = false;

      while (scanned < MAX_SCAN_EVENTS) {
        const batchSize = Math.min(200, MAX_SCAN_EVENTS - scanned);
        const result = await pg.query<EventRow>(visibleEventQuery(), [
          tenantId,
          scannedId,
          now,
          userId,
          privileged,
          batchSize
        ]);
        if (result.rows.length === 0) break;

        let stoppedAtLimit = false;
        for (const row of result.rows) {
          if (row.visible === true || String(row.visible) === 'true') {
            if (items.length >= limit) {
              hasMore = true;
              stoppedAtLimit = true;
              break;
            }
            items.push(this.decodeEvent(row));
          }
          scannedId = String(row.id);
          scanned += 1;
        }
        if (stoppedAtLimit) break;
        if (result.rows.length < batchSize) break;
        if (scanned >= MAX_SCAN_EVENTS) hasMore = true;
      }

      return {
        items,
        next_cursor: this.encodeCursor(tenantId, scannedId),
        has_more: hasMore,
        snapshot_required: false
      };
    });
  }

  async canView(
    event: IveKitTenantEvent,
    viewer: { user_id: string; role: AuthRole }
  ): Promise<boolean> {
    if (event.audience_user_ids.length > 0) return event.audience_user_ids.includes(viewer.user_id);
    if (viewer.role === 'owner' || viewer.role === 'admin' || viewer.role === 'system') return true;
    const scope = event.visibility_scope;
    if (scope === 'tenant') return true;
    const result = await withPgTenant(this.pg, event.tenant_id, (pg) => pg.query<{ visible: boolean }>(
      visibilityProbeQuery(scope),
      [event.tenant_id, event.visibility_ref_id, viewer.user_id]
    ));
    return result.rows[0]?.visible === true || String(result.rows[0]?.visible) === 'true';
  }

  async pruneExpired(input: {
    now?: Date;
    tenant_limit: number;
    batch_size: number;
  }): Promise<IveKitTenantEventRetentionSummary> {
    const now = input.now || this.now();
    const tenantLimit = boundedInteger(input.tenant_limit, 100, 1, 1_000);
    const batchSize = boundedInteger(input.batch_size, 1_000, 1, 10_000);
    const tenants = await this.pg.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM opc_ivekit_event_retention_tenant_ids($1, $2)',
      [now.toISOString(), tenantLimit]
    );
    let deleted = 0;
    for (const row of tenants.rows) {
      const tenantId = String(row.tenant_id || '').trim();
      if (!tenantId) continue;
      const result = await withPgTenant(this.pg, tenantId, (pg) => pg.query(
        `WITH doomed AS (
           SELECT id FROM ivekit_tenant_events
           WHERE tenant_id = $1 AND expires_at <= $2
           ORDER BY id ASC
           LIMIT $3
         )
         DELETE FROM ivekit_tenant_events event
         USING doomed
         WHERE event.id = doomed.id
         RETURNING event.id`,
        [tenantId, now.toISOString(), batchSize]
      ));
      deleted += result.rowCount ?? result.rows.length;
    }
    return { tenants: tenants.rows.length, deleted };
  }

  private decodeEvent(row: EventRow): IveKitTenantEvent {
    const eventId = String(row.id);
    return {
      event_id: eventId,
      cursor: this.encodeCursor(String(row.tenant_id), eventId),
      tenant_id: String(row.tenant_id),
      type: String(row.event_type),
      data: jsonValue(row.payload),
      timestamp: timestamp(row.occurred_at),
      expires_at: timestamp(row.expires_at),
      visibility_scope: row.visibility_scope,
      visibility_ref_id: String(row.visibility_ref_id || ''),
      audience_user_ids: arrayValue(row.audience_user_ids)
    };
  }

  private encodeCursor(tenantId: string, eventId: string): string {
    const payload: EventCursorPayload = {
      v: 1,
      tenant_id: tenantId,
      event_id: eventId,
      issued_at: this.now().toISOString()
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.cursorSecret).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  private decodeCursor(
    value: string,
    tenantId: string
  ): EventCursorPayload | { reason: IveKitTenantEventPage['reason'] } {
    const [body, signature, extra] = String(value || '').split('.');
    if (!body || !signature || extra) return { reason: 'invalid_cursor' };
    const expected = createHmac('sha256', this.cursorSecret).update(body).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, 'base64url');
    } catch {
      return { reason: 'invalid_cursor' };
    }
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { reason: 'invalid_cursor' };
    }
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as EventCursorPayload;
      if (
        payload.v !== 1 || !payload.tenant_id || !/^\d+$/.test(String(payload.event_id)) ||
        !Number.isFinite(Date.parse(payload.issued_at))
      ) return { reason: 'invalid_cursor' };
      if (payload.tenant_id !== tenantId) return { reason: 'cursor_tenant_mismatch' };
      if (this.now().getTime() - Date.parse(payload.issued_at) > this.retentionMs) {
        return { reason: 'cursor_expired' };
      }
      return payload;
    } catch {
      return { reason: 'invalid_cursor' };
    }
  }
}

export function iveKitEventReplayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = String(env.OPC_IVEKIT_EVENT_REPLAY_ENABLED || '').trim();
  if (configured && configured !== '0' && configured !== '1') {
    throw new Error('OPC_IVEKIT_EVENT_REPLAY_ENABLED must be 0 or 1');
  }
  const hasSecret = Boolean(String(
    env.OPC_IVEKIT_EVENT_CURSOR_SECRET || env.OPC_JWT_SECRET || ''
  ).trim());
  if (configured === '1' && !hasSecret) {
    throw new Error('OPC_IVEKIT_EVENT_CURSOR_SECRET or OPC_JWT_SECRET is required when event replay is enabled');
  }
  return configured === '1' || (!configured && hasSecret);
}

export function inferIveKitEventVisibility(data: unknown): {
  scope: IveKitEventVisibilityScope;
  ref_id: string;
} {
  const record = objectValue(data);
  const remoteSessionId = firstText(record.remote_session_id, objectValue(record.remote_session).id);
  if (remoteSessionId) return { scope: 'remote_session', ref_id: remoteSessionId };
  const callId = firstText(
    record.call_id,
    objectValue(record.call).id,
    objectValue(objectValue(record.snapshot).call).id
  );
  if (callId) return { scope: 'media_call', ref_id: callId };
  const sessionId = firstText(
    record.session_id,
    objectValue(record.attachment).session_id,
    objectValue(record.job).session_id
  );
  if (sessionId) return { scope: 'chat_session', ref_id: sessionId };
  return { scope: 'tenant', ref_id: '' };
}

function visibleEventQuery(): string {
  return `SELECT event.*,
    CASE
      WHEN cardinality(event.audience_user_ids) > 0
        THEN $4 = ANY(event.audience_user_ids)
      WHEN $5::boolean THEN TRUE
      WHEN event.visibility_scope = 'tenant' THEN TRUE
      WHEN event.visibility_scope = 'chat_session' THEN EXISTS (
        SELECT 1 FROM collaboration_participants participant
        WHERE participant.tenant_id = event.tenant_id
          AND participant.session_id = event.visibility_ref_id
          AND participant.identity = $4
          AND participant.left_at IS NULL
      )
      WHEN event.visibility_scope = 'media_call' THEN EXISTS (
        SELECT 1 FROM ivekit_media_call_participants participant
        WHERE participant.tenant_id = event.tenant_id
          AND participant.call_id = event.visibility_ref_id
          AND participant.identity = $4
          AND participant.status IN ('invited', 'ringing', 'accepted', 'joined')
      )
      WHEN event.visibility_scope = 'remote_session' THEN EXISTS (
        SELECT 1
        FROM remote_assistance_sessions remote
        JOIN collaboration_participants participant
          ON participant.tenant_id = remote.tenant_id
         AND participant.session_id = remote.collaboration_session_id
        WHERE remote.tenant_id = event.tenant_id
          AND remote.id = event.visibility_ref_id
          AND participant.identity = $4
          AND participant.left_at IS NULL
      )
      ELSE FALSE
    END AS visible
  FROM ivekit_tenant_events event
  WHERE event.tenant_id = $1
    AND event.id > $2::bigint
    AND event.expires_at > $3::timestamptz
  ORDER BY event.id ASC
  LIMIT $6`;
}

function visibilityProbeQuery(scope: Exclude<IveKitEventVisibilityScope, 'tenant'>): string {
  if (scope === 'chat_session') {
    return `SELECT EXISTS (
      SELECT 1 FROM collaboration_participants participant
      WHERE participant.tenant_id = $1 AND participant.session_id = $2
        AND participant.identity = $3 AND participant.left_at IS NULL
    ) AS visible`;
  }
  if (scope === 'media_call') {
    return `SELECT EXISTS (
      SELECT 1 FROM ivekit_media_call_participants participant
      WHERE participant.tenant_id = $1 AND participant.call_id = $2
        AND participant.identity = $3
        AND participant.status IN ('invited', 'ringing', 'accepted', 'joined')
    ) AS visible`;
  }
  return `SELECT EXISTS (
    SELECT 1
    FROM remote_assistance_sessions remote
    JOIN collaboration_participants participant
      ON participant.tenant_id = remote.tenant_id
     AND participant.session_id = remote.collaboration_session_id
    WHERE remote.tenant_id = $1 AND remote.id = $2
      AND participant.identity = $3 AND participant.left_at IS NULL
  ) AS visible`;
}

function safeReplayPayload(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value ?? null, (key, nested) => {
    if (/token|password|secret|authorization|cookie/i.test(key)) return undefined;
    if (nested && typeof nested === 'object') {
      if (seen.has(nested)) throw Object.assign(new Error('tenant event payload must be acyclic'), { status: 400 });
      seen.add(nested);
    }
    return nested;
  });
  return JSON.parse(serialized) as unknown;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    return value.slice(1, -1).split(',').map((item) => item.replace(/^"|"$/g, '')).filter(Boolean);
  }
  return [];
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function requiredText(value: unknown, field: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw Object.assign(new Error(`${field} is required`), { status: 400 });
  return normalized;
}

function uniqueTexts(values: unknown[], max: number): string[] {
  const result = [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
  if (result.length > max) throw Object.assign(new Error(`audience exceeds ${max} users`), { status: 400 });
  return result;
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${field} must be a positive integer`);
  return resolved;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw Object.assign(new Error(`limit must be between ${min} and ${max}`), { status: 400 });
  }
  return resolved;
}

function envNumber(key: string, fallback: number): number {
  const value = String(process.env[key] || '').trim();
  return value ? Number(value) : fallback;
}
