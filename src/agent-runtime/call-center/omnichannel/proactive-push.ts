import { all, id, one, run } from '../../../db.js';

export interface ProactivePushRule {
  id: string;
  tenant_id: string;
  name: string;
  trigger_event: string;
  channel: string;
  message_template: string;
  min_intent_score: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export class ProactivePushStore {
  constructor(private readonly db: unknown) {}

  list(tenantId: string): ProactivePushRule[] {
    return all(
      this.db,
      'SELECT * FROM proactive_push_rules WHERE tenant_id = ? ORDER BY created_at DESC',
      [tenantId]
    ).map((row) => decode(row as Record<string, unknown>));
  }

  create(input: Omit<ProactivePushRule, 'id' | 'created_at' | 'updated_at'>): ProactivePushRule {
    const ruleId = id('push');
    run(
      this.db,
      `INSERT INTO proactive_push_rules
        (id, tenant_id, name, trigger_event, channel, message_template, min_intent_score, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ruleId,
        input.tenant_id,
        input.name,
        input.trigger_event,
        input.channel,
        input.message_template,
        input.min_intent_score,
        input.enabled ? 1 : 0
      ]
    );
    return this.get(ruleId)!;
  }

  get(ruleId: string): ProactivePushRule | null {
    const row = one(this.db, 'SELECT * FROM proactive_push_rules WHERE id = ?', [ruleId]);
    return row ? decode(row as Record<string, unknown>) : null;
  }

  recordEvent(input: {
    tenant_id: string;
    rule_id: string;
    customer_key: string;
    channel: string;
    message: string;
    status: 'sent' | 'queued' | 'failed' | 'skipped';
  }): void {
    run(
      this.db,
      `INSERT INTO proactive_push_events (id, tenant_id, rule_id, customer_key, channel, message, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id('pevt'), input.tenant_id, input.rule_id, input.customer_key, input.channel, input.message, input.status]
    );
  }
}

export function evaluateProactivePush(
  db: unknown,
  input: {
    tenant_id: string;
    trigger_event: string;
    customer_key: string;
    intent_score?: number;
    variables?: Record<string, string>;
  }
): { queued: number; skipped: number } {
  const store = new ProactivePushStore(db);
  const rules = store.list(input.tenant_id).filter(
    (r) => r.enabled && r.trigger_event === input.trigger_event
  );
  let queued = 0;
  let skipped = 0;
  for (const rule of rules) {
    const score = input.intent_score ?? 0;
    if (score < rule.min_intent_score) {
      store.recordEvent({
        tenant_id: input.tenant_id,
        rule_id: rule.id,
        customer_key: input.customer_key,
        channel: rule.channel,
        message: rule.message_template,
        status: 'skipped'
      });
      skipped += 1;
      continue;
    }
    const message = interpolate(rule.message_template, input.variables || {});
    // TODO: Actually send via SMS/email/wechat sender based on rule.channel.
    // Currently records as 'queued' (not 'sent') — the message is NOT delivered.
    // Previous code marked as 'sent' which was a fake/stub status.
    store.recordEvent({
      tenant_id: input.tenant_id,
      rule_id: rule.id,
      customer_key: input.customer_key,
      channel: rule.channel,
      message,
      status: 'queued'
    });
    queued += 1;
  }
  return { queued, skipped };
}

function interpolate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? '');
}

function decode(row: Record<string, unknown>): ProactivePushRule {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    name: String(row.name),
    trigger_event: String(row.trigger_event),
    channel: String(row.channel),
    message_template: String(row.message_template),
    min_intent_score: Number(row.min_intent_score),
    enabled: Boolean(row.enabled),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}
