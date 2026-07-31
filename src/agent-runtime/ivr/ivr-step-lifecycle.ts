/**
 * Task -1 lifecycle helpers — play resume, waiting resume, interaction phases.
 */

import { IVR_BRANCH } from './ivr-branch-handles.js';
import { applyBranchRoute } from './ivr-branch-vars.js';
import { requireEdge, resolveEdge } from './ivr-types.js';
import type { IvrNodeBase } from './ivr-types.js';
import type {
  AiDialogueResult,
  IvrAction,
  IvrRuntimeContext,
  IvrStepInput,
  QueueAdvanceEvent,
  TransferAdvanceEvent,
} from './ivr-executor.js';
import { resolveTransferEventHandle } from './ivr-transfer-handler.js';
import {
  resolveScreenShareEventHandle,
  resolveVideoEventHandle,
} from './ivr-video-handlers.js';

export function hasConsumerInput(input: IvrStepInput, context: IvrRuntimeContext): boolean {
  if (input.timedOut) return true;
  if (input.speechResult != null && input.speechResult !== '') return true;
  if (input.visualSelection != null && input.visualSelection !== '') return true;
  if (input.dtmf != null && input.dtmf !== '') return true;
  if (context.pendingDigits) return true;
  return false;
}

export function stripWalkConsumerInput(input: IvrStepInput): IvrStepInput {
  return {
    ...input,
    dtmf: undefined,
    speechResult: undefined,
    timedOut: false,
    playCompleted: false,
    bargeInDigits: undefined,
    queueEvent: undefined,
    transferEvent: undefined,
    aiDialogueResult: undefined,
  };
}

export function shouldAutoWalkAfterAdvance(context: IvrRuntimeContext): boolean {
  return (
    !context.interaction?.awaiting &&
    !context.waiting &&
    context.pendingAdvanceNodeId == null &&
    context.pendingDisconnectFlush == null &&
    context.pendingTransferFlush == null &&
    context.pendingFlushAudio == null
  );
}

export function shouldStopWalk(context: IvrRuntimeContext): boolean {
  return (
    !!context.interaction?.awaiting ||
    !!context.waiting ||
    context.pendingAdvanceNodeId != null ||
    context.pendingDisconnectFlush != null ||
    context.pendingTransferFlush != null ||
    context.pendingFlushAudio != null
  );
}

export function resolveQueueEventHandle(event: QueueAdvanceEvent): string {
  switch (event.kind) {
    case 'connected':
      return IVR_BRANCH.OUT;
    case 'timeout':
      return IVR_BRANCH.TIMEOUT;
    case 'error':
      return IVR_BRANCH.ERROR;
  }
}

export function resolveAiDialogueHandle(reason: AiDialogueResult['reason']): string {
  if (reason === 'timeout') return IVR_BRANCH.TIMEOUT;
  if (reason === 'error') return IVR_BRANCH.ERROR;
  return IVR_BRANCH.OUT;
}

export function handlePlayCompleted(
  context: IvrRuntimeContext,
  node: IvrNodeBase,
  input: IvrStepInput
): {
  action: IvrAction;
  context: IvrRuntimeContext;
  nextNodeId: string | null;
  terminated: boolean;
} | null {
  if (!input.playCompleted) return null;

  if (context.pendingAdvanceNodeId == null) return null;

  const nextId = context.pendingAdvanceNodeId;
  const pendingDigits = input.bargeInDigits ?? context.pendingDigits;

  return {
    action: { kind: 'log', message: 'play completed', node: node.id },
    context: {
      ...context,
      currentNodeId: nextId,
      pendingAdvanceNodeId: null,
      pendingDigits: pendingDigits || undefined,
    },
    nextNodeId: nextId,
    terminated: false,
  };
}

