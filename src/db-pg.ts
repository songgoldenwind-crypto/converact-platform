import { resolveBrandEnv } from './config/converact-env.js';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import {
  isPostgresMigrationFile,
  readPostgresMigrationPlan,
  runPostgresMigrationsOnClient
} from './postgres-migrations.js';

const migrationsDir = dirname(fileURLToPath(import.meta.url)) + '/migrations';

export interface PgQueryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<R>>;
}

export interface PostgresPoolErrorEvent {
  event: 'postgres.pool.idle_client_error';
  error_code: string;
  action: 'connection_discarded';
}

interface PostgresPoolErrorEmitter {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

type TableRow = Record<string, unknown>;

/**
 * In-memory Postgres substitute for unit tests (CONVERACT_USE_MEMORY_PG=1).
 * Executes a focused subset of SQL used by auth + compliance stores.
 */
export class MemoryPg implements PgQueryable {
  private readonly tables = new Map<string, Map<string, TableRow>>();
  private readonly identityCounters = new Map<string, bigint>();
  private migrationVersions = new Set<string>();
  private timeCursor = Date.now();

  constructor() {
    this.ensureTable('schema_migrations');
    this.ensureTable('tenants');
    this.ensureTable('users');
    this.ensureTable('tenant_quota_limits');
    this.ensureTable('compliance_dnc_list');
    this.ensureTable('compliance_call_log');
    this.ensureTable('compliance_consent');
    this.ensureTable('collaboration_sessions');
    this.ensureTable('collaboration_participants');
    this.ensureTable('collaboration_messages');
    this.ensureTable('collaboration_message_delivery_attempts');
    this.ensureTable('collaboration_message_receipts');
    this.ensureTable('collaboration_participant_realtime_state');
    this.ensureTable('collaboration_message_mutations');
    this.ensureTable('tinode_message_mutation_outbox');
    this.ensureTable('collaboration_message_reactions');
    this.ensureTable('collaboration_message_pins');
    this.ensureTable('collaboration_message_attachments');
    this.ensureTable('collaboration_attachment_processing_jobs');
    this.ensureTable('collaboration_visual_observations');
    this.ensureTable('collaboration_message_translations');
    this.ensureTable('collaboration_chat_bindings');
    this.ensureTable('collaboration_provider_users');
    this.ensureTable('tinode_inbound_cursors');
    this.ensureTable('collaboration_policy_events');
    this.ensureTable('collaboration_policy_findings');
    this.ensureTable('collaboration_policy_finding_reviews');
    this.ensureTable('collaboration_quality_review_jobs');
    this.ensureTable('collaboration_intelligence_policies');
    this.ensureTable('collaboration_intelligence_source_links');
    this.ensureTable('collaboration_translation_jobs');
    this.ensureTable('remote_assistance_sessions');
    this.ensureTable('remote_consent_events');
    this.ensureTable('remote_tool_sessions');
    this.ensureTable('remote_audit_events');
    this.ensureTable('evidence_records');
    this.ensureTable('rustdesk_devices');
    this.ensureTable('rustdesk_access_policy_events');
    this.ensureTable('rustdesk_authorization_codes');
    this.ensureTable('rustdesk_gateway_sessions');
    this.ensureTable('rustdesk_gateway_events');
    this.ensureTable('rustdesk_device_commands');
    this.ensureTable('rustdesk_control_locks');
    this.ensureTable('rustdesk_secondary_confirmations');
    this.ensureTable('rustdesk_control_events');
    this.ensureTable('ivekit_media_calls');
    this.ensureTable('ivekit_media_call_participants');
    this.ensureTable('ivekit_media_call_actions');
    this.ensureTable('ivekit_media_moderation_actions');
    this.ensureTable('ivekit_media_moderation_commands');
    this.ensureTable('ivekit_tenant_events');
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = []
  ): Promise<QueryResult<R>> {
    const sql = text.replace(/\s+/g, ' ').trim();
    const executed = this.execute(sql, params);
    const rows = (Array.isArray(executed) ? executed : executed.rows) as R[];
    const rowCount = Array.isArray(executed)
      ? rows.length
      : executed.rowCount ?? rows.length;
    return { rows, rowCount, command: '', oid: 0, fields: [] };
  }

  private execute(sql: string, params: unknown[]): TableRow[] | { rows: TableRow[]; rowCount: number } {
    if (
      sql.startsWith('SELECT pg_try_advisory_xact_lock_shared') ||
      sql.startsWith('SELECT pg_try_advisory_xact_lock(')
    ) {
      return [{ acquired: true }];
    }
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return [];

    if (sql.includes('ivekit_unified_timeline')) {
      const tenantId = String(params[0]);
      const chatIds = new Set((params[1] as unknown[] || []).map(String));
      const mediaIds = new Set((params[2] as unknown[] || []).map(String));
      const remoteIds = new Set((params[3] as unknown[] || []).map(String));
      const refType = String(params[4]);
      const refId = String(params[5]);
      const system = params[6] === true;
      const cursorAt = params[7] == null ? '' : String(params[7]);
      const cursorId = String(params[8] || '');
      const limit = Number(params[9] || 51);
      const events: TableRow[] = [];
      const add = (row: TableRow) => {
        if (String(row.tenant_id) === tenantId) events.push(row);
      };
      for (const row of this.table('collaboration_messages').values()) {
        if (!chatIds.has(String(row.session_id))) continue;
        add({ id: `chat_message:${row.id}`, tenant_id: row.tenant_id, source: 'chat',
          event_type: 'chat.message.created', resource_type: 'chat_session', resource_id: row.session_id,
          actor_identity: row.sender_identity, occurred_at: row.created_at,
          attributes: { message_type: row.message_type }, evidence_ref: null });
      }
      for (const row of this.table('collaboration_message_mutations').values()) {
        if (!chatIds.has(String(row.session_id))) continue;
        add({ id: `chat_mutation:${row.id}`, tenant_id: row.tenant_id, source: 'chat',
          event_type: `chat.message.${row.action}`, resource_type: 'chat_session', resource_id: row.session_id,
          actor_identity: row.actor_identity, occurred_at: row.created_at,
          attributes: { message_id: row.message_id, version: row.version }, evidence_ref: null });
      }
      for (const row of this.table('ivekit_media_call_actions').values()) {
        if (!mediaIds.has(String(row.call_id))) continue;
        add({ id: `media_action:${row.id}`, tenant_id: row.tenant_id, source: 'media',
          event_type: `media.call.${row.action}`, resource_type: 'media_call', resource_id: row.call_id,
          actor_identity: row.actor_identity, occurred_at: row.created_at,
          attributes: { from_status: row.from_status, to_status: row.to_status }, evidence_ref: null });
      }
      for (const row of this.table('remote_consent_events').values()) {
        if (!remoteIds.has(String(row.remote_session_id))) continue;
        add({ id: `remote_consent:${row.id}`, tenant_id: row.tenant_id, source: 'remote',
          event_type: `remote.consent.${row.event_type}`, resource_type: 'remote_session', resource_id: row.remote_session_id,
          actor_identity: row.actor_identity, occurred_at: row.created_at,
          attributes: { scopes: jsonArray(row.scopes), expires_at: row.expires_at || null }, evidence_ref: null });
      }
      for (const row of this.table('remote_audit_events').values()) {
        if (!remoteIds.has(String(row.remote_session_id))) continue;
        add({ id: `remote_audit:${row.id}`, tenant_id: row.tenant_id, source: 'remote',
          event_type: row.event_type, resource_type: 'remote_session', resource_id: row.remote_session_id,
          actor_identity: row.actor_identity, occurred_at: row.created_at, attributes: {}, evidence_ref: null });
      }
      for (const row of this.table('evidence_records').values()) {
        const metadata = jsonObject(row.metadata);
        const visible = system || chatIds.has(String(row.session_id)) || remoteIds.has(String(row.session_id)) ||
          mediaIds.has(String(metadata.call_session_id || ''));
        if (!visible || String(row.business_ref_type) !== refType || String(row.business_ref_id) !== refId) continue;
        add({ id: `evidence:${row.id}`, tenant_id: row.tenant_id, source: 'evidence',
          event_type: `evidence.${row.kind}`, resource_type: 'evidence', resource_id: row.session_id,
          actor_identity: row.created_by, occurred_at: row.created_at, attributes: { kind: row.kind },
          evidence_ref: { id: row.id, kind: row.kind, checksum: row.checksum, retention_until: row.retention_until || null } });
      }
      for (const row of this.table('collaboration_policy_findings').values()) {
        if (!chatIds.has(String(row.session_id))) continue;
        add({ id: `quality_finding:${row.id}`, tenant_id: row.tenant_id, source: 'quality',
          event_type: `quality.finding.${row.review_status}`, resource_type: 'finding', resource_id: row.session_id,
          actor_identity: row.reviewed_by, occurred_at: row.updated_at,
          attributes: { source: row.source, policy_type: row.policy_type, severity: row.severity,
            review_status: row.review_status }, evidence_ref: null });
      }
      return events
        .filter((row) => !cursorAt || String(row.occurred_at).localeCompare(cursorAt) < 0 ||
          (String(row.occurred_at) === cursorAt && String(row.id).localeCompare(cursorId) < 0))
        .sort((left, right) => String(right.occurred_at).localeCompare(String(left.occurred_at)) ||
          String(right.id).localeCompare(String(left.id)))
        .slice(0, limit);
    }

    if (sql.startsWith('SELECT tenant_id FROM opc_worker_tenant_ids')) {
      const queue = String(params[0]);
      if (queue !== 'media_call_timeout') return [];
      const now = String(params[1]);
      const limit = Number(params[2] || 100);
      const tenantIds = new Set(
        [...this.table('ivekit_media_calls').values()]
          .filter((row) => row.status === 'ringing' && Boolean(row.ring_expires_at) && String(row.ring_expires_at) <= now)
          .map((row) => String(row.tenant_id))
      );
      return [...tenantIds].sort().slice(0, limit).map((tenant_id) => ({ tenant_id }));
    }

    if (sql.startsWith('SELECT version FROM schema_migrations')) {
      const version = String(params[0] ?? '');
      const applied = this.migrationVersions.has(version);
      return applied ? [{ version }] : [];
    }

    if (sql.startsWith('INSERT INTO schema_migrations')) {
      this.migrationVersions.add(String(params[0]));
      return [];
    }

    if (sql.startsWith('INSERT INTO ivekit_media_calls')) {
      const now = this.nowIso();
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        room_name: params[2],
        media: params[3],
        status: 'created',
        initiated_by: params[4],
        business_ref_type: params[5],
        business_ref_id: params[6],
        business_ref_display_name: params[7],
        business_ref_metadata: JSON.parse(String(params[8] || '{}')),
        title: params[9],
        metadata: JSON.parse(String(params[10] || '{}')),
        ring_timeout_seconds: params[11],
        ring_expires_at: null,
        accepted_at: null,
        started_at: null,
        ended_at: null,
        end_reason: '',
        created_at: now,
        updated_at: now
      };
      this.table('ivekit_media_calls').set(String(row.id), row);
      return [row];
    }

    if (sql.startsWith('INSERT INTO ivekit_media_call_participants')) {
      const now = this.nowIso();
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        call_id: params[2],
        identity: params[3],
        role: params[4],
        status: params[5],
        display_name: params[6],
        metadata: JSON.parse(String(params[7] || '{}')),
        invited_at: now,
        accepted_at: null,
        joined_at: params[8] || null,
        left_at: null,
        updated_at: now
      };
      this.table('ivekit_media_call_participants').set(String(row.id), row);
      return [row];
    }

    if (sql.startsWith('SELECT * FROM ivekit_media_calls') && sql.includes("status = 'ringing'")) {
      const tenantId = String(params[0]);
      const now = String(params[1]);
      const limit = Number(params[2] || 25);
      return [...this.table('ivekit_media_calls').values()]
        .filter((row) => String(row.tenant_id) === tenantId && row.status === 'ringing' &&
          Boolean(row.ring_expires_at) && String(row.ring_expires_at) <= now)
        .sort((left, right) => String(left.ring_expires_at).localeCompare(String(right.ring_expires_at)) ||
          String(left.id).localeCompare(String(right.id)))
        .slice(0, limit);
    }

