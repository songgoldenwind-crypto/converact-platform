import type { QmScores } from './qm-policy.js';
import { computeOverallScore } from './qm-policy.js';
import { chatCompletionsWithFallback } from '../../integrations/llm-env-client.js';

export interface QmEvaluatorDeps {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface QmEvaluationResult {
  scores: QmScores;
  violations: string[];
  summary: string;
  recommendation: string;
  overall_score: number;
}

const SYSTEM_PROMPT = `你是通话质检 AI。评估以下通话记录的质量，按 5 个维度打分（0.0-1.0）：
1. politeness（礼貌度）：语气是否友善、专业
2. compliance（合规性）：是否做了 AI 披露、是否涉及禁止话题
3. problem_resolution（问题解决）：是否有效回答了客户问题
4. upsell_effectiveness（追售效果）：是否在合适时机推进下一步
5. script_adherence（话术遵守）：是否按照预设话术流程推进

返回 JSON：{"scores":{"politeness":0.9,"compliance":0.8,"problem_resolution":0.7,"upsell_effectiveness":0.6,"script_adherence":0.8},"violations":["未做AI披露"],"summary":"一句话总结","recommendation":"改进建议","overall_score":0.85}`;

export async function evaluateCallQuality(
  conversationText: string,
  opts: {
    deps?: QmEvaluatorDeps;
    language?: string;
    policyRules?: string[];
    agentGoal?: string;
  }
): Promise<QmEvaluationResult> {
  const { policyRules, agentGoal } = opts;

  let systemMessage = SYSTEM_PROMPT;
  if (policyRules?.length) {
    systemMessage += `\n\n适用策略规则：\n${policyRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
  }
  if (agentGoal) {
    systemMessage += `\n\nAgent 目标：${agentGoal}`;
  }

  try {
    const result = await chatCompletionsWithFallback({
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: conversationText }
      ],
      temperature: 0.1,
      extraBody: { response_format: { type: 'json_object' } }
    });

    const parsed = JSON.parse(result.text) as Partial<QmEvaluationResult>;
    return validateResult(parsed);
  } catch (error) {
    // Previously: silently returned fallbackResult() with 0.5 scores,
    // making it impossible to distinguish real 0.5 from LLM failure.
    console.warn('[qm-evaluator] LLM evaluation failed:', error);
    const fallback = fallbackResult();
    fallback.summary = `[评估失败] ${error instanceof Error ? error.message : String(error)}`;
    return fallback;
  }
}

function validateResult(raw: Partial<QmEvaluationResult>): QmEvaluationResult {
  const scores: QmScores = {
    politeness: clampScore(raw.scores?.politeness),
    compliance: clampScore(raw.scores?.compliance),
    problem_resolution: clampScore(raw.scores?.problem_resolution),
    upsell_effectiveness: clampScore(raw.scores?.upsell_effectiveness),
    script_adherence: clampScore(raw.scores?.script_adherence)
  };

  const violations = Array.isArray(raw.violations)
    ? raw.violations.filter((v): v is string => typeof v === 'string')
    : [];

  return {
    scores,
    violations,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    recommendation: typeof raw.recommendation === 'string' ? raw.recommendation : '',
    overall_score: computeOverallScore(scores)
  };
}

function clampScore(value: unknown): number {
  const n = Number(value);
  if (Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function fallbackResult(): QmEvaluationResult {
  const scores: QmScores = {
    politeness: 0.5,
    compliance: 0.5,
    problem_resolution: 0.5,
    upsell_effectiveness: 0.5,
    script_adherence: 0.5
  };
  return {
    scores,
    violations: [],
    summary: '质检评估失败，使用默认分数',
    recommendation: '',
    overall_score: computeOverallScore(scores)
  };
}
