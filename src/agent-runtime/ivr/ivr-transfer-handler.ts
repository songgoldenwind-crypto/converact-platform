/**
 * Transfer node failure branches (原则七 7-B) + Genesys queue flush (ADR-4 Task 8).
 */
import { applyBranchRoute } from './ivr-branch-vars.js';
import { IVR_BRANCH } from './ivr-branch-handles.js';
import type { IvrFlowGraph } from './ivr-types.js';
import { getNodeExits, requireEdge } from './ivr-types.js';
import {
  resolvePlayContents,
  resolvePlayContentsResult,
  type PlayContentLike,
  type ResolvedPrompt,
} from './ivr-play-resolver.js';
import type { IvrAction, IvrRuntimeContext, IvrStepInput } from './ivr-executor.js';
import {
  clearAudioQueue,
  consumeQueueForFlush,
  enqueuePlayContents,
  segmentsToPromptQueue,
  type AudioQueueSegment,
} from './ivr-audio-queue.js';

export const TRANSFER_BRANCH = {
  NO_ANSWER: 'no_answer',
  BUSY: 'busy',
  FAILED: 'failed',
} as const;

export type TransferAdvanceEvent =
  | { kind: 'connected' }
  | { kind: 'no_answer' }
  | { kind: 'busy' }
  | { kind: 'failed'; reason?: string };

export type TransferFailureReason = 'no_answer' | 'busy' | 'failed';

export interface TransferExecResult {
  ok: boolean;
  reason?: TransferFailureReason | 'connected';
  error?: string;
}

export interface TransferStepOutcome {
  action: IvrAction;
  context: IvrRuntimeContext;
  nextNodeId: string | null;
  terminated: boolean;
}

/**
 * Legacy graphs with zero outgoing edges remain terminal (emit transfer action and end).
 * Any outgoing handle (out / no_answer / busy / failed) means we must run executeTransfer
 * or wait for transferEvent — otherwise OUT-only designer graphs skip the real bridge.
 */
export function isTransferTerminal(graph: IvrFlowGraph, nodeId: string): boolean {
  return getNodeExits(graph, nodeId).size === 0;
}

export function resolveTransferEventHandle(event: TransferAdvanceEvent): string {
  switch (event.kind) {
    case 'connected':
      return IVR_BRANCH.OUT;
    case 'no_answer':
      return TRANSFER_BRANCH.NO_ANSWER;
    case 'busy':
      return TRANSFER_BRANCH.BUSY;
    case 'failed':
      return TRANSFER_BRANCH.FAILED;
  }
}

