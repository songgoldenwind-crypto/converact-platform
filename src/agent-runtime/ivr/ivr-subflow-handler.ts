/**
 * Subflow enter / return — Task P8 (SF-A).
 */

import { IVR_BRANCH } from './ivr-branch-handles.js';
import { applyBranchRoute } from './ivr-branch-vars.js';
import { getNodeExits, requireEdge, type IvrFlowGraph, type IvrNodeBase } from './ivr-types.js';
import type { IvrFlowFrame, IvrRuntimeContext } from './ivr-executor.js';
import type { IvrSideEffects } from './ivr-side-effects.js';

export const MAX_SUBFLOW_DEPTH = 5;

function substituteVars(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? '');
}

export function buildSubflowFrame(
  parentGraph: IvrFlowGraph,
  subflowNodeId: string
): IvrFlowFrame {
  const exits = getNodeExits(parentGraph, subflowNodeId);
  return {
    graph: parentGraph,
    subflowNodeId,
    returnNodeId: exits.get(IVR_BRANCH.OUT) ?? null,
    errorReturnNodeId: exits.get(IVR_BRANCH.ERROR) ?? null,
  };
}

export type SubflowEnterResult =
  | {
      mode: 'entered';
      context: IvrRuntimeContext;
      nextNodeId: string;
      action: { kind: 'subflow'; flowId: string; node: string };
    }
  | {
      mode: 'error';
      nextNodeId: string | null;
      variables: Record<string, string>;
      reason: string;
    };

export async function tryEnterSubflow(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrRuntimeContext,
  variables: Record<string, string>,
  opts: {
    tenantId?: string;
    executeSubflow?: IvrSideEffects['executeSubflow'];
  }
): Promise<SubflowEnterResult> {
  const depth = context.subflowDepth ?? 0;
  if (depth >= MAX_SUBFLOW_DEPTH) {
    variables.subflow_error = 'max_depth_exceeded';
    const edge = requireEdge(graph, node.id, IVR_BRANCH.ERROR);
    const target = edge.ok ? edge.target : null;
    return {
      mode: 'error',
      nextNodeId: target,
      variables: applyBranchRoute(variables, node.id, IVR_BRANCH.ERROR, target),
      reason: 'max_depth_exceeded',
    };
  }

  for (const p of (node.data.params as Array<{ key: string; source: string }>) || []) {
    variables[p.key] = substituteVars(p.source, variables);
  }

  const flowId = (node.data.flowId as string) || '';
  if (!opts.executeSubflow || !opts.tenantId || !flowId) {
    variables.subflow_error = 'subflow_load_failed';
    const edge = requireEdge(graph, node.id, IVR_BRANCH.ERROR);
    const target = edge.ok ? edge.target : null;
    return {
      mode: 'error',
      nextNodeId: target,
      variables: applyBranchRoute(variables, node.id, IVR_BRANCH.ERROR, target),
      reason: 'subflow_load_failed',
    };
  }

  const loaded = await opts.executeSubflow(flowId, opts.tenantId);
  if (!loaded.success || !loaded.graph) {
    variables.subflow_error = loaded.error ?? 'subflow_not_found';
    variables.last_error = variables.subflow_error;
    const edge = requireEdge(graph, node.id, IVR_BRANCH.ERROR);
    const target = edge.ok ? edge.target : null;
    return {
      mode: 'error',
      nextNodeId: target,
      variables: applyBranchRoute(variables, node.id, IVR_BRANCH.ERROR, target),
      reason: variables.subflow_error,
    };
  }

  const frame = buildSubflowFrame(graph, node.id);
  const newContext: IvrRuntimeContext = {
    graph: loaded.graph,
    currentNodeId: loaded.graph.entryNodeId,
    variables,
    flowStack: [...context.flowStack, frame],
    subflowDepth: depth + 1,
    retryCounters: context.retryCounters,
    lastPromptNodeId: context.lastPromptNodeId,
  };

  return {
    mode: 'entered',
    context: newContext,
    nextNodeId: loaded.graph.entryNodeId,
    action: { kind: 'subflow', flowId, node: node.id },
  };
}

export function popSubflowReturn(
  context: IvrRuntimeContext,
  variables: Record<string, string>,
  returnCode: 'ok' | 'error' = 'ok'
): {
  context: IvrRuntimeContext;
  nextNodeId: string | null;
} | null {
  if (context.flowStack.length === 0) return null;

  const frame = context.flowStack[context.flowStack.length - 1];
  const target =
    returnCode === 'error' ? frame.errorReturnNodeId : frame.returnNodeId;
  const newStack = context.flowStack.slice(0, -1);
  const depth = Math.max(0, (context.subflowDepth ?? 1) - 1);

  return {
    context: {
      graph: frame.graph,
      currentNodeId: target,
      variables,
      flowStack: newStack,
      subflowDepth: depth,
      retryCounters: context.retryCounters,
      lastPromptNodeId: context.lastPromptNodeId,
      interaction: undefined,
      waiting: undefined,
      pendingAdvanceNodeId: undefined,
      pendingDisconnectFlush: undefined,
      disconnectFarewellEnqueued: undefined,
      pendingDigits: undefined,
    },
    nextNodeId: target,
  };
}
