/**
 * HTTP / webhook 三分支路由 — 原则一 (1-B).
 */

import { IVR_BRANCH } from './ivr-branch-handles.js';
import { requireEdge, type IvrFlowGraph } from './ivr-types.js';
import type { HttpExecResult, WebhookExecResult } from './ivr-side-effects.js';

export interface IoBranchRoute {
  target: string | null;
  branch: string;
}

function pickTarget(graph: IvrFlowGraph, nodeId: string, handle: string): string | null {
  const edge = requireEdge(graph, nodeId, handle);
  return edge.ok ? edge.target : null;
}

export function routeHttpBranch(
  graph: IvrFlowGraph,
  nodeId: string,
  result: HttpExecResult,
  variables: Record<string, string>
): IoBranchRoute {
  variables.http_status = String(result.statusCode);
  if (result.success) {
    return { target: pickTarget(graph, nodeId, IVR_BRANCH.SUCCESS), branch: IVR_BRANCH.SUCCESS };
  }
  if (result.error === 'timeout') {
    const timeoutTarget = pickTarget(graph, nodeId, IVR_BRANCH.TIMEOUT);
    if (timeoutTarget) {
      return { target: timeoutTarget, branch: IVR_BRANCH.TIMEOUT };
    }
    return { target: pickTarget(graph, nodeId, IVR_BRANCH.FAIL), branch: IVR_BRANCH.FAIL };
  }
  variables.last_error = result.error ?? 'http_failed';
  return { target: pickTarget(graph, nodeId, IVR_BRANCH.FAIL), branch: IVR_BRANCH.FAIL };
}

export function routeWebhookBranch(
  graph: IvrFlowGraph,
  nodeId: string,
  result: WebhookExecResult,
  variables: Record<string, string>
): IoBranchRoute {
  variables.webhook_status = String(result.statusCode);
  if (result.success) {
    return { target: pickTarget(graph, nodeId, IVR_BRANCH.SUCCESS), branch: IVR_BRANCH.SUCCESS };
  }
  if (result.error === 'timeout') {
    const timeoutTarget = pickTarget(graph, nodeId, IVR_BRANCH.TIMEOUT);
    if (timeoutTarget) {
      return { target: timeoutTarget, branch: IVR_BRANCH.TIMEOUT };
    }
    return { target: pickTarget(graph, nodeId, IVR_BRANCH.FAIL), branch: IVR_BRANCH.FAIL };
  }
  variables.last_error = result.error ?? 'webhook_failed';
  return { target: pickTarget(graph, nodeId, IVR_BRANCH.FAIL), branch: IVR_BRANCH.FAIL };
}
