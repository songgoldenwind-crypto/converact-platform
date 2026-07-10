/**
 * Start node — pushParams channel / custom / literal mapping (SU-1).
 */
import { IVR_BRANCH } from './ivr-branch-handles.js';
import { applyBranchRoute } from './ivr-branch-vars.js';
import type { IvrFlowGraph, IvrNodeBase } from './ivr-types.js';
import { requireEdge } from './ivr-types.js';
import type { IvrAction, IvrRuntimeContext } from './ivr-executor.js';

export interface PushParamLike {
  key: string;
  source: string;
}

function substituteVars(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
    const trimmed = key.trim();
    return variables[trimmed] ?? `{{${trimmed}}}`;
  });
}

/** channel.caller_area_code | custom.X-Campaign | literal:foo | {{var}} */
export function resolveParamSource(
  source: string,
  channelVars: Record<string, string>,
  variables: Record<string, string>
): string {
  if (source.startsWith('literal:')) {
    return source.slice('literal:'.length);
  }
  if (source.startsWith('channel.')) {
    const key = source.slice('channel.'.length);
    return channelVars[key] ?? '';
  }
  if (source.startsWith('custom.')) {
    const key = source.slice('custom.'.length);
    return channelVars[`custom.${key}`] ?? channelVars[key] ?? '';
  }
  return substituteVars(source, variables);
}

export function applyStartPushParams(
  node: IvrNodeBase,
  variables: Record<string, string>,
  channelVariables: Record<string, string> = {}
): Record<string, string> {
  const next = { ...variables };
  const params = (node.data.pushParams as PushParamLike[]) ?? [];
  for (const p of params) {
    if (!p.key) continue;
    next[p.key] = resolveParamSource(p.source, channelVariables, next);
  }
  return next;
}

export function advanceStartStep(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrRuntimeContext,
  action: IvrAction,
  variables: Record<string, string>,
  channelVariables: Record<string, string> = {}
): {
  action: IvrAction;
  context: IvrRuntimeContext;
  nextNodeId: string | null;
  terminated: boolean;
} {
  const merged = applyStartPushParams(node, variables, channelVariables);
  const edge = requireEdge(graph, node.id, IVR_BRANCH.OUT);
  const nextNodeId = edge.ok ? edge.target : null;
  const routed = applyBranchRoute(merged, node.id, IVR_BRANCH.OUT, nextNodeId);
  return {
    action,
    context: {
      ...context,
      variables: routed,
      currentNodeId: nextNodeId,
    },
    nextNodeId,
    terminated: false,
  };
}