    if (sql.startsWith('SELECT * FROM ivekit_media_calls') && sql.includes('business_ref_type = $2')) {
      const [tenantId, refType, refId, identity] = params.map((value) => String(value || ''));
      const limit = Number(params[4] || 50);
      const visibleCallIds = new Set(
        [...this.table('ivekit_media_call_participants').values()]
          .filter((row) => String(row.tenant_id) === tenantId && String(row.identity) === identity &&
            !['declined', 'left', 'missed', 'removed'].includes(String(row.status)))
          .map((row) => String(row.call_id))
      );
      return [...this.table('ivekit_media_calls').values()]
        .filter((row) => String(row.tenant_id) === tenantId &&
          String(row.business_ref_type) === refType && String(row.business_ref_id) === refId &&
          (!identity || visibleCallIds.has(String(row.id))))
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)) ||
          String(right.id).localeCompare(String(left.id)))
        .slice(0, limit);
    }

    if (sql.startsWith('SELECT * FROM ivekit_media_calls')) {
      const tenantId = String(params[0]);
      const lookup = String(params[1]);
      const row = sql.includes('room_name = $2')
        ? [...this.table('ivekit_media_calls').values()]
          .find((candidate) => String(candidate.room_name) === lookup)
        : this.table('ivekit_media_calls').get(lookup);
      return row && String(row.tenant_id) === tenantId ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM ivekit_media_call_participants')) {
      const tenantId = String(params[0]);
      const callId = String(params[1]);
      return [...this.table('ivekit_media_call_participants').values()]
        .filter((row) => String(row.tenant_id) === tenantId && String(row.call_id) === callId)
        .sort((left, right) => String(left.invited_at).localeCompare(String(right.invited_at)) ||
          String(left.id).localeCompare(String(right.id)));
    }

    if (sql.startsWith('UPDATE ivekit_media_calls')) {
      const row = this.table('ivekit_media_calls').get(String(params[1]));
      if (!row || String(row.tenant_id) !== String(params[0])) return [];
      row.status = params[2];
      row.ring_expires_at = params[3];
      row.accepted_at = params[4];
      row.started_at = params[5];
      row.ended_at = params[6];
      row.end_reason = params[7];
      row.updated_at = this.nowIso();
      return [row];
    }

    if (sql.startsWith('UPDATE ivekit_media_call_participants')) {
      const row = [...this.table('ivekit_media_call_participants').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[0]) &&
        String(candidate.call_id) === String(params[1]) &&
        String(candidate.identity) === String(params[2])
      );
      if (!row) return [];
      row.status = params[3];
      row.accepted_at = params[4];
      row.joined_at = params[5];
      row.left_at = params[6];
      row.updated_at = this.nowIso();
      return [row];
    }

    if (sql.startsWith('SELECT call_id, payload_hash, result_snapshot FROM ivekit_media_call_actions')) {
      const row = [...this.table('ivekit_media_call_actions').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[0]) &&
        String(candidate.idempotency_key) === String(params[1])
      );
      return row ? [row] : [];
    }

    if (sql.startsWith('INSERT INTO ivekit_media_call_actions')) {
      const duplicate = [...this.table('ivekit_media_call_actions').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[1]) &&
        String(candidate.idempotency_key) === String(params[3])
      );
      if (duplicate) throw new Error('duplicate ivekit media call action idempotency key');
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        call_id: params[2],
        idempotency_key: params[3],
        payload_hash: params[4],
        action: params[5],
        actor_identity: params[6],
        reason: params[7],
        metadata: JSON.parse(String(params[8] || '{}')),
        from_status: params[9],
        to_status: params[10],
        result_snapshot: JSON.parse(String(params[11] || '{}')),
        created_at: this.nowIso()
      };
      this.table('ivekit_media_call_actions').set(String(row.id), row);
      return [];
    }

    if (sql.startsWith('INSERT INTO ivekit_media_moderation_actions')) {
      const duplicate = [...this.table('ivekit_media_moderation_actions').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[1]) &&
        String(candidate.idempotency_key) === String(params[7])
      );
      if (duplicate) throw new Error('duplicate ivekit media moderation idempotency key');
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        call_id: params[2],
        room_name: params[3],
        participant_identity: params[4],
        action: params[5],
        actor_identity: params[6],
        idempotency_key: params[7],
        payload_hash: params[8],
        track_sid: params[9],
        source: params[10],
        muted: params[11],
        reason: params[12],
        metadata: JSON.parse(String(params[13] || '{}')),
        result_snapshot: JSON.parse(String(params[14] || '{}')),
        created_at: this.nowIso()
      };
      this.table('ivekit_media_moderation_actions').set(String(row.id), row);
      return [row];
    }

    if (sql.startsWith('SELECT * FROM ivekit_media_moderation_actions')) {
      if (sql.includes('idempotency_key = $2')) {
        const row = [...this.table('ivekit_media_moderation_actions').values()].find((candidate) =>
          String(candidate.tenant_id) === String(params[0]) &&
          String(candidate.idempotency_key) === String(params[1])
        );
        return row ? [row] : [];
      }
      return [...this.table('ivekit_media_moderation_actions').values()]
        .filter((row) =>
          String(row.tenant_id) === String(params[0]) &&
          String(row.call_id) === String(params[1])
        )
        .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)) ||
          String(left.id).localeCompare(String(right.id)));
    }

    if (sql.startsWith('INSERT INTO ivekit_media_moderation_commands')) {
      const duplicate = [...this.table('ivekit_media_moderation_commands').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[1]) &&
        String(candidate.idempotency_key) === String(params[8])
      );
      if (duplicate) return [];
      const now = this.nowIso();
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        call_id: params[2],
        room_name: params[3],
        participant_identity: params[4],
        action: params[5],
        actor_identity: params[6],
        actor_is_system: params[7],
        idempotency_key: params[8],
        payload_hash: params[9],
        request_payload: JSON.parse(String(params[10] || '{}')),
        status: 'pending',
        result_snapshot: null,
        error_code: '',
        error_message: '',
        created_at: now,
        updated_at: now,
        completed_at: null
      };
      this.table('ivekit_media_moderation_commands').set(String(row.id), row);
      return [row];
    }

    if (sql.startsWith('SELECT * FROM ivekit_media_moderation_commands')) {
      const rows = [...this.table('ivekit_media_moderation_commands').values()]
        .filter((row) => String(row.tenant_id) === String(params[0]));
      if (sql.includes('idempotency_key = $2')) {
        const row = rows.find((candidate) => String(candidate.idempotency_key) === String(params[1]));
        return row ? [row] : [];
      }
      return rows
        .filter((row) => String(row.status) === 'pending')
        .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)) ||
          String(left.id).localeCompare(String(right.id)))
        .slice(0, Number(params[1] || 50));
    }

    if (sql.startsWith('UPDATE ivekit_media_moderation_commands')) {
      const row = [...this.table('ivekit_media_moderation_commands').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[0]) &&
        String(candidate.idempotency_key) === String(params[1])
      );
      if (!row) return [];
      row.status = params[2];
      row.result_snapshot = params[3] == null ? null : JSON.parse(String(params[3]));
      row.error_code = params[4];
      row.error_message = params[5];
      row.completed_at = params[2] === 'completed' ? this.nowIso() : null;
      row.updated_at = this.nowIso();
      return [row];
    }

    if (sql.startsWith('INSERT INTO tenants')) {
      const planCode = sql.includes("'free'") ? 'free' : String(params[2] ?? 'free');
      const row: TableRow = {
        id: params[0],
        name: params[1],
        plan_code: planCode,
        status: 'active',
        settings: {},
        created_at: this.nowIso(),
        updated_at: this.nowIso()
      };
      this.table('tenants').set(String(row.id), row);
      return [];
    }

    if (sql.startsWith('SELECT id, name, plan_code, status FROM tenants WHERE id')) {
      const row = this.table('tenants').get(String(params[0]));
      return row ? [{ id: row.id, name: row.name, plan_code: row.plan_code, status: row.status }] : [];
    }

    if (sql.startsWith('SELECT status FROM tenants WHERE id')) {
      const row = this.table('tenants').get(String(params[0]));
      return row ? [{ status: row.status }] : [];
    }

    if (sql.startsWith('INSERT INTO users')) {
      const role = sql.includes("'owner'") ? 'owner' : String(params[4] ?? 'operator');
      const name = sql.includes("'owner'") ? (params[4] ?? null) : (params[5] ?? null);
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        email: params[2],
        password_hash: params[3],
        role,
        name,
        is_active: true,
        created_at: this.nowIso()
      };
      this.table('users').set(String(row.id), row);
      return [];
    }

    if (
      sql.includes('FROM users u') &&
      sql.includes('JOIN tenants t') &&
      (sql.includes('LOWER(u.email)') || sql.includes('u.email ='))
    ) {
      const email = String(params[0]).toLowerCase();
      const tenantFilter = sql.includes('u.tenant_id = $2') ? String(params[1]) : null;
      const rows: TableRow[] = [];
      for (const row of this.table('users').values()) {
        if (String(row.email).toLowerCase() !== email || row.is_active !== true) continue;
        if (tenantFilter && String(row.tenant_id) !== tenantFilter) continue;
        const tenant = this.table('tenants').get(String(row.tenant_id));
        if (!tenant) continue;
        rows.push({
          user_id: row.id,
          email: row.email,
          password_hash: row.password_hash,
          role: row.role,
          name: row.name,
          tenant_id: tenant.id,
          tenant_name: tenant.name,
          plan_code: tenant.plan_code,
          tenant_status: tenant.status
        });
      }
      return rows;
    }

    if (sql.startsWith('UPDATE users SET external_sub')) {
      const row = this.table('users').get(String(params[2]));
      if (row && String(row.tenant_id) === String(params[3])) {
        if (!row.external_sub) row.external_sub = params[0];
        if (!row.name && params[1]) row.name = params[1];
        this.table('users').set(String(row.id), row);
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('INSERT INTO users') && sql.includes('external_sub')) {
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        email: params[2],
        password_hash: params[3],
        role: params[4],
        name: params[5],
        external_sub: params[6],
        is_active: true,
        created_at: this.nowIso()
      };
      this.table('users').set(String(row.id), row);
      return [];
    }

    if (sql.includes('FROM users u') && sql.includes('u.id =') && sql.includes('u.tenant_id =')) {
      const row = this.table('users').get(String(params[0]));
      if (!row || String(row.tenant_id) !== String(params[1]) || row.is_active !== true) return [];
      const tenant = this.table('tenants').get(String(row.tenant_id));
      if (!tenant) return [];
      return [{
        user_id: row.id,
        email: row.email,
        role: row.role,
        name: row.name,
        tenant_id: tenant.id,
        tenant_name: tenant.name,
        plan_code: tenant.plan_code,
        tenant_status: tenant.status
      }];
    }

    if (sql.startsWith('INSERT INTO tenant_quota_limits')) {
      const id = String(params[0]);
      const row: TableRow = {
        id,
        tenant_id: params[1],
        quota_key: params[2],
        period: params[3] ?? 'monthly',
        hard_limit: params[4],
        soft_limit: params[5],
        status: 'active',
        created_by: params[6] ?? 'system',
        created_at: this.nowIso(),
        updated_at: this.nowIso()
      };
      const key = `${row.tenant_id}:${row.quota_key}:${row.period}`;
      this.table('tenant_quota_limits').set(key, row);
      return [];
    }

    if (
      sql.includes('INSERT INTO tenant_quota_limits') &&
      sql.includes('ON CONFLICT (tenant_id, quota_key, period)')
    ) {
      const id = String(params[0]);
      const row: TableRow = {
        id,
        tenant_id: params[1],
        quota_key: params[2],
        period: 'monthly',
        hard_limit: params[3],
        soft_limit: params[4],
        status: 'active',
        created_by: 'system',
        created_at: this.nowIso(),
        updated_at: this.nowIso()
      };
      const key = `${row.tenant_id}:${row.quota_key}:${row.period}`;
      this.table('tenant_quota_limits').set(key, row);
      return [];
    }

    if (sql.startsWith('INSERT INTO compliance_dnc_list')) {
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        phone_number: params[2],
        reason: params[3],
        added_at: this.nowIso()
      };
      const key = `${row.tenant_id}:${row.phone_number}`;
      this.table('compliance_dnc_list').set(key, row);
      return [];
    }

    if (sql.startsWith('SELECT id FROM compliance_dnc_list')) {
      const key = `${params[0]}:${params[1]}`;
      const row = this.table('compliance_dnc_list').get(key);
      return row ? [{ id: row.id }] : [];
    }

    if (sql.includes('FROM compliance_dnc_list') && sql.includes('ORDER BY')) {
      const tenantId = String(params[0]);
      return [...this.table('compliance_dnc_list').values()]
        .filter((r) => String(r.tenant_id) === tenantId)
        .map((r) => ({
          id: r.id,
          phone_number: r.phone_number,
          reason: r.reason,
          added_at: r.added_at
        }));
    }

    if (sql.startsWith('DELETE FROM compliance_dnc_list')) {
      const key = `${params[1]}:${params[0]}`;
      const existed = this.table('compliance_dnc_list').has(key);
      this.table('compliance_dnc_list').delete(key);
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    if (sql.startsWith('INSERT INTO compliance_call_log')) {
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        phone_number: params[2],
        result: params[3],
        called_at: this.nowIso()
      };
      this.table('compliance_call_log').set(String(row.id), row);
      return [];
    }

    if (sql.startsWith('SELECT COUNT(*)::int AS count FROM compliance_call_log')) {
      const tenantId = String(params[0]);
      const phone = String(params[1]);
      const since = new Date(String(params[2]));
      let count = 0;
      for (const row of this.table('compliance_call_log').values()) {
        if (String(row.tenant_id) !== tenantId || String(row.phone_number) !== phone) continue;
        if (new Date(String(row.called_at)) >= since) count += 1;
      }
      return [{ count }];
    }

    if (sql.startsWith('INSERT INTO compliance_consent')) {
      const row: TableRow = {
        id: params[0],
        call_session_id: params[1],
        tenant_id: params[2],
        consent_type: params[3],
        status: params[4],
        recorded_at: this.nowIso()
      };
      const key = `${row.call_session_id}:${row.consent_type}`;
      this.table('compliance_consent').set(key, row);
      return [];
    }

    if (sql.startsWith('SELECT status FROM compliance_consent')) {
      const key = `${params[0]}:${params[1]}`;
      const row = this.table('compliance_consent').get(key);
      return row ? [{ status: row.status }] : [];
    }

    if (sql.startsWith('INSERT INTO collaboration_sessions')) {
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        business_ref_type: params[2],
        business_ref_id: params[3],
        title: params[4],
        metadata: params[5],
        status: 'open',
        created_at: this.nowIso(),
        updated_at: this.nowIso(),
        closed_at: null
      };
      this.table('collaboration_sessions').set(String(row.id), row);
      return [];
    }

    if (sql.startsWith('SELECT * FROM collaboration_sessions WHERE id')) {
      const row = this.table('collaboration_sessions').get(String(params[0]));
      return row ? [row] : [];
    }

    if (sql.startsWith('SELECT session.id AS session_id,') && sql.includes('online_participant_count')) {
      const tenantId = String(params[0]);
      const sessionIds = new Set((params[1] as unknown[] || []).map(String));
      const identity = String(params[2] || '');
      const now = Date.now();
      return [...this.table('collaboration_sessions').values()]
        .filter((session) => String(session.tenant_id) === tenantId && sessionIds.has(String(session.id)))
        .filter((session) => [...this.table('collaboration_participants').values()].some(
          (participant) => String(participant.tenant_id) === tenantId &&
            String(participant.session_id) === String(session.id) &&
            String(participant.identity) === identity && !participant.left_at
        ))
        .map((session) => {
          const messages = [...this.table('collaboration_messages').values()]
            .filter((message) => String(message.tenant_id) === tenantId)
            .filter((message) => String(message.session_id) === String(session.id));
          const latest = messages.sort((left, right) => compareRows(right, left))[0];
          const unreadCount = identity ? messages
            .filter((message) => String(message.sender_identity) !== identity && !message.deleted_at)
            .filter((message) => ![...this.table('collaboration_message_receipts').values()].some(
              (receipt) => String(receipt.tenant_id) === tenantId &&
                String(receipt.message_id) === String(message.id) &&
                String(receipt.identity) === identity && Boolean(receipt.read_at)
            )).length : 0;
          const onlineCount = [...this.table('collaboration_participant_realtime_state').values()]
            .filter((state) => String(state.tenant_id) === tenantId)
            .filter((state) => String(state.session_id) === String(session.id))
            .filter((state) => String(state.presence_status) === 'online')
            .filter((state) => new Date(String(state.presence_expires_at || 0)).getTime() > now)
            .filter((state) => [...this.table('collaboration_participants').values()].some(
              (participant) => String(participant.tenant_id) === tenantId &&
                String(participant.session_id) === String(session.id) &&
                String(participant.identity) === String(state.identity) && !participant.left_at
            )).length;
          return {
            session_id: session.id,
            last_message_id: latest?.id || null,
            last_message_sender_identity: latest?.sender_identity || null,
            last_message_type: latest?.message_type || null,
            last_message_body: latest?.deleted_at
              ? ''
              : String(latest?.current_body || latest?.body || ''),
            last_message_created_at: latest?.created_at || null,
            last_message_deleted: Boolean(latest?.deleted_at),
            unread_count: unreadCount,
            online_participant_count: onlineCount
          };
        });
    }

    if (sql.startsWith("SELECT * FROM collaboration_sessions WHERE tenant_id = $1 AND ($2 = '' OR status = $2)")) {
      const [tenantId, status, refType, refId, query, identity, rawCursorCreatedAt, cursorId, rawLimit] = params;
      const cursorCreatedAt = rawCursorCreatedAt == null ? '' : String(rawCursorCreatedAt);
      const limit = Number(rawLimit || 51);
      return [...this.table('collaboration_sessions').values()]
        .filter((row) => String(row.tenant_id) === String(tenantId))
        .filter((row) => !status || String(row.status) === String(status))
        .filter((row) => !refType || String(row.business_ref_type) === String(refType))
        .filter((row) => !refId || String(row.business_ref_id) === String(refId))
        .filter((row) => !query || [row.title, row.business_ref_type, row.business_ref_id]
          .map((value) => String(value || '').toLowerCase()).join(' ').includes(String(query)))
        .filter((row) => !identity || [...this.table('collaboration_participants').values()].some(
          (participant) => String(participant.tenant_id) === String(tenantId) &&
            String(participant.session_id) === String(row.id) &&
            String(participant.identity) === String(identity) && !participant.left_at
        ))
        .filter((row) => !cursorCreatedAt || compareTuple(row, cursorCreatedAt, String(cursorId)) < 0)
        .sort((a, b) => compareRows(b, a))
        .slice(0, limit);
    }

    if (sql.startsWith('SELECT * FROM collaboration_sessions') && sql.includes('business_ref_type')) {
      const tenantId = String(params[0]);
      const refType = String(params[1]);
      const refId = String(params[2]);
      const identity = String(params[3] || '');
      const limit = Number(params[4] || 50);
      return [...this.table('collaboration_sessions').values()]
        .filter((row) => String(row.tenant_id) === tenantId && String(row.business_ref_type) === refType && String(row.business_ref_id) === refId)
        .filter((row) => !identity || [...this.table('collaboration_participants').values()].some(
          (participant) => String(participant.tenant_id) === tenantId &&
            String(participant.session_id) === String(row.id) &&
            String(participant.identity) === identity && !participant.left_at
        ))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
    }

    if (sql.startsWith('UPDATE collaboration_sessions')) {
      const row = this.table('collaboration_sessions').get(String(params[0]));
      if (row) {
        row.status = 'closed';
        row.updated_at = this.nowIso();
        row.closed_at = row.closed_at || this.nowIso();
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('INSERT INTO collaboration_participants')) {
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        session_id: params[2],
        identity: params[3],
        role: params[4],
        display_name: params[5],
        user_ref_type: params[6],
        user_ref_id: params[7],
        joined_at: this.nowIso(),
        left_at: null
      };
      this.table('collaboration_participants').set(String(row.id), row);
      return [];
    }

    if (sql.startsWith('SELECT * FROM collaboration_participants WHERE id')) {
      const row = this.table('collaboration_participants').get(String(params[0]));
      return row ? [row] : [];
    }

    if (sql.startsWith('UPDATE collaboration_participants SET left_at')) {
      const tenantId = String(params[0]);
      const sessionId = String(params[1]);
      const identity = String(params[2]);
      let count = 0;
      for (const row of this.table('collaboration_participants').values()) {
        if (
          String(row.tenant_id) === tenantId &&
          String(row.session_id) === sessionId &&
          String(row.identity) === identity
        ) {
          row.left_at = row.left_at || this.nowIso();
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (sql.startsWith('SELECT * FROM collaboration_participants WHERE tenant_id')) {
      const tenantId = String(params[0]);
      const sessionId = String(params[1]);
      const identity = String(params[2]);
      return [...this.table('collaboration_participants').values()]
        .filter((row) =>
          String(row.tenant_id) === tenantId &&
          String(row.session_id) === sessionId &&
          String(row.identity) === identity
        )
        .sort((a, b) => String(b.joined_at).localeCompare(String(a.joined_at)))
        .slice(0, 1);
    }

    if (sql.startsWith('SELECT * FROM collaboration_participants WHERE session_id')) {
      const sessionId = String(params[0]);
      return [...this.table('collaboration_participants').values()]
        .filter((row) => String(row.session_id) === sessionId)
        .sort((a, b) => String(a.joined_at).localeCompare(String(b.joined_at)));
    }

    if (sql.startsWith('INSERT INTO collaboration_chat_bindings')) {
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        session_id: params[2],
        provider: params[3],
        provider_topic_id: params[4],
        provider_status: params[5],
        metadata: params[6],
        created_at: this.nowIso(),
        updated_at: this.nowIso()
      };
      this.table('collaboration_chat_bindings').set(String(row.id), row);
      return [];
    }

    if (sql.startsWith('SELECT * FROM collaboration_chat_bindings WHERE id')) {
      const row = this.table('collaboration_chat_bindings').get(String(params[0]));
      return row ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM collaboration_chat_bindings WHERE tenant_id')) {
      const tenantId = String(params[0]);
      const sessionId = String(params[1]);
      const provider = params[2] != null ? String(params[2]) : '';
      const rows = [...this.table('collaboration_chat_bindings').values()]
        .filter((row) => String(row.tenant_id) === tenantId)
        .filter((row) => String(row.session_id) === sessionId)
        .filter((row) => !provider || String(row.provider) === provider)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      return rows.slice(0, 1);
    }

    if (sql.startsWith('SELECT id FROM collaboration_participants WHERE tenant_id')) {
      const row = [...this.table('collaboration_participants').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[0]) &&
        String(candidate.session_id) === String(params[1]) &&
        String(candidate.identity) === String(params[2]) &&
        !candidate.left_at
      );
      return row ? [{ id: row.id }] : [];
    }

    if (sql.startsWith('SELECT * FROM collaboration_provider_users WHERE tenant_id')) {
      const tenantId = String(params[0]);
      const sessionId = String(params[1]);
      if (sql.includes('provider_user_id = $3')) {
        const providerUserId = String(params[2]);
        const row = [...this.table('collaboration_provider_users').values()].find((candidate) =>
          String(candidate.tenant_id) === tenantId &&
          String(candidate.session_id) === sessionId &&
          String(candidate.provider) === 'tinode' &&
          String(candidate.provider_user_id) === providerUserId &&
          String(candidate.status) === 'active'
        );
        return row ? [row] : [];
      }
      const provider = String(params[2]);
      const identity = String(params[3]);
      const row = [...this.table('collaboration_provider_users').values()].find((candidate) =>
        String(candidate.tenant_id) === tenantId &&
        String(candidate.session_id) === sessionId &&
        String(candidate.provider) === provider &&
        String(candidate.identity) === identity
      );
      return row ? [row] : [];
    }

    if (sql.startsWith('INSERT INTO collaboration_provider_users')) {
      const existing = [...this.table('collaboration_provider_users').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[1]) &&
        String(candidate.session_id) === String(params[2]) &&
        String(candidate.provider) === 'tinode' &&
        String(candidate.identity) === String(params[5])
      );
      const conflicting = [...this.table('collaboration_provider_users').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[1]) &&
        String(candidate.session_id) === String(params[2]) &&
        String(candidate.provider) === 'tinode' &&
        String(candidate.provider_user_id) === String(params[4]) &&
        String(candidate.identity) !== String(params[5])
      );
      if (conflicting) throw Object.assign(new Error('duplicate provider user'), { code: '23505' });
      const now = this.nowIso();
      const row = existing || {
        id: params[0],
        tenant_id: params[1],
        session_id: params[2],
        provider: 'tinode',
        identity: params[5],
        created_at: now
      };
      row.binding_id = params[3];
      row.provider_user_id = params[4];
      row.status = 'active';
      row.metadata = params[6];
      row.updated_at = now;
      this.table('collaboration_provider_users').set(String(row.id), row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('SELECT provider_user.identity FROM collaboration_provider_users')) {
      const row = [...this.table('collaboration_provider_users').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[0]) &&
        String(candidate.binding_id) === String(params[1]) &&
        String(candidate.provider) === 'tinode' &&
        String(candidate.provider_user_id) === String(params[2]) &&
        String(candidate.status) === 'active' &&
        [...this.table('collaboration_participants').values()].some((participant) =>
          String(participant.tenant_id) === String(candidate.tenant_id) &&
          String(participant.session_id) === String(candidate.session_id) &&
          String(participant.identity) === String(candidate.identity) &&
          !participant.left_at
        )
      );
      return row ? [{ identity: row.identity }] : [];
    }

    if (sql.startsWith("UPDATE collaboration_provider_users SET status = 'revoked'")) {
      for (const row of this.table('collaboration_provider_users').values()) {
        if (
          String(row.tenant_id) === String(params[0]) &&
          String(row.session_id) === String(params[1]) &&
          String(row.provider) === String(params[2]) &&
          String(row.identity) === String(params[3])
        ) {
          row.status = 'revoked';
          row.updated_at = this.nowIso();
        }
      }
      return [];
    }

    if (
      sql.startsWith('INSERT INTO tinode_inbound_cursors') &&
      sql.includes("provider_topic_id, status") &&
      sql.includes("'paused'")
    ) {
      const tenantId = String(params[0]);
      const bindingId = String(params[2]);
      const binding = this.table('collaboration_chat_bindings').get(bindingId);
      if (
        !binding ||
        String(binding.tenant_id) !== tenantId ||
        String(binding.provider) !== 'tinode'
      ) {
        return { rows: [], rowCount: 0 };
      }
      const existing = [...this.table('tinode_inbound_cursors').values()].find((candidate) =>
        String(candidate.tenant_id) === tenantId &&
        String(candidate.binding_id) === bindingId
      );
      const now = this.nowIso();
      const row = existing || {
        id: params[1],
        tenant_id: tenantId,
        binding_id: bindingId,
        provider_topic_id: binding.provider_topic_id,
        last_data_seq: 0,
        last_del_id: 0,
        consecutive_failures: 0,
        created_at: now
      };
      row.status = 'paused';
      row.lease_token_hash = '';
      row.lease_until = null;
      row.next_retry_at = null;
      row.last_error_code = '';
      row.last_error_message = '';
      row.updated_at = now;
      this.table('tinode_inbound_cursors').set(String(row.id), row);
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE tinode_inbound_cursors SET status = 'paused'")) {
      let rowCount = 0;
      for (const row of this.table('tinode_inbound_cursors').values()) {
        if (
          String(row.tenant_id) !== String(params[0]) ||
          String(row.binding_id) !== String(params[1])
        ) continue;
        row.status = 'paused';
        row.lease_token_hash = '';
        row.lease_until = null;
        row.next_retry_at = null;
        row.last_error_code = '';
        row.last_error_message = '';
        row.updated_at = this.nowIso();
        rowCount += 1;
      }
      return { rows: [], rowCount };
    }

    if (sql.startsWith('INSERT INTO collaboration_messages')) {
      const idempotencyKey = String(params[8] || '');
      if (idempotencyKey) {
        const duplicate = [...this.table('collaboration_messages').values()].find((candidate) =>
          String(candidate.tenant_id) === String(params[1]) &&
          String(candidate.session_id) === String(params[2]) &&
          String(candidate.idempotency_key || '') === idempotencyKey
        );
        if (duplicate) return { rows: [], rowCount: 0 };
      }
      const createdAt = this.nowIso();
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        session_id: params[2],
        sender_identity: params[3],
        message_type: params[4],
        body: params[5],
        current_body: '',
        original_language: params[6],
        metadata: params[7],
        idempotency_key: params[8] || '',
        idempotency_payload_hash: params[9] || '',
        provider: params[10] || 'local',
        provider_topic_id: params[11] || '',
        provider_message_id: '',
        provider_payload: params[12] || '',
        provider_delivery_metadata: params[13] || '{}',
        provider_delivery_status: params[14] || 'not_required',
        provider_delivery_attempts: 0,
        provider_delivery_claim_token_hash: '',
        provider_delivery_lease_until: null,
        provider_next_attempt_at: null,
        provider_last_error_code: '',
        provider_last_error_message: '',
        provider_delivered_at: null,
        provider_delivery_updated_at: createdAt,
        edit_version: 0,
        edited_at: null,
        deleted_at: null,
        deleted_by: '',
        reply_to_message_id: params[15] || null,
        forwarded_from_message_id: params[16] || null,
        mentions: params[17] || '[]',
        created_at: createdAt
      };
      this.table('collaboration_messages').set(String(row.id), row);
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('SELECT id, session_id FROM collaboration_messages WHERE id')) {
      const row = this.table('collaboration_messages').get(String(params[0]));
      if (!row || String(row.tenant_id) !== String(params[1])) return [];
      return [{ id: row.id, session_id: row.session_id }];
    }

    if (sql.startsWith('SELECT id, sender_identity, body, current_body, edit_version, created_at FROM collaboration_messages')) {
      return [...this.table('collaboration_messages').values()]
        .filter((row) =>
          String(row.tenant_id) === String(params[0]) &&
          String(row.session_id) === String(params[1]) &&
          !row.deleted_at
        )
        .sort((left, right) => compareRows(right, left))
        .slice(0, Number(params[2] || 20))
        .map((row) => ({
          id: row.id, sender_identity: row.sender_identity, body: row.body,
          current_body: row.current_body, edit_version: row.edit_version, created_at: row.created_at
        }));
    }

    if (sql.startsWith('SELECT * FROM collaboration_messages WHERE id')) {
      const row = this.table('collaboration_messages').get(String(params[0]));
      if (!row) return [];
      if (sql.includes('AND tenant_id') && String(row.tenant_id) !== String(params[1])) return [];
      return [row];
    }

    if (sql.startsWith('SELECT * FROM collaboration_messages WHERE tenant_id')) {
      const tenantId = String(params[0]);
      const sessionId = String(params[1]);
      const idempotencyKey = String(params[2]);
      const row = [...this.table('collaboration_messages').values()].find((candidate) =>
        String(candidate.tenant_id) === tenantId &&
        String(candidate.session_id) === sessionId &&
        String(candidate.idempotency_key || '') === idempotencyKey
      );
      return row ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM collaboration_messages AS message WHERE tenant_id = $1')) {
      const [tenantId, sessionId, query, rawCursorCreatedAt, cursorId, rawLimit] = params;
      const cursorCreatedAt = rawCursorCreatedAt == null ? '' : String(rawCursorCreatedAt);
      const limit = Number(rawLimit || 51);
      const before = sql.includes('(created_at, id) <') || sql.includes('ORDER BY created_at DESC');
      return [...this.table('collaboration_messages').values()]
        .filter((row) => String(row.tenant_id) === String(tenantId) && String(row.session_id) === String(sessionId))
        .filter((row) => !query || (
          !row.deleted_at && String(row.current_body || row.body || '').toLowerCase().includes(String(query))
        ))
        .filter((row) => {
          if (!cursorCreatedAt) return true;
          const compared = compareTuple(row, cursorCreatedAt, String(cursorId));
          return before ? compared < 0 : compared > 0;
        })
        .sort((a, b) => before ? compareRows(b, a) : compareRows(a, b))
        .slice(0, limit);
    }

    if (sql.startsWith('SELECT * FROM collaboration_messages WHERE session_id')) {
      const sessionId = String(params[0]);
      return [...this.table('collaboration_messages').values()]
        .filter((row) => String(row.session_id) === sessionId)
        .sort((a, b) =>
          String(a.created_at).localeCompare(String(b.created_at)) ||
          String(a.id).localeCompare(String(b.id))
        );
    }

    if (sql.startsWith('SELECT id, sender_identity, deleted_at FROM collaboration_messages')) {
      return [...this.table('collaboration_messages').values()]
        .filter((row) => String(row.tenant_id) === String(params[0]))
        .filter((row) => String(row.session_id) === String(params[1]))
        .sort((a, b) =>
          String(a.created_at).localeCompare(String(b.created_at)) ||
          String(a.id).localeCompare(String(b.id))
        )
        .map((row) => ({
          id: row.id,
          sender_identity: row.sender_identity,
          deleted_at: row.deleted_at
        }));
    }

    if (sql.startsWith('INSERT INTO collaboration_message_reactions')) {
      const key = `${params[1]}:${params[3]}:${params[4]}:${params[5]}`;
      if (!this.table('collaboration_message_reactions').has(key)) {
        this.table('collaboration_message_reactions').set(key, {
          id: params[0],
          tenant_id: params[1],
          session_id: params[2],
          message_id: params[3],
          identity: params[4],
          emoji: params[5],
          created_at: this.nowIso()
        });
      }
      return [];
    }

    if (sql.startsWith('SELECT * FROM collaboration_message_reactions')) {
      return [...this.table('collaboration_message_reactions').values()]
        .filter((row) => String(row.tenant_id) === String(params[0]))
        .filter((row) => String(row.session_id) === String(params[1]))
        .filter((row) => String(row.message_id) === String(params[2]))
        .sort(compareRows);
    }

    if (sql.startsWith('DELETE FROM collaboration_message_reactions')) {
      for (const [key, row] of this.table('collaboration_message_reactions')) {
        if (
          String(row.tenant_id) === String(params[0]) && String(row.session_id) === String(params[1]) &&
          String(row.message_id) === String(params[2]) && String(row.identity) === String(params[3]) &&
          String(row.emoji) === String(params[4])
        ) this.table('collaboration_message_reactions').delete(key);
      }
      return [];
    }

    if (sql.startsWith('INSERT INTO collaboration_message_pins')) {
      const key = `${params[1]}:${params[2]}:${params[3]}`;
      if (!this.table('collaboration_message_pins').has(key)) {
        this.table('collaboration_message_pins').set(key, {
          id: params[0],
          tenant_id: params[1],
          session_id: params[2],
          message_id: params[3],
          pinned_by: params[4],
          created_at: this.nowIso()
        });
      }
      return [];
    }

    if (sql.startsWith('SELECT * FROM collaboration_message_pins')) {
      return [...this.table('collaboration_message_pins').values()]
        .filter((row) => String(row.tenant_id) === String(params[0]))
        .filter((row) => String(row.session_id) === String(params[1]))
        .sort((a, b) => compareRows(b, a));
    }

    if (sql.startsWith('DELETE FROM collaboration_message_pins')) {
      for (const [key, row] of this.table('collaboration_message_pins')) {
        if (
          String(row.tenant_id) === String(params[0]) && String(row.session_id) === String(params[1]) &&
          String(row.message_id) === String(params[2])
        ) this.table('collaboration_message_pins').delete(key);
      }
      return [];
    }

    if (sql.startsWith('SELECT COUNT(*) AS unread_count FROM collaboration_messages AS message')) {
      const tenantId = String(params[0]);
      const sessionId = String(params[1]);
      const identity = String(params[2]);
      const count = [...this.table('collaboration_messages').values()]
        .filter((row) => String(row.tenant_id) === tenantId)
        .filter((row) => String(row.session_id) === sessionId)
        .filter((row) => String(row.sender_identity) !== identity)
        .filter((row) => !row.deleted_at)
        .filter((row) => ![...this.table('collaboration_message_receipts').values()].some(
          (receipt) =>
            String(receipt.tenant_id) === tenantId &&
            String(receipt.message_id) === String(row.id) &&
            String(receipt.identity) === identity &&
            Boolean(receipt.read_at)
        ))
        .length;
      return [{ unread_count: count }];
    }

    if (sql.startsWith('UPDATE collaboration_messages SET current_body')) {
      const row = this.table('collaboration_messages').get(String(params[0]));
      if (
        !row ||
        String(row.tenant_id) !== String(params[1]) ||
        row.deleted_at
      ) return { rows: [], rowCount: 0 };
      row.current_body = params[2];
      row.edit_version = params[3];
      row.edited_at = params[4];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE collaboration_messages SET edit_version')) {
      const row = this.table('collaboration_messages').get(String(params[0]));
      if (
        !row ||
        String(row.tenant_id) !== String(params[1]) ||
        row.deleted_at
      ) return { rows: [], rowCount: 0 };
      row.edit_version = params[2];
      row.deleted_at = params[3];
      row.deleted_by = params[4];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO collaboration_message_mutations')) {
      const duplicate = [...this.table('collaboration_message_mutations').values()].find(
        (row) =>
          String(row.tenant_id) === String(params[1]) &&
          String(row.message_id) === String(params[3]) &&
          Number(row.version) === Number(params[4])
      );
      if (duplicate) throw new Error('duplicate collaboration message mutation version');
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        session_id: params[2],
        message_id: params[3],
        version: params[4],
        action: params[5],
        actor_identity: params[6],
        before_body_hash: params[7],
        after_body_hash: params[8],
        reason: params[9],
        created_at: params[10]
      };
      this.table('collaboration_message_mutations').set(String(row.id), row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('SELECT * FROM collaboration_message_mutations WHERE tenant_id')) {
      return [...this.table('collaboration_message_mutations').values()]
        .filter((row) => String(row.tenant_id) === String(params[0]))
        .filter((row) => String(row.session_id) === String(params[1]))
        .filter((row) => String(row.message_id) === String(params[2]))
        .sort((a, b) => Number(a.version) - Number(b.version));
    }

    if (sql.startsWith('INSERT INTO tinode_message_mutation_outbox')) {
      const duplicate = [...this.table('tinode_message_mutation_outbox').values()].find(
        (row) =>
          String(row.tenant_id) === String(params[1]) &&
          String(row.mutation_id) === String(params[4])
      );
      if (duplicate) return { rows: [], rowCount: 0 };
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        session_id: params[2],
        message_id: params[3],
        mutation_id: params[4],
        mutation_version: params[5],
        action: params[6],
        provider_topic_id: params[7],
        target_provider_message_id: params[8],
        body: params[9],
        status: 'pending',
        attempt_count: 0,
        max_attempts: 5,
        next_attempt_at: null,
        claim_token: '',
        claimed_until: null,
        provider_operation_id: '',
        last_error_code: '',
        last_error_message: '',
        created_at: params[10],
        updated_at: params[10],
        completed_at: null
      };
      this.table('tinode_message_mutation_outbox').set(String(row.id), row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('SELECT tenant_id FROM opc_tinode_mutation_tenant_ids')) {
      const now = String(params[0]);
      const limit = Number(params[1] || 50);
      const tenantIds = new Set<string>();
      for (const row of [...this.table('tinode_message_mutation_outbox').values()]
        .sort((left, right) => compareRows(left, right))) {
        const session = this.table('collaboration_sessions').get(String(row.session_id));
        const message = this.table('collaboration_messages').get(String(row.message_id));
        if (!session || String(session.status) !== 'open') continue;
        if (!message || String(message.provider) !== 'tinode' || !message.provider_message_id) continue;
        if (Number(row.attempt_count || 0) >= Number(row.max_attempts || 0)) continue;
        const status = String(row.status);
        const due = status === 'pending' ||
          (status === 'retry_wait' && (!row.next_attempt_at || String(row.next_attempt_at) <= now)) ||
          (status === 'processing' && Boolean(row.claimed_until) && String(row.claimed_until) <= now);
        if (!due) continue;
        const earlierPending = [...this.table('tinode_message_mutation_outbox').values()].some(
          (earlier) =>
            String(earlier.tenant_id) === String(row.tenant_id) &&
            String(earlier.message_id) === String(row.message_id) &&
            Number(earlier.mutation_version) < Number(row.mutation_version) &&
            String(earlier.status) !== 'delivered'
        );
        if (earlierPending) continue;
        tenantIds.add(String(row.tenant_id));
        if (tenantIds.size >= limit) break;
      }
      return [...tenantIds].map((tenant_id) => ({ tenant_id }));
    }

    if (
      sql.startsWith('WITH candidate AS') &&
      sql.includes('UPDATE tinode_message_mutation_outbox AS outbox')
    ) {
      const tenantId = String(params[0]);
      const now = String(params[1]);
      const candidate = [...this.table('tinode_message_mutation_outbox').values()]
        .filter((row) => String(row.tenant_id) === tenantId)
        .filter((row) => {
          const session = this.table('collaboration_sessions').get(String(row.session_id));
          const message = this.table('collaboration_messages').get(String(row.message_id));
          if (!session || String(session.status) !== 'open') return false;
          if (!message || String(message.provider) !== 'tinode' || !message.provider_message_id) return false;
          if (Number(row.attempt_count || 0) >= Number(row.max_attempts || 0)) return false;
          const status = String(row.status);
          const due = status === 'pending' ||
            (status === 'retry_wait' && (!row.next_attempt_at || String(row.next_attempt_at) <= now)) ||
            (status === 'processing' && Boolean(row.claimed_until) && String(row.claimed_until) <= now);
          if (!due) return false;
          return ![...this.table('tinode_message_mutation_outbox').values()].some(
            (earlier) =>
              String(earlier.tenant_id) === tenantId &&
              String(earlier.message_id) === String(row.message_id) &&
              Number(earlier.mutation_version) < Number(row.mutation_version) &&
              String(earlier.status) !== 'delivered'
          );
        })
        .sort((left, right) => compareRows(left, right))[0];
      if (!candidate) return { rows: [], rowCount: 0 };
      const message = this.table('collaboration_messages').get(String(candidate.message_id))!;
      const previousStatus = candidate.status;
      candidate.status = 'processing';
      candidate.attempt_count = Number(candidate.attempt_count || 0) + 1;
      candidate.claim_token = params[2];
      candidate.claimed_until = params[3];
      candidate.target_provider_message_id = message.provider_message_id;
      candidate.next_attempt_at = null;
      candidate.updated_at = now;
      return { rows: [{ ...candidate, previous_status: previousStatus }], rowCount: 1 };
    }

    if (
      sql.startsWith('SELECT * FROM tinode_message_mutation_outbox WHERE tenant_id') &&
      sql.includes('mutation_id = $2')
    ) {
      return [...this.table('tinode_message_mutation_outbox').values()]
        .filter((row) => String(row.tenant_id) === String(params[0]))
        .filter((row) => String(row.mutation_id) === String(params[1]));
    }

    if (sql.startsWith('SELECT * FROM tinode_message_mutation_outbox WHERE tenant_id')) {
      return [...this.table('tinode_message_mutation_outbox').values()]
        .filter((row) => String(row.tenant_id) === String(params[0]))
        .filter((row) => String(row.message_id) === String(params[1]))
        .sort((a, b) => Number(a.mutation_version) - Number(b.mutation_version));
    }

    if (
      sql.startsWith("UPDATE tinode_message_mutation_outbox SET status = 'dead_letter'") &&
      sql.includes("status IN ('pending', 'processing', 'retry_wait')")
    ) {
      let rowCount = 0;
      for (const row of this.table('tinode_message_mutation_outbox').values()) {
        if (
          String(row.tenant_id) !== String(params[0]) ||
          String(row.session_id) !== String(params[1]) ||
          !['pending', 'processing', 'retry_wait'].includes(String(row.status))
        ) continue;
        const now = this.nowIso();
        row.status = 'dead_letter';
        row.next_attempt_at = null;
        row.claim_token = '';
        row.claimed_until = null;
        row.last_error_code = 'session_closed';
        row.last_error_message = 'collaboration session closed before provider mutation completed';
        row.completed_at = row.completed_at || now;
        row.updated_at = now;
        rowCount += 1;
      }
      return { rows: [], rowCount };
    }

    if (sql.startsWith("UPDATE tinode_message_mutation_outbox SET status = 'delivered'")) {
      const row = this.table('tinode_message_mutation_outbox').get(String(params[0]));
      if (
        !row ||
        String(row.tenant_id) !== String(params[1]) ||
        String(row.status) !== 'processing' ||
        String(row.claim_token) !== String(params[2])
      ) return { rows: [], rowCount: 0 };
      row.status = 'delivered';
      row.provider_operation_id = params[3];
      row.claim_token = '';
      row.claimed_until = null;
      row.completed_at = params[4];
      row.updated_at = params[4];
      row.last_error_code = '';
      row.last_error_message = '';
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE tinode_message_mutation_outbox SET status = $4')) {
      const row = this.table('tinode_message_mutation_outbox').get(String(params[0]));
      if (
        !row ||
        String(row.tenant_id) !== String(params[1]) ||
        String(row.status) !== 'processing' ||
        String(row.claim_token) !== String(params[2])
      ) return { rows: [], rowCount: 0 };
      row.status = params[3];
      row.next_attempt_at = params[4];
      row.claim_token = '';
      row.claimed_until = null;
      row.last_error_code = params[5];
      row.last_error_message = params[6];
      row.updated_at = params[7];
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE collaboration_messages SET provider_delivery_status = 'publishing'")) {
      const row = this.table('collaboration_messages').get(String(params[0]));
      if (!row || String(row.tenant_id) !== String(params[1]) || String(row.provider) !== 'tinode') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("session.status = 'open'")) {
        const session = this.table('collaboration_sessions').get(String(row.session_id));
        if (!session || String(session.status) !== 'open') return { rows: [], rowCount: 0 };
      }
      const now = String(params[4]);
      const status = String(row.provider_delivery_status);
      const due = status === 'pending' ||
        (status === 'retry_wait' && (!row.provider_next_attempt_at || String(row.provider_next_attempt_at) <= now)) ||
        (status === 'publishing' && Boolean(row.provider_delivery_lease_until) && String(row.provider_delivery_lease_until) <= now);
      if (!due || Number(row.provider_delivery_attempts || 0) >= Number(params[5])) {
        return { rows: [], rowCount: 0 };
      }
      row.provider_delivery_status = 'publishing';
      row.provider_delivery_attempts = Number(row.provider_delivery_attempts || 0) + 1;
      row.provider_delivery_claim_token_hash = params[2];
      row.provider_delivery_lease_until = params[3];
      row.provider_next_attempt_at = null;
      row.provider_last_error_code = '';
      row.provider_last_error_message = '';
      row.provider_delivery_updated_at = params[4];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE collaboration_messages SET provider_delivery_status = $4')) {
      const row = this.table('collaboration_messages').get(String(params[0]));
      if (
        !row ||
        String(row.tenant_id) !== String(params[1]) ||
        String(row.provider_delivery_status) !== 'publishing' ||
        String(row.provider_delivery_claim_token_hash) !== String(params[2])
      ) {
        return { rows: [], rowCount: 0 };
      }
      row.provider_delivery_status = params[3];
      row.provider_message_id = params[4];
      row.provider_delivery_claim_token_hash = '';
      row.provider_delivery_lease_until = null;
      row.provider_next_attempt_at = params[5];
      row.provider_last_error_code = params[6];
      row.provider_last_error_message = params[7];
      if (String(params[3]) === 'delivered') row.provider_delivered_at = params[8];
      row.provider_delivery_updated_at = params[8];
      row.provider_delivery_metadata = params[9];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE collaboration_messages SET provider_delivery_status = $3')) {
      const row = this.table('collaboration_messages').get(String(params[0]));
      if (
        !row ||
        String(row.tenant_id) !== String(params[1]) ||
        String(row.provider_delivery_status) !== 'publishing' ||
        !row.provider_delivery_lease_until ||
        String(row.provider_delivery_lease_until) > String(params[4])
      ) {
        return { rows: [], rowCount: 0 };
      }
      row.provider_delivery_status = params[2];
      row.provider_delivery_claim_token_hash = '';
      row.provider_delivery_lease_until = null;
      row.provider_next_attempt_at = params[3];
      row.provider_last_error_code = 'claim_lease_expired';
      row.provider_last_error_message = 'provider delivery claim lease expired';
      row.provider_delivery_updated_at = params[4];
      return {
        rows: [{
          id: row.id,
          tenant_id: row.tenant_id,
          provider_delivery_attempts: row.provider_delivery_attempts
        }],
        rowCount: 1
      };
    }

    if (
      sql.startsWith("UPDATE collaboration_messages SET provider_delivery_status = 'failed'") &&
      sql.includes("provider_last_error_code = 'session_closed'")
    ) {
      let rowCount = 0;
      for (const row of this.table('collaboration_messages').values()) {
        if (
          String(row.tenant_id) !== String(params[0]) ||
          String(row.session_id) !== String(params[1]) ||
          String(row.provider) !== 'tinode' ||
          !['pending', 'blocked_by_file_security', 'publishing', 'retry_wait']
            .includes(String(row.provider_delivery_status))
        ) continue;
        row.provider_delivery_status = 'failed';
        row.provider_delivery_claim_token_hash = '';
        row.provider_delivery_lease_until = null;
        row.provider_next_attempt_at = null;
        row.provider_last_error_code = 'session_closed';
        row.provider_last_error_message =
          'collaboration session closed before provider delivery completed';
        row.provider_delivery_updated_at = this.nowIso();
        rowCount += 1;
      }
      return { rows: [], rowCount };
    }

    if (sql.startsWith("UPDATE collaboration_messages SET provider_delivery_status = 'failed'")) {
      const tenantScoped = sql.includes('WHERE tenant_id = $1');
      const tenantId = tenantScoped ? String(params[0]) : '';
      const maxAttempts = Number(params[tenantScoped ? 1 : 0]);
      const now = String(params[tenantScoped ? 2 : 1]);
      const rows: TableRow[] = [];
      for (const row of this.table('collaboration_messages').values()) {
        if (tenantScoped && String(row.tenant_id) !== tenantId) continue;
        if (
          String(row.provider) !== 'tinode' ||
          String(row.provider_delivery_status) !== 'publishing' ||
          !row.provider_delivery_lease_until ||
          String(row.provider_delivery_lease_until) > now ||
          Number(row.provider_delivery_attempts || 0) < maxAttempts
        ) continue;
        row.provider_delivery_status = 'failed';
        row.provider_delivery_claim_token_hash = '';
        row.provider_delivery_lease_until = null;
        row.provider_next_attempt_at = null;
        row.provider_last_error_code = 'claim_lease_expired';
        row.provider_last_error_message = 'provider delivery claim lease expired';
        row.provider_delivery_updated_at = now;
        rows.push({
          id: row.id,
          tenant_id: row.tenant_id,
          provider_delivery_attempts: row.provider_delivery_attempts
        });
      }
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith("UPDATE collaboration_messages SET provider_delivery_status = 'retry_wait'")) {
      const tenantScoped = sql.includes('WHERE tenant_id = $1');
      const tenantId = tenantScoped ? String(params[0]) : '';
      const maxAttempts = Number(params[tenantScoped ? 1 : 0]);
      const nextAttemptAt = String(params[tenantScoped ? 2 : 1]);
      const now = String(params[tenantScoped ? 3 : 2]);
      const rows: TableRow[] = [];
      for (const row of this.table('collaboration_messages').values()) {
        if (tenantScoped && String(row.tenant_id) !== tenantId) continue;
        if (
          String(row.provider) !== 'tinode' ||
          String(row.provider_delivery_status) !== 'publishing' ||
          !row.provider_delivery_lease_until ||
          String(row.provider_delivery_lease_until) > now ||
          Number(row.provider_delivery_attempts || 0) >= maxAttempts
        ) continue;
        row.provider_delivery_status = 'retry_wait';
        row.provider_delivery_claim_token_hash = '';
        row.provider_delivery_lease_until = null;
        row.provider_next_attempt_at = nextAttemptAt;
        row.provider_last_error_code = 'claim_lease_expired';
        row.provider_last_error_message = 'provider delivery claim lease expired';
        row.provider_delivery_updated_at = now;
        rows.push({
          id: row.id,
          tenant_id: row.tenant_id,
          provider_delivery_attempts: row.provider_delivery_attempts
        });
      }
      return { rows, rowCount: rows.length };
    }

    if (
      sql.startsWith('SELECT id, tenant_id FROM collaboration_messages') ||
      sql.startsWith('SELECT messages.id, messages.tenant_id, messages.session_id')
    ) {
      const tenantScoped = sql.includes('WHERE tenant_id = $1') ||
        sql.includes('WHERE messages.tenant_id = $1');
      const tenantId = tenantScoped ? String(params[0]) : '';
      const now = String(params[tenantScoped ? 1 : 0]);
      const limit = Number(params[tenantScoped ? 2 : 1]);
      return [...this.table('collaboration_messages').values()]
        .filter((row) => !tenantScoped || String(row.tenant_id) === tenantId)
        .filter((row) => {
          if (!sql.includes("session.status = 'open'")) return true;
          const session = this.table('collaboration_sessions').get(String(row.session_id));
          return Boolean(session && String(session.status) === 'open');
        })
        .filter((row) => String(row.provider) === 'tinode')
        .filter((row) => {
          const status = String(row.provider_delivery_status);
          return status === 'pending' ||
            (status === 'retry_wait' && (!row.provider_next_attempt_at || String(row.provider_next_attempt_at) <= now)) ||
            (status === 'publishing' && Boolean(row.provider_delivery_lease_until) && String(row.provider_delivery_lease_until) <= now);
        })
        .sort((a, b) => String(a.provider_next_attempt_at || a.created_at).localeCompare(String(b.provider_next_attempt_at || b.created_at)))
        .slice(0, limit)
        .map((row) => ({ id: row.id, tenant_id: row.tenant_id, session_id: row.session_id }));
    }

    if (sql.startsWith('SELECT id, tenant_id, provider_delivery_attempts FROM collaboration_messages')) {
      const tenantScoped = sql.includes('WHERE tenant_id = $1');
      const tenantId = tenantScoped ? String(params[0]) : '';
      const now = String(params[tenantScoped ? 1 : 0]);
      return [...this.table('collaboration_messages').values()]
        .filter((row) => !tenantScoped || String(row.tenant_id) === tenantId)
        .filter((row) =>
          String(row.provider) === 'tinode' &&
          String(row.provider_delivery_status) === 'publishing' &&
          Boolean(row.provider_delivery_lease_until) &&
          String(row.provider_delivery_lease_until) <= now
        )
        .sort((a, b) => String(a.provider_delivery_lease_until).localeCompare(String(b.provider_delivery_lease_until)))
        .map((row) => ({
          id: row.id,
          tenant_id: row.tenant_id,
          provider_delivery_attempts: row.provider_delivery_attempts
        }));
    }

    if (sql.startsWith('INSERT INTO collaboration_message_delivery_attempts')) {
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        session_id: params[2],
        message_id: params[3],
        attempt_number: params[4],
        provider: params[5],
        status: 'started',
        provider_message_id: '',
        error_code: '',
        error_message: '',
        started_at: params[6],
        completed_at: null,
        metadata: params[7]
      };
      this.table('collaboration_message_delivery_attempts').set(String(row.id), row);
      return { rows: [], rowCount: 1 };
    }

    if (
      sql.startsWith("UPDATE collaboration_message_delivery_attempts AS attempt SET status = 'failed'") &&
      sql.includes("error_code = 'session_closed'")
    ) {
      let rowCount = 0;
      for (const attempt of this.table('collaboration_message_delivery_attempts').values()) {
        const message = this.table('collaboration_messages').get(String(attempt.message_id));
        if (
          !message ||
          String(message.tenant_id) !== String(params[0]) ||
          String(message.session_id) !== String(params[1]) ||
          String(message.provider) !== 'tinode' ||
          !['pending', 'blocked_by_file_security', 'publishing', 'retry_wait']
            .includes(String(message.provider_delivery_status)) ||
          String(attempt.status) !== 'started'
        ) continue;
        attempt.status = 'failed';
        attempt.completed_at = this.nowIso();
        attempt.error_code = 'session_closed';
        attempt.error_message =
          'collaboration session closed before provider delivery completed';
        rowCount += 1;
      }
      return { rows: [], rowCount };
    }

    if (sql.startsWith('UPDATE collaboration_message_delivery_attempts attempts')) {
      const message = this.table('collaboration_messages').get(String(params[0]));
      if (!message || String(message.tenant_id) !== String(params[1])) return { rows: [], rowCount: 0 };
      let count = 0;
      for (const attempt of this.table('collaboration_message_delivery_attempts').values()) {
        if (
          String(attempt.message_id) === String(message.id) &&
          Number(attempt.attempt_number) === Number(message.provider_delivery_attempts) &&
          String(attempt.status) === 'started' &&
          String(message.provider_delivery_status) === 'publishing' &&
          Boolean(message.provider_delivery_lease_until) &&
          String(message.provider_delivery_lease_until) <= String(params[2])
        ) {
          attempt.status = 'lease_expired';
          attempt.completed_at = params[2];
          attempt.error_code = 'claim_lease_expired';
          attempt.error_message = 'provider delivery claim lease expired';
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (sql.startsWith('UPDATE collaboration_message_delivery_attempts SET status = $3')) {
      const attempt = this.table('collaboration_message_delivery_attempts').get(String(params[0]));
      if (!attempt || String(attempt.tenant_id) !== String(params[1]) || String(attempt.status) !== 'started') {
        return { rows: [], rowCount: 0 };
      }
      attempt.status = params[2];
      attempt.provider_message_id = params[3];
      attempt.error_code = params[4];
      attempt.error_message = params[5];
      attempt.completed_at = params[6];
      attempt.metadata = params[7];
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE collaboration_message_delivery_attempts SET status = 'lease_expired'")) {
      let count = 0;
      for (const attempt of this.table('collaboration_message_delivery_attempts').values()) {
        if (
          String(attempt.tenant_id) === String(params[0]) &&
          String(attempt.message_id) === String(params[1]) &&
          Number(attempt.attempt_number) === Number(params[2]) &&
          String(attempt.status) === 'started'
        ) {
          attempt.status = 'lease_expired';
          attempt.completed_at = params[3];
          attempt.error_code = 'claim_lease_expired';
          attempt.error_message = params[4];
          attempt.metadata = params[5];
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (sql.startsWith('SELECT * FROM collaboration_message_delivery_attempts WHERE tenant_id')) {
      const tenantId = String(params[0]);
      const messageId = String(params[1]);
      return [...this.table('collaboration_message_delivery_attempts').values()]
        .filter((row) => String(row.tenant_id) === tenantId && String(row.message_id) === messageId)
        .sort((a, b) => Number(a.attempt_number) - Number(b.attempt_number));
    }

    if (sql.startsWith('INSERT INTO collaboration_message_attachments')) {
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        session_id: params[2],
        message_id: params[3],
        secure_file_id: params[4] || null,
        kind: params[5],
        storage_url: params[6],
        filename: params[7],
        content_type: params[8],
        size_bytes: params[9],
        checksum: params[10],
        processing_status: params[11],
        ocr_text: '',
        asr_text: '',
        extracted_text: '',
        processing_error_code: '',
        processed_at: null,
        metadata: params[12],
        created_at: this.nowIso(),
        updated_at: this.nowIso()
      };
      this.table('collaboration_message_attachments').set(String(row.id), row);
      return [];
    }

    if (sql.startsWith('SELECT * FROM collaboration_message_attachments WHERE id')) {
      const row = this.table('collaboration_message_attachments').get(String(params[0]));
      const tenantMatches = params[1] == null || String(row?.tenant_id) === String(params[1]);
      return row && tenantMatches ? [row] : [];
    }

    if (
      sql.startsWith('SELECT id, message_id, checksum, ocr_text, asr_text, processed_at') ||
      sql.startsWith('SELECT id, message_id, kind, checksum, ocr_text, asr_text')
    ) {
      const messageIds = new Set((params[2] as unknown[] || []).map(String));
      return [...this.table('collaboration_message_attachments').values()]
        .filter((row) =>
          String(row.tenant_id) === String(params[0]) &&
          String(row.session_id) === String(params[1]) &&
          messageIds.has(String(row.message_id))
        )
        .sort(compareRows)
        .map((row) => ({
          id: row.id, message_id: row.message_id, kind: row.kind, checksum: row.checksum,
          ocr_text: row.ocr_text, asr_text: row.asr_text, processed_at: row.processed_at,
          updated_at: row.updated_at, created_at: row.created_at
        }));
    }

    if (sql.startsWith('SELECT * FROM collaboration_message_attachments WHERE tenant_id')) {
      const tenantId = String(params[0]);
      const messageId = String(params[1]);
      return [...this.table('collaboration_message_attachments').values()]
        .filter((row) => String(row.tenant_id) === tenantId && String(row.message_id) === messageId)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    }

    if (sql.startsWith("UPDATE collaboration_message_attachments SET processing_status = 'pending'")) {
      const row = this.table('collaboration_message_attachments').get(String(params[0]));
      if (
        row &&
        String(row.tenant_id) === String(params[1]) &&
        (!sql.includes("processing_status != 'ready'") || String(row.processing_status) !== 'ready')
      ) {
        row.processing_status = 'pending';
        row.processing_error_code = '';
        row.updated_at = params[2];
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.startsWith("UPDATE collaboration_message_attachments SET processing_status = 'ready'")) {
      const row = this.table('collaboration_message_attachments').get(String(params[0]));
      if (!row || String(row.tenant_id) !== String(params[1])) return { rows: [], rowCount: 0 };
      row.processing_status = 'ready';
      row.ocr_text = params[2];
      row.asr_text = params[3];
      row.extracted_text = params[4];
      row.processing_error_code = '';
      row.metadata = params[5];
      row.processed_at = params[6];
      row.updated_at = params[6];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE collaboration_message_attachments SET processing_status = $3')) {
      const row = this.table('collaboration_message_attachments').get(String(params[0]));
      if (!row || String(row.tenant_id) !== String(params[1])) return { rows: [], rowCount: 0 };
      row.processing_status = params[2];
      row.processing_error_code = params[3];
      row.updated_at = params[4];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO collaboration_attachment_processing_jobs')) {
      const existing = [...this.table('collaboration_attachment_processing_jobs').values()].find(
        (row) =>
          String(row.tenant_id) === String(params[1]) &&
          String(row.attachment_id) === String(params[4]) &&
          String(row.processor) === String(params[5])
      );
      if (existing) return { rows: [], rowCount: 0 };
      const now = this.nowIso();
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        session_id: params[2],
        message_id: params[3],
        attachment_id: params[4],
        processor: params[5],
        attempt_count: 0,
        max_attempts: params[6],
        status: params[7],
        next_attempt_at: null,
        lease_until: null,
        worker_id: '',
        provider_profile_id: params[8],
        provider_mode: params[9],
        provider_name: params[10],
        error_code: params[11],
        error_message: params[11],
        output_metadata: {},
        created_at: now,
        updated_at: now,
        completed_at: null
      };
      this.table('collaboration_attachment_processing_jobs').set(String(row.id), row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO collaboration_visual_observations')) {
      const duplicate = [...this.table('collaboration_visual_observations').values()].find((row) =>
        String(row.tenant_id) === String(params[1]) &&
        String(row.attachment_id) === String(params[4]) &&
        String(row.processor_job_id) === String(params[5]) &&
        String(row.observation_type) === String(params[6]) &&
        String(row.value_hash) === String(params[7]) &&
        String(row.frame_timestamp_ms ?? '') === String(params[10] ?? '') &&
        String(row.page_number ?? '') === String(params[11] ?? '')
      );
      if (duplicate) return { rows: [], rowCount: 0 };
      const row: TableRow = {
        id: params[0], tenant_id: params[1], session_id: params[2], message_id: params[3],
        attachment_id: params[4], processor_job_id: params[5], observation_type: params[6],
        value_hash: params[7], symbology: params[8], confidence: params[9],
        frame_timestamp_ms: params[10], page_number: params[11], metadata: params[12],
        detector_version: params[13], created_at: params[14]
      };
      this.table('collaboration_visual_observations').set(String(row.id), row);
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('SELECT * FROM collaboration_visual_observations')) {
      return [...this.table('collaboration_visual_observations').values()]
        .filter((row) =>
          String(row.tenant_id) === String(params[0]) &&
          String(row.attachment_id) === String(params[1])
        )
        .sort(compareRows);
    }

    if (sql.startsWith('SELECT id, message_id, attachment_id, observation_type, value_hash')) {
      const messageIds = new Set((params[2] as unknown[] || []).map(String));
      return [...this.table('collaboration_visual_observations').values()]
        .filter((row) =>
          String(row.tenant_id) === String(params[0]) &&
          String(row.session_id) === String(params[1]) &&
          messageIds.has(String(row.message_id))
        )
        .sort(compareRows)
        .map((row) => ({
          id: row.id, message_id: row.message_id, attachment_id: row.attachment_id,
          observation_type: row.observation_type, value_hash: row.value_hash,
          symbology: row.symbology, frame_timestamp_ms: row.frame_timestamp_ms,
          page_number: row.page_number, detector_version: row.detector_version
        }));
    }

    if (sql.startsWith('SELECT status, error_code FROM collaboration_attachment_processing_jobs')) {
      return [...this.table('collaboration_attachment_processing_jobs').values()]
        .filter((row) =>
          String(row.tenant_id) === String(params[0]) &&
          String(row.attachment_id) === String(params[1])
        )
        .map((row) => ({ status: row.status, error_code: row.error_code }));
    }

    if (sql.startsWith('SELECT * FROM collaboration_attachment_processing_jobs WHERE tenant_id')) {
      const tenantId = String(params[0]);
      const rows = [...this.table('collaboration_attachment_processing_jobs').values()]
        .filter((row) => String(row.tenant_id) === tenantId);
      if (sql.includes('attachment_id = $2 AND processor = $3')) {
        return rows.filter(
          (row) => String(row.attachment_id) === String(params[1]) && String(row.processor) === String(params[2])
        );
      }
      if (sql.includes('attachment_id = $2') && !sql.includes('attempt_count < max_attempts')) {
        const matched = rows.filter((row) => String(row.attachment_id) === String(params[1]));
        if (sql.includes('ORDER BY created_at ASC, id ASC')) return matched.sort(compareRows);
        return matched.sort((a, b) => compareRows(b, a)).slice(0, 1);
      }
      const processorFilter = sql.includes('processor = ANY')
        ? new Set((params[2] as unknown[]).map(String))
        : null;
      const dueAt = String(params[1]);
      const limit = Number(params[processorFilter ? 3 : 2]);
      return rows
        .filter((row) => Number(row.attempt_count) < Number(row.max_attempts))
        .filter((row) => !processorFilter || processorFilter.has(String(row.processor)))
        .filter((row) =>
          String(row.status) === 'pending' ||
          (String(row.status) === 'retry_wait' && (!row.next_attempt_at || String(row.next_attempt_at) <= dueAt))
        )
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, limit);
    }

    if (sql.startsWith('SELECT * FROM collaboration_attachment_processing_jobs WHERE attempt_count')) {
      const processorFilter = sql.includes('processor = ANY')
        ? new Set((params[1] as unknown[]).map(String))
        : null;
      const dueAt = String(params[0]);
      const limit = Number(params[processorFilter ? 2 : 1]);
      return [...this.table('collaboration_attachment_processing_jobs').values()]
        .filter((row) => Number(row.attempt_count) < Number(row.max_attempts))
        .filter((row) => !processorFilter || processorFilter.has(String(row.processor)))
        .filter((row) =>
          String(row.status) === 'pending' ||
          (String(row.status) === 'retry_wait' && (!row.next_attempt_at || String(row.next_attempt_at) <= dueAt))
        )
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, limit);
    }

    if (sql.startsWith("UPDATE collaboration_attachment_processing_jobs SET status = 'processing'")) {
      const row = this.table('collaboration_attachment_processing_jobs').get(String(params[0]));
      const now = String(params[7]);
      const claimable = row &&
        String(row.tenant_id) === String(params[1]) &&
        Number(row.attempt_count) < Number(row.max_attempts) &&
        (
          String(row.status) === 'pending' ||
          (String(row.status) === 'retry_wait' && (!row.next_attempt_at || String(row.next_attempt_at) <= now))
        );
      if (!row || !claimable) return { rows: [], rowCount: 0 };
      row.status = 'processing';
      row.attempt_count = Number(row.attempt_count) + 1;
      row.lease_until = params[3];
      row.worker_id = params[2];
      row.next_attempt_at = null;
      row.provider_profile_id = params[4];
      row.provider_mode = params[5];
      row.provider_name = params[6];
      row.error_code = '';
      row.error_message = '';
      row.updated_at = params[7];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE collaboration_attachment_processing_jobs SET status = 'succeeded'")) {
      const row = this.table('collaboration_attachment_processing_jobs').get(String(params[0]));
      if (
        !row ||
        String(row.tenant_id) !== String(params[1]) ||
        String(row.status) !== 'processing' ||
        String(row.worker_id) !== String(params[2])
      ) return { rows: [], rowCount: 0 };
      row.status = 'succeeded';
      row.provider_profile_id = params[3];
      row.provider_mode = params[4];
      row.provider_name = params[5];
      row.error_code = '';
      row.error_message = '';
      row.output_metadata = params[6];
      row.lease_until = null;
      row.worker_id = '';
      row.completed_at = params[7];
      row.updated_at = params[7];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE collaboration_attachment_processing_jobs SET status = $4')) {
      const row = this.table('collaboration_attachment_processing_jobs').get(String(params[0]));
      if (
        !row ||
        String(row.tenant_id) !== String(params[1]) ||
        String(row.status) !== 'processing' ||
        String(row.worker_id) !== String(params[2])
      ) return { rows: [], rowCount: 0 };
      row.status = params[3];
      row.next_attempt_at = params[4];
      row.lease_until = null;
      row.worker_id = '';
      row.error_code = params[5];
      row.error_message = params[6];
      row.attempt_count = Math.max(0, Number(row.attempt_count) - Number(params[8] || 0));
      row.output_metadata = mergeJsonObjects(row.output_metadata, params[9]);
      row.completed_at = params[3] === 'failed' ? params[7] : null;
      row.updated_at = params[7];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE collaboration_attachment_processing_jobs SET status = 'pending'")) {
      const tenantId = String(params[0]);
      const attachmentId = String(params[1]);
      const row = [...this.table('collaboration_attachment_processing_jobs').values()].find(
        (candidate) =>
          String(candidate.tenant_id) === tenantId &&
          String(candidate.attachment_id) === attachmentId &&
          (String(candidate.status) === 'failed' || String(candidate.status) === 'cancelled')
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'pending';
      row.attempt_count = 0;
      row.next_attempt_at = null;
      row.lease_until = null;
      row.worker_id = '';
      row.error_code = '';
      row.error_message = '';
      row.completed_at = null;
      row.updated_at = params[2];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE collaboration_attachment_processing_jobs SET status = 'cancelled'")) {
      const row = this.table('collaboration_attachment_processing_jobs').get(String(params[0]));
      if (!row || String(row.tenant_id) !== String(params[1]) || !['pending', 'retry_wait'].includes(String(row.status))) {
        return { rows: [], rowCount: 0 };
      }
      row.status = 'cancelled';
      row.error_code = params[2];
      row.error_message = params[2];
      row.next_attempt_at = null;
      row.completed_at = params[3];
      row.updated_at = params[3];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE collaboration_attachment_processing_jobs SET error_code = $3')) {
      const row = this.table('collaboration_attachment_processing_jobs').get(String(params[0]));
      if (!row || String(row.tenant_id) !== String(params[1]) || !['pending', 'retry_wait'].includes(String(row.status))) {
        return { rows: [], rowCount: 0 };
      }
      row.error_code = params[2];
      row.error_message = params[2];
      row.updated_at = params[3];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE collaboration_attachment_processing_jobs SET status = CASE')) {
      const tenantScoped = sql.includes('WHERE tenant_id = $1');
      const tenantId = tenantScoped ? String(params[0]) : '';
      const now = String(params[tenantScoped ? 1 : 0]);
      let count = 0;
      const rows: TableRow[] = [];
      for (const row of this.table('collaboration_attachment_processing_jobs').values()) {
        if (tenantScoped && String(row.tenant_id) !== tenantId) continue;
        if (String(row.status) !== 'processing' || !row.lease_until || String(row.lease_until) > now) continue;
        const terminal = Number(row.attempt_count) >= Number(row.max_attempts);
        row.status = terminal ? 'failed' : 'retry_wait';
        row.next_attempt_at = terminal ? null : now;
        row.lease_until = null;
        row.worker_id = '';
        row.error_code = 'claim_lease_expired';
        row.error_message = 'attachment processing claim lease expired';
        row.updated_at = now;
        row.completed_at = terminal ? now : null;
        count += 1;
        rows.push({ tenant_id: row.tenant_id, attachment_id: row.attachment_id });
      }
      return { rows, rowCount: count };
    }

    if (sql.startsWith('INSERT INTO collaboration_message_translations')) {
      if (sql.includes('source_type, source_ref_id')) {
        const duplicate = [...this.table('collaboration_message_translations').values()].find((candidate) =>
          String(candidate.tenant_id) === String(params[1]) &&
          String(candidate.source_type) === String(params[7]) &&
          String(candidate.source_ref_id) === String(params[8]) &&
          String(candidate.target_language) === String(params[3]) &&
          String(candidate.source_hash) === String(params[9])
        );
        if (duplicate) return { rows: [], rowCount: 0 };
        const row: TableRow = {
          id: params[0], tenant_id: params[1], message_id: params[2], target_language: params[3],
          translated_body: params[4], provider: params[5], confidence: params[6],
          source_type: params[7], source_ref_id: params[8], source_hash: params[9],
          source_language: params[10], provider_profile_id: params[11], provider_mode: params[12],
          provider_request_id: params[13], output_metadata: params[14],
          created_at: params[15], updated_at: params[15]
        };
        this.table('collaboration_message_translations').set(String(row.id), row);
        return { rows: [], rowCount: 1 };
      }
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        message_id: params[2],
        target_language: params[3],
        translated_body: params[4],
        provider: params[5],
        confidence: params[6],
        created_at: this.nowIso()
      };
      this.table('collaboration_message_translations').set(String(row.id), row);
      return [];
    }

    if (sql.startsWith('INSERT INTO collaboration_translation_jobs')) {
      const duplicate = [...this.table('collaboration_translation_jobs').values()].find((candidate) =>
        (String(candidate.tenant_id) === String(params[1]) && String(candidate.idempotency_key) === String(params[15])) ||
        (String(candidate.tenant_id) === String(params[1]) && String(candidate.source_type) === String(params[4]) &&
          String(candidate.source_ref_id) === String(params[5]) &&
          String(candidate.target_language) === String(params[7]) && String(candidate.source_hash) === String(params[8]))
      );
      if (duplicate) return { rows: [], rowCount: 0 };
      const row: TableRow = {
        id: params[0], tenant_id: params[1], session_id: params[2], message_id: params[3],
        source_type: params[4], source_ref_id: params[5], source_language: params[6],
        target_language: params[7], source_hash: params[8], status: params[9],
        attempt_count: 0, max_attempts: params[10], next_attempt_at: null, lease_until: null,
        worker_id: '', provider_profile_id: params[11], provider_mode: params[12], provider_name: params[13],
        provider_request_id: '', error_code: params[14], error_message: params[14], output_metadata: {},
        idempotency_key: params[15], payload_hash: params[16], automatic: params[17],
        created_at: params[18], updated_at: params[18],
        completed_at: String(params[9]) === 'cancelled' ? params[18] : null
      };
      this.table('collaboration_translation_jobs').set(String(row.id), row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('SELECT * FROM collaboration_translation_jobs WHERE tenant_id') && sql.includes('idempotency_key')) {
      const row = [...this.table('collaboration_translation_jobs').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[0]) && String(candidate.idempotency_key) === String(params[1])
      );
      return row ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM collaboration_translation_jobs WHERE tenant_id') &&
      sql.includes('source_type = $2') && !sql.includes("($4 = ''")) {
      const row = [...this.table('collaboration_translation_jobs').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[0]) && String(candidate.source_type) === String(params[1]) &&
        String(candidate.source_ref_id) === String(params[2]) && String(candidate.target_language) === String(params[3]) &&
        String(candidate.source_hash) === String(params[4])
      );
      return row ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM collaboration_translation_jobs WHERE id')) {
      const row = this.table('collaboration_translation_jobs').get(String(params[0]));
      return row && String(row.tenant_id) === String(params[1]) ? [row] : [];
    }

    if (sql.startsWith("UPDATE collaboration_translation_jobs SET status = 'pending'")) {
      const row = this.table('collaboration_translation_jobs').get(String(params[0]));
      if (!row || String(row.tenant_id) !== String(params[1]) || row.status !== 'failed') {
        return { rows: [], rowCount: 0 };
      }
      row.status = 'pending'; row.attempt_count = 0; row.next_attempt_at = null;
      row.lease_until = null; row.worker_id = ''; row.error_code = ''; row.error_message = '';
      row.completed_at = null; row.updated_at = params[2];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('SELECT * FROM collaboration_translation_jobs WHERE tenant_id') && sql.includes('attempt_count')) {
      const now = String(params[1]);
      return [...this.table('collaboration_translation_jobs').values()]
        .filter((row) => String(row.tenant_id) === String(params[0]))
        .filter((row) => Number(row.attempt_count) < Number(row.max_attempts))
        .filter((row) => row.status === 'pending' || (row.status === 'retry_wait' &&
          (!row.next_attempt_at || String(row.next_attempt_at) <= now)))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, Number(params[2]));
    }

    if (sql.startsWith('SELECT * FROM collaboration_translation_jobs WHERE tenant_id') && sql.includes("($4 = ''")) {
      const history = params[4] === true;
      return [...this.table('collaboration_translation_jobs').values()]
        .filter((row) => String(row.tenant_id) === String(params[0]))
        .filter((row) => String(row.source_type) === String(params[1]) && String(row.source_ref_id) === String(params[2]))
        .filter((row) => !String(params[3] || '') || String(row.target_language) === String(params[3]))
        .filter((row) => history || String(row.source_hash) === String(params[5]))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)))
        .slice(0, 500);
    }

    if (sql.startsWith('SELECT * FROM collaboration_translation_jobs WHERE attempt_count')) {
      const now = String(params[0]);
      return [...this.table('collaboration_translation_jobs').values()]
        .filter((row) => Number(row.attempt_count) < Number(row.max_attempts))
        .filter((row) => row.status === 'pending' || (row.status === 'retry_wait' &&
          (!row.next_attempt_at || String(row.next_attempt_at) <= now)))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, Number(params[1]));
    }

    if (sql.startsWith("UPDATE collaboration_translation_jobs SET status = 'processing'")) {
      const row = this.table('collaboration_translation_jobs').get(String(params[0]));
      const now = String(params[7]);
      if (!row || String(row.tenant_id) !== String(params[1]) || Number(row.attempt_count) >= Number(row.max_attempts) ||
        !(row.status === 'pending' || (row.status === 'retry_wait' &&
          (!row.next_attempt_at || String(row.next_attempt_at) <= now)))) return { rows: [], rowCount: 0 };
      row.status = 'processing'; row.attempt_count = Number(row.attempt_count) + 1;
      row.lease_until = params[3]; row.worker_id = params[2]; row.next_attempt_at = null;
      row.provider_profile_id = params[4]; row.provider_mode = params[5]; row.provider_name = params[6];
      row.error_code = ''; row.error_message = ''; row.updated_at = params[7];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE collaboration_translation_jobs SET status = 'succeeded'")) {
      const row = this.table('collaboration_translation_jobs').get(String(params[0]));
      if (!row || String(row.tenant_id) !== String(params[1]) || row.status !== 'processing' ||
        String(row.worker_id) !== String(params[2]) || String(row.source_hash) !== String(params[3])) {
        return { rows: [], rowCount: 0 };
      }
      row.status = 'succeeded'; row.provider_profile_id = params[4]; row.provider_mode = params[5];
      row.provider_name = params[6]; row.provider_request_id = params[7]; row.output_metadata = params[8];
      row.error_code = ''; row.error_message = ''; row.lease_until = null; row.worker_id = '';
      row.completed_at = params[9]; row.updated_at = params[9];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE collaboration_translation_jobs SET status = $4')) {
      const row = this.table('collaboration_translation_jobs').get(String(params[0]));
      if (!row || String(row.tenant_id) !== String(params[1]) || row.status !== 'processing' ||
        String(row.worker_id) !== String(params[2])) return { rows: [], rowCount: 0 };
      row.status = params[3]; row.next_attempt_at = params[4]; row.lease_until = null; row.worker_id = '';
      row.error_code = params[5]; row.error_message = params[6];
      row.attempt_count = Math.max(0, Number(row.attempt_count) - Number(params[8] || 0));
      row.output_metadata = mergeJsonObjects(row.output_metadata, params[9]);
      row.completed_at = params[3] === 'failed' ? params[7] : null; row.updated_at = params[7];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE collaboration_translation_jobs SET status = 'cancelled'")) {
      const row = this.table('collaboration_translation_jobs').get(String(params[0]));
      if (!row || String(row.tenant_id) !== String(params[1]) ||
        !['pending', 'retry_wait', 'processing'].includes(String(row.status))) return { rows: [], rowCount: 0 };
      row.status = 'cancelled'; row.next_attempt_at = null; row.lease_until = null; row.worker_id = '';
      row.error_code = params[2]; row.error_message = params[2]; row.completed_at = params[3]; row.updated_at = params[3];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE collaboration_translation_jobs SET provider_profile_id')) {
      const row = this.table('collaboration_translation_jobs').get(String(params[0]));
      if (!row || String(row.tenant_id) !== String(params[1]) ||
        !['pending', 'retry_wait'].includes(String(row.status))) return { rows: [], rowCount: 0 };
      row.provider_profile_id = params[2]; row.error_code = params[3]; row.error_message = params[3];
      row.updated_at = params[4]; return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE collaboration_translation_jobs SET status = CASE')) {
      const tenantId = String(params[0] || ''); const now = String(params[1]); let count = 0;
      for (const row of this.table('collaboration_translation_jobs').values()) {
        if (tenantId && String(row.tenant_id) !== tenantId) continue;
        if (row.status !== 'processing' || !row.lease_until || String(row.lease_until) > now) continue;
        const terminal = Number(row.attempt_count) >= Number(row.max_attempts);
        row.status = terminal ? 'failed' : 'retry_wait'; row.next_attempt_at = terminal ? null : now;
        row.lease_until = null; row.worker_id = ''; row.error_code = 'claim_lease_expired';
        row.error_message = 'translation claim lease expired'; row.updated_at = now;
        row.completed_at = terminal ? now : null; count += 1;
      }
      return { rows: [], rowCount: count };
    }

    if (sql.startsWith('SELECT * FROM collaboration_message_translations WHERE tenant_id')) {
      if (!sql.includes("($4 = ''")) {
        const row = [...this.table('collaboration_message_translations').values()].find((candidate) =>
          String(candidate.tenant_id) === String(params[0]) &&
          String(candidate.source_type) === String(params[1]) &&
          String(candidate.source_ref_id) === String(params[2]) &&
          String(candidate.target_language) === String(params[3]) &&
          String(candidate.source_hash) === String(params[4])
        );
        return row ? [row] : [];
      }
      const history = params[4] === true;
      return [...this.table('collaboration_message_translations').values()]
        .filter((row) => String(row.tenant_id) === String(params[0]))
        .filter((row) => String(row.source_type) === String(params[1]) && String(row.source_ref_id) === String(params[2]))
        .filter((row) => !String(params[3] || '') || String(row.target_language) === String(params[3]))
        .filter((row) => history || String(row.source_hash) === String(params[5]))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)))
        .slice(0, 500);
    }

    if (sql.startsWith('SELECT * FROM collaboration_intelligence_policies WHERE tenant_id')) {
      const row = this.table('collaboration_intelligence_policies').get(String(params[0]));
      return row ? [row] : [];
    }

    if (sql.startsWith('INSERT INTO collaboration_intelligence_policies')) {
      const tenantId = String(params[0]);
      const existing = this.table('collaboration_intelligence_policies').get(tenantId);
      const expectedVersion = Number(params[31]);
      if (existing && Number(existing.version) !== expectedVersion) return [];
      const now = this.nowIso();
      const row: TableRow = {
        tenant_id: tenantId,
        ocr_enabled: params[1],
        asr_enabled: params[2],
        quality_review_enabled: params[3],
        translation_enabled: params[4],
        realtime_speech_enabled: params[5],
        tts_enabled: params[6],
        model_gateway_enabled: params[7],
        ocr_profile_id: params[8],
        asr_profile_id: params[9],
        quality_profile_id: params[10],
        translation_profile_id: params[11],
        realtime_speech_profile_id: params[12],
        tts_profile_id: params[13],
        model_gateway_profile_id: params[14],
        ocr_profile_ids: params[15],
        asr_profile_ids: params[16],
        quality_profile_ids: params[17],
        translation_profile_ids: params[18],
        realtime_speech_profile_ids: params[19],
        tts_profile_ids: params[20],
        model_gateway_profile_ids: params[21],
        allow_third_party: params[22],
        auto_ocr: params[23],
        auto_asr: params[24],
        auto_quality_review: params[25],
        auto_translation: params[26],
        translation_target_languages: params[27],
        min_ocr_confidence: params[28],
        min_asr_confidence: params[29],
        version: existing ? Number(existing.version) + 1 : 1,
        updated_by: params[30],
        created_at: existing?.created_at || now,
        updated_at: now
      };
      this.table('collaboration_intelligence_policies').set(tenantId, row);
      return [row];
    }

    if (sql.startsWith('INSERT INTO collaboration_intelligence_source_links')) {
      const existing = [...this.table('collaboration_intelligence_source_links').values()].find((row) =>
        (String(row.tenant_id) === String(params[1]) && String(row.idempotency_key) === String(params[13])) ||
        (
          String(row.tenant_id) === String(params[1]) &&
          String(row.session_id) === String(params[2]) &&
          String(row.source_type) === String(params[3]) &&
          String(row.source_ref_id) === String(params[4])
        )
      );
      if (existing) return { rows: [], rowCount: 0 };
      const now = this.nowIso();
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        session_id: params[2],
        source_type: params[3],
        source_ref_id: params[4],
        message_id: params[5],
        attachment_id: params[6],
        processor_profile_id: params[7],
        content_type: params[8],
        checksum: params[9],
        status: params[10],
        error_code: params[11],
        created_by: params[12],
        idempotency_key: params[13],
        request_hash: params[14],
        created_at: now,
        updated_at: now
      };
      this.table('collaboration_intelligence_source_links').set(String(row.id), row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('SELECT * FROM collaboration_intelligence_source_links')) {
      const rows = [...this.table('collaboration_intelligence_source_links').values()];
      if (sql.includes('idempotency_key = $2')) {
        return rows.filter((row) =>
          String(row.tenant_id) === String(params[0]) && String(row.idempotency_key) === String(params[1])
        );
      }
      if (sql.includes('source_type = $3')) {
        return rows.filter((row) =>
          String(row.tenant_id) === String(params[0]) &&
          String(row.session_id) === String(params[1]) &&
          String(row.source_type) === String(params[2]) &&
          String(row.source_ref_id) === String(params[3])
        );
      }
      return rows.filter((row) =>
        String(row.id) === String(params[0]) &&
        String(row.tenant_id) === String(params[1]) &&
        String(row.session_id) === String(params[2])
      );
    }

    if (sql.startsWith("UPDATE collaboration_intelligence_source_links SET status = 'pending'")) {
      const row = this.table('collaboration_intelligence_source_links').get(String(params[0]));
      if (row && String(row.tenant_id) === String(params[1]) && String(row.session_id) === String(params[2])) {
        row.status = 'pending';
        row.error_code = '';
        row.processor_profile_id = params[3];
        row.updated_at = this.nowIso();
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.startsWith('UPDATE collaboration_intelligence_source_links SET status = $3')) {
      const row = [...this.table('collaboration_intelligence_source_links').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[0]) &&
        String(candidate.attachment_id) === String(params[1])
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.status = params[2];
      row.error_code = params[3];
      row.processor_profile_id = params[4];
      row.updated_at = this.nowIso();
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('SELECT * FROM collaboration_message_translations WHERE id')) {
      const row = this.table('collaboration_message_translations').get(String(params[0]));
      return row ? [row] : [];
    }

    if (sql.startsWith('INSERT INTO collaboration_policy_events')) {
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        session_id: params[2],
        message_id: params[3],
        policy_type: params[4],
        severity: params[5],
        matched_text_hash: params[6],
        action: params[7],
        source: params[8] || 'text',
        source_ref_id: params[9] || '',
        attachment_id: params[10] || '',
        finding_id: params[11] || '',
        detector_version: params[12] || 'legacy-v1',
        policy_version: params[13] || 'legacy-v1',
        evidence_snapshot_hash: params[14] || '0'.repeat(64),
        content_version: params[15] || 1,
        created_at: this.nowIso()
      };
      this.table('collaboration_policy_events').set(String(row.id), row);
      return [];
    }

    if (sql.startsWith('SELECT * FROM collaboration_policy_events WHERE id')) {
      const row = this.table('collaboration_policy_events').get(String(params[0]));
      return row ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM collaboration_policy_events WHERE session_id')) {
      const sessionId = String(params[0]);
      const messageId = sql.includes('AND message_id') ? String(params[1]) : '';
      return [...this.table('collaboration_policy_events').values()]
        .filter((row) => String(row.session_id) === sessionId)
        .filter((row) => !messageId || String(row.message_id) === messageId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }

    if (sql.startsWith('INSERT INTO collaboration_participant_realtime_state')) {
      const existing = [...this.table('collaboration_participant_realtime_state').values()].find(
        (row) =>
          String(row.tenant_id) === String(params[1]) &&
          String(row.session_id) === String(params[2]) &&
          String(row.identity) === String(params[3])
      );
      if (existing) return { rows: [], rowCount: 0 };
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        session_id: params[2],
        identity: params[3],
        presence_status: 'offline',
        presence_expires_at: null,
        typing_expires_at: null,
        last_seen_at: null,
        metadata: {},
        created_at: params[4],
        updated_at: params[4]
      };
      this.table('collaboration_participant_realtime_state').set(String(row.id), row);
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE collaboration_participant_realtime_state SET typing_expires_at')) {
      const row = [...this.table('collaboration_participant_realtime_state').values()].find(
        (candidate) =>
          String(candidate.tenant_id) === String(params[0]) &&
          String(candidate.session_id) === String(params[1]) &&
          String(candidate.identity) === String(params[2])
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.typing_expires_at = params[3];
      row.last_seen_at = params[4];
      row.updated_at = params[4];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE collaboration_participant_realtime_state SET presence_status')) {
      const row = [...this.table('collaboration_participant_realtime_state').values()].find(
        (candidate) =>
          String(candidate.tenant_id) === String(params[0]) &&
          String(candidate.session_id) === String(params[1]) &&
          String(candidate.identity) === String(params[2])
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.presence_status = params[3];
      row.presence_expires_at = params[4];
      row.last_seen_at = params[5];
      row.updated_at = params[5];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('SELECT * FROM collaboration_participant_realtime_state WHERE tenant_id')) {
      return [...this.table('collaboration_participant_realtime_state').values()]
        .filter((row) => String(row.tenant_id) === String(params[0]))
        .filter((row) => String(row.session_id) === String(params[1]))
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    }

    if (sql.startsWith('INSERT INTO collaboration_message_receipts')) {
      const existing = [...this.table('collaboration_message_receipts').values()].find(
        (row) =>
          String(row.tenant_id) === String(params[1]) &&
          String(row.message_id) === String(params[3]) &&
          String(row.identity) === String(params[4])
      );
      if (existing) {
        if (!existing.delivered_at && params[5]) existing.delivered_at = params[5];
        if (!existing.read_at && params[6]) existing.read_at = params[6];
        if (params[6] || Number(params[8]) >= Number(existing.provider_sequence || 0)) {
          existing.source = params[7];
        }
        existing.provider_sequence = Math.max(
          Number(existing.provider_sequence || 0),
          Number(params[8] || 0)
        );
        existing.metadata = mergeJsonObjects(existing.metadata, params[9]);
        existing.updated_at = params[10];
        return { rows: [existing], rowCount: 1 };
      }
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        session_id: params[2],
        message_id: params[3],
        identity: params[4],
        delivered_at: params[5],
        read_at: params[6],
        source: params[7],
        provider_sequence: params[8],
        metadata: params[9],
        created_at: params[10],
        updated_at: params[10]
      };
      this.table('collaboration_message_receipts').set(String(row.id), row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('SELECT * FROM collaboration_message_receipts WHERE tenant_id')) {
      return [...this.table('collaboration_message_receipts').values()]
        .filter((row) => String(row.tenant_id) === String(params[0]))
        .filter((row) => String(row.session_id) === String(params[1]))
        .filter((row) => !String(params[2] || '') || String(row.message_id) === String(params[2]))
        .filter((row) => !String(params[3] || '') || String(row.identity) === String(params[3]))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    }

    if (sql.startsWith('INSERT INTO collaboration_policy_findings')) {
      const existing = [...this.table('collaboration_policy_findings').values()]
        .find((row) => String(row.fingerprint) === String(params[9]));
      if (existing) {
        existing.severity = params[7];
        existing.action = params[10];
        if (params[11] != null) existing.confidence = params[11];
        if (String(params[12] || '')) existing.rationale = params[12];
        existing.evidence_refs = params[13];
        existing.metadata = mergeJsonObjects(existing.metadata, params[14]);
        existing.detector_version = params[15];
        existing.policy_version = params[16];
        existing.evidence_snapshot_hash = params[17];
        existing.content_version = params[18];
        existing.updated_at = params[19];
        return { rows: [existing], rowCount: 1 };
      }
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        session_id: params[2],
        message_id: params[3],
        source: params[4],
        source_ref_id: params[5],
        policy_type: params[6],
        severity: params[7],
        matched_text_hash: params[8],
        fingerprint: params[9],
        action: params[10],
        confidence: params[11],
        rationale: params[12],
        evidence_refs: params[13],
        review_status: 'pending',
        reviewed_by: '',
        reviewed_at: null,
        review_note: '',
        metadata: params[14],
        detector_version: params[15],
        policy_version: params[16],
        evidence_snapshot_hash: params[17],
        content_version: params[18],
        created_at: params[19],
        updated_at: params[19],
        resolved_at: null
      };
      this.table('collaboration_policy_findings').set(String(row.id), row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('SELECT * FROM collaboration_policy_findings WHERE id')) {
      const row = this.table('collaboration_policy_findings').get(String(params[0]));
      return row && String(row.tenant_id) === String(params[1]) ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM collaboration_policy_findings WHERE tenant_id')) {
      return [...this.table('collaboration_policy_findings').values()]
        .filter((row) => String(row.tenant_id) === String(params[0]))
        .filter((row) => String(row.session_id) === String(params[1]))
        .filter((row) => !String(params[2] || '') || String(row.message_id) === String(params[2]))
        .filter((row) => !String(params[3] || '') || String(row.source) === String(params[3]))
        .filter((row) => !String(params[4] || '') || String(row.review_status) === String(params[4]))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, Number(params[5]));
    }

    if (sql.startsWith('SELECT finding.* FROM collaboration_policy_findings AS finding')) {
      const cursorCreatedAt = String(params[7] || '');
      const cursorId = String(params[8] || '');
      const messages = this.table('collaboration_messages');
      return [...this.table('collaboration_policy_findings').values()]
        .filter((row) => String(row.tenant_id) === String(params[0]))
        .filter((row) => !String(params[1] || '') || String(row.session_id) === String(params[1]))
        .filter((row) => !String(params[2] || '') || String(row.source) === String(params[2]))
        .filter((row) => !String(params[3] || '') || String(row.severity) === String(params[3]))
        .filter((row) => !String(params[4] || '') || String(row.review_status) === String(params[4]))
        .filter((row) => !String(params[5] || '') || String(row.created_at) >= String(params[5]))
        .filter((row) => !String(params[6] || '') || String(row.created_at) <= String(params[6]))
        .filter((row) => !cursorCreatedAt || String(row.created_at) < cursorCreatedAt || (
          String(row.created_at) === cursorCreatedAt && String(row.id) < cursorId
        ))
        .filter((row) => {
          const messageId = String(row.message_id || '');
          if (!messageId) return true;
          const message = messages.get(messageId);
          return Boolean(message && !message.deleted_at);
        })
        .sort((left, right) =>
          String(right.created_at).localeCompare(String(left.created_at)) ||
          String(right.id).localeCompare(String(left.id))
        )
        .slice(0, Number(params[9]));
    }

    if (sql.startsWith('UPDATE collaboration_policy_findings SET review_status')) {
      const row = this.table('collaboration_policy_findings').get(String(params[0]));
      if (!row || String(row.tenant_id) !== String(params[1])) return { rows: [], rowCount: 0 };
      row.review_status = params[2];
      row.reviewed_by = params[3];
      row.reviewed_at = params[4];
      row.review_note = params[5];
      if (params[2] === 'resolved') row.resolved_at = params[4];
      row.updated_at = params[4];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO collaboration_policy_finding_reviews')) {
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        finding_id: params[2],
        from_status: params[3],
        to_status: params[4],
        reviewed_by: params[5],
        note: params[6],
        note_hash: params[7],
        metadata: params[8],
        created_at: params[9]
      };
      this.table('collaboration_policy_finding_reviews').set(String(row.id), row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('SELECT * FROM collaboration_policy_finding_reviews WHERE tenant_id')) {
      return [...this.table('collaboration_policy_finding_reviews').values()]
        .filter((row) => String(row.tenant_id) === String(params[0]))
        .filter((row) => String(row.finding_id) === String(params[1]))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    }

    if (sql.startsWith('INSERT INTO collaboration_quality_review_jobs')) {
      const existing = [...this.table('collaboration_quality_review_jobs').values()].find(
        (row) => String(row.tenant_id) === String(params[1]) && String(row.message_id) === String(params[3])
      );
      if (existing) {
        const changed = String(existing.input_hash) !== String(params[4]);
        const wasCancelled = String(existing.status) === 'cancelled';
        const wasSucceeded = String(existing.status) === 'succeeded';
        const incomingStatus = String(params[6]);
        existing.session_id = params[2];
        existing.input_hash = params[4];
        if (changed) {
          existing.status = incomingStatus;
          existing.attempt_count = 0;
          existing.next_attempt_at = null;
          existing.lease_until = null;
          existing.worker_id = '';
          existing.error_code = params[11];
          existing.error_message = params[11];
          existing.completed_at = incomingStatus === 'cancelled' ? params[12] : null;
        } else if (!wasSucceeded && incomingStatus === 'cancelled') {
          existing.status = 'cancelled';
          existing.error_code = params[11];
          existing.error_message = params[11];
          existing.completed_at = params[12];
        } else if (!wasSucceeded && wasCancelled) {
          existing.status = 'pending';
          existing.attempt_count = 0;
          existing.next_attempt_at = null;
          existing.lease_until = null;
          existing.worker_id = '';
          existing.error_code = params[11];
          existing.error_message = params[11];
          existing.completed_at = null;
        }
        existing.provider_profile_id = params[7];
        existing.provider_mode = params[8];
        existing.provider_name = params[9];
        existing.automatic = params[10];
        existing.updated_at = params[12];
        return { rows: [existing], rowCount: 1 };
      }
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        session_id: params[2],
        message_id: params[3],
        input_hash: params[4],
        status: params[6],
        attempt_count: 0,
        max_attempts: params[5],
        next_attempt_at: null,
        lease_until: null,
        worker_id: '',
        provider_profile_id: params[7],
        provider_mode: params[8],
        provider_name: params[9],
        automatic: params[10],
        error_code: params[11],
        error_message: params[11],
        output_metadata: {},
        created_at: params[12],
        updated_at: params[12],
        completed_at: String(params[6]) === 'cancelled' ? params[12] : null
      };
      this.table('collaboration_quality_review_jobs').set(String(row.id), row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('SELECT * FROM collaboration_quality_review_jobs WHERE tenant_id') && sql.includes('message_id = $2')) {
      const row = [...this.table('collaboration_quality_review_jobs').values()].find(
        (candidate) =>
          String(candidate.tenant_id) === String(params[0]) &&
          String(candidate.message_id) === String(params[1])
      );
      return row ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM collaboration_quality_review_jobs WHERE tenant_id')) {
      const dueAt = String(params[1]);
      const limit = Number(params[2]);
      return [...this.table('collaboration_quality_review_jobs').values()]
        .filter((row) => String(row.tenant_id) === String(params[0]))
        .filter((row) => Number(row.attempt_count) < Number(row.max_attempts))
        .filter((row) =>
          String(row.status) === 'pending' ||
          (String(row.status) === 'retry_wait' && (!row.next_attempt_at || String(row.next_attempt_at) <= dueAt))
        )
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, limit);
    }

    if (sql.startsWith('SELECT * FROM collaboration_quality_review_jobs WHERE attempt_count')) {
      const dueAt = String(params[0]);
      const limit = Number(params[1]);
      return [...this.table('collaboration_quality_review_jobs').values()]
        .filter((row) => Number(row.attempt_count) < Number(row.max_attempts))
        .filter((row) =>
          String(row.status) === 'pending' ||
          (String(row.status) === 'retry_wait' && (!row.next_attempt_at || String(row.next_attempt_at) <= dueAt))
        )
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, limit);
    }

    if (sql.startsWith("UPDATE collaboration_quality_review_jobs SET status = 'processing'")) {
      const row = this.table('collaboration_quality_review_jobs').get(String(params[0]));
      const now = String(params[7]);
      const claimable = row &&
        String(row.tenant_id) === String(params[1]) &&
        Number(row.attempt_count) < Number(row.max_attempts) &&
        (
          String(row.status) === 'pending' ||
          (String(row.status) === 'retry_wait' && (!row.next_attempt_at || String(row.next_attempt_at) <= now))
        );
      if (!row || !claimable) return { rows: [], rowCount: 0 };
      row.status = 'processing';
      row.attempt_count = Number(row.attempt_count) + 1;
      row.lease_until = params[3];
      row.worker_id = params[2];
      row.next_attempt_at = null;
      row.provider_profile_id = params[4];
      row.provider_mode = params[5];
      row.provider_name = params[6];
      row.error_code = '';
      row.error_message = '';
      row.updated_at = params[7];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE collaboration_quality_review_jobs SET status = 'cancelled'")) {
      const row = sql.includes('WHERE id = $1')
        ? this.table('collaboration_quality_review_jobs').get(String(params[0]))
        : [...this.table('collaboration_quality_review_jobs').values()].find(
          (candidate) =>
            String(candidate.tenant_id) === String(params[0]) &&
            String(candidate.message_id) === String(params[1])
        );
      if (sql.includes('WHERE id = $1') && row && String(row.tenant_id) !== String(params[1])) {
        return { rows: [], rowCount: 0 };
      }
      if (!row || row.status === 'succeeded' || row.status === 'cancelled') {
        return { rows: [], rowCount: 0 };
      }
      row.status = 'cancelled';
      row.next_attempt_at = null;
      row.lease_until = null;
      row.worker_id = '';
      row.error_code = params[2];
      row.error_message = params[3];
      row.completed_at = params[4];
      row.updated_at = params[4];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE collaboration_quality_review_jobs SET provider_profile_id')) {
      const row = this.table('collaboration_quality_review_jobs').get(String(params[0]));
      if (
        !row ||
        String(row.tenant_id) !== String(params[1]) ||
        !['pending', 'retry_wait'].includes(String(row.status))
      ) return { rows: [], rowCount: 0 };
      row.provider_profile_id = params[2];
      row.error_code = params[3];
      row.error_message = params[3];
      row.updated_at = params[4];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE collaboration_quality_review_jobs SET status = 'succeeded'")) {
      const row = this.table('collaboration_quality_review_jobs').get(String(params[0]));
      if (
        !row ||
        String(row.tenant_id) !== String(params[1]) ||
        String(row.status) !== 'processing' ||
        String(row.worker_id) !== String(params[2]) ||
        String(row.input_hash) !== String(params[3])
      ) return { rows: [], rowCount: 0 };
      row.status = 'succeeded';
      row.provider_profile_id = params[4];
      row.provider_mode = params[5];
      row.provider_name = params[6];
      row.error_code = '';
      row.error_message = '';
      row.output_metadata = params[7];
      row.lease_until = null;
      row.worker_id = '';
      row.completed_at = params[8];
      row.updated_at = params[8];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE collaboration_quality_review_jobs SET status = $4')) {
      const row = this.table('collaboration_quality_review_jobs').get(String(params[0]));
      if (
        !row ||
        String(row.tenant_id) !== String(params[1]) ||
        String(row.status) !== 'processing' ||
        String(row.worker_id) !== String(params[2])
      ) return { rows: [], rowCount: 0 };
      row.status = params[3];
      row.next_attempt_at = params[4];
      row.lease_until = null;
      row.worker_id = '';
      row.error_code = params[5];
      row.error_message = params[6];
      row.attempt_count = Math.max(0, Number(row.attempt_count) - Number(params[8] || 0));
      row.output_metadata = mergeJsonObjects(row.output_metadata, params[9]);
      row.completed_at = params[3] === 'failed' ? params[7] : null;
      row.updated_at = params[7];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE collaboration_quality_review_jobs SET status = CASE')) {
      const tenantScoped = sql.includes('WHERE tenant_id = $1');
      const tenantId = tenantScoped ? String(params[0]) : '';
      const now = String(params[tenantScoped ? 1 : 0]);
      let count = 0;
      for (const row of this.table('collaboration_quality_review_jobs').values()) {
        if (tenantScoped && String(row.tenant_id) !== tenantId) continue;
        if (String(row.status) !== 'processing' || !row.lease_until || String(row.lease_until) > now) continue;
        const terminal = Number(row.attempt_count) >= Number(row.max_attempts);
        row.status = terminal ? 'failed' : 'retry_wait';
        row.next_attempt_at = terminal ? null : now;
        row.lease_until = null;
        row.worker_id = '';
        row.error_code = 'claim_lease_expired';
        row.error_message = 'quality review claim lease expired';
        row.updated_at = now;
        row.completed_at = terminal ? now : null;
        count += 1;
      }
      return { rows: [], rowCount: count };
    }

    if (sql.startsWith('INSERT INTO remote_assistance_sessions')) {
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        collaboration_session_id: params[2],
        business_ref_type: params[3],
        business_ref_id: params[4],
        mode: params[5],
        adapter_provider: params[6],
        started_by: params[7],
        metadata: params[8],
        status: 'created',
        started_at: null,
        ended_at: null,
        created_at: this.nowIso()
      };
      this.table('remote_assistance_sessions').set(String(row.id), row);
      return [];
    }

    if (sql.startsWith('SELECT * FROM remote_assistance_sessions WHERE id')) {
      const row = this.table('remote_assistance_sessions').get(String(params[0]));
      return row ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM remote_assistance_sessions') && sql.includes('business_ref_type')) {
      const tenantId = String(params[0]);
      const refType = String(params[1]);
      const refId = String(params[2]);
      const limit = Number(params[3] || 50);
      return [...this.table('remote_assistance_sessions').values()]
        .filter((row) => String(row.tenant_id) === tenantId && String(row.business_ref_type) === refType && String(row.business_ref_id) === refId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
    }

    if (sql.startsWith('UPDATE remote_assistance_sessions SET status')) {
      const row = this.table('remote_assistance_sessions').get(String(params[0]));
      if (row) {
        if (sql.includes("'ended'")) {
          row.status = 'ended';
          row.ended_at = row.ended_at || this.nowIso();
        } else {
          row.status = 'active';
          row.started_at = row.started_at || this.nowIso();
        }
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('INSERT INTO remote_consent_events')) {
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        remote_session_id: params[2],
        actor_identity: params[3],
        event_type: params[4],
        scopes: params[5],
        expires_at: params[6],
        metadata: params[7],
        created_at: this.nowIso()
      };
      this.table('remote_consent_events').set(String(row.id), row);
      return [];
    }

    if (sql.startsWith('SELECT * FROM remote_consent_events WHERE id')) {
      const row = this.table('remote_consent_events').get(String(params[0]));
      return row ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM remote_consent_events WHERE remote_session_id')) {
      const remoteSessionId = String(params[0]);
      const limit = Number(params[1] || 1);
      const rows = [...this.table('remote_consent_events').values()]
        .filter((row) => String(row.remote_session_id) === remoteSessionId)
        .sort((a, b) => {
          if (sql.includes('ORDER BY created_at ASC')) {
            return String(a.created_at).localeCompare(String(b.created_at));
          }
          return String(b.created_at).localeCompare(String(a.created_at));
        });
      return rows.slice(0, limit);
    }

    if (sql.startsWith('INSERT INTO remote_tool_sessions')) {
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        remote_session_id: params[2],
        provider: params[3],
        external_id: params[4],
        launch_url: params[5],
        started_by: params[6],
        metadata: params[7],
        status: 'active',
        started_at: this.nowIso(),
        ended_at: null
      };
      this.table('remote_tool_sessions').set(String(row.id), row);
      return [];
    }

    if (sql.startsWith('SELECT * FROM remote_tool_sessions WHERE id')) {
      const row = this.table('remote_tool_sessions').get(String(params[0]));
      return row ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM remote_tool_sessions WHERE tenant_id')) {
      const row = [...this.table('remote_tool_sessions').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[0]) && String(candidate.external_id) === String(params[1])
      );
      return row ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM remote_tool_sessions WHERE remote_session_id')) {
      const remoteSessionId = String(params[0]);
      const limit = Number(params[1] || 50);
      const activeOnly = sql.includes("status = 'active'");
      return [...this.table('remote_tool_sessions').values()]
        .filter((row) => String(row.remote_session_id) === remoteSessionId && (!activeOnly || String(row.status) === 'active'))
        .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))
        .slice(0, limit);
    }

    if (sql.startsWith('UPDATE remote_tool_sessions SET status')) {
      const row = this.table('remote_tool_sessions').get(String(params[0]));
      if (row) {
        row.status = 'ended';
        row.ended_at = this.nowIso();
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('INSERT INTO remote_audit_events')) {
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        remote_session_id: params[2],
        actor_identity: params[3],
        event_type: params[4],
        target: params[5],
        metadata: params[6],
        created_at: this.nowIso()
      };
      this.table('remote_audit_events').set(String(row.id), row);
      return [];
    }

    if (sql.startsWith('SELECT * FROM remote_audit_events WHERE id')) {
      const row = this.table('remote_audit_events').get(String(params[0]));
      return row ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM remote_audit_events WHERE tenant_id')) {
      const tenantId = String(params[0]);
      const remoteSessionId = String(params[1]);
      const limit = Number(params[2] || 100);
      return [...this.table('remote_audit_events').values()]
        .filter((row) => String(row.tenant_id) === tenantId && String(row.remote_session_id) === remoteSessionId)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, limit);
    }

    if (sql.startsWith('SELECT COUNT(*) AS count FROM remote_audit_events')) {
      const remoteSessionId = String(params[0]);
      const count = [...this.table('remote_audit_events').values()]
        .filter((row) => String(row.remote_session_id) === remoteSessionId).length;
      return [{ count }];
    }

    if (sql.startsWith('INSERT INTO rustdesk_devices')) {
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        business_ref_type: params[2],
        business_ref_id: params[3],
        rustdesk_id: params[4],
        display_name: params[5],
        status: 'active',
        runtime_status: 'unknown',
        last_seen_at: null,
        last_seen_actor: '',
        metadata: params[6],
        created_at: this.nowIso(),
        updated_at: this.nowIso(),
        deactivated_at: null
      };
      this.table('rustdesk_devices').set(String(row.id), row);
      return [];
    }

    if (sql.startsWith('SELECT id, business_ref_type, business_ref_id FROM rustdesk_devices')) {
      const row = this.table('rustdesk_devices').get(String(params[1]));
      return row && String(row.tenant_id) === String(params[0]) ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM rustdesk_access_policy_events') && sql.includes('idempotency_key')) {
      const row = [...this.table('rustdesk_access_policy_events').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[0]) &&
        String(candidate.idempotency_key) === String(params[1])
      );
      return row ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM rustdesk_access_policy_events') && sql.includes('device_id')) {
      const rows = [...this.table('rustdesk_access_policy_events').values()]
        .filter((row) =>
          String(row.tenant_id) === String(params[0]) &&
          String(row.device_id) === String(params[1])
        )
        .sort((left, right) => Number(left.version) - Number(right.version));
      return sql.includes('ORDER BY version DESC') ? rows.reverse().slice(0, 1) : rows;
    }

    if (sql.startsWith('INSERT INTO rustdesk_access_policy_events')) {
      const duplicateKey = [...this.table('rustdesk_access_policy_events').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[1]) &&
        String(candidate.idempotency_key) === String(params[13])
      );
      const duplicateVersion = [...this.table('rustdesk_access_policy_events').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[1]) &&
        String(candidate.device_id) === String(params[2]) &&
        Number(candidate.version) === Number(params[12])
      );
      if (duplicateKey || duplicateVersion) throw new Error('duplicate rustdesk access policy event');
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        device_id: params[2],
        event_type: params[3],
        mode: params[4],
        allowed_scopes: JSON.parse(String(params[5] || '[]')),
        business_ref_type: params[6],
        business_ref_id: params[7],
        approved_by: params[8],
        reason: params[9],
        expires_at: params[10] || null,
        supersedes_id: params[11] || null,
        version: params[12],
        idempotency_key: params[13],
        request_hash: params[14],
        created_at: this.nowIso()
      };
      this.table('rustdesk_access_policy_events').set(String(row.id), row);
      return [row];
    }

    if (sql.startsWith('SELECT * FROM rustdesk_authorization_codes') && sql.includes('idempotency_key')) {
      const row = [...this.table('rustdesk_authorization_codes').values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[0]) &&
        String(candidate.idempotency_key) === String(params[1])
      );
      return row ? [row] : [];
    }

    if (sql.startsWith('INSERT INTO rustdesk_authorization_codes')) {
      const table = this.table('rustdesk_authorization_codes');
      const duplicate = [...table.values()].find((candidate) =>
        String(candidate.tenant_id) === String(params[1]) &&
        String(candidate.idempotency_key) === String(params[17])
      );
      if (duplicate || table.has(String(params[0]))) {
        throw new Error('duplicate RustDesk authorization code');
      }
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        remote_session_id: params[2],
        device_id: params[3],
        scopes: JSON.parse(String(params[4] || '[]')),
        requested_by: params[5],
        requested_at: params[6],
        code_salt: params[7],
        code_hmac: params[8],
        expires_at: params[9],
        max_attempts: params[10],
        attempt_count: params[11],
        status: params[12],
        verified_by: params[13] || null,
        verified_at: params[14] || null,
        consumed_external_id: params[15] || null,
        consumed_at: params[16] || null,
        idempotency_key: params[17],
        request_hash: params[18],
        updated_at: params[19],
        claim_id: null,
        claimed_by: null,
        claimed_at: null,
        claim_expires_at: null
      };
      table.set(String(row.id), row);
      return [row];
    }

    if (sql.startsWith("UPDATE rustdesk_authorization_codes SET status = 'expired'")) {
      const row = this.table('rustdesk_authorization_codes').get(String(params[1]));
      const canExpire = Boolean(
        row &&
        String(row.tenant_id) === String(params[0]) &&
        ['pending', 'verified', 'claimed'].includes(String(row.status)) &&
        String(row.expires_at) <= String(params[2])
      );
      if (canExpire && row) {
        row.status = 'expired';
        row.claim_id = null;
        row.claimed_by = null;
        row.claimed_at = null;
        row.claim_expires_at = null;
        row.updated_at = params[2];
      }
      return { rows: [], rowCount: canExpire ? 1 : 0 };
    }

    if (sql.startsWith("UPDATE rustdesk_authorization_codes SET status = 'verified', claim_id = NULL") &&
        sql.includes('claim_expires_at <= $3')) {
      const row = this.table('rustdesk_authorization_codes').get(String(params[1]));
      const canRelease = Boolean(
        row && String(row.tenant_id) === String(params[0]) && row.status === 'claimed' &&
        String(row.claim_expires_at) <= String(params[2]) && String(row.expires_at) > String(params[2])
      );
      if (canRelease && row) {
        row.status = 'verified';
        row.claim_id = null;
        row.claimed_by = null;
        row.claimed_at = null;
        row.claim_expires_at = null;
        row.updated_at = params[2];
      }
      return { rows: [], rowCount: canRelease ? 1 : 0 };
    }

    if (sql.startsWith('SELECT * FROM rustdesk_authorization_codes') && sql.includes('id = $2')) {
      const row = this.table('rustdesk_authorization_codes').get(String(params[1]));
      return row && String(row.tenant_id) === String(params[0]) ? [row] : [];
    }

    if (sql.startsWith('UPDATE rustdesk_authorization_codes SET attempt_count')) {
      const row = this.table('rustdesk_authorization_codes').get(String(params[1]));
      const canUpdate = Boolean(row && String(row.tenant_id) === String(params[0]));
      if (canUpdate && row) {
        row.attempt_count = params[2];
        row.status = params[3];
        row.updated_at = params[4];
      }
      return { rows: [], rowCount: canUpdate ? 1 : 0 };
    }

    if (sql.startsWith("UPDATE rustdesk_authorization_codes SET status = 'verified'") &&
        !sql.includes('claim_id = NULL')) {
      const row = this.table('rustdesk_authorization_codes').get(String(params[1]));
      const canVerify = Boolean(
        row && String(row.tenant_id) === String(params[0]) && row.status === 'pending'
      );
      if (canVerify && row) {
        row.status = 'verified';
        row.verified_by = params[2];
        row.verified_at = params[3];
        row.updated_at = params[3];
      }
      return { rows: canVerify && row ? [row] : [], rowCount: canVerify ? 1 : 0 };
    }

    if (sql.startsWith("UPDATE rustdesk_authorization_codes SET status = 'claimed'")) {
      const row = this.table('rustdesk_authorization_codes').get(String(params[1]));
      const canClaim = Boolean(
        row && String(row.tenant_id) === String(params[0]) && row.status === 'verified' &&
        String(row.verified_by) === String(params[2])
      );
      if (canClaim && row) {
        row.status = 'claimed';
        row.claim_id = params[3];
        row.claimed_by = params[2];
        row.claimed_at = params[4];
        row.claim_expires_at = params[5];
        row.updated_at = params[4];
      }
      return { rows: canClaim && row ? [row] : [], rowCount: canClaim ? 1 : 0 };
    }

    if (sql.startsWith("UPDATE rustdesk_authorization_codes SET status = 'verified', claim_id = NULL") &&
        sql.includes('claim_id = $4')) {
      const row = this.table('rustdesk_authorization_codes').get(String(params[1]));
      const canRelease = Boolean(
        row && String(row.tenant_id) === String(params[0]) && row.status === 'claimed' &&
        String(row.verified_by) === String(params[2]) && String(row.claimed_by) === String(params[2]) &&
        String(row.claim_id) === String(params[3])
      );
      if (canRelease && row) {
        row.status = 'verified';
        row.claim_id = null;
        row.claimed_by = null;
        row.claimed_at = null;
        row.claim_expires_at = null;
        row.updated_at = params[4];
      }
      return { rows: canRelease && row ? [row] : [], rowCount: canRelease ? 1 : 0 };
    }

    if (sql.startsWith("UPDATE rustdesk_authorization_codes SET status = 'consumed'") &&
        sql.includes('claim_id = NULL')) {
      const row = this.table('rustdesk_authorization_codes').get(String(params[1]));
      const canConsume = Boolean(
        row && String(row.tenant_id) === String(params[0]) && row.status === 'claimed' &&
        String(row.verified_by) === String(params[2]) && String(row.claimed_by) === String(params[2]) &&
        String(row.claim_id) === String(params[3])
      );
      if (canConsume && row) {
        row.status = 'consumed';
        row.consumed_external_id = params[4];
        row.consumed_at = params[5];
        row.claim_id = null;
        row.claimed_by = null;
        row.claimed_at = null;
        row.claim_expires_at = null;
        row.updated_at = params[5];
      }
      return { rows: canConsume && row ? [row] : [], rowCount: canConsume ? 1 : 0 };
    }

    if (sql.startsWith("UPDATE rustdesk_authorization_codes SET status = 'consumed'")) {
      const row = this.table('rustdesk_authorization_codes').get(String(params[1]));
      const canConsume = Boolean(
        row &&
        String(row.tenant_id) === String(params[0]) &&
        row.status === 'verified' &&
        String(row.verified_by) === String(params[2])
      );
      if (canConsume && row) {
        row.status = 'consumed';
        row.consumed_external_id = params[3];
        row.consumed_at = params[4];
        row.updated_at = params[4];
      }
      return { rows: canConsume && row ? [row] : [], rowCount: canConsume ? 1 : 0 };
    }

    if (sql.startsWith('SELECT * FROM rustdesk_devices') && sql.includes('rustdesk_id')) {
      const tenantId = String(params[0]);
      const rustdeskId = String(params[1]);
      return [...this.table('rustdesk_devices').values()]
        .filter((row) =>
          String(row.tenant_id) === tenantId &&
          String(row.rustdesk_id) === rustdeskId &&
          !row.deactivated_at
        )
        .slice(0, 1);
    }

    if (sql.startsWith('SELECT * FROM rustdesk_devices') && sql.includes('id = $2')) {
      const tenantId = String(params[0]);
      const deviceId = String(params[1]);
      const row = this.table('rustdesk_devices').get(deviceId);
      return row && String(row.tenant_id) === tenantId ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM rustdesk_devices') && sql.includes('business_ref_type')) {
      const tenantId = String(params[0]);
      const refType = String(params[1]);
      const refId = String(params[2]);
      const limit = Number(params[3] || 50);
      return [...this.table('rustdesk_devices').values()]
        .filter((row) =>
          String(row.tenant_id) === tenantId &&
          String(row.business_ref_type) === refType &&
          String(row.business_ref_id) === refId &&
          !row.deactivated_at
        )
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
    }

    if (sql.startsWith('UPDATE rustdesk_devices SET runtime_status')) {
      const tenantId = String(params[0]);
      const deviceId = String(params[1]);
      const row = this.table('rustdesk_devices').get(deviceId);
      const canUpdate = Boolean(row && String(row.tenant_id) === tenantId && !row.deactivated_at);
      if (canUpdate && row) {
        row.runtime_status = params[2];
        row.last_seen_at = params[3];
        row.last_seen_actor = params[4];
        row.metadata = params[5];
        row.updated_at = this.nowIso();
      }
      return { rows: [], rowCount: canUpdate ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE rustdesk_devices SET status')) {
      const tenantId = String(params[0]);
      const deviceId = String(params[1]);
      const row = this.table('rustdesk_devices').get(deviceId);
      if (row && String(row.tenant_id) === tenantId) {
        row.status = 'inactive';
        row.updated_at = this.nowIso();
        row.deactivated_at = row.deactivated_at || this.nowIso();
      }
      return { rows: [], rowCount: row && String(row.tenant_id) === tenantId ? 1 : 0 };
    }

    if (sql.startsWith('INSERT INTO rustdesk_gateway_sessions')) {
      const row: TableRow = {
        external_id: params[0],
        tenant_id: params[1],
        status: 'active',
        target_type: params[2],
        target_id: params[3],
        target_display_name: params[4],
        permissions: params[5],
        actor_identity: params[6],
        launch_url: params[7],
        metadata: params[8],
        created_at: this.nowIso(),
        ended_at: null,
        ended_by: ''
      };
      this.table('rustdesk_gateway_sessions').set(String(row.external_id), row);
      return [];
    }

    if (sql.startsWith('SELECT external_id, status, permissions FROM rustdesk_gateway_sessions')) {
      const tenantId = String(params[0]);
      const row = this.table('rustdesk_gateway_sessions').get(String(params[1]));
      return row && String(row.tenant_id) === tenantId ? [row] : [];
    }

    if (sql.startsWith('INSERT INTO rustdesk_secondary_confirmations')) {
      const row: TableRow = {
        id: params[0], tenant_id: params[1], external_id: params[2], actor_identity: params[3],
        operation: params[4], expires_at: params[5], consumed_at: null,
        consumed_by_event_id: null, audit_linked_at: null, audit_event_id: null, created_at: params[6]
      };
      this.table('rustdesk_secondary_confirmations').set(String(row.id), row);
      return [row];
    }

    if (sql.startsWith('UPDATE rustdesk_secondary_confirmations SET audit_linked_at')) {
      const row = [...this.table('rustdesk_secondary_confirmations').values()].find((candidate) =>
        String(candidate.consumed_by_event_id) === String(params[0]) &&
        String(candidate.tenant_id) === String(params[1]) &&
        String(candidate.external_id) === String(params[2]) &&
        String(candidate.actor_identity) === String(params[3]) &&
        String(candidate.operation) === String(params[4])
      );
      if (!row || !row.consumed_at || row.audit_linked_at || String(row.expires_at) <= String(params[5])) return [];
      row.audit_linked_at = params[6];
      row.audit_event_id = params[7];
      return [row];
    }

    if (sql.startsWith('UPDATE rustdesk_secondary_confirmations SET consumed_at')) {
      const row = this.table('rustdesk_secondary_confirmations').get(String(params[0]));
      if (!row || String(row.tenant_id) !== String(params[1]) || String(row.external_id) !== String(params[2]) ||
        String(row.actor_identity) !== String(params[3]) || String(row.operation) !== String(params[4]) ||
        row.consumed_at || String(row.expires_at) <= String(params[5])) return [];
      row.consumed_at = params[5];
      row.consumed_by_event_id = params[6];
      return [row];
    }

    if (sql.startsWith('SELECT * FROM rustdesk_control_locks')) {
      const row = this.table('rustdesk_control_locks').get(`${params[0]}:${params[1]}`);
      return row ? [row] : [];
    }

    if (sql.startsWith('INSERT INTO rustdesk_control_locks')) {
      const key = `${params[0]}:${params[1]}`;
      const row: TableRow = {
        tenant_id: params[0], external_id: params[1], owner_identity: params[2], status: 'owned',
        lease_expires_at: params[3], version: params[4], updated_at: params[5]
      };
      this.table('rustdesk_control_locks').set(key, row);
      return [row];
    }

    if (sql.startsWith("UPDATE rustdesk_control_locks SET status = 'released'")) {
      const row = this.table('rustdesk_control_locks').get(`${params[0]}:${params[1]}`);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'released';
      row.version = params[2];
      row.updated_at = params[3];
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE rustdesk_control_locks SET status = 'expired'")) {
      const row = this.table('rustdesk_control_locks').get(`${params[0]}:${params[1]}`);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'expired';
      row.version = params[2];
      row.updated_at = params[3];
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO rustdesk_control_events') && sql.includes("'operation_confirmed'")) {
      const row: TableRow = {
        id: params[0], tenant_id: params[1], external_id: params[2], event_type: 'operation_confirmed',
        actor_identity: params[3], operation: params[4], lock_version: params[5],
        confirmation_id: params[6], metadata: {}, created_at: params[7]
      };
      this.table('rustdesk_control_events').set(String(row.id), row);
      return [];
    }

    if (sql.startsWith('INSERT INTO rustdesk_control_events')) {
      const row: TableRow = {
        id: params[0], tenant_id: params[1], external_id: params[2], event_type: params[3],
        actor_identity: params[4], previous_owner_identity: params[5], owner_identity: params[6],
        lock_version: params[7], metadata: {}, created_at: params[8]
      };
      this.table('rustdesk_control_events').set(String(row.id), row);
      return [];
    }

    if (sql.startsWith('SELECT * FROM rustdesk_gateway_sessions WHERE external_id')) {
      const row = this.table('rustdesk_gateway_sessions').get(String(params[0]));
      return row ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM rustdesk_gateway_sessions WHERE tenant_id')) {
      const tenantId = String(params[0]);
      const hasStatusFilter = sql.includes('AND status =');
      const status = hasStatusFilter ? String(params[1]) : '';
      const limit = Number(params[hasStatusFilter ? 2 : 1] || 50);
      return [...this.table('rustdesk_gateway_sessions').values()]
        .filter((row) => String(row.tenant_id) === tenantId)
        .filter((row) => !hasStatusFilter || String(row.status) === status)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
    }

    if (sql.startsWith('UPDATE rustdesk_gateway_sessions SET metadata = $3')) {
      const row = this.table('rustdesk_gateway_sessions').get(String(params[0]));
      if (row && String(row.tenant_id) === String(params[1])) {
        row.metadata = params[2];
      }
      return { rows: [], rowCount: row && String(row.tenant_id) === String(params[1]) ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE rustdesk_gateway_sessions')) {
      const row = this.table('rustdesk_gateway_sessions').get(String(params[0]));
      if (row) {
        const wasEnded = Boolean(row.ended_at);
        row.status = 'ended';
        if (!wasEnded) {
          row.ended_at = this.nowIso();
          row.ended_by = params[1] || '';
        }
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('INSERT INTO rustdesk_gateway_events')) {
      const externalId = String(params[1]);
      const idempotencyKey = String(params[6] || '');
      const existing = idempotencyKey
        ? [...this.table('rustdesk_gateway_events').values()].find((item) =>
          String(item.external_id) === externalId &&
          String(item.idempotency_key || '') === idempotencyKey
        )
        : undefined;
      if (existing) return { rows: [], rowCount: 0 };
      const row: TableRow = {
        id: params[0],
        external_id: params[1],
        tenant_id: params[2],
        event_type: params[3],
        actor_identity: params[4],
        target: params[5],
        idempotency_key: idempotencyKey,
        metadata: params[7],
        occurred_at: params[8] || this.nowIso(),
        created_at: this.nowIso()
      };
      this.table('rustdesk_gateway_events').set(String(row.id), row);
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('SELECT * FROM rustdesk_gateway_events') && sql.includes('idempotency_key')) {
      const externalId = String(params[0]);
      const idempotencyKey = String(params[1]);
      const row = [...this.table('rustdesk_gateway_events').values()]
        .find((item) =>
          String(item.external_id) === externalId &&
          String(item.idempotency_key || '') === idempotencyKey
        );
      return row ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM rustdesk_gateway_events')) {
      const externalId = String(params[0]);
      return [...this.table('rustdesk_gateway_events').values()]
        .filter((row) => String(row.external_id) === externalId)
        .sort((a, b) => {
          const occurred = String(a.occurred_at).localeCompare(String(b.occurred_at));
          if (occurred !== 0) return occurred;
          return String(a.created_at).localeCompare(String(b.created_at));
        });
    }

    if (sql.startsWith('INSERT INTO rustdesk_device_commands')) {
      const existing = [...this.table('rustdesk_device_commands').values()].find((row) =>
        String(row.tenant_id) === String(params[1]) &&
        String(row.external_id) === String(params[3]) &&
        String(row.command_type) === 'disconnect_session'
      );
      if (existing) return { rows: [], rowCount: 0 };
      const now = this.nowIso();
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        device_id: params[2],
        external_id: params[3],
        command_type: 'disconnect_session',
        status: 'pending',
        requested_by: params[4],
        requested_reason: params[5],
        emergency_fallback_authorized: false,
        emergency_fallback_reason: '',
        emergency_fallback_authorized_by: '',
        emergency_fallback_authorized_at: null,
        attempt_count: 0,
        max_attempts: 3,
        claimed_by: null,
        claim_token_hash: null,
        lease_expires_at: null,
        next_attempt_at: null,
        execution_method: null,
        exit_code: null,
        duration_ms: null,
        stdout_bytes: null,
        stderr_bytes: null,
        stdout_sha256: null,
        stderr_sha256: null,
        result_metadata: {},
        requested_at: now,
        started_at: null,
        completed_at: null,
        updated_at: now
      };
      this.table('rustdesk_device_commands').set(String(row.id), row);
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('SELECT * FROM rustdesk_device_commands') && sql.includes('external_id = $2')) {
      const tenantId = String(params[0]);
      const externalId = String(params[1]);
      const row = [...this.table('rustdesk_device_commands').values()].find((item) =>
        String(item.tenant_id) === tenantId &&
        String(item.external_id) === externalId &&
        String(item.command_type) === 'disconnect_session'
      );
      return row ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM rustdesk_device_commands') && sql.includes('device_id = $2') && sql.includes('id = $3')) {
      const row = this.table('rustdesk_device_commands').get(String(params[2]));
      return row &&
        String(row.tenant_id) === String(params[0]) &&
        String(row.device_id) === String(params[1])
        ? [row]
        : [];
    }

    if (sql.startsWith('UPDATE rustdesk_device_commands SET emergency_fallback_authorized = TRUE')) {
      const row = [...this.table('rustdesk_device_commands').values()].find((item) =>
        String(item.tenant_id) === String(params[0]) &&
        String(item.external_id) === String(params[1]) &&
        String(item.command_type) === 'disconnect_session'
      );
      const metadata = row ? jsonObject(row.result_metadata) : {};
      const canUpdate = Boolean(
        row &&
        row.emergency_fallback_authorized !== true &&
        (row.status === 'pending' || row.status === 'failed') &&
        row.execution_method === 'session_adapter' &&
        metadata.precise_disconnect_unavailable === true
      );
      if (!row || !canUpdate) return { rows: [], rowCount: 0 };
      row.emergency_fallback_authorized = true;
      row.emergency_fallback_reason = params[2];
      row.emergency_fallback_authorized_by = params[3];
      row.emergency_fallback_authorized_at = params[4];
      row.status = 'pending';
      row.attempt_count = 0;
      row.claimed_by = null;
      row.claim_token_hash = null;
      row.lease_expires_at = null;
      row.next_attempt_at = params[4];
      row.execution_method = null;
      row.exit_code = null;
      row.duration_ms = null;
      row.stdout_bytes = null;
      row.stderr_bytes = null;
      row.stdout_sha256 = null;
      row.stderr_sha256 = null;
      row.result_metadata = {};
      row.started_at = null;
      row.completed_at = null;
      row.updated_at = params[4];
      return { rows: [row], rowCount: 1 };
    }

    if (
      sql.startsWith("UPDATE rustdesk_device_commands SET status = 'failed'") &&
      sql.includes('claimed_by = $4') &&
      sql.includes('attempt_count = $5')
    ) {
      const row = this.table('rustdesk_device_commands').get(String(params[2]));
      const canUpdate = Boolean(
        row &&
        String(row.tenant_id) === String(params[0]) &&
        String(row.device_id) === String(params[1]) &&
        row.status === 'claimed' &&
        String(row.claimed_by || '') === String(params[3]) &&
        Number(row.attempt_count) === Number(params[4])
      );
      if (!row || !canUpdate) return { rows: [], rowCount: 0 };
      row.status = 'failed';
      row.claim_token_hash = null;
      row.lease_expires_at = null;
      row.next_attempt_at = null;
      row.execution_method = null;
      row.exit_code = null;
      row.duration_ms = null;
      row.stdout_bytes = null;
      row.stderr_bytes = null;
      row.stdout_sha256 = null;
      row.stderr_sha256 = null;
      row.result_metadata = params[6];
      row.completed_at = params[5];
      row.updated_at = params[5];
      return { rows: [row], rowCount: 1 };
    }

    if (
      sql.startsWith('UPDATE rustdesk_device_commands SET claim_token_hash = $6') &&
      sql.includes('claimed_by = $4') &&
      sql.includes('attempt_count = $5')
    ) {
      const row = this.table('rustdesk_device_commands').get(String(params[2]));
      const canUpdate = Boolean(
        row &&
        String(row.tenant_id) === String(params[0]) &&
        String(row.device_id) === String(params[1]) &&
        row.status === 'claimed' &&
        String(row.claimed_by || '') === String(params[3]) &&
        Number(row.attempt_count) === Number(params[4])
      );
      if (!row || !canUpdate) return { rows: [], rowCount: 0 };
      row.claim_token_hash = params[5];
      row.lease_expires_at = params[6];
      row.updated_at = params[7];
      return { rows: [row], rowCount: 1 };
    }

    if (
      sql.startsWith("UPDATE rustdesk_device_commands SET status = 'failed'") &&
      sql.includes('attempt_count >= max_attempts')
    ) {
      const tenantId = String(params[0]);
      const deviceId = String(params[1]);
      const now = String(params[2]);
      const rows = [...this.table('rustdesk_device_commands').values()]
        .filter((row) =>
          String(row.tenant_id) === tenantId &&
          String(row.device_id) === deviceId &&
          row.status === 'claimed' &&
          Number(row.attempt_count) >= Number(row.max_attempts) &&
          Boolean(row.lease_expires_at) &&
          String(row.lease_expires_at) <= now
        );
      for (const row of rows) {
        row.status = 'failed';
        row.claim_token_hash = null;
        row.lease_expires_at = null;
        row.next_attempt_at = null;
        row.execution_method = null;
        row.exit_code = null;
        row.duration_ms = null;
        row.stdout_bytes = null;
        row.stderr_bytes = null;
        row.stdout_sha256 = null;
        row.stderr_sha256 = null;
        row.result_metadata = params[3];
        row.completed_at = now;
        row.updated_at = now;
      }
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith("UPDATE rustdesk_device_commands SET status = 'claimed'")) {
      const tenantId = String(params[0]);
      const deviceId = String(params[1]);
      const now = String(params[5]);
      const row = [...this.table('rustdesk_device_commands').values()]
        .filter((item) => String(item.tenant_id) === tenantId && String(item.device_id) === deviceId)
        .filter((item) => Number(item.attempt_count) < Number(item.max_attempts))
        .filter((item) => {
          if (item.status === 'pending') {
            return !item.next_attempt_at || String(item.next_attempt_at) <= now;
          }
          return item.status === 'claimed' && Boolean(item.lease_expires_at) && String(item.lease_expires_at) <= now;
        })
        .sort((a, b) => String(a.requested_at).localeCompare(String(b.requested_at)))[0];
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'claimed';
      row.attempt_count = Number(row.attempt_count) + 1;
      row.claimed_by = params[2];
      row.claim_token_hash = params[3];
      row.lease_expires_at = params[4];
      row.next_attempt_at = null;
      row.started_at = row.started_at || now;
      row.updated_at = now;
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE rustdesk_device_commands SET status = 'pending'")) {
      const row = this.table('rustdesk_device_commands').get(String(params[2]));
      const now = String(params[13]);
      const canUpdate = Boolean(
        row &&
        String(row.tenant_id) === String(params[0]) &&
        String(row.device_id) === String(params[1]) &&
        row.status === 'claimed' &&
        String(row.claim_token_hash || '') === String(params[3]) &&
        String(row.lease_expires_at || '') > now
      );
      if (!row || !canUpdate) return { rows: [], rowCount: 0 };
      row.status = 'pending';
      row.claimed_by = null;
      row.claim_token_hash = null;
      row.lease_expires_at = null;
      row.next_attempt_at = params[4];
      row.execution_method = params[5];
      row.exit_code = params[6];
      row.duration_ms = params[7];
      row.stdout_bytes = params[8];
      row.stderr_bytes = params[9];
      row.stdout_sha256 = params[10];
      row.stderr_sha256 = params[11];
      row.result_metadata = params[12];
      row.updated_at = now;
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE rustdesk_device_commands SET status = $5')) {
      const row = this.table('rustdesk_device_commands').get(String(params[2]));
      const now = String(params[13]);
      const canUpdate = Boolean(
        row &&
        String(row.tenant_id) === String(params[0]) &&
        String(row.device_id) === String(params[1]) &&
        row.status === 'claimed' &&
        String(row.claim_token_hash || '') === String(params[3]) &&
        String(row.lease_expires_at || '') > now
      );
      if (!row || !canUpdate) return { rows: [], rowCount: 0 };
      row.status = params[4];
      row.lease_expires_at = null;
      row.next_attempt_at = null;
      row.execution_method = params[5];
      row.exit_code = params[6];
      row.duration_ms = params[7];
      row.stdout_bytes = params[8];
      row.stderr_bytes = params[9];
      row.stdout_sha256 = params[10];
      row.stderr_sha256 = params[11];
      row.result_metadata = params[12];
      row.completed_at = now;
      row.updated_at = now;
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO evidence_records')) {
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        business_ref_type: params[2],
        business_ref_id: params[3],
        session_id: params[4],
        kind: params[5],
        storage_url: params[6],
        checksum: params[7],
        retention_until: params[8],
        created_by: params[9],
        metadata: params[10],
        created_at: this.nowIso()
      };
      this.table('evidence_records').set(String(row.id), row);
      return [];
    }

    if (sql.startsWith('UPDATE evidence_records SET metadata = $1')) {
      const row = this.table('evidence_records').get(String(params[1]));
      if (row) row.metadata = params[0];
      return [];
    }

    if (sql.startsWith('UPDATE evidence_records')) {
      const row = this.table('evidence_records').get(String(params[4]));
      if (row) {
        row.storage_url = params[0];
        if (params[1]) row.checksum = params[1];
        row.metadata = params[2];
        if (params[3]) row.retention_until = params[3];
      }
      return [];
    }

    if (sql.startsWith('SELECT * FROM evidence_records WHERE id')) {
      const row = this.table('evidence_records').get(String(params[0]));
      const tenantMatches = params[1] == null || String(row?.tenant_id) === String(params[1]);
      return row && tenantMatches ? [row] : [];
    }

    if (sql.startsWith('SELECT * FROM evidence_records WHERE tenant_id') && sql.includes('session_id = $2')) {
      const tenantId = String(params[0]);
      const sessionId = String(params[1]);
      const limit = Number(params[2] || 50);
      return [...this.table('evidence_records').values()]
        .filter((row) => String(row.tenant_id) === tenantId && String(row.session_id) === sessionId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
    }

    if (sql.startsWith('SELECT * FROM evidence_records WHERE tenant_id')) {
      const tenantId = String(params[0]);
      const refType = String(params[1]);
      const refId = String(params[2]);
      const limit = Number(params[3] || 50);
      return [...this.table('evidence_records').values()]
        .filter((row) => String(row.tenant_id) === tenantId && String(row.business_ref_type) === refType && String(row.business_ref_id) === refId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
    }

    if (sql.startsWith('INSERT INTO ivekit_tenant_events')) {
      const idempotencyKey = String(params[8] || '');
      if (idempotencyKey) {
        const existing = [...this.table('ivekit_tenant_events').values()].find((event) =>
          String(event.tenant_id) === String(params[0]) &&
          String(event.idempotency_key || '') === idempotencyKey
        );
        if (existing) return [existing];
      }
      const id = this.nextIdentity('ivekit_tenant_events');
      const row: TableRow = {
        id,
        tenant_id: params[0],
        event_type: params[1],
        visibility_scope: params[2],
        visibility_ref_id: params[3],
        audience_user_ids: params[4],
        payload: params[5],
        occurred_at: params[6],
        expires_at: params[7],
        idempotency_key: idempotencyKey
      };
      this.table('ivekit_tenant_events').set(id, row);
      return [row];
    }

    if (sql.startsWith('SELECT COALESCE(MAX(id), 0)::text AS head_event_id FROM ivekit_tenant_events')) {
      const tenantId = String(params[0]);
      const ids = [...this.table('ivekit_tenant_events').values()]
        .filter((row) => String(row.tenant_id) === tenantId)
        .map((row) => BigInt(String(row.id)));
      return [{ head_event_id: ids.length ? String(ids.reduce((left, right) => left > right ? left : right)) : '0' }];
    }

    if (sql.startsWith('SELECT event.*, CASE') && sql.includes('FROM ivekit_tenant_events event')) {
      const tenantId = String(params[0]);
      const afterId = BigInt(String(params[1]));
      const now = String(params[2]);
      const userId = String(params[3]);
      const privileged = params[4] === true;
      const limit = Number(params[5]);
      return [...this.table('ivekit_tenant_events').values()]
        .filter((row) =>
          String(row.tenant_id) === tenantId &&
          BigInt(String(row.id)) > afterId &&
          String(row.expires_at) > now
        )
        .sort((left, right) => Number(BigInt(String(left.id)) - BigInt(String(right.id))))
        .slice(0, limit)
        .map((row) => ({ ...row, visible: this.memoryTenantEventVisible(row, userId, privileged) }));
    }

    if (sql.startsWith('SELECT tenant_id FROM opc_ivekit_event_retention_tenant_ids')) {
      const now = String(params[0]);
      const limit = Number(params[1]);
      const oldest = new Map<string, string>();
      for (const row of this.table('ivekit_tenant_events').values()) {
        if (String(row.expires_at) > now) continue;
        const tenantId = String(row.tenant_id);
        const current = oldest.get(tenantId);
        if (!current || String(row.expires_at) < current) oldest.set(tenantId, String(row.expires_at));
      }
      return [...oldest.entries()]
        .sort((left, right) => left[1].localeCompare(right[1]) || left[0].localeCompare(right[0]))
        .slice(0, limit)
        .map(([tenant_id]) => ({ tenant_id }));
    }

    if (sql.startsWith('WITH doomed AS (') && sql.includes('DELETE FROM ivekit_tenant_events')) {
      const tenantId = String(params[0]);
      const now = String(params[1]);
      const limit = Number(params[2]);
      const doomed = [...this.table('ivekit_tenant_events').values()]
        .filter((row) => String(row.tenant_id) === tenantId && String(row.expires_at) <= now)
        .sort((left, right) => Number(BigInt(String(left.id)) - BigInt(String(right.id))))
        .slice(0, limit);
      for (const row of doomed) this.table('ivekit_tenant_events').delete(String(row.id));
      return { rows: doomed.map((row) => ({ id: row.id })), rowCount: doomed.length };
    }

    if (sql.startsWith('SELECT EXISTS (') && sql.includes('AS visible')) {
      const tenantId = String(params[0]);
      const refId = String(params[1]);
      const userId = String(params[2]);
      if (sql.includes('FROM ivekit_media_call_participants')) {
        return [{ visible: [...this.table('ivekit_media_call_participants').values()].some((participant) =>
          String(participant.tenant_id) === tenantId &&
          String(participant.call_id) === refId &&
          String(participant.identity) === userId &&
          ['invited', 'ringing', 'accepted', 'joined'].includes(String(participant.status))
        ) }];
      }
      if (sql.includes('FROM remote_assistance_sessions')) {
        const remote = this.table('remote_assistance_sessions').get(refId);
        return [{ visible: Boolean(remote) && [...this.table('collaboration_participants').values()].some(
          (participant) =>
            String(participant.tenant_id) === tenantId &&
            String(participant.session_id) === String(remote?.collaboration_session_id) &&
            String(participant.identity) === userId &&
            !participant.left_at
        ) }];
      }
      return [{ visible: [...this.table('collaboration_participants').values()].some((participant) =>
        String(participant.tenant_id) === tenantId &&
        String(participant.session_id) === refId &&
        String(participant.identity) === userId &&
        !participant.left_at
      ) }];
    }

    throw new Error(`MemoryPg: unsupported SQL: ${sql.slice(0, 120)}`);
  }

  private memoryTenantEventVisible(row: TableRow, userId: string, privileged: boolean): boolean {
    const audience = Array.isArray(row.audience_user_ids) ? row.audience_user_ids.map(String) : [];
    if (audience.length > 0) return audience.includes(userId);
    if (privileged || row.visibility_scope === 'tenant') return true;
    if (row.visibility_scope === 'chat_session') {
      return [...this.table('collaboration_participants').values()].some((participant) =>
        String(participant.tenant_id) === String(row.tenant_id) &&
        String(participant.session_id) === String(row.visibility_ref_id) &&
        String(participant.identity) === userId &&
        !participant.left_at
      );
    }
    if (row.visibility_scope === 'media_call') {
      return [...this.table('ivekit_media_call_participants').values()].some((participant) =>
        String(participant.tenant_id) === String(row.tenant_id) &&
        String(participant.call_id) === String(row.visibility_ref_id) &&
        String(participant.identity) === userId &&
        ['invited', 'ringing', 'accepted', 'joined'].includes(String(participant.status))
      );
    }
    if (row.visibility_scope === 'remote_session') {
      const remote = this.table('remote_assistance_sessions').get(String(row.visibility_ref_id));
      return Boolean(remote) && [...this.table('collaboration_participants').values()].some((participant) =>
        String(participant.tenant_id) === String(row.tenant_id) &&
        String(participant.session_id) === String(remote?.collaboration_session_id) &&
        String(participant.identity) === userId &&
        !participant.left_at
      );
    }
    return false;
  }

  private ensureTable(name: string): void {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
  }

  private table(name: string): Map<string, TableRow> {
    this.ensureTable(name);
    return this.tables.get(name)!;
  }

  private nowIso(): string {
    this.timeCursor += 1;
    return new Date(this.timeCursor).toISOString();
  }

  private nextIdentity(table: string): string {
    const value = (this.identityCounters.get(table) || 0n) + 1n;
    this.identityCounters.set(table, value);
    return String(value);
  }
}

function compareRows(left: TableRow, right: TableRow): number {
  return String(left.created_at).localeCompare(String(right.created_at)) ||
    String(left.id).localeCompare(String(right.id));
}

function compareTuple(row: TableRow, createdAt: string, id: string): number {
  return String(row.created_at).localeCompare(createdAt) || String(row.id).localeCompare(id);
}

function mergeJsonObjects(left: unknown, right: unknown): string {
  const parse = (value: unknown): Record<string, unknown> => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    try {
      const parsed = JSON.parse(String(value || '{}')) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  };
  return JSON.stringify({ ...parse(left), ...parse(right) });
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value || '{}')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]')) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let sharedPool: PgQueryable | null = null;
let realPool: Pool | null = null;