export function handleWaitingResume(
  context: IvrRuntimeContext,
  input: IvrStepInput
): {
  action: IvrAction;
  context: IvrRuntimeContext;
  nextNodeId: string | null;
  terminated: boolean;
} | null {
  if (context.waiting?.kind === 'transfer' && input.transferEvent) {
    const handle = resolveTransferEventHandle(input.transferEvent);
    const variables = { ...context.variables };
    if (input.transferEvent.kind === 'connected') {
      variables.transfer_result = 'connected';
    } else if (input.transferEvent.kind === 'failed' && input.transferEvent.reason) {
      variables.transfer_fail_reason = input.transferEvent.reason;
      variables.transfer_result = 'failed';
    } else {
      variables.transfer_result = input.transferEvent.kind;
    }
    const edge = requireEdge(context.graph, context.waiting.nodeId, handle);
    return {
      action: { kind: 'log', message: `transfer ${input.transferEvent.kind}`, node: context.waiting.nodeId },
      context: {
        ...context,
        variables: applyBranchRoute(variables, context.waiting.nodeId, handle, edge.ok ? edge.target : null),
        waiting: undefined,
        currentNodeId: edge.ok ? edge.target : null,
      },
      nextNodeId: edge.ok ? edge.target : null,
      terminated: false,
    };
  }

  if (context.waiting?.kind === 'queue' && input.queueEvent) {
    const handle = resolveQueueEventHandle(input.queueEvent);
    const variables = { ...context.variables };
    if (input.queueEvent.kind === 'connected') {
      variables.agent_id = input.queueEvent.agentId;
      variables.queue_result = 'connected';
    } else if (input.queueEvent.kind === 'timeout') {
      variables.queue_result = 'timeout';
    } else {
      variables.queue_result = 'error';
      variables.last_error = input.queueEvent.reason;
    }
    const edge = requireEdge(context.graph, context.waiting.nodeId, handle);
    return {
      action: { kind: 'log', message: `queue ${input.queueEvent.kind}`, node: context.waiting.nodeId },
      context: {
        ...context,
        variables: applyBranchRoute(variables, context.waiting.nodeId, handle, edge.ok ? edge.target : null),
        waiting: undefined,
        currentNodeId: edge.ok ? edge.target : null,
      },
      nextNodeId: edge.ok ? edge.target : null,
      terminated: false,
    };
  }

  if (context.waiting?.kind === 'ai_dialogue' && input.aiDialogueResult) {
    const handle = resolveAiDialogueHandle(input.aiDialogueResult.reason);
    const variables = { ...context.variables };
    if (input.aiDialogueResult.variables) Object.assign(variables, input.aiDialogueResult.variables);
    if (input.aiDialogueResult.intentScore != null) {
      variables.intent_score = String(input.aiDialogueResult.intentScore);
    }
    const edge = requireEdge(context.graph, context.waiting.nodeId, handle);
    return {
      action: { kind: 'log', message: `ai_dialogue ${input.aiDialogueResult.reason}`, node: context.waiting.nodeId },
      context: {
        ...context,
        variables: applyBranchRoute(variables, context.waiting.nodeId, handle, edge.ok ? edge.target : null),
        waiting: undefined,
        currentNodeId: edge.ok ? edge.target : null,
      },
      nextNodeId: edge.ok ? edge.target : null,
      terminated: false,
    };
  }

  if (context.waiting?.kind === 'video' && input.videoEvent) {
    const handle = resolveVideoEventHandle(input.videoEvent);
    const variables = { ...context.variables };
    if (input.videoEvent.kind === 'completed') {
      variables.video_result = 'completed';
    } else if (input.videoEvent.kind === 'skipped') {
      variables.video_result = 'skipped';
    } else {
      variables.video_result = 'error';
      if (input.videoEvent.reason) variables.last_error = input.videoEvent.reason;
    }
    const edge = requireEdge(context.graph, context.waiting.nodeId, handle);
    return {
      action: { kind: 'log', message: `video ${input.videoEvent.kind}`, node: context.waiting.nodeId },
      context: {
        ...context,
        variables: applyBranchRoute(variables, context.waiting.nodeId, handle, edge.ok ? edge.target : null),
        waiting: undefined,
        currentNodeId: edge.ok ? edge.target : null,
      },
      nextNodeId: edge.ok ? edge.target : null,
      terminated: false,
    };
  }

  if (context.waiting?.kind === 'video' && input.screenShareEvent) {
    const handle = resolveScreenShareEventHandle(input.screenShareEvent);
    const variables = { ...context.variables };
    if (input.screenShareEvent.kind === 'accepted') {
      variables.screen_share_result = 'accepted';
    } else if (input.screenShareEvent.kind === 'denied') {
      variables.screen_share_result = 'denied';
    } else {
      variables.screen_share_result = 'error';
      if (input.screenShareEvent.reason) variables.last_error = input.screenShareEvent.reason;
    }
    const edge = requireEdge(context.graph, context.waiting.nodeId, handle);
    return {
      action: { kind: 'log', message: `screen_share ${input.screenShareEvent.kind}`, node: context.waiting.nodeId },
      context: {
        ...context,
        variables: applyBranchRoute(variables, context.waiting.nodeId, handle, edge.ok ? edge.target : null),
        waiting: undefined,
        currentNodeId: edge.ok ? edge.target : null,
      },
      nextNodeId: edge.ok ? edge.target : null,
      terminated: false,
    };
  }

  return null;
}

