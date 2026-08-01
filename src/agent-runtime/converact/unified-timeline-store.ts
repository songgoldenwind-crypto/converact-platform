import type { PgQueryable } from '../../db-pg.js';

export interface ConveractFabricUnifiedTimelineEvent {
  id: string;
  source: 'chat' | 'media' | 'remote' | 'evidence' | 'quality';
  event_type: string;
  resource_type: 'chat_session' | 'media_call' | 'remote_session' | 'evidence' | 'finding';
  resource_id: string;
  actor_identity: string;
  occurred_at: string;
  attributes: Record<string, unknown>;
  evidence_ref: {
    id: string;
    kind: string;
    checksum: string;
    retention_until: string | null;
  } | null;
}

export interface ConveractFabricUnifiedTimelinePage {
  items: ConveractFabricUnifiedTimelineEvent[];
  has_more: boolean;
  next_cursor: string | null;
}

interface TimelineCursor {
  v: 1;
  business_ref_type: string;
  business_ref_id: string;
  occurred_at: string;
  id: string;
}

export class ConveractFabricUnifiedTimelineStore {
  constructor(private readonly pg: PgQueryable) {}

  async list(input: {
    tenant_id: string;
    business_ref: { type: string; id: string };
    chat_session_ids: string[];
    media_call_ids: string[];
    remote_session_ids: string[];
    system: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<ConveractFabricUnifiedTimelinePage> {
    const limit = boundedLimit(input.limit);
    const cursor = decodeCursor(input.cursor, input.business_ref);
    const result = await this.pg.query(
      `/* ivekit_unified_timeline */
       WITH unified_events AS (
         SELECT 'chat_message:' || message.id AS id, 'chat' AS source,
                'chat.message.created' AS event_type, 'chat_session' AS resource_type,
                message.session_id AS resource_id, message.sender_identity AS actor_identity,
                message.created_at AS occurred_at,
                jsonb_build_object('message_type', message.message_type) AS attributes,
                NULL::jsonb AS evidence_ref
         FROM collaboration_messages AS message
         WHERE message.tenant_id = $1 AND message.session_id = ANY($2::text[])
         UNION ALL
         SELECT 'chat_mutation:' || mutation.id, 'chat', 'chat.message.' || mutation.action,
                'chat_session', mutation.session_id, mutation.actor_identity, mutation.created_at,
                jsonb_build_object('message_id', mutation.message_id, 'version', mutation.version), NULL::jsonb
         FROM collaboration_message_mutations AS mutation
         WHERE mutation.tenant_id = $1 AND mutation.session_id = ANY($2::text[])
         UNION ALL
         SELECT 'media_action:' || action.id, 'media', 'media.call.' || action.action,
                'media_call', action.call_id, action.actor_identity, action.created_at,
                jsonb_build_object('from_status', action.from_status, 'to_status', action.to_status), NULL::jsonb
         FROM ivekit_media_call_actions AS action
         WHERE action.tenant_id = $1 AND action.call_id = ANY($3::text[])
         UNION ALL
         SELECT 'remote_consent:' || consent.id, 'remote', 'remote.consent.' || consent.event_type,
                'remote_session', consent.remote_session_id, consent.actor_identity, consent.created_at,
                jsonb_build_object('scopes', consent.scopes::jsonb, 'expires_at', consent.expires_at), NULL::jsonb
         FROM remote_consent_events AS consent
         WHERE consent.tenant_id = $1 AND consent.remote_session_id = ANY($4::text[])
         UNION ALL
         SELECT 'remote_audit:' || audit.id, 'remote', audit.event_type,
                'remote_session', audit.remote_session_id, audit.actor_identity, audit.created_at,
                '{}'::jsonb, NULL::jsonb
         FROM remote_audit_events AS audit
         WHERE audit.tenant_id = $1 AND audit.remote_session_id = ANY($4::text[])
         UNION ALL
         SELECT 'evidence:' || evidence.id, 'evidence', 'evidence.' || evidence.kind,
                'evidence', evidence.session_id, evidence.created_by, evidence.created_at,
                jsonb_build_object('kind', evidence.kind),
                jsonb_build_object('id', evidence.id, 'kind', evidence.kind, 'checksum', evidence.checksum,
                  'retention_until', evidence.retention_until)
         FROM evidence_records AS evidence
         WHERE evidence.tenant_id = $1 AND evidence.business_ref_type = $5 AND evidence.business_ref_id = $6
           AND ($7::boolean OR evidence.session_id = ANY($2::text[]) OR evidence.session_id = ANY($4::text[])
             OR COALESCE(evidence.metadata::jsonb->>'call_session_id', '') = ANY($3::text[]))
         UNION ALL
         SELECT 'quality_finding:' || finding.id, 'quality', 'quality.finding.' || finding.review_status,
                'finding', finding.session_id, finding.reviewed_by, finding.updated_at,
                jsonb_build_object('source', finding.source, 'policy_type', finding.policy_type,
                  'severity', finding.severity, 'review_status', finding.review_status), NULL::jsonb
         FROM collaboration_policy_findings AS finding
         WHERE finding.tenant_id = $1 AND finding.session_id = ANY($2::text[])
       )
       SELECT * FROM unified_events
       WHERE ($8::timestamptz IS NULL OR (occurred_at, id) < ($8::timestamptz, $9))
       ORDER BY occurred_at DESC, id DESC
       LIMIT $10`,
      [
        input.tenant_id,
        input.chat_session_ids,
        input.media_call_ids,
        input.remote_session_ids,
        input.business_ref.type,
        input.business_ref.id,
        input.system,
        cursor?.occurred_at || null,
        cursor?.id || '',
        limit + 1
      ]
    );
    const items = result.rows.slice(0, limit).map(decodeEvent);
    const hasMore = result.rows.length > limit;
    const tail = items.at(-1);
    return {
      items,
      has_more: hasMore,
      next_cursor: hasMore && tail ? encodeCursor(input.business_ref, tail) : null
    };
  }
}

function decodeEvent(row: Record<string, unknown>): ConveractFabricUnifiedTimelineEvent {
  return {
    id: String(row.id),
    source: String(row.source) as ConveractFabricUnifiedTimelineEvent['source'],
    event_type: String(row.event_type),
    resource_type: String(row.resource_type) as ConveractFabricUnifiedTimelineEvent['resource_type'],
    resource_id: String(row.resource_id || ''),
    actor_identity: String(row.actor_identity || ''),
    occurred_at: new Date(String(row.occurred_at)).toISOString(),
    attributes: jsonObject(row.attributes),
    evidence_ref: row.evidence_ref ? jsonObject(row.evidence_ref) as ConveractFabricUnifiedTimelineEvent['evidence_ref'] : null
  };
}

function boundedLimit(value: number | undefined): number {
  const limit = value === undefined ? 50 : value;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw Object.assign(new Error('limit must be an integer from 1 to 100'), { status: 400 });
  }
  return limit;
}

function encodeCursor(ref: { type: string; id: string }, event: ConveractFabricUnifiedTimelineEvent): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    business_ref_type: ref.type,
    business_ref_id: ref.id,
    occurred_at: event.occurred_at,
    id: event.id
  } satisfies TimelineCursor)).toString('base64url');
}

function decodeCursor(value: string | undefined, ref: { type: string; id: string }): TimelineCursor | null {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as TimelineCursor;
    if (cursor.v !== 1 || cursor.business_ref_type !== ref.type || cursor.business_ref_id !== ref.id ||
        !cursor.id || !Number.isFinite(new Date(cursor.occurred_at).getTime())) throw new Error('invalid');
    return cursor;
  } catch {
    throw Object.assign(new Error('invalid or incompatible timeline cursor'), { status: 400 });
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
