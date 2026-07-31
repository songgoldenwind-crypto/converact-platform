/**
 * Collect digits + verify — 原则四 (4-H2).
 */

import type { IvrFlowGraph, IvrNodeBase } from './ivr-types.js';
import { requireEdge } from './ivr-types.js';
import { IVR_BRANCH } from './ivr-branch-handles.js';
import type { IvrAction, IvrRuntimeContext } from './ivr-executor.js';

function edgeTarget(graph: IvrFlowGraph, nodeId: string, handle: string): string | null {
  const r = requireEdge(graph, nodeId, handle);
  return r.ok ? r.target : null;
}

export interface CollectVerifyState {
  nodeId: string;
  storeVariable: string;
  stagingValue: string;
  phase: 'collecting' | 'verifying';
  verifyMode: 'digits' | 'numeric';
  maskInLogs?: boolean;
}

export interface CollectNodeDataLike {
  minDigits?: number;
  maxDigits?: number;
  endMode?: 'max_digits' | 'hash_key';
  storeVariable?: string;
  verifyMode?: 'none' | 'digits' | 'numeric';
  verifyPromptTemplate?: string;
  validationRegex?: string;
  maskInLogs?: boolean;
  maxVerifyRetries?: number;
  maxRetries?: number;
}

export type CollectInputResult =
  | { type: 'need_gather' }
  | { type: 'emit_verify'; action: IvrAction; context: IvrRuntimeContext }
  | { type: 'emit_collect'; action: IvrAction; context: IvrRuntimeContext }
  | { type: 'advance'; nextNodeId: string | null; branch: string; context: IvrRuntimeContext };

const DEFAULT_VERIFY_TEMPLATE = '您输入的是 {{value}}。确认请按 1，重新输入请按 2。';

