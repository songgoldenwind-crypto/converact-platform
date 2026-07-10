/**
 * Disconnect node — Genesys queue flush + hangup (ADR-4 Task 9).
 */
import { applyBranchRoute } from './ivr-branch-vars.js';
import { IVR_BRANCH } from './ivr-branch-handles.js';
import type { IvrFlowGraph } from './ivr-types.js';
import type { IvrNodeBase } from './ivr-types.js';
import {
  resolvePlayContentsResult,
  type PlayContentLike,
  type ResolvedPrompt,
} from './ivr-play-resolver.js';
import type { IvrAction, IvrRuntimeContext, IvrStepInput } from './ivr-executor.js';
import { popSubflowReturn } from './ivr-subflow-handler.js';
import {
  clearAudioQueue,
  consumeQueueForFlush,
  enqueuePlayContents,
  segmentsToPromptQueue,
  type AudioQueueSegment,
} from './ivr-audio-queue.js';

export interface DisconnectStepOutcome {
  action: IvrAction;
  context: IvrRuntimeContext;
  nextNodeId: string | null;
  terminated: boolean;
}

function disconnectHasFarewellContents(contents: PlayContentLike[] | undefined): boolean {
  return !!contents?.some(
    (c) => (c.text && c.text.trim().length > 0) || !!c.audioFile || !!c.variable
  );
}

function finishDisconnectFlush(context: IvrRuntimeContext, nodeId: string): IvrRuntimeContext {
  return {
    ...context,
    audioQueue: clearAudioQueue(),
    pendingDisconnectFlush: undefined,
    disconnectFarewellEnqueued: nodeId,
  };
}

async function resolveFarewellSegments(
  nodeId: string,
  contents: PlayContentLike[],
  variables: Record<string, string>,
  input: IvrStepInput
): Promise<AudioQueueSegment[]> {
  const segments: AudioQueueSegment[] = [];
  for (const content of contents) {
    let resolved: ResolvedPrompt;
    if (input.resolvePrompt) {
      resolved = await input.resolvePrompt([content], variables);
    } else {
      const result = resolvePlayContentsResult([content], variables);
      resolved = result.ok === false ? result.fallback : result.prompt;
    }
    segments.push({
      ...resolved,
      interruptible: false,
      sourceNodeId: nodeId,
    });
  }
  return segments;
}

async function maybeEnqueueDisconnectFarewell(
  graph: IvrFlowGraph,
  nodeId: string,
  context: IvrRuntimeContext,
  variables: Record<string, string>,
  input: IvrStepInput
): Promise<IvrRuntimeContext | null> {
  const nodeData = graph.nodes.find((n) => n.id === nodeId)?.data ?? {};
  const contents = nodeData.contents as PlayContentLike[] | undefined;
  if (!disconnectHasFarewellContents(contents) || context.disconnectFarewellEnqueued === nodeId) {
    return null;
  }
  const segments = await resolveFarewellSegments(nodeId, contents!, variables, input);
  return {
    ...context,
    variables,
    audioQueue: enqueuePlayContents(context.audioQueue, segments),
    disconnectFarewellEnqueued: nodeId,
  };
}

function completeDisconnectHangup(
  node: IvrNodeBase,
  context: IvrRuntimeContext,
  variables: Record<string, string>,
  endReason: string
): DisconnectStepOutcome {
  variables.end_reason = endReason;

  if (context.flowStack.length > 0) {
    const returnCode = (node.data.returnCode as 'ok' | 'error') ?? 'ok';
    const popped = popSubflowReturn(context, variables, returnCode);
    if (popped) {
      const frame = context.flowStack[context.flowStack.length - 1];
      const branch = returnCode === 'error' ? IVR_BRANCH.ERROR : IVR_BRANCH.OUT;
      const routed = applyBranchRoute(variables, frame.subflowNodeId, branch, popped.nextNodeId);
      return {
        action: { kind: 'log', message: `subflow end (${returnCode})`, node: node.id },
        context: { ...popped.context, variables: routed },
        nextNodeId: popped.nextNodeId,
        terminated: false,
      };
    }
  }

  return {
    action: { kind: 'disconnect', phase: 'hangup', endReason, node: node.id },
    context: {
      ...context,
      variables,
      pendingDisconnectFlush: undefined,
      currentNodeId: null,
    },
    nextNodeId: null,
    terminated: true,
  };
}

async function handleDisconnectQueueFlush(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  action: IvrAction,
  context: IvrRuntimeContext,
  variables: Record<string, string>,
  input: IvrStepInput
): Promise<DisconnectStepOutcome> {
  const nodeId = node.id;
  const endReason = action.kind === 'disconnect' ? action.endReason : 'completed';
  let ctx = context;

  if ((input.flushCompleted || input.bargeInDigits) && ctx.pendingDisconnectFlush === nodeId) {
    ctx = finishDisconnectFlush(ctx, nodeId);
    return completeDisconnectHangup(node, ctx, variables, endReason);
  }

  const enqueued = await maybeEnqueueDisconnectFarewell(graph, nodeId, ctx, variables, input);
  if (enqueued) ctx = enqueued;

  const queue = consumeQueueForFlush(ctx.audioQueue);
  if (queue.length > 0) {
    if (ctx.pendingDisconnectFlush !== nodeId) {
      return {
        action: { kind: 'flush_play_queue', promptQueue: segmentsToPromptQueue(queue), node: nodeId },
        context: { ...ctx, pendingDisconnectFlush: nodeId, currentNodeId: nodeId },
        nextNodeId: nodeId,
        terminated: false,
      };
    }
    if (!input.flushCompleted && !input.bargeInDigits) {
      return {
        action: { kind: 'log', message: 'disconnect flush pending', node: nodeId },
        context: { ...ctx, currentNodeId: nodeId },
        nextNodeId: nodeId,
        terminated: false,
      };
    }
  }

  return completeDisconnectHangup(node, ctx, variables, endReason);
}

export async function advanceDisconnectStep(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  action: IvrAction,
  context: IvrRuntimeContext,
  variables: Record<string, string>,
  input: IvrStepInput
): Promise<DisconnectStepOutcome | null> {
  if (node.type !== 'disconnect' || action.kind !== 'disconnect') return null;
  return handleDisconnectQueueFlush(graph, node, action, context, variables, input);
}
