/**
 * 原则一 1-E — play 节点解析失败时走 error 出边。
 */
import { IVR_BRANCH } from './ivr-branch-handles.js';
import { applyBranchRoute } from './ivr-branch-vars.js';
import type { IvrFlowGraph, IvrNodeBase } from './ivr-types.js';
import { requireEdge } from './ivr-types.js';
import type { IvrAction, IvrRuntimeContext } from './ivr-executor.js';

export function tryRoutePlayResolveFailure(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  action: IvrAction,
  context: IvrRuntimeContext,
  variables: Record<string, string>
): {
  action: IvrAction;
  context: IvrRuntimeContext;
  nextNodeId: string | null;
  terminated: boolean;
} | null {
  if (action.kind !== 'play' || !action.resolveError) return null;

  const edge = requireEdge(graph, node.id, IVR_BRANCH.ERROR);
  if (edge.ok) {
    const routed = {
      ...applyBranchRoute(variables, node.id, IVR_BRANCH.ERROR, edge.target),
      last_error: action.resolveError,
      play_resolve_error: action.resolveError,
    };
    return {
      action: { kind: 'log', message: `play resolve error: ${action.resolveError}`, node: node.id },
      context: {
        ...context,
        variables: routed,
        currentNodeId: edge.target,
        pendingAdvanceNodeId: null,
        lastPromptNodeId: node.id,
      },
      nextNodeId: edge.target,
      terminated: false,
    };
  }

  const onError = (node.data.onError as string) ?? 'continue';
  if (onError === 'branch') {
    Object.assign(variables, applyBranchRoute(variables, node.id, IVR_BRANCH.ERROR, null));
    variables.last_error = action.resolveError;
  }
  return null;
}
