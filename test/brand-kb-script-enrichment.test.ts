import assert from 'node:assert/strict';
import { test } from 'node:test';

import { enrichScriptBasisPackWithBrandKb } from '../src/agent-runtime/geo-intelligence/enrich-script-basis-pack.js';

test('enrichScriptBasisPackWithBrandKb injects proof lines and anchors', () => {
  const pack = enrichScriptBasisPackWithBrandKb(
    { packet_id: 'script-basis-v1', summary: '基础话术包' },
    {
      key_facts: [{ fact_type: 'data_point', fact_content: '平均节省 3 小时/天', fact_evidence: '调研' }],
      top_cases: [{ case_title: '某财税客户', outcome_quote: '当月新增 12 个意向客户', outcome_metrics: {} }],
      faq_answers: [{ question: '太贵了？', answer: 'ROI 通常 2 周内回本', objection_type: 'price' }],
      kb_completeness_score: 0.72
    }
  );

  assert.match(String(pack?.summary), /品牌知识库/);
  assert.equal((pack?.brand_kb_proof_lines as any[])?.length, 2);
  assert.equal((pack?.brand_kb_anchors as any)?.key_facts?.length, 1);
  assert.equal(pack?.script_opening_proof_hint, '平均节省 3 小时/天');
  assert.equal(pack?.brand_kb_objection_boost?.[0]?.objection_type, 'price');
});

test('enrichScriptBasisPackWithBrandKb leaves pack unchanged when kb is empty', () => {
  const pack = { packet_id: 'script-basis-v1', summary: '仅基础包' };
  assert.deepEqual(
    enrichScriptBasisPackWithBrandKb(pack, {
      key_facts: [],
      top_cases: [],
      faq_answers: [],
      kb_completeness_score: 0
    }),
    pack
  );
});
