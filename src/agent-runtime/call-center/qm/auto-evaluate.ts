import { all } from '../../../db.js';
import { broadcastQmLowScoreAlert } from '../../../call-center-events.js';
import { QmStore } from './qm-store.js';
import { evaluateCallQuality } from './qm-evaluator.js';
import { DEFAULT_QM_POLICY } from './qm-policy.js';
import { isEnvLlmConfigured } from '../../integrations/llm-env-client.js';

export async function triggerAutoQmEvaluation(
  db: unknown,
  tenantId: string,
  callSessionId: string
): Promise<void> {
  try {
    const store = new QmStore(db);
    if (store.getEvaluationBySession(callSessionId)) return;

    const turns = all(
      db,
      'SELECT role, content FROM ai_conversation_turns WHERE call_session_id = ? ORDER BY turn_index ASC',
      [callSessionId]
    );
    if (!turns.length) return;

    const conversationText = turns
      .map((t) => `[${String((t as { role: string }).role)}]: ${String((t as { content: string }).content)}`)
      .join('\n');

    const result = await evaluateCallQuality(conversationText, {
      deps: {},
      policyRules: DEFAULT_QM_POLICY.rules
    });

    // Re-check after LLM call — concurrent evaluation may have already created one
    // while we were waiting for the LLM response. Prevents duplicate evaluations.
    if (store.getEvaluationBySession(callSessionId)) return;

    const evaluation = store.createEvaluation({
      tenant_id: tenantId,
      call_session_id: callSessionId,
      evaluator: isEnvLlmConfigured() ? 'llm' : 'fallback',
      scores: result.scores,
      violations: result.violations,
      summary: result.summary,
      recommendation: result.recommendation,
      overall_score: result.overall_score
    });

    if (evaluation.overall_score < DEFAULT_QM_POLICY.alert_threshold) {
      broadcastQmLowScoreAlert(tenantId, {
        evaluation_id: evaluation.id,
        call_session_id: callSessionId,
        overall_score: evaluation.overall_score,
        violations: evaluation.violations,
        summary: evaluation.summary
      });
    }
  } catch (error) {
    console.warn('[qm] auto evaluation failed:', error);
  }
}
