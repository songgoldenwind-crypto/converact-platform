import { createHash } from 'node:crypto';
import { all, id, json, one, parseJson, run } from '../../db.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import type { AuditStoreLike } from '../runtime-domain-types.js';

interface RedactedContent {
  content: unknown;
  pii_classes: string[];
}

export class TranscriptStore {
  db: unknown;
  runStore: AuditStoreLike | null;

  constructor(db: unknown, runStore: AuditStoreLike | null = null) {
    this.db = db;
    this.runStore = runStore;
  }

  append(input: JsonRecord): JsonRecord | null {
    const redacted = redactContent(input.content ?? {});
    const entry = {
      id: id('trn'),
      tenant_id: input.tenant_id,
      workspace_id: input.workspace_id || 'default',
      session_key: input.session_key || '',
      workflow_run_id: input.workflow_run_id || null,
      agent_run_id: input.agent_run_id || null,
      role: input.role,
      content_type: input.content_type,
      content_redacted: redacted.content,
      content_hash: hash(redacted.content),
      pii_classes: redacted.pii_classes,
      channel: input.channel || '',
      business_object_refs: input.business_object_refs || []
    };
    run(
      this.db,
      `INSERT INTO transcript_entries
        (id, tenant_id, workspace_id, session_key, workflow_run_id, agent_run_id, role, content_type, content_redacted, content_hash, pii_classes, channel, business_object_refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.tenant_id,
        entry.workspace_id,
        entry.session_key,
        entry.workflow_run_id,
        entry.agent_run_id,
        entry.role,
        entry.content_type,
        json(entry.content_redacted),
        entry.content_hash,
        json(entry.pii_classes),
        entry.channel,
        json(entry.business_object_refs)
      ]
    );
    this.runStore?.audit(entry.tenant_id, 'transcript.entry_appended', 'transcript_entry', entry.id, {
      role: entry.role,
      content_type: entry.content_type
    });
    return this.get(entry.tenant_id, entry.id);
  }

  get(tenantId: string, entryId: string): JsonRecord | null {
    const row = one(this.db, 'SELECT * FROM transcript_entries WHERE tenant_id = ? AND id = ?', [tenantId, entryId]);
    return row ? decodeTranscript(row) : null;
  }

  listBySession({ tenant_id, session_key, limit = 50 }: JsonRecord): JsonRecord[] {
    return all(
      this.db,
      `SELECT * FROM transcript_entries
       WHERE tenant_id = ? AND session_key = ?
       ORDER BY created_at ASC
       LIMIT ?`,
      [tenant_id, session_key, limit]
    ).map(decodeTranscript);
  }

  summarize(input: JsonRecord): JsonRecord {
    const summary = {
      id: id('trsum'),
      tenant_id: input.tenant_id,
      session_key: input.session_key || '',
      summary: input.summary,
      source_entry_ids: input.source_entry_ids || [],
      created_by_agent_run_id: input.created_by_agent_run_id || null
    };
    run(
      this.db,
      `INSERT INTO transcript_summaries
        (id, tenant_id, session_key, summary, source_entry_ids, created_by_agent_run_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        summary.id,
        summary.tenant_id,
        summary.session_key,
        summary.summary,
        json(summary.source_entry_ids),
        summary.created_by_agent_run_id
      ]
    );
    return summary;
  }
}

function decodeTranscript(row: JsonRecord): JsonRecord {
  return {
    ...row,
    content_redacted: parseJson(row.content_redacted),
    pii_classes: parseJson(row.pii_classes, []),
    business_object_refs: parseJson(row.business_object_refs, [])
  };
}

function redactContent(value: unknown): RedactedContent {
  const pii = new Set<string>();
  return {
    content: redactValue(value ?? {}, pii),
    pii_classes: [...pii]
  };
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function redactValue(value: unknown, pii: Set<string>): unknown {
  if (typeof value === 'string') {
    return redactString(value, pii);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, pii));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, redactValue(child, pii)])
    );
  }
  return value;
}

function redactString(value: string, pii: Set<string>): string {
  let redacted = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, () => {
    pii.add('email');
    return '[REDACTED_EMAIL]';
  });
  redacted = redacted.replace(/(\+?\d[\d\s().-]{7,}\d)/g, () => {
    pii.add('phone');
    return '[REDACTED_PHONE]';
  });
  return redacted;
}
