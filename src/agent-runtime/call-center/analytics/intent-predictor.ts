import { id, json, run } from '../../../db.js';
import { evaluateProactivePush } from '../omnichannel/proactive-push.js';

export interface IntentSignal {
  event: string;
  weight?: number;
  url?: string;
}

export interface IntentPrediction {
  customer_key: string;
  intent_score: number;
  predicted_topic: string;
  recommended_action: 'none' | 'proactive_chat' | 'outbound_call' | 'email_followup';
  explanation: string;
  proactive_push?: { queued: number; skipped: number };
}

const SIGNAL_WEIGHTS: Record<string, number> = {
  page_view: 0.1,
  pricing_page: 0.35,
  product_detail: 0.25,
  cart_abandon: 0.55,
  repeat_visit: 0.3,
  chat_widget_open: 0.2,
  support_page: 0.4,
  demo_request: 0.6
};

const TOPIC_BY_EVENT: Record<string, string> = {
  pricing_page: 'pricing_inquiry',
  product_detail: 'product_interest',
  cart_abandon: 'purchase_hesitation',
  support_page: 'support_need',
  demo_request: 'demo_interest',
  page_view: 'browsing'
};

export function predictCustomerIntent(
  db: unknown,
  tenantId: string,
  customerKey: string,
  signals: IntentSignal[],
  opts: { auto_push?: boolean; variables?: Record<string, string> } = {}
): IntentPrediction {
  let score = 0;
  const parts: string[] = [];
  let dominantEvent = 'page_view';

  for (const signal of signals) {
    const base = SIGNAL_WEIGHTS[signal.event] ?? 0.15;
    const weight = signal.weight ?? 1;
    const contribution = base * weight;
    score += contribution;
    parts.push(`${signal.event}(+${contribution.toFixed(2)})`);
    if (contribution >= (SIGNAL_WEIGHTS[dominantEvent] ?? 0)) {
      dominantEvent = signal.event;
    }
  }

  if (signals.filter((s) => s.event === 'repeat_visit').length >= 2) {
    score += 0.15;
    parts.push('repeat_visit_bonus(+0.15)');
    dominantEvent = 'repeat_visit';
  }

  score = Math.min(1, Math.round(score * 1000) / 1000);
  const predictedTopic = TOPIC_BY_EVENT[dominantEvent] || 'general_interest';
  const recommendedAction = recommendAction(score, dominantEvent);
  const explanation = parts.length ? parts.join(', ') : 'no signals';

  run(
    db,
    `INSERT INTO intent_predictions (id, tenant_id, customer_key, intent_score, predicted_topic, signals, recommended_action)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id('intent'),
      tenantId,
      customerKey,
      score,
      predictedTopic,
      json(signals),
      recommendedAction
    ]
  );

  let proactivePush: { queued: number; skipped: number } | undefined;
  if (opts.auto_push && score >= 0.5) {
    proactivePush = evaluateProactivePush(db, {
      tenant_id: tenantId,
      trigger_event: dominantEvent,
      customer_key: customerKey,
      intent_score: score,
      variables: opts.variables
    });
  }

  return {
    customer_key: customerKey,
    intent_score: score,
    predicted_topic: predictedTopic,
    recommended_action: recommendedAction,
    explanation,
    proactive_push: proactivePush
  };
}

function recommendAction(
  score: number,
  dominantEvent: string
): IntentPrediction['recommended_action'] {
  if (score < 0.35) return 'none';
  if (dominantEvent === 'demo_request' || score >= 0.75) return 'outbound_call';
  if (dominantEvent === 'cart_abandon' || dominantEvent === 'pricing_page') return 'proactive_chat';
  if (score >= 0.5) return 'email_followup';
  return 'none';
}
