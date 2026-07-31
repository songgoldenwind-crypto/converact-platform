/**
 * Knowledge QA routing — noAnswerAction immediate actions + found path (不一致-2 K-H3).
 */
import { IVR_BRANCH } from './ivr-branch-handles.js';
import type { IvrNodeBase } from './ivr-types.js';
import { requireEdge } from './ivr-types.js';
import type { IvrAction, IvrRuntimeContext } from './ivr-executor.js';
import type { KnowledgeQaExecResult } from './ivr-side-effects.js';

export interface KnowledgeQaNodeDataLike {
  knowledgeBaseId?: string;
  maxResults?: number;
  noAnswerAction?: string;
  noAnswerTarget?: string;
  questionVariable?: string;
  confidenceThreshold?: number;
  answerPlayMode?: 'none' | 'tts' | 'summary';
  answerVariable?: string;
}

export type KnowledgeQaStepResult =
  | { mode: 'action'; action: IvrAction; variables: Record<string, string> }
  | {
      mode: 'branch';
      nextNodeId: string | null;
      variables: Record<string, string>;
      branch: string;
      action?: IvrAction;
      pendingAdvanceNodeId?: string | null;
    };

export function applyKnowledgeQaVariables(
  node: IvrNodeBase,
  variables: Record<string, string>,
  result: KnowledgeQaExecResult
): Record<string, string> {
  const data = node.data as KnowledgeQaNodeDataLike;
  const answerVar = data.answerVariable || 'kb_answer';
  const next = { ...variables };
  next.kb_result = result.found ? 'found' : 'not_found';
  if (result.answer) next[answerVar] = result.answer;
  if (result.source) next.kb_source = result.source;
  if (result.confidence != null) next.kb_confidence = String(result.confidence);
  if (result.reason) next.kb_miss_reason = result.reason;
  return next;
}

export function isKnowledgeQaHit(
  node: IvrNodeBase,
  result: KnowledgeQaExecResult
): boolean {
  if (!result.found) return false;
  const threshold = (node.data as KnowledgeQaNodeDataLike).confidenceThreshold ?? 0.3;
  if (result.confidence == null) return true;
  return result.confidence >= threshold;
}

/**
 * Lexical overlap confidence for keyword KB hits (0..1).
 * Whitespace tokens + CJK bigrams so Chinese queries are not always 1.0.
 */
export function lexicalKnowledgeConfidence(query: string, title: string, content: string): number {
  const q = query.trim().toLowerCase();
  const hay = `${title}\n${content}`.toLowerCase();
  if (!q || !hay) return 0;
  if (title.toLowerCase() === q || hay.includes(q)) return 1;

  const tokens = q.split(/\s+/).filter(Boolean);
  const features: string[] = [...tokens];
  const compact = q.replace(/\s+/g, '');
  if (/[\u4e00-\u9fff]/.test(compact) && compact.length >= 2) {
    for (let i = 0; i < compact.length - 1; i++) {
      features.push(compact.slice(i, i + 2));
    }
  }
  if (!features.length) return 0;

  let hits = 0;
  for (const f of features) {
    if (hay.includes(f)) hits++;
  }
  return Math.max(0, Math.min(1, hits / features.length));
}

/** Broaden recall for scoring: first whitespace token, or first 2 CJK chars. */
export function knowledgeSearchQuery(question: string): string {
  const trimmed = question.trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length > 1) return parts[0];
  const q = parts[0] || trimmed;
  if (/[\u4e00-\u9fff]/.test(q) && q.length > 2) return q.slice(0, 2);
  return q;
}

export function routeKnowledgeQaMiss(
  graph: IvrRuntimeContext['graph'],
  node: IvrNodeBase,
  variables: Record<string, string>
): KnowledgeQaStepResult {
  const data = node.data as KnowledgeQaNodeDataLike;
  const nextVars = { ...variables, kb_result: 'not_found' };
  const na = data.noAnswerAction || 'continue';

  if (na === 'transfer' && data.noAnswerTarget) {
    return {
      mode: 'action',
      action: {
        kind: 'transfer',
        targetType: 'queue',
        targetValue: String(data.noAnswerTarget),
        node: node.id,
      },
      variables: nextVars,
    };
  }

  if (na === 'voicemail') {
    return {
      mode: 'action',
      action: { kind: 'voicemail', maxDurationSec: 120, node: node.id },
      variables: nextVars,
    };
  }

  const edge = requireEdge(graph, node.id, IVR_BRANCH.NOT_FOUND);
  return {
    mode: 'branch',
    nextNodeId: edge.ok ? edge.target : null,
    variables: nextVars,
    branch: IVR_BRANCH.NOT_FOUND,
  };
}

export function routeKnowledgeQaFound(
  graph: IvrRuntimeContext['graph'],
  node: IvrNodeBase,
  variables: Record<string, string>,
  answer: string
): KnowledgeQaStepResult {
  const data = node.data as KnowledgeQaNodeDataLike;
  const edge = requireEdge(graph, node.id, IVR_BRANCH.FOUND);
  const nextNodeId = edge.ok ? edge.target : null;
  const playMode = data.answerPlayMode ?? 'none';

  if (playMode !== 'none' && answer && nextNodeId) {
    const text = playMode === 'summary' ? answer.slice(0, 200) : answer;
    return {
      mode: 'branch',
      nextNodeId: node.id,
      pendingAdvanceNodeId: nextNodeId,
      variables,
      branch: IVR_BRANCH.FOUND,
      action: { kind: 'play', text, node: node.id },
    };
  }

  return {
    mode: 'branch',
    nextNodeId,
    variables,
    branch: IVR_BRANCH.FOUND,
  };
}

export async function advanceKnowledgeQaStep(
  graph: IvrRuntimeContext['graph'],
  node: IvrNodeBase,
  variables: Record<string, string>,
  execute?: (
    nodeData: Record<string, unknown>,
    vars: Record<string, string>
  ) => Promise<KnowledgeQaExecResult>
): Promise<KnowledgeQaStepResult> {
  const data = node.data as KnowledgeQaNodeDataLike;
  const questionVar = data.questionVariable || 'caller_question';
  const question = variables[questionVar] || '';

  let result: KnowledgeQaExecResult;
  if (execute) {
    result = await execute(node.data, variables);
  } else if (!question.trim()) {
    result = { found: false, reason: 'empty_question' };
  } else if (variables.kb_result === 'found') {
    result = {
      found: true,
      answer: variables[data.answerVariable || 'kb_answer'] || '',
      source: variables.kb_source || 'cache',
      confidence: variables.kb_confidence ? parseFloat(variables.kb_confidence) : 1,
    };
  } else {
    result = { found: false, reason: 'no_side_effect' };
  }

  const vars = applyKnowledgeQaVariables(node, variables, result);

  if (!isKnowledgeQaHit(node, result)) {
    return routeKnowledgeQaMiss(graph, node, vars);
  }

  return routeKnowledgeQaFound(graph, node, vars, result.answer || '');
}