function routeTransferBranch(
  graph: IvrFlowGraph,
  nodeId: string,
  handle: string,
  variables: Record<string, string>,
  context: IvrRuntimeContext
): TransferStepOutcome {
  const edge = requireEdge(graph, nodeId, handle);
  if (handle === TRANSFER_BRANCH.FAILED) {
    variables.transfer_result = 'failed';
  } else if (handle === TRANSFER_BRANCH.BUSY) {
    variables.transfer_result = 'busy';
  } else if (handle === TRANSFER_BRANCH.NO_ANSWER) {
    variables.transfer_result = 'no_answer';
  } else if (handle === IVR_BRANCH.OUT) {
    variables.transfer_result = 'connected';
  }
  return {
    action: { kind: 'log', message: `transfer ${handle}`, node: nodeId },
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

function failureReasonToHandle(reason: TransferFailureReason): string {
  return resolveTransferEventHandle({ kind: reason });
}

function hasPreTransferContents(contents: PlayContentLike[] | undefined): boolean {
  return !!contents?.some(
    (c) => (c.text && c.text.trim().length > 0) || !!c.audioFile || !!c.variable
  );
}

function finishTransferFlush(context: IvrRuntimeContext, nodeId: string): IvrRuntimeContext {
  return {
    ...context,
    audioQueue: clearAudioQueue(),
    pendingTransferFlush: undefined,
    preTransferPromptPlayed: nodeId,
  };
}

async function resolvePreTransferSegments(
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

async function maybeEnqueuePreTransferPrompt(
  graph: IvrFlowGraph,
  nodeId: string,
  context: IvrRuntimeContext,
  variables: Record<string, string>,
  input: IvrStepInput
): Promise<IvrRuntimeContext | null> {
  const nodeData = graph.nodes.find((n) => n.id === nodeId)?.data ?? {};
  const preContents = nodeData.preTransferPrompt as PlayContentLike[] | undefined;
  if (!hasPreTransferContents(preContents) || context.preTransferPromptPlayed === nodeId) {
    return null;
  }
  if (context.preTransferPromptEnqueued === nodeId) {
    return null;
  }
  const segments = await resolvePreTransferSegments(nodeId, preContents!, variables, input);
  return {
    ...context,
    variables,
    audioQueue: enqueuePlayContents(context.audioQueue, segments),
    preTransferPromptEnqueued: nodeId,
  };
}

async function handleTransferQueueFlush(
  graph: IvrFlowGraph,
  nodeId: string,
  action: IvrAction,
  context: IvrRuntimeContext,
  variables: Record<string, string>,
  input: IvrStepInput
): Promise<TransferStepOutcome | null> {
  let ctx = context;

  if ((input.flushCompleted || input.bargeInDigits) && ctx.pendingTransferFlush === nodeId) {
    ctx = finishTransferFlush(ctx, nodeId);
  } else {
    const enqueued = await maybeEnqueuePreTransferPrompt(graph, nodeId, ctx, variables, input);
    if (enqueued) ctx = enqueued;

    const queue = consumeQueueForFlush(ctx.audioQueue);
    if (queue.length > 0) {
      if (ctx.pendingTransferFlush !== nodeId) {
        return {
          action: { kind: 'flush_play_queue', promptQueue: segmentsToPromptQueue(queue), node: nodeId },
          context: { ...ctx, pendingTransferFlush: nodeId, currentNodeId: nodeId },
          nextNodeId: nodeId,
          terminated: false,
        };
      }
      if (!input.flushCompleted && !input.bargeInDigits) {
        return {
          action: { kind: 'log', message: 'transfer flush pending', node: nodeId },
          context: { ...ctx, currentNodeId: nodeId },
          nextNodeId: nodeId,
          terminated: false,
        };
      }
    }
  }

  if (isTransferTerminal(graph, nodeId)) {
    return {
      action,
      context: { ...ctx, variables, currentNodeId: null },
      nextNodeId: null,
      terminated: true,
    };
  }

  if (ctx.waiting?.kind === 'transfer' && ctx.waiting.nodeId === nodeId) {
    if (input.transferEvent) return null;
    return {
      action,
      context: { ...ctx, variables, currentNodeId: nodeId },
      nextNodeId: nodeId,
      terminated: false,
    };
  }

  const exec = input.deferTransferToProvider ? undefined : input.sideEffects?.executeTransfer;
  if (exec) {
    const rawData = {
      ...(ctx.graph.nodes.find((n) => n.id === nodeId)?.data ?? {}),
    } as Record<string, unknown>;
    // Designer group_call nodes typically store only targetValue (group id).
    // Resolve members the same way menu/RWI paths do via groupCallResolver.
    if (
      rawData.targetType === 'group_call' &&
      input.groupCallResolver &&
      (!Array.isArray(rawData.memberSeatIds) || (rawData.memberSeatIds as string[]).length === 0)
    ) {
      rawData.memberSeatIds = input.groupCallResolver(String(rawData.targetValue ?? ''));
    }
    const result = await exec(rawData, variables, input.callSessionId ?? '');
    if (result.ok && result.reason === 'connected') {
      return routeTransferBranch(graph, nodeId, IVR_BRANCH.OUT, variables, ctx);
    }
    if (!result.ok && result.reason && result.reason !== 'connected') {
      variables.last_error = result.error ?? result.reason;
      variables.transfer_fail_reason = result.error ?? result.reason;
      return routeTransferBranch(
        graph,
        nodeId,
        failureReasonToHandle(result.reason),
        variables,
        ctx
      );
    }
    if (!result.ok) {
      variables.last_error = result.error ?? 'transfer_failed';
      return routeTransferBranch(graph, nodeId, TRANSFER_BRANCH.FAILED, variables, ctx);
    }
  }

  return {
    action,
    context: {
      ...ctx,
      variables,
      waiting: { kind: 'transfer', nodeId, since: new Date().toISOString() },
      currentNodeId: nodeId,
    },
    nextNodeId: nodeId,
    terminated: false,
  };
}

/**
 * First advance: enqueue + flush audioQueue, then optional sync executeTransfer or enter waiting.
 * Second advance: transferEvent via handleWaitingResume.
 */
export async function advanceTransferStep(
  graph: IvrFlowGraph,
  nodeId: string,
  action: IvrAction,
  context: IvrRuntimeContext,
  variables: Record<string, string>,
  input: IvrStepInput
): Promise<TransferStepOutcome | null> {
  if (action.kind !== 'transfer') return null;
  return handleTransferQueueFlush(graph, nodeId, action, context, variables, input);
}