export function stripCollectDigits(raw: string, endMode: 'max_digits' | 'hash_key'): string {
  if (endMode === 'max_digits') return raw;
  return raw.replace(/#+$/, '');
}

export function validateCollectedDigits(
  digits: string,
  data: CollectNodeDataLike
): 'ok' | 'too_short' | 'too_long' | 'regex_fail' {
  const min = data.minDigits ?? 1;
  const max = data.maxDigits ?? 6;
  if (digits.length < min) return 'too_short';
  if (digits.length > max) return 'too_long';
  if (data.validationRegex) {
    try {
      if (!new RegExp(data.validationRegex).test(digits)) return 'regex_fail';
    } catch {
      return 'regex_fail';
    }
  }
  return 'ok';
}

export function formatVerifyPrompt(
  value: string,
  mode: 'digits' | 'numeric',
  template: string = DEFAULT_VERIFY_TEMPLATE
): string {
  const spoken = mode === 'digits' ? value.split('').join(' ') : value;
  return template.replace(/\{\{value\}\}/g, spoken);
}

function buildCollectAction(
  node: IvrNodeBase,
  data: CollectNodeDataLike,
  _variables: Record<string, string>
): IvrAction {
  const promptArr = (node.data.prompt as Array<{ text?: string }>) ?? [];
  const prompt = promptArr[0]?.text ?? '请输入';
  return {
    kind: 'collect_digits',
    prompt,
    minDigits: data.minDigits ?? 1,
    maxDigits: data.maxDigits ?? 6,
    storeVar: data.storeVariable ?? 'collected',
    endMode: data.endMode ?? 'hash_key',
    inputWaitSec: (node.data.inputWaitSec as number) ?? 5,
    timeoutSec: (node.data.timeoutSec as number) ?? 10,
    maxRetries: data.maxRetries ?? 1,
    node: node.id,
  };
}

export function handleCollectStep(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrRuntimeContext,
  input: { dtmf?: string; timedOut?: boolean }
): CollectInputResult {
  const data = node.data as CollectNodeDataLike;
  const storeVar = data.storeVariable ?? 'collected';
  const verify = context.collectVerify;
  const counters = { ...(context.retryCounters ?? {}) };

  if (verify?.phase === 'verifying' && verify.nodeId === node.id) {
    if (input.timedOut) {
      const edge = requireEdge(graph, node.id, IVR_BRANCH.TIMEOUT);
      return {
        type: 'advance',
        nextNodeId: edge.ok ? edge.target : null,
        branch: IVR_BRANCH.TIMEOUT,
        context: { ...context, collectVerify: undefined, retryCounters: counters },
      };
    }
    const d = input.dtmf;
    if (d === '1') {
      const variables = { ...context.variables, [verify.storeVariable]: verify.stagingValue };
      const next = edgeTarget(graph, node.id, IVR_BRANCH.OUT);
      return {
        type: 'advance',
        nextNodeId: next,
        branch: IVR_BRANCH.OUT,
        context: { ...context, variables, collectVerify: undefined, retryCounters: counters },
      };
    }
    if (d === '2') {
      const prev = counters[node.id]?.verify ?? 0;
      const maxV = data.maxVerifyRetries ?? 3;
      if (prev >= maxV) {
        const next =
          edgeTarget(graph, node.id, IVR_BRANCH.MAX_RETRIES) ??
          edgeTarget(graph, node.id, IVR_BRANCH.TIMEOUT);
        return {
          type: 'advance',
          nextNodeId: next,
          branch: IVR_BRANCH.MAX_RETRIES,
          context: { ...context, collectVerify: undefined, retryCounters: counters },
        };
      }
      counters[node.id] = { ...counters[node.id], verify: prev + 1 };
      return {
        type: 'emit_collect',
        action: buildCollectAction(node, data, context.variables),
        context: { ...context, collectVerify: undefined, retryCounters: counters },
      };
    }
    const next = edgeTarget(graph, node.id, IVR_BRANCH.INVALID);
    return {
      type: 'advance',
      nextNodeId: next,
      branch: IVR_BRANCH.INVALID,
      context: { ...context, retryCounters: counters },
    };
  }

  if (input.timedOut || !input.dtmf) {
    const next = edgeTarget(graph, node.id, IVR_BRANCH.TIMEOUT);
    return {
      type: 'advance',
      nextNodeId: next,
      branch: IVR_BRANCH.TIMEOUT,
      context: { ...context, retryCounters: counters },
    };
  }

  const endMode = data.endMode ?? 'hash_key';
  const digits = stripCollectDigits(input.dtmf, endMode);
  const validation = validateCollectedDigits(digits, data);

  if (validation !== 'ok') {
    const prev = counters[node.id]?.invalid ?? 0;
    const maxInv = data.maxRetries ?? 3;
    counters[node.id] = { ...counters[node.id], invalid: prev + 1 };
    if (prev + 1 >= maxInv) {
      const next =
        edgeTarget(graph, node.id, IVR_BRANCH.MAX_RETRIES) ??
        edgeTarget(graph, node.id, IVR_BRANCH.TIMEOUT);
      return {
        type: 'advance',
        nextNodeId: next,
        branch: IVR_BRANCH.MAX_RETRIES,
        context: { ...context, retryCounters: counters },
      };
    }
    const next = edgeTarget(graph, node.id, IVR_BRANCH.INVALID);
    return {
      type: 'advance',
      nextNodeId: next,
      branch: IVR_BRANCH.INVALID,
      context: { ...context, retryCounters: counters },
    };
  }

  const verifyMode = data.verifyMode ?? 'none';
  if (verifyMode === 'none') {
    const variables = { ...context.variables, [storeVar]: digits };
    const next = edgeTarget(graph, node.id, IVR_BRANCH.OUT);
    return {
      type: 'advance',
      nextNodeId: next,
      branch: IVR_BRANCH.OUT,
      context: { ...context, variables, retryCounters: counters },
    };
  }

  const prompt = formatVerifyPrompt(
    digits,
    verifyMode === 'digits' ? 'digits' : 'numeric',
    data.verifyPromptTemplate
  );
  const collectVerify: CollectVerifyState = {
    nodeId: node.id,
    storeVariable: storeVar,
    stagingValue: digits,
    phase: 'verifying',
    verifyMode: verifyMode === 'digits' ? 'digits' : 'numeric',
    maskInLogs: data.maskInLogs,
  };
  return {
    type: 'emit_verify',
    action: { kind: 'collect_verify', prompt, node: node.id },
    context: { ...context, collectVerify, retryCounters: counters },
  };
}

export function redactVariablesForLog(
  variables: Record<string, string>,
  collectVerify?: CollectVerifyState
): Record<string, string> {
  if (!collectVerify?.maskInLogs) return variables;
  const out = { ...variables };
  if (collectVerify.storeVariable in out) out[collectVerify.storeVariable] = '****';
  if (collectVerify.stagingValue) out._staging = '****';
  return out;
}
