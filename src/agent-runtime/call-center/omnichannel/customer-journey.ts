import { all } from '../../../db.js';
import { buildCustomerKey } from '../omnichannel/omni-service.js';
import { redactPhone } from '../../voice/voice-store.js';

export interface UnifiedJourneyEvent {
  id: string;
  event_type: string;
  channel: string;
  summary: string;
  ref_id: string | null;
  occurred_at: string;
  source: 'journey' | 'call_session';
}

export function getUnifiedCustomerJourney(
  db: unknown,
  tenantId: string,
  input: { phone?: string; email?: string; customer_id?: string },
  limit = 80
): UnifiedJourneyEvent[] {
  const customerKey = buildCustomerKey({
    phone: input.phone,
    email: input.email,
    customer_id: input.customer_id
  });
  const events: UnifiedJourneyEvent[] = [];

  const journeyRows = all(
    db,
    `SELECT * FROM customer_journey_events WHERE tenant_id = ? AND customer_key = ? ORDER BY occurred_at DESC LIMIT ?`,
    [tenantId, customerKey, limit]
  );
  for (const row of journeyRows) {
    events.push({
      id: String((row as { id: string }).id),
      event_type: String((row as { event_type: string }).event_type),
      channel: String((row as { channel: string }).channel),
      summary: String((row as { summary: string }).summary),
      ref_id: (row as { ref_id: string | null }).ref_id ? String((row as { ref_id: string }).ref_id) : null,
      occurred_at: String((row as { occurred_at: string }).occurred_at),
      source: 'journey'
    });
  }

  if (input.phone) {
    const redacted = redactPhone(input.phone);
    const sessionRows = all(
      db,
      `SELECT id, direction, status, phone_redacted, started_at, created_at FROM voice_call_sessions
       WHERE tenant_id = ? AND phone_redacted = ? ORDER BY created_at DESC LIMIT 30`,
      [tenantId, redacted]
    );
    for (const row of sessionRows) {
      events.push({
        id: `call_${String((row as { id: string }).id)}`,
        event_type: 'call_session',
        channel: 'voice',
        summary: `${String((row as { direction: string }).direction)} · ${String((row as { status: string }).status)} · ${String((row as { phone_redacted: string }).phone_redacted || '')}`,
        ref_id: String((row as { id: string }).id),
        occurred_at: String((row as { started_at: string }).started_at || (row as { created_at: string }).created_at),
        source: 'call_session'
      });
    }
  }

  events.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
  return events.slice(0, limit);
}
