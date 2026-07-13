import { createHash } from 'node:crypto';

import { pgId, withPgTransaction, type PgQueryable } from '../../db-pg.js';
import type {
  CollaborationPolicyFinding,
  CollaborationPolicyFindingReview,
  PolicyEvidenceRef,
  PolicyFindingReviewStatus,
  PolicyFindingSource,
  PolicySeverity
} from './types.js';

export interface RecordPolicyFindingInput {
  tenant_id: string;
  session_id: string;
  message_id?: string;
  source: PolicyFindingSource;
  source_ref_id?: string;
  policy_type: string;
  severity: PolicySeverity;
  matched_text_hash: string;
  action?: string;
  confidence?: number | null;
  rationale?: string;
  evidence_refs?: PolicyEvidenceRef[];
  metadata?: Record<string, unknown>;
}

export interface TenantFindingQueueInput {
  tenant_id: string;
  session_id?: string;
  source?: PolicyFindingSource;
  severity?: PolicySeverity;
  review_status?: PolicyFindingReviewStatus;
  created_from?: string;
  created_to?: string;
  cursor?: string;
  limit?: number;
}

export interface TenantFindingQueuePage {
  items: CollaborationPolicyFinding[];
  next_cursor: string;
}

export class PolicyFindingStore {
  constructor(private readonly pg: PgQueryable) {}

