import type { ScriptKbContext } from './types.js';

export function enrichScriptBasisPackWithBrandKb(
  pack: Record<string, unknown> | null | undefined,
  kbContext: ScriptKbContext | null | undefined
): Record<string, unknown> | null {
  if (!pack || typeof pack !== 'object') return pack ?? null;
  if (!kbContext) return pack;

  const keyFacts = (kbContext.key_facts || []).slice(0, 3);
  const topCases = (kbContext.top_cases || []).slice(0, 2);
  const faqAnswers = (kbContext.faq_answers || []).slice(0, 3);
  if (!keyFacts.length && !topCases.length && !faqAnswers.length) {
    return pack;
  }

  const proofLines = [
    ...keyFacts.map((fact) => String(fact.fact_content || '').trim()),
    ...topCases.map((item) => String(item.outcome_quote || item.case_title || '').trim())
  ].filter(Boolean).slice(0, 4);

  const objectionBoost = faqAnswers
    .filter((item) => item.objection_type)
    .slice(0, 2)
    .map((item) => ({
      objection_type: item.objection_type,
      answer: item.answer,
      question: item.question
    }));

  const kbSummary = proofLines.length
    ? `品牌知识库已注入 ${proofLines.length} 条可引用事实，开口可优先用真实案例/数据佐证。`
    : '品牌知识库已接入，可补充异议回应。';

  return {
    ...pack,
    summary: String(pack.summary || '').trim()
      ? `${String(pack.summary).trim()} ${kbSummary}`
      : kbSummary,
    brand_kb_anchors: {
      key_facts: keyFacts,
      top_cases: topCases,
      faq_answers: faqAnswers,
      kb_completeness_score: kbContext.kb_completeness_score ?? 0
    },
    brand_kb_proof_lines: proofLines,
    brand_kb_objection_boost: objectionBoost,
    script_opening_proof_hint: proofLines[0] || '',
    writeback_targets: Array.from(new Set([
      ...((Array.isArray(pack.writeback_targets) ? pack.writeback_targets : []) as string[]),
      'script_basis_pack.brand_kb_anchors'
    ]))
  };
}
