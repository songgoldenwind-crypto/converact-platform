import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, QueryResult, QueryResultRow } from 'pg';

const migrationsDir = dirname(fileURLToPath(import.meta.url)) + '/migrations';

export interface PgQueryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<R>>;
}

type TableRow = Record<string, unknown>;

/**
 * In-memory Postgres substitute for unit tests (OPC_USE_MEMORY_PG=1).
 * Executes a focused subset of SQL used by auth + compliance stores.
 */
export class MemoryPg implements PgQueryable {
  private readonly tables = new Map<string, Map<string, TableRow>>();
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
    this.ensureTable('collaboration_message_reactions');
    this.ensureTable('collaboration_message_pins');
    this.ensureTable('collaboration_message_attachments');
    this.ensureTable('collaboration_attachment_processing_jobs');
    this.ensureTable('collaboration_message_translations');
    this.ensureTable('collaboration_chat_bindings');
    this.ensureTable('collaboration_policy_events');
    this.ensureTable('collaboration_policy_findings');
    this.ensureTable('collaboration_policy_finding_reviews');
    this.ensureTable('collaboration_quality_review_jobs');
    this.ensureTable('remote_assistance_sessions');
    this.ensureTable('remote_consent_events');
    this.ensureTable('remote_tool_sessions');
    this.ensureTable('remote_audit_events');
    this.ensureTable('evidence_records');
    this.ensureTable('rustdesk_devices');
    this.ensureTable('rustdesk_gateway_sessions');
    this.ensureTable('rustdesk_gateway_events');
    this.ensureTable('rustdesk_device_commands');
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
    if (sql.startsWith('SELECT version FROM schema_migrations')) {
      const version = String(params[0] ?? '');
      const applied = this.migrationVersions.has(version);
      return applied ? [{ version }] : [];
    }