  async recordFinding(input: RecordPolicyFindingInput): Promise<CollaborationPolicyFinding> {
    const fingerprint = findingFingerprint(input);
    const findingId = pgId('cfind');
    const now = new Date().toISOString();
    const result = await this.pg.query(
      `INSERT INTO collaboration_policy_findings
        (id, tenant_id, session_id, message_id, source, source_ref_id, policy_type, severity,
         matched_text_hash, fingerprint, action, confidence, rationale, evidence_refs, metadata,
         created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
       ON CONFLICT (fingerprint) DO UPDATE SET
         severity = EXCLUDED.severity,
         action = EXCLUDED.action,
         confidence = COALESCE(EXCLUDED.confidence, collaboration_policy_findings.confidence),
         rationale = CASE WHEN EXCLUDED.rationale != '' THEN EXCLUDED.rationale ELSE collaboration_policy_findings.rationale END,
         evidence_refs = EXCLUDED.evidence_refs,
         metadata = collaboration_policy_findings.metadata || EXCLUDED.metadata,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        findingId,
        input.tenant_id,
        input.session_id,
        input.message_id || '',
        input.source,
        input.source_ref_id || input.message_id || '',
        input.policy_type,
        input.severity,
        input.matched_text_hash,
        fingerprint,
        input.action || 'review',
        finiteConfidence(input.confidence),
        redactSensitiveText(input.rationale || ''),
        JSON.stringify(input.evidence_refs || []),
        JSON.stringify(sanitizePolicyMetadata(input.metadata || {})),
        now
      ]
    );
    return decodeFinding(result.rows[0]);
  }

  async getFinding(input: {
    tenant_id: string;
    finding_id: string;
  }): Promise<CollaborationPolicyFinding | null> {
    const result = await this.pg.query(
      'SELECT * FROM collaboration_policy_findings WHERE id = $1 AND tenant_id = $2',
      [input.finding_id, input.tenant_id]
    );
    return result.rows[0] ? decodeFinding(result.rows[0]) : null;
  }

  async listFindings(input: {
    tenant_id: string;
    session_id: string;
    message_id?: string;
    source?: PolicyFindingSource;
    review_status?: PolicyFindingReviewStatus;
    limit?: number;
  }): Promise<CollaborationPolicyFinding[]> {
    const limit = findingListLimit(input.limit);
    const result = await this.pg.query(
      `SELECT * FROM collaboration_policy_findings
       WHERE tenant_id = $1 AND session_id = $2
         AND ($3 = '' OR message_id = $3)
         AND ($4 = '' OR source = $4)
         AND ($5 = '' OR review_status = $5)
       ORDER BY created_at DESC LIMIT $6`,
      [
        input.tenant_id,
        input.session_id,
        input.message_id || '',
        input.source || '',
        input.review_status || '',
        limit
      ]
    );
    return result.rows.map(decodeFinding);
  }

  async listTenantReviewQueue(input: TenantFindingQueueInput): Promise<TenantFindingQueuePage> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const sessionId = optionalBoundedText(input.session_id, 200, 'session_id');
    const source = optionalEnum(input.source, ['text', 'ocr', 'asr', 'ai'], 'source');
    const severity = optionalEnum(input.severity, ['low', 'medium', 'high'], 'severity');
    const reviewStatus = optionalEnum(
      input.review_status,
      ['pending', 'confirmed', 'false_positive', 'resolved', 'escalated'],
      'review_status'
    );
    const createdFrom = optionalIsoDate(input.created_from, 'created_from');
    const createdTo = optionalIsoDate(input.created_to, 'created_to');
    if (createdFrom && createdTo && createdFrom > createdTo) {
      throw badRequest('created_from cannot be after created_to');
    }
    const cursor = decodeFindingCursor(input.cursor);
    const limit = queueLimit(input.limit);
    const result = await this.pg.query(
      `SELECT finding.* FROM collaboration_policy_findings AS finding
       LEFT JOIN collaboration_messages AS message
         ON message.id = finding.message_id AND message.tenant_id = finding.tenant_id
       WHERE finding.tenant_id = $1
         AND ($2 = '' OR finding.session_id = $2)
         AND ($3 = '' OR finding.source = $3)
         AND ($4 = '' OR finding.severity = $4)
         AND ($5 = '' OR finding.review_status = $5)
         AND ($6::timestamptz IS NULL OR finding.created_at >= $6::timestamptz)
         AND ($7::timestamptz IS NULL OR finding.created_at <= $7::timestamptz)
         AND ($8::timestamptz IS NULL OR finding.created_at < $8::timestamptz
           OR (finding.created_at = $8::timestamptz AND finding.id < $9))
         AND (finding.message_id = '' OR (message.id IS NOT NULL AND message.deleted_at IS NULL))
       ORDER BY finding.created_at DESC, finding.id DESC
       LIMIT $10`,
      [
        tenantId,
        sessionId,
        source,
        severity,
        reviewStatus,
        createdFrom || null,
        createdTo || null,
        cursor?.created_at || null,
        cursor?.id || '',
        limit + 1
      ]
    );
    const decoded = result.rows.map(decodeFinding);
    const items = decoded.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      next_cursor: decoded.length > limit && last
        ? encodeFindingCursor({ created_at: last.created_at, id: last.id })
        : ''
    };
  }

  async reviewFinding(input: {
    tenant_id: string;
    finding_id: string;
    review_status: Exclude<PolicyFindingReviewStatus, 'pending'>;
    reviewed_by: string;
    note?: string;
    metadata?: Record<string, unknown>;
  }): Promise<CollaborationPolicyFinding> {
    const reviewedBy = String(input.reviewed_by || '').trim();
    if (!reviewedBy) throw Object.assign(new Error('reviewed_by is required'), { status: 400 });
    return withPgTransaction(this.pg, async (pg) => {
      const currentResult = await pg.query(
        'SELECT * FROM collaboration_policy_findings WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [input.finding_id, input.tenant_id]
      );
      if (!currentResult.rows[0]) {
        throw Object.assign(new Error('policy finding not found'), { status: 404 });
      }
      const current = decodeFinding(currentResult.rows[0]);
      if (current.review_status === input.review_status) return current;
      if (!reviewTransitionAllowed(current.review_status, input.review_status)) {
        throw Object.assign(new Error('invalid finding review transition'), { status: 409 });
      }
      const now = new Date().toISOString();
      const note = redactSensitiveText(input.note || '').slice(0, 2_000);
      const updatedResult = await pg.query(
        `UPDATE collaboration_policy_findings
         SET review_status = $3, reviewed_by = $4, reviewed_at = $5,
             review_note = $6, resolved_at = CASE WHEN $3 = 'resolved' THEN $5 ELSE resolved_at END,
             updated_at = $5
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        [input.finding_id, input.tenant_id, input.review_status, reviewedBy, now, note]
      );
      const reviewId = pgId('cfrev');
      await pg.query(
        `INSERT INTO collaboration_policy_finding_reviews
          (id, tenant_id, finding_id, from_status, to_status, reviewed_by, note, note_hash, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          reviewId,
          input.tenant_id,
          input.finding_id,
          current.review_status,
          input.review_status,
          reviewedBy,
          note,
          sha256(note),
          JSON.stringify(sanitizePolicyMetadata(input.metadata || {})),
          now
        ]
      );
      return decodeFinding(updatedResult.rows[0]);
    });
  }

  async listReviews(input: {
    tenant_id: string;
    finding_id: string;
  }): Promise<CollaborationPolicyFindingReview[]> {
    const result = await this.pg.query(
      `SELECT * FROM collaboration_policy_finding_reviews
       WHERE tenant_id = $1 AND finding_id = $2
       ORDER BY created_at ASC`,
      [input.tenant_id, input.finding_id]
    );
    return result.rows.map(decodeReview);
  }
}

function findingFingerprint(input: RecordPolicyFindingInput): string {
  return sha256([
    input.tenant_id,
    input.session_id,
    input.message_id || '',
    input.source,
    input.source_ref_id || input.message_id || '',
    input.policy_type,
    input.matched_text_hash
  ].join('\u0000'));
}

function reviewTransitionAllowed(
  from: PolicyFindingReviewStatus,
  to: Exclude<PolicyFindingReviewStatus, 'pending'>
): boolean {
  if (from === 'resolved' || from === 'false_positive') return false;
  if (from === 'pending') return to === 'confirmed' || to === 'false_positive' || to === 'escalated';
  if (from === 'confirmed') return to === 'resolved' || to === 'escalated' || to === 'false_positive';
  return to === 'confirmed' || to === 'resolved' || to === 'false_positive';
}

export function redactSensitiveText(value: string): string {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, '[phone]');
}

export function sanitizePolicyMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeMetadataValue(value, 0) as Record<string, unknown>;
}

function sanitizeMetadataValue(value: unknown, depth: number): unknown {
  if (depth >= 6) return '[truncated]';
  if (typeof value === 'string') return redactSensitiveText(value).slice(0, 2_000);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeMetadataValue(item, depth + 1));
  }
  if (typeof value !== 'object') return String(value).slice(0, 2_000);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, item]) => [key.slice(0, 200), sanitizeMetadataValue(item, depth + 1)])
  );
}

function findingListLimit(value: number | undefined): number {
  if (value == null) return 100;
  if (!Number.isInteger(value)) {
    throw Object.assign(new Error('limit must be an integer'), { status: 400 });
  }
  return Math.min(Math.max(value, 1), 500);
}

function queueLimit(value: number | undefined): number {
  if (value == null) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw badRequest('limit must be an integer between 1 and 500');
  }
  return value;
}

function requiredText(value: unknown, field: string): string {
  const text = String(value || '').trim();
  if (!text) throw badRequest(`${field} is required`);
  return text;
}

function optionalBoundedText(value: unknown, max: number, field: string): string {
  const text = String(value || '').trim();
  if (text.length > max) throw badRequest(`${field} is too long`);
  return text;
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): T | '' {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!allowed.includes(text as T)) throw badRequest(`${field} is invalid`);
  return text as T;
}

function optionalIsoDate(value: unknown, field: string): string {
  const text = String(value || '').trim();
  if (!text) return '';
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw badRequest(`${field} must be an ISO date-time`);
  return new Date(timestamp).toISOString();
}

function encodeFindingCursor(cursor: { created_at: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeFindingCursor(value: unknown): { created_at: string; id: string } | null {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const decoded = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid');
    const record = decoded as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'created_at' && key !== 'id')) throw new Error('invalid');
    const createdAt = optionalIsoDate(record.created_at, 'cursor');
    const id = optionalBoundedText(record.id, 200, 'cursor id');
    if (!createdAt || !id) throw new Error('invalid');
    return { created_at: createdAt, id };
  } catch {
    throw badRequest('cursor is invalid');
  }
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

function finiteConfidence(value: number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeFinding(row: Record<string, unknown>): CollaborationPolicyFinding {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    message_id: String(row.message_id || ''),
    source: String(row.source) as CollaborationPolicyFinding['source'],
    source_ref_id: String(row.source_ref_id || ''),
    policy_type: String(row.policy_type),
    severity: String(row.severity) as CollaborationPolicyFinding['severity'],
    matched_text_hash: String(row.matched_text_hash || ''),
    fingerprint: String(row.fingerprint || ''),
    action: String(row.action || 'review'),
    confidence: row.confidence == null ? null : Number(row.confidence),
    rationale: String(row.rationale || ''),
    evidence_refs: parseArray(row.evidence_refs),
    review_status: String(row.review_status || 'pending') as CollaborationPolicyFinding['review_status'],
    reviewed_by: String(row.reviewed_by || ''),
    reviewed_at: row.reviewed_at ? String(row.reviewed_at) : null,
    review_note: String(row.review_note || ''),
    metadata: parseRecord(row.metadata),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || row.created_at || ''),
    resolved_at: row.resolved_at ? String(row.resolved_at) : null
  };
}

function decodeReview(row: Record<string, unknown>): CollaborationPolicyFindingReview {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    finding_id: String(row.finding_id),
    from_status: String(row.from_status) as CollaborationPolicyFindingReview['from_status'],
    to_status: String(row.to_status) as CollaborationPolicyFindingReview['to_status'],
    reviewed_by: String(row.reviewed_by),
    note: String(row.note || ''),
    note_hash: String(row.note_hash || ''),
    metadata: parseRecord(row.metadata),
    created_at: String(row.created_at || '')
  };
}

function parseRecord(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function parseArray(value: unknown): PolicyEvidenceRef[] {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed as PolicyEvidenceRef[] : [];
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return fallback;
  }
}
