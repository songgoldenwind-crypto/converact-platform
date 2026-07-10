/**
 * Menu / visual_menu 统一路由：无效键、max_retries、routeType 直达队列/坐席/分机/群呼。
 */
import type { IvrFlowGraph, IvrNodeBase } from './ivr-types.js';
import { requireEdge } from './ivr-types.js';
import { IVR_BRANCH } from './ivr-branch-handles.js';
import type { IvrAction, IvrRuntimeContext } from './ivr-executor.js';
import { matchSpeechToDigit } from './ivr-speech-match.js';

/** 严格取边；无 fallback */
function edgeTarget(graph: IvrFlowGraph, nodeId: string, handle: string): string | null {
  const r = requireEdge(graph, nodeId, handle);
  return r.ok ? r.target : null;
}

export interface MenuOptionLike {
  digit: string;
  label: string;
  routeType?: 'agent' | 'queue' | 'extension' | 'group_call' | 'node' | string;
  routeTarget?: string;
}

export interface MenuNodeDataLike {
  options?: MenuOptionLike[];
  items?: Array<{ digit: string; label: string }>;
  maxRetries?: number;
  maxInvalidRetries?: number;
  timeoutSec?: number;
  speechEnabled?: boolean;
  speechAliases?: Array<{ digit: string; phrases: string[] }>;
}

export type MenuInputResolution =
  | { kind: 'digit'; digit: string }
  | { kind: 'invalid' }
  | { kind: 'timeout' }
  | { kind: 'none' };

export type MenuRouteResolution =
  | { mode: 'graph'; nextNodeId: string; digit: string }
  | { mode: 'action'; action: IvrAction; digit: string }
  | { mode: 'invalid'; digit?: string }
  | { mode: 'max_retries' }
  | { mode: 'timeout' };

export function resolveMenuInput(
  node: IvrNodeBase,
  input: { dtmf?: string; visualSelection?: string; speechResult?: string; timedOut?: boolean }
): MenuInputResolution {
  if (input.timedOut) return { kind: 'timeout' };
  const digit = input.dtmf ?? input.visualSelection;
  if (digit) return { kind: 'digit', digit };
  const data = node.data as MenuNodeDataLike;
  if (input.speechResult && data.speechEnabled) {
    const digit = matchSpeechToDigit(input.speechResult, data.speechAliases ?? []);
    return digit ? { kind: 'digit', digit } : { kind: 'invalid' };
  }
  if (!input.dtmf && !input.speechResult) return { kind: 'none' };
  if (!input.dtmf && input.speechResult && !data.speechEnabled) return { kind: 'none' };
  return { kind: 'timeout' };
}

export function getMenuOptions(node: IvrNodeBase): MenuOptionLike[] {
  const data = node.data as MenuNodeDataLike;
  if (data.options?.length) return data.options;
  return (data.items ?? []).map((i) => ({
    digit: i.digit,
    label: i.label,
    routeType: 'node' as const,
    routeTarget: '',
  }));
}

export function findMenuOption(node: IvrNodeBase, digit: string): MenuOptionLike | undefined {
  return getMenuOptions(node).find((o) => o.digit === digit);
}

/**
 * routeType 优先级高于 digit_N 图边（不一致-1 核心修复）。
 */
export function buildImmediateMenuAction(
  node: IvrNodeBase,
  opt: MenuOptionLike,
  memberSeatIds?: string[]
): IvrAction | null {
  const target = opt.routeTarget ?? '';
  switch (opt.routeType) {
    case 'queue':
      return {
        kind: 'queue',
        queueName: target,
        strategy: 'fifo',
        timeoutSec: 300,
        node: node.id,
      };
    case 'agent':
      return {
        kind: 'transfer',
        targetType: 'agent_ring_all',
        targetValue: target,
        node: node.id,
      };
    case 'extension':
      return {
        kind: 'transfer',
        targetType: 'extension',
        targetValue: target,
        node: node.id,
      };
    case 'group_call':
      return {
        kind: 'transfer',
        targetType: 'group_call',
        targetValue: target,
        memberSeatIds,
        node: node.id,
      };
    case 'node':
    default:
      return null;
  }
}

export function handleInvalidDigit(
  graph: IvrFlowGraph,
  nodeId: string,
  context: IvrRuntimeContext,
  data: MenuNodeDataLike
): { mode: MenuRouteResolution['mode']; retryCounters: NonNullable<IvrRuntimeContext['retryCounters']> } {
  const counters = { ...(context.retryCounters ?? {}) };
  const prev = counters[nodeId]?.invalid ?? 0;
  const maxInv = data.maxInvalidRetries ?? data.maxRetries ?? 3;
  counters[nodeId] = { ...counters[nodeId], invalid: prev + 1 };

  if (prev + 1 >= maxInv) {
    const maxEdge = edgeTarget(graph, nodeId, IVR_BRANCH.MAX_RETRIES);
    if (maxEdge) {
      return { mode: 'max_retries', retryCounters: counters };
    }
    return { mode: 'timeout', retryCounters: counters };
  }

  return { mode: 'invalid', retryCounters: counters };
}

