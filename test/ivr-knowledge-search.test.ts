import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { KnowledgeQaExecResult } from '../src/agent-runtime/ivr/ivr-side-effects.js';
import {
  isKnowledgeQaHit,
  applyKnowledgeQaVariables,
} from '../src/agent-runtime/ivr/ivr-knowledge-handler.js';

const node = {
  id: 'kq1',
  type: 'knowledge_qa' as const,
  name: 'KQ',
  position: { x: 0, y: 0 },
  data: { confidenceThreshold: 0.5 },
};

test('isKnowledgeQaHit: high confidence → hit', () => {
  assert.equal(isKnowledgeQaHit(node, { found: true, confidence: 0.9 }), true);
});

test('isKnowledgeQaHit: low confidence → miss', () => {
  assert.equal(isKnowledgeQaHit(node, { found: true, confidence: 0.2 }), false);
});

test('applyKnowledgeQaVariables writes kb_answer and kb_source', () => {
  const vars = applyKnowledgeQaVariables(node, {}, {
    found: true,
    answer: 'hello',
    source: 'doc1',
    confidence: 0.9,
  });
  assert.equal(vars.kb_result, 'found');
  assert.equal(vars.kb_answer, 'hello');
  assert.equal(vars.kb_source, 'doc1');
});
