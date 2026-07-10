/**
 * Inbound IVR routing — connects inbound router `action: 'ivr'` to the unified runtime.
 */

import { IvrFlowStore } from './ivr-flow-store.js';
import { validateFlowGraph, validateFlowGraphDetailed, type IvrFlowGraph } from './ivr-types.js';
import { publishBlockingIssues } from './ivr-validation-policy.js';
import {
  actionToPromptText,
  advanceRuntimeStep,
  createRuntimeContext,
  shouldAutoWalkAfterAdvance,
  walkToPromptableAction,
  type IvrSessionState,
} from './ivr-runtime.js';
import type { IvrStepInput } from './ivr-executor.js';
import { buildLiveIvrStepInput } from './ivr-live-input.js';
import { parseIvrAdvanceBody } from './ivr-advance-input.js';
import { isBargeInProductionEnabled } from './ivr-production-gates.js';

export type { IvrSessionState };

function normalizeProductionAdvanceInput(
  state: IvrSessionState,
  input: IvrStepInput
): IvrStepInput {
  if (input.playCompleted || input.bargeInDigits || input.flushCompleted) return input;
  if (!input.dtmf) return input;
  // Production barge-in (dtmf while audio still queued) requires explicit gate.
  if (!isBargeInProductionEnabled()) return input;

  const onInterruptiblePlay =
    state.lastAction?.kind === 'play' &&
    state.lastAction.interruptible === true &&
    state.context.pendingAdvanceNodeId != null;

  const onQueuedGather =
    state.lastAction?.kind === 'menu' && (state.context.audioQueue?.length ?? 0) > 0;

  const onPendingFlush =
    state.lastAction?.kind === 'flush_play_queue' &&
    (state.context.pendingFlushAudio != null ||
      state.context.pendingTransferFlush != null ||
      state.context.pendingDisconnectFlush != null);

  if (!onInterruptiblePlay && !onQueuedGather && !onPendingFlush) return input;

  return {
    ...input,
    ...(onInterruptiblePlay ? { playCompleted: true } : {}),
    bargeInDigits: input.dtmf,
    dtmf: undefined,
  };
}

function buildStepInput(
  db: unknown,
  tenantId: string,
  partial: IvrStepInput & { callSessionId?: string } = {},
  session?: Pick<IvrSessionState, 'channelVariables' | 'mediaType'>
): IvrStepInput {
  return buildLiveIvrStepInput(db, tenantId, {
    dtmf: partial.dtmf,
    speechResult: partial.speechResult,
    timedOut: partial.timedOut,
    playCompleted: partial.playCompleted,
    flushCompleted: partial.flushCompleted,
    bargeInDigits: partial.bargeInDigits,
    queueEvent: partial.queueEvent,
    transferEvent: partial.transferEvent,
    aiDialogueResult: partial.aiDialogueResult,
    videoEvent: partial.videoEvent,
    screenShareEvent: partial.screenShareEvent,
    visualSelection: partial.visualSelection,
    channelVariables: partial.channelVariables ?? session?.channelVariables,
    mediaType: partial.mediaType ?? session?.mediaType,
    callSessionId: partial.callSessionId,
    roomName: partial.roomName,
  });
}

export function startIvrSession(
  db: unknown,
  tenantId: string,
  callSessionId: string,
  ivrFlowId?: string,
  initialVariables: Record<string, string> = {},
  opts?: {
    channelVariables?: Record<string, string>;
    mediaType?: import('./ivr-video-handlers.js').IvrMediaType;
  }
): IvrSessionState | null {
  const store = new IvrFlowStore(db);
  let flow = ivrFlowId ? store.getFlow(tenantId, ivrFlowId) : null;
  if (!flow) {
    const flows = store.listFlows(tenantId);
    flow =
      flows.find((f) => f.status === 'published' && publishBlockingIssues(validateFlowGraphDetailed(f.graph)).length === 0) ||
      flows.find((f) => f.status === 'published') ||
      flows[0] ||
      null;
  }
  if (!flow || validateFlowGraph(flow.graph).length > 0) return null;
  if (flow.status === 'needs_repair') return null;

  return {
    callSessionId,
    tenantId,
    flowId: flow.id,
    context: createRuntimeContext(flow.graph, initialVariables),
    stepCount: 0,
    terminated: false,
    channelVariables: opts?.channelVariables,
    mediaType: opts?.mediaType,
  };
}

export async function advanceIvrStep(
  state: IvrSessionState,
  db: unknown,
  stepInput: IvrStepInput = {}
): Promise<{
  action: IvrSessionState['lastAction'];
  state: IvrSessionState;
  terminated: boolean;
}> {
  if (state.terminated || !state.context.currentNodeId) {
    return { action: state.lastAction, state, terminated: true };
  }

  const input = buildStepInput(db, state.tenantId, normalizeProductionAdvanceInput(state, {
    ...stepInput,
    callSessionId: stepInput.callSessionId ?? state.callSessionId,
  }), state);

  const step = await advanceRuntimeStep(state.context, input);
  const newState: IvrSessionState = {
    ...state,
    context: step.context,
    stepCount: state.stepCount + 1,
    terminated: step.terminated,
    lastAction: step.action,
  };
  return { action: step.action, state: newState, terminated: step.terminated };
}

/** Media / ACD / AI callbacks → unified advance (ADR-1.1 -1.API.0). */
export async function onIvrMediaEvent(
  state: IvrSessionState,
  db: unknown,
  partialInput: IvrStepInput
): Promise<{
  action: IvrSessionState['lastAction'];
  state: IvrSessionState;
  terminated: boolean;
}> {
  return advanceIvrStep(state, db, partialInput);
}

export async function resolveIvrRoute(
  db: unknown,
  tenantId: string,
  callSessionId: string,
  ivrFlowId?: string,
  opts?: {
    channelVariables?: Record<string, string>;
    mediaType?: import('./ivr-video-handlers.js').IvrMediaType;
    initialVariables?: Record<string, string>;
  }
): Promise<
  | { action: 'ivr'; flowId: string; firstPrompt: string; hasFlow: boolean; session: IvrSessionState }
  | { action: 'ivr'; hasFlow: false }
> {
  const session = startIvrSession(
    db,
    tenantId,
    callSessionId,
    ivrFlowId,
    opts?.initialVariables ?? {},
    { channelVariables: opts?.channelVariables, mediaType: opts?.mediaType }
  );
  if (!session) return { action: 'ivr', hasFlow: false };

  const walked = await walkToPromptableAction(
    session.context,
    buildStepInput(db, tenantId, { callSessionId }, session)
  );

  const updated: IvrSessionState = {
    ...session,
    context: walked.context,
    terminated: walked.terminated,
    lastAction: walked.action,
  };

  return {
    action: 'ivr',
    flowId: updated.flowId,
    firstPrompt: actionToPromptText(walked.action),
    hasFlow: true,
    session: updated,
  };
}

/** Re-export for tests that only need graph validation */
export function loadFlowGraph(db: unknown, tenantId: string, flowId?: string): IvrFlowGraph | null {
  const store = new IvrFlowStore(db);
  const flow = flowId
    ? store.getFlow(tenantId, flowId)
    : store.listFlows(tenantId).find((f) => f.status === 'published') || store.listFlows(tenantId)[0];
  return flow?.graph ?? null;
}