export function resolveMenuRoute(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  digit: string,
  groupCallResolver?: (groupId: string) => string[]
): MenuRouteResolution {
  const opt = findMenuOption(node, digit);
  if (!opt) {
    return { mode: 'invalid', digit };
  }

  const routeType = opt.routeType ?? 'node';
  if (routeType !== 'node') {
    if (!opt.routeTarget?.trim()) {
      return { mode: 'invalid', digit };
    }
    const memberSeatIds =
      routeType === 'group_call' && opt.routeTarget
        ? groupCallResolver?.(opt.routeTarget)
        : undefined;
    const action = buildImmediateMenuAction(node, opt, memberSeatIds);
    if (action) {
      return { mode: 'action', action, digit };
    }
  }

  const edge = edgeTarget(graph, node.id, IVR_BRANCH.digit(digit));
  if (!edge) {
    return { mode: 'invalid', digit };
  }
  return { mode: 'graph', nextNodeId: edge, digit };
}

export interface MenuStepResult {
  action?: IvrAction;
  nextNodeId: string | null;
  variables: Record<string, string>;
  retryCounters: NonNullable<IvrRuntimeContext['retryCounters']>;
  branch?: string;
}

function routeInvalid(
  graph: IvrFlowGraph,
  nodeId: string,
  context: IvrRuntimeContext,
  data: MenuNodeDataLike,
  variables: Record<string, string>,
  retryCounters: NonNullable<IvrRuntimeContext['retryCounters']>
): MenuStepResult {
  const inv = handleInvalidDigit(graph, nodeId, { ...context, retryCounters }, data);
  if (inv.mode === 'max_retries') {
    const next =
      edgeTarget(graph, nodeId, IVR_BRANCH.MAX_RETRIES) ??
      edgeTarget(graph, nodeId, IVR_BRANCH.TIMEOUT);
    return {
      nextNodeId: next ?? null,
      variables,
      retryCounters: inv.retryCounters,
      branch: IVR_BRANCH.MAX_RETRIES,
    };
  }
  if (inv.mode === 'timeout') {
    const next = edgeTarget(graph, nodeId, IVR_BRANCH.TIMEOUT);
    return {
      nextNodeId: next ?? null,
      variables,
      retryCounters: inv.retryCounters,
      branch: IVR_BRANCH.TIMEOUT,
    };
  }
  const next = edgeTarget(graph, nodeId, IVR_BRANCH.INVALID);
  return {
    nextNodeId: next ?? null,
    variables,
    retryCounters: inv.retryCounters,
    branch: IVR_BRANCH.INVALID,
  };
}

/**
 * executor 唯一入口：处理 menu / visual_menu 的 advance（Consuming 阶段）。
 */
export function handleMenuStep(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrRuntimeContext,
  input: {
    dtmf?: string;
    visualSelection?: string;
    speechResult?: string;
    timedOut?: boolean;
    groupCallResolver?: (groupId: string) => string[];
  }
): MenuStepResult {
  const data = node.data as MenuNodeDataLike;
  const variables = { ...context.variables };
  let retryCounters = { ...(context.retryCounters ?? {}) };

  const resolved = resolveMenuInput(node, input);

  if (resolved.kind === 'none') {
    return { nextNodeId: node.id, variables, retryCounters };
  }

  if (resolved.kind === 'timeout') {
    const next = edgeTarget(graph, node.id, IVR_BRANCH.TIMEOUT);
    return {
      nextNodeId: next ?? null,
      variables,
      retryCounters,
      branch: IVR_BRANCH.TIMEOUT,
    };
  }

  if (resolved.kind === 'invalid') {
    return routeInvalid(graph, node.id, context, data, variables, retryCounters);
  }

  const route = resolveMenuRoute(graph, node, resolved.digit, input.groupCallResolver);
  variables.last_digit = resolved.digit;

  if (route.mode === 'invalid') {
    return routeInvalid(graph, node.id, context, data, variables, retryCounters);
  }

  if (route.mode === 'action') {
    return {
      action: route.action,
      nextNodeId: null,
      variables,
      retryCounters,
      branch: `routeType:${findMenuOption(node, route.digit)?.routeType}`,
    };
  }

  if (route.mode === 'graph') {
    return {
      nextNodeId: route.nextNodeId,
      variables,
      retryCounters,
      branch: IVR_BRANCH.digit(route.digit),
    };
  }

  return routeInvalid(graph, node.id, context, data, variables, retryCounters);
}
