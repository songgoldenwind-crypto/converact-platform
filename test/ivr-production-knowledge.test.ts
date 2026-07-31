import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { KnowledgeStore } from '../src/agent-runtime/call-center/knowledge/knowledge-store.js';
import { createProductionSideEffects } from '../src/agent-runtime/ivr/ivr-production-effects.js';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

const TENANT = 'tenant-kb-prod';

function kqGraph(kbId: string): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'kq1',
    variables: [],
    nodes: [
      {
        id: 'kq1',
        type: 'knowledge_qa',
        name: 'KQ',
        position: { x: 0, y: 0 },
        data: {
          knowledgeBaseId: kbId,
          maxResults: 1,
          noAnswerAction: 'continue',
          questionVariable: 'caller_question',
        },
      },
      { id: 'found', type: 'play', name: 'F', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
      { id: 'miss', type: 'play', name: 'M', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'no' }] } },
    ],
    edges: [
      { id: 'e1', source: 'kq1', target: 'found', sourceHandle: 'found' },
      { id: 'e2', source: 'kq1', target: 'miss', sourceHandle: 'not_found' },
    ],
  };
}

test('production executeKnowledgeQa: hit routes to found', async () => {
  const db = createDatabase(':memory:');
  const kbStore = new KnowledgeStore(db);
  const kb = kbStore.createKnowledgeBase({ tenant_id: TENANT, name: 'FAQ' });
  kbStore.addDocument({
    tenant_id: TENANT,
    knowledge_base_id: kb.id,
    title: '退货',
    content: '七天内可退货',
  });

  const effects = createProductionSideEffects(db, TENANT);
  const ctx = createRuntimeContext(kqGraph(kb.id));
  ctx.variables.caller_question = '退货';

  const step = await advanceSingleStep(ctx, { sideEffects: effects });
  assert.equal(step.nextNodeId, 'found');
  assert.equal(step.context.variables.kb_result, 'found');
  assert.ok(step.context.variables.kb_answer?.includes('退货'));
});

test('production executeKnowledgeQa: empty question → not_found', async () => {
  const db = createDatabase(':memory:');
  const kbStore = new KnowledgeStore(db);
  const kb = kbStore.createKnowledgeBase({ tenant_id: TENANT, name: 'FAQ' });
  const effects = createProductionSideEffects(db, TENANT);

  const step = await advanceSingleStep(createRuntimeContext(kqGraph(kb.id)), {
    sideEffects: effects,
  });
  assert.equal(step.nextNodeId, 'miss');
  assert.equal(step.context.variables.kb_result, 'not_found');
});

test('production executeKnowledgeQa: no match → not_found', async () => {
  const db = createDatabase(':memory:');
  const kbStore = new KnowledgeStore(db);
  const kb = kbStore.createKnowledgeBase({ tenant_id: TENANT, name: 'FAQ' });
  kbStore.addDocument({
    tenant_id: TENANT,
    knowledge_base_id: kb.id,
    title: '营业时间',
    content: '周一至周五 9-18 点',
  });
  const effects = createProductionSideEffects(db, TENANT);
  const ctx = createRuntimeContext(kqGraph(kb.id));
  ctx.variables.caller_question = '完全不相关的问句 xyz';

  const step = await advanceSingleStep(ctx, { sideEffects: effects });
  assert.equal(step.nextNodeId, 'miss');
  assert.equal(step.context.variables.kb_result, 'not_found');
});

test('production executeKnowledgeQa: low lexical confidence → not_found', async () => {
  const db = createDatabase(':memory:');
  const kbStore = new KnowledgeStore(db);
  const kb = kbStore.createKnowledgeBase({ tenant_id: TENANT, name: 'FAQ' });
  kbStore.addDocument({
    tenant_id: TENANT,
    knowledge_base_id: kb.id,
    title: '退货政策',
    content: '七天无理由退货 运费自理 包装完整',
  });
  const effects = createProductionSideEffects(db, TENANT);
  const graph = kqGraph(kb.id);
  const node = graph.nodes.find((n) => n.id === 'kq1');
  assert.ok(node);
  node.data = { ...node.data, confidenceThreshold: 0.85 };

  const ctx = createRuntimeContext(graph);
  // Recall uses first 2 CJK chars ("退货"); full-query bigram overlap stays low.
  ctx.variables.caller_question = '退货发票开票地址电话客服工单进度';

  const step = await advanceSingleStep(ctx, { sideEffects: effects });
  assert.equal(step.nextNodeId, 'miss');
  assert.equal(step.context.variables.kb_result, 'not_found');
  assert.equal(step.context.variables.kb_miss_reason, 'low_confidence');
});
