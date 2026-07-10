/**
 * Queue node / immediate queue action — two-step waiting + ACD enqueue (原则七 7-A).
 */
import { IVR_BRANCH } from './ivr-branch-handles.js';
import type { AcdEnqueueFn, AcdEnqueueResult } from './ivr-acd-adapter.js';
import type { IvrFlowGraph } from './ivr-types.js';
import { requireEdge } from './ivr-types.js';
import type { IvrAction, IvrRuntimeContext, IvrStepInput } from './ivr-executor.js';
import { applyBranchRoute } from './ivr-branch-vars.js';

export interface QueueStepOutcome {
  action: IvrAction;
  context: IvrRuntimeContext;
  nextNodeId: string | null;
  terminated: boolean;
}

function routeQueueBranch(
  graph: IvrFlowGraph,
  nodeId: string,
  handle: string,
  variables: Record<string, string>,
  context: IvrRuntimeContext
): QueueStepOutcome | null {
  const edge = requireEdge(graph, nodeId, handle);
  return {
    action: { kind: 'log', message: `queue branch ${handle}`, node: nodeId },
    context: {
      ...context,
      variables: applyBranchRoute(variables, nodeId, handle, edge.ok ? edge.target : null),
      waiting: undefined,
      currentNodeId: edge.ok ? edge.target : null,
    },
    nextNodeId: edge.ok ? edge.target : null,
    terminated: false,
  };
}

function applyEnqueueResult(
  graph: IvrFlowGraph,
  nodeId: string,
  action: IvrAction & { kind: 'queue' },
  context: IvrRuntimeContext,
  variables: Record<string, string>,
  result: AcdEnqueueResult
): QueueStepOutcome {
  if (result.status === 'at_capacity') {
    variables.queue_result = 'at_capacity';
    return routeQueueBranch(graph, nodeId, IVR_BRANCH.AT_CAPACITY, variables, context)!;
  }

  if (result.status === 'error') {
    variables.queue_result = 'error';
    variables.last_error = result.reason;
    return routeQueueBranch(graph, nodeId, IVR_BRANCH.ERROR, variables, context)!;
  }

  if (result.status === 'connected') {
    variables.agent_id = result.agentId;
    variables.queue_result = 'connected';
    if (result.queueEntryId) variables.queue_entry_id = result.queueEntryId;
    return routeQueueBranch(graph, nodeId, IVR_BRANCH.OUT, variables, context)!;
  }

  variables.queue_entry_id = result.queueEntryId;
  variables.queue_result = 'pending';
  return {
    action,
    context: {
      ...context,
      variables,
      waiting: {
        kind: 'queue',
        nodeId,
        since: new Date().toISOString(),
        queueEntryId: result.queueEntryId,
        queueName: action.queueName,
      },
      currentNodeId: nodeId,
    },
    nextNodeId: nodeId,
    terminated: false,
  };
}

async function resolveEnqueue(
  action: IvrAction & { kind: 'queue' },
  input: IvrStepInput
): Promise<AcdEnqueueResult> {
  if (input.acdEnqueue) {
    return input.acdEnqueue({
      callSessionId: input.callSessionId || '',
      queueName: action.queueName,
      strategy: action.strategy,
    });
  }
  return { status: 'pending', queueEntryId: 'sim-entry' };
}

/**
 * First advance: enqueue + enter waiting (or branch on at_capacity/error/immediate connect).
 * Second advance with queueEvent: handled by handleWaitingResume in ivr-step-lifecycle.
 */
export async function advanceQueueStep(
  graph: IvrFlowGraph,
  nodeId: string,
  action: IvrAction,
  context: IvrRuntimeContext,
  variables: Record<string, string>,
  input: IvrStepInput
): Promise<QueueStepOutcome | null> {
  if (action.kind !== 'queue') return null;

  if (context.waiting?.kind === 'queue' && context.waiting.nodeId === nodeId) {
    if (input.queueEvent) return null;
    return {
      action,
      context: { ...context, variables, currentNodeId: nodeId },
      nextNodeId: nodeId,
      terminated: false,
    };
  }

  const result = await resolveEnqueue(action, input);
  return applyEnqueueResult(graph, nodeId, action, context, variables, result);
}

export type { AcdEnqueueFn };
