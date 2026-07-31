/**
 * flush_audio — explicit Genesys-style queue flush (ADR-4 F2).
 */
import { IVR_BRANCH } from './ivr-branch-handles.js';
import { requireEdge, type IvrFlowGraph, type IvrNodeBase } from './ivr-types.js';
import type { IvrAction, IvrRuntimeContext, IvrStepInput } from './ivr-executor.js';
import {
  clearAudioQueue,
  consumeQueueForFlush,
  isAudioFlushSyncPoint,
  segmentsToPromptQueue,
} from './ivr-audio-queue.js';

export interface FlushAudioStepResult {
  action: IvrAction;
  context: IvrRuntimeContext;
  nextNodeId: string | null;
  terminated: boolean;
  /** Caller should advanceSingleStep into sync-point successor in same turn. */
  walkToSyncPoint?: boolean;
}

function completeFlush(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrRuntimeContext,
  variables: Record<string, string>,
  bargeInDigits?: string
): FlushAudioStepResult {
  const edge = requireEdge(graph, node.id, IVR_BRANCH.OUT);
  const nextId = edge.ok ? edge.target : null;
  const nextCtx: IvrRuntimeContext = {
    ...context,
    variables,
    audioQueue: clearAudioQueue(),
    pendingFlushAudio: undefined,
    pendingDigits: bargeInDigits ?? context.pendingDigits,
    currentNodeId: nextId,
  };
  const nextNode = nextId ? graph.nodes.find((n) => n.id === nextId) : null;
  return {
    action: { kind: 'log', message: 'flush completed', node: node.id },
    context: nextCtx,
    nextNodeId: nextId,
    terminated: !nextId,
    walkToSyncPoint: !!(nextNode && isAudioFlushSyncPoint(nextNode.type)),
  };
}

export function handleFlushAudioStep(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrRuntimeContext,
  variables: Record<string, string>,
  input: IvrStepInput
): FlushAudioStepResult {
  if (input.bargeInDigits && context.pendingFlushAudio === node.id) {
    return completeFlush(graph, node, context, variables, input.bargeInDigits);
  }

  if (input.flushCompleted && context.pendingFlushAudio === node.id) {
    return completeFlush(graph, node, context, variables);
  }

  const queue = consumeQueueForFlush(context.audioQueue);
  if (queue.length === 0) {
    return completeFlush(graph, node, context, variables);
  }

  if (context.pendingFlushAudio === node.id) {
    if (!input.flushCompleted && !input.bargeInDigits) {
      return {
        action: { kind: 'log', message: 'flush_audio pending', node: node.id },
        context: { ...context, variables, currentNodeId: node.id },
        nextNodeId: node.id,
        terminated: false,
      };
    }
  }

  const promptQueue = segmentsToPromptQueue(queue);
  return {
    action: { kind: 'flush_play_queue', promptQueue, node: node.id },
    context: {
      ...context,
      variables,
      pendingFlushAudio: node.id,
      currentNodeId: node.id,
    },
    nextNodeId: node.id,
    terminated: false,
  };
}
