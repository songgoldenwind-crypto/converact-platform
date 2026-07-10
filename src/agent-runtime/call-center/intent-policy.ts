/** 与 ai-agent-py/intent_scorer.py 的 TRANSFER_THRESHOLD 保持一致 */
export const INTENT_TRANSFER_THRESHOLD = 0.7;

export type IntentRecommendation = 'transfer' | 'continue';

export function intentRecommendation(score: number): IntentRecommendation {
  return score >= INTENT_TRANSFER_THRESHOLD ? 'transfer' : 'continue';
}