export function attachPostgresPoolErrorHandler(
  pool: PostgresPoolErrorEmitter,
  report: (
    event: PostgresPoolErrorEvent
  ) => void | PromiseLike<void> = reportPostgresPoolError
): void {
  pool.on('error', (error) => {
    try {
      const pending = report({
        event: 'postgres.pool.idle_client_error',
        error_code: safePostgresErrorCode(error),
        action: 'connection_discarded'
      });
      if (pending) void Promise.resolve(pending).catch(() => undefined);
    } catch {
      // Error reporting must never recreate the unhandled pool error path.
    }
  });
}

export interface PostgresConnectionConfig {
  runtimeUrl: string;
  migrationUrl: string | null;
}

export function postgresConnectionConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): PostgresConnectionConfig | null {
  const runtimeUrl = env.DATABASE_URL || postgresUrlFromPgEnv(env);
  if (!runtimeUrl) return null;
  return {
    runtimeUrl,
    migrationUrl: env.DATABASE_MIGRATION_URL ||
      (resolveBrandEnv(env, 'SCHEMA_MANAGED_BY_MIGRATIONS') === '1' ? null : runtimeUrl)
  };
}

function postgresUrlFromPgEnv(env: NodeJS.ProcessEnv): string | null {
  const host = String(env.PGHOST || '').trim();
  const database = String(env.PGDATABASE || '').trim();
  const user = String(env.PGUSER || '').trim();
  if (!host || !database || !user) return null;
  const password = String(env.PGPASSWORD || '');
  const normalizedHost = host.startsWith('[') || !host.includes(':') ? host : `[${host}]`;
  const auth = `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ''}`;
  return `postgresql://${auth}@${normalizedHost}:${env.PGPORT || '5432'}/${encodeURIComponent(database)}`;
}

