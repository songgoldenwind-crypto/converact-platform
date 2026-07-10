export interface QmScores {
  politeness: number;
  compliance: number;
  problem_resolution: number;
  upsell_effectiveness: number;
  script_adherence: number;
}

export interface QmPolicy {
  id: string;
  name: string;
  rules: string[];
  weights: Record<keyof QmScores, number>;
  alert_threshold: number;
}

export const DEFAULT_QM_POLICY: QmPolicy = {
  id: 'default',
  name: '默认质检策略',
  rules: [
    '必须在通话开始 30 秒内完成 AI 身份披露',
    '禁止承诺无法兑现的优惠或服务',
    '客户明确拒绝时不可继续推销',
    '必须确认客户需求后再推荐方案'
  ],
  weights: {
    politeness: 0.2,
    compliance: 0.25,
    problem_resolution: 0.25,
    upsell_effectiveness: 0.15,
    script_adherence: 0.15
  },
  alert_threshold: 0.5
};

export function computeOverallScore(
  scores: QmScores,
  weights?: Record<keyof QmScores, number>
): number {
  const w = weights ?? DEFAULT_QM_POLICY.weights;
  return (
    scores.politeness * w.politeness +
    scores.compliance * w.compliance +
    scores.problem_resolution * w.problem_resolution +
    scores.upsell_effectiveness * w.upsell_effectiveness +
    scores.script_adherence * w.script_adherence
  );
}