    if (sql.startsWith('INSERT INTO schema_migrations')) {
      this.migrationVersions.add(String(params[0]));
      return [];
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

    if (sql.startsWith("UPDATE collaboration_messages SET provider_delivery_status = 'publishing'")) {
      const row = this.table('collaboration_messages').get(String(params[0]));
      if (!row || String(row.tenant_id) !== String(params[1]) || String(row.provider) !== 'tinode') {
        return { rows: [], rowCount: 0 };
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

    if (sql.startsWith('SELECT id, tenant_id FROM collaboration_messages')) {
      const tenantScoped = sql.includes('WHERE tenant_id = $1');
      const tenantId = tenantScoped ? String(params[0]) : '';
      const now = String(params[tenantScoped ? 1 : 0]);
      const limit = Number(params[tenantScoped ? 2 : 1]);
      return [...this.table('collaboration_messages').values()]
        .filter((row) => !tenantScoped || String(row.tenant_id) === tenantId)
        .filter((row) => String(row.provider) === 'tinode')
        .filter((row) => {
          const status = String(row.provider_delivery_status);
          return status === 'pending' ||
            (status === 'retry_wait' && (!row.provider_next_attempt_at || String(row.provider_next_attempt_at) <= now)) ||
            (status === 'publishing' && Boolean(row.provider_delivery_lease_until) && String(row.provider_delivery_lease_until) <= now);
        })
        .sort((a, b) => String(a.provider_next_attempt_at || a.created_at).localeCompare(String(b.provider_next_attempt_at || b.created_at)))
        .slice(0, limit)
        .map((row) => ({ id: row.id, tenant_id: row.tenant_id }));
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
        kind: params[4],
        storage_url: params[5],
        filename: params[6],
        content_type: params[7],
        size_bytes: params[8],
        checksum: params[9],
        processing_status: params[10],
        ocr_text: '',
        asr_text: '',
        extracted_text: '',
        processing_error_code: '',
        processed_at: null,
        metadata: params[11],
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
        status: 'pending',
        attempt_count: 0,
        max_attempts: params[6],
        next_attempt_at: null,
        lease_until: null,
        worker_id: '',
        provider_mode: params[7],
        provider_name: params[8],
        error_code: '',
        error_message: '',
        output_metadata: {},
        created_at: now,
        updated_at: now,
        completed_at: null
      };
      this.table('collaboration_attachment_processing_jobs').set(String(row.id), row);
      return { rows: [row], rowCount: 1 };
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
        return rows
          .filter((row) => String(row.attachment_id) === String(params[1]))
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
          .slice(0, 1);
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
      const now = String(params[6]);
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
      row.provider_mode = params[4];
      row.provider_name = params[5];
      row.error_code = '';
      row.error_message = '';
      row.updated_at = params[6];
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
      row.provider_mode = params[3];
      row.provider_name = params[4];
      row.error_code = '';
      row.error_message = '';
      row.output_metadata = params[5];
      row.lease_until = null;
      row.worker_id = '';
      row.completed_at = params[6];
      row.updated_at = params[6];
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

    if (sql.startsWith('UPDATE collaboration_attachment_processing_jobs SET status = CASE')) {
      const tenantScoped = sql.includes('WHERE tenant_id = $1');
      const tenantId = tenantScoped ? String(params[0]) : '';
      const now = String(params[tenantScoped ? 1 : 0]);
      let count = 0;
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
      }
      return { rows: [], rowCount: count };
    }

    if (sql.startsWith('INSERT INTO collaboration_message_translations')) {
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
        existing.updated_at = params[15];
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
        created_at: params[15],
        updated_at: params[15],
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
        existing.session_id = params[2];
        existing.input_hash = params[4];
        if (changed) {
          existing.status = 'pending';
          existing.attempt_count = 0;
          existing.next_attempt_at = null;
          existing.lease_until = null;
          existing.worker_id = '';
          existing.error_code = '';
          existing.error_message = '';
          existing.completed_at = null;
        }
        existing.provider_mode = params[6];
        existing.provider_name = params[7];
        existing.updated_at = params[8];
        return { rows: [existing], rowCount: 1 };
      }
      const row: TableRow = {
        id: params[0],
        tenant_id: params[1],
        session_id: params[2],
        message_id: params[3],
        input_hash: params[4],
        status: 'pending',
        attempt_count: 0,
        max_attempts: params[5],
        next_attempt_at: null,
        lease_until: null,
        worker_id: '',
        provider_mode: params[6],
        provider_name: params[7],
        error_code: '',
        error_message: '',
        output_metadata: {},
        created_at: params[8],
        updated_at: params[8],
        completed_at: null
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
      const now = String(params[6]);
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
      row.provider_mode = params[4];
      row.provider_name = params[5];
      row.error_code = '';
      row.error_message = '';
      row.updated_at = params[6];
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE collaboration_quality_review_jobs SET status = 'cancelled'")) {
      const row = [...this.table('collaboration_quality_review_jobs').values()].find(
        (candidate) =>
          String(candidate.tenant_id) === String(params[0]) &&
          String(candidate.message_id) === String(params[1])
      );
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
      return row ? [row] : [];
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

    throw new Error(`MemoryPg: unsupported SQL: ${sql.slice(0, 120)}`);
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

let sharedPool: PgQueryable | null = null;
let realPool: Pool | null = null;

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
      (env.OPC_SCHEMA_MANAGED_BY_MIGRATIONS === '1' ? null : runtimeUrl)
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

  if (process.env.OPC_USE_MEMORY_PG === '1') {
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

export async function runMigrations(pg: PgQueryable): Promise<void> {
  const files = readdirSync(migrationsDir)
    .filter(isPostgresMigrationFile)
    .sort();

  if (pg instanceof MemoryPg) {
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const existing = await pg.query('SELECT version FROM schema_migrations WHERE version = $1', [version]);
      if (existing.rowCount && existing.rowCount > 0) continue;
      await pg.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    }
    return;
  }

  const connection = pg as Pool & { release?: () => void };
  if (typeof connection.connect === 'function' && typeof connection.release !== 'function') {
    const conn = await connection.connect();
    try {
      await conn.query(`SELECT pg_advisory_lock(hashtext('opc_schema_migrations'))`);
      await runPostgresMigrationsOnClient(conn, files);
    } finally {
      try {
        await conn.query(`SELECT pg_advisory_unlock(hashtext('opc_schema_migrations'))`);
      } finally {
        conn.release();
      }
    }
    return;
  }

  await runPostgresMigrationsOnClient(pg, files);
}

async function runPostgresMigrationsOnClient(pg: PgQueryable, files: string[]): Promise<void> {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const existing = await pg.query('SELECT version FROM schema_migrations WHERE version = $1', [version]);
    if (existing.rowCount && existing.rowCount > 0) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    await pg.query('BEGIN');
    try {
      await pg.query(sql);
      await pg.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await pg.query('COMMIT');
    } catch (error) {
      await pg.query('ROLLBACK');
      throw error;
    }
  }
}

export function isPostgresMigrationFile(file: string): boolean {
  return /^\d{3}_[a-z0-9_]+\.sql$/.test(file);
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