export function pgId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export async function initPostgres(): Promise<PgQueryable | null> {
  if (sharedPool) return sharedPool;

  if (resolveBrandEnv(process.env, 'USE_MEMORY_PG') === '1') {
    sharedPool = new MemoryPg();
    await runMigrations(sharedPool);
    return sharedPool;
  }

  const config = postgresConnectionConfigFromEnv();
  if (!config) return null;

  const { Pool: PgPool } = await import('pg');
  const poolOptions = {
    max: Number(process.env.PG_POOL_MAX || 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  };

  if (config.migrationUrl && config.migrationUrl !== config.runtimeUrl) {
    const migrationPool = new PgPool({
      ...poolOptions,
      connectionString: config.migrationUrl,
      max: 1
    });
    attachPostgresPoolErrorHandler(migrationPool);
    try {
      await migrationPool.query('SELECT 1');
      await runMigrations(migrationPool);
    } finally {
      await migrationPool.end();
    }
  }

  const runtimePool = new PgPool({
    ...poolOptions,
    connectionString: config.runtimeUrl
  });
  attachPostgresPoolErrorHandler(runtimePool);
  try {
    await runtimePool.query('SELECT 1');
    if (config.migrationUrl === config.runtimeUrl) {
      await runMigrations(runtimePool);
    }
    realPool = runtimePool;
    sharedPool = runtimePool;
    return sharedPool;
  } catch (error) {
    await runtimePool.end();
    throw error;
  }
}

export function getPostgres(): PgQueryable {
  if (!sharedPool) {
    throw Object.assign(new Error('postgres not initialized — call initPostgres() first'), { status: 503 });
  }
  return sharedPool;
}

export function getPostgresOrNull(): PgQueryable | null {
  return sharedPool;
}

export async function closePostgres(): Promise<void> {
  if (realPool) {
    await realPool.end();
    realPool = null;
  }
  sharedPool = null;
}

/** Reset pool for tests. */
export function resetPostgresForTests(pool: PgQueryable | null = null): void {
  sharedPool = pool;
  realPool = null;
}

export async function runMigrations(
  pg: PgQueryable,
  options: { directory?: string; advisoryLockName?: string } = {}
): Promise<void> {
  const plan = readPostgresMigrationPlan(options.directory || migrationsDir);

  if (pg instanceof MemoryPg) {
    for (const migration of plan) {
      const version = migration.version;
      const existing = await pg.query('SELECT version FROM schema_migrations WHERE version = $1', [version]);
      if (existing.rowCount && existing.rowCount > 0) continue;
      await pg.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    }
    return;
  }

  const connection = pg as Pool & { release?: () => void };
  if (typeof connection.connect === 'function' && typeof connection.release !== 'function') {
    const conn = await connection.connect();
    const lockName = options.advisoryLockName || 'opc_schema_migrations';
    try {
      await conn.query('SELECT pg_advisory_lock(hashtext($1))', [lockName]);
      await runPostgresMigrationsOnClient(conn, plan);
    } finally {
      try {
        await conn.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
      } finally {
        conn.release();
      }
    }
    return;
  }

  await runPostgresMigrationsOnClient(pg, plan);
}

export { isPostgresMigrationFile };

function safePostgresErrorCode(error: Error): string {
  const code = String((error as Error & { code?: unknown }).code || '');
  return /^[A-Z0-9]{1,16}$/.test(code) ? code : 'unknown';
}

function reportPostgresPoolError(event: PostgresPoolErrorEvent): void {
  process.stderr.write(`[postgres] ${JSON.stringify(event)}\n`);
}

export async function withPgTransaction<T>(
  pg: PgQueryable,
  fn: (client: PgQueryable) => Promise<T>
): Promise<T> {
  const connection = pg as Pool & { release?: () => void };
  if (typeof connection.connect !== 'function' || typeof connection.release === 'function') {
    return fn(pg);
  }
  const client = await connection.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