export function handlePlayNodeEmit(
  context: IvrRuntimeContext,
  node: IvrNodeBase,
  action: IvrAction,
  variables: Record<string, string>
): {
  action: IvrAction;
  context: IvrRuntimeContext;
  nextNodeId: string | null;
  terminated: boolean;
} {
  const outTarget = resolveEdge(context.graph, node.id, 'out');
  const playQueueIndex = context.playQueueIndex ?? 0;
  return {
    action,
    context: {
      ...context,
      variables,
      currentNodeId: node.id,
      pendingAdvanceNodeId: outTarget,
      lastPromptNodeId: node.id,
      playQueueIndex,
    },
    nextNodeId: node.id,
    terminated: false,
  };
}

/** PL-1: after a segment completes, emit the next play action or return final resume. */
export function resumePlayQueueOrExit(
  node: IvrNodeBase,
  context: IvrRuntimeContext,
  playResume: {
    action: IvrAction;
    context: IvrRuntimeContext;
    nextNodeId: string | null;
    terminated: boolean;
  }
): {
  moreSegments: boolean;
  context: IvrRuntimeContext;
  playResume: typeof playResume;
} {
  if (node.type !== 'play') {
    return { moreSegments: false, context, playResume };
  }
  const contents = (node.data.contents as unknown[]) || [];
  const idx = context.playQueueIndex ?? 0;
  if (idx + 1 >= contents.length) {
    return { moreSegments: false, context, playResume };
  }
  return {
    moreSegments: true,
    context: {
      ...playResume.context,
      currentNodeId: node.id,
      pendingAdvanceNodeId: undefined,
      playQueueIndex: idx + 1,
    },
    playResume,
  };
}

export type InteractionKind = 'menu' | 'collect' | 'collect_verify';

export function interactionKindForNode(node: IvrNodeBase): InteractionKind | null {
  if (node.type === 'collect') return 'collect';
  return null;
}

export function handleInteractiveNode(
  node: IvrNodeBase,
  context: IvrRuntimeContext,
  action: IvrAction,
  variables: Record<string, string>,
  input: IvrStepInput,
  exits: Map<string, string>
): {
  action: IvrAction;
  context: IvrRuntimeContext;
  nextNodeId: string | null;
  terminated: boolean;
} {
  const kind = interactionKindForNode(node)!;
  const awaitingSameNode =
    context.interaction?.awaiting === true && context.interaction.nodeId === node.id;
  const consuming = hasConsumerInput(input, context);

  if (awaitingSameNode && !consuming) {
    return {
      action,
      context: { ...context, variables, interaction: context.interaction },
      nextNodeId: node.id,
      terminated: false,
    };
  }

  if (!awaitingSameNode && !consuming) {
    return {
      action,
      context: {
        ...context,
        variables,
        lastPromptNodeId: node.id,
        interaction: { nodeId: node.id, kind, awaiting: true },
      },
      nextNodeId: node.id,
      terminated: false,
    };
  }

  const effectiveDtmf = input.dtmf ?? context.pendingDigits;
  let nextNodeId: string | null = null;
  const nextVariables = { ...variables };
  const clearedContext: IvrRuntimeContext = {
    ...context,
    variables: nextVariables,
    interaction: undefined,
    pendingDigits: undefined,
  };

  if (node.type === 'collect') {
    if (input.timedOut) {
      nextNodeId = exits.get('timeout') ?? null;
    } else if (effectiveDtmf) {
      const storeVar = (node.data.storeVariable as string) || 'collected';
      nextVariables[storeVar] = effectiveDtmf;
      nextNodeId = exits.get('out') ?? null;
    } else {
      nextNodeId = exits.get('timeout') ?? null;
    }
  }

  return {
    action,
    context: { ...clearedContext, currentNodeId: nextNodeId },
    nextNodeId,
    terminated: false,
  };
}
