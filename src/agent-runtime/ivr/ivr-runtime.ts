/**
 * IVR runtime — shared state machine for simulation, inbound routing, and live sessions.
 */

import type { IvrFlowGraph } from './ivr-types.js';
import { isTerminalNode } from './ivr-types.js';
import {
  advanceSingleStep,
  createRuntimeContext,
  type IvrAction,
  type IvrFlowFrame,
  type IvrRuntimeContext,
  type IvrStepInput,
} from './ivr-executor.js';
import {
  shouldAutoWalkAfterAdvance,
  shouldStopWalk,
  stripWalkConsumerInput,
} from './ivr-step-lifecycle.js';

export type { IvrAction, IvrFlowFrame, IvrRuntimeContext, IvrStepInput };

export { createRuntimeContext };

export interface IvrSessionState {
  callSessionId: string;
  tenantId: string;
  flowId: string;
  context: IvrRuntimeContext;
  stepCount: number;
  terminated: boolean;
  lastAction?: IvrAction;
  channelVariables?: Record<string, string>;
  mediaType?: import('./ivr-video-handlers.js').IvrMediaType;
}

const PROMPTABLE_KINDS = new Set(['play', 'flush_play_queue', 'menu', 'collect_digits', 'collect_verify', 'visual_menu', 'compliance']);

export function isPromptableAction(action: IvrAction | undefined): boolean {
  if (!action) return false;
  return PROMPTABLE_KINDS.has(action.kind);
}

export async function advanceRuntimeStep(
  context: IvrRuntimeContext,
  input: IvrStepInput = {}
): Promise<{
  action: IvrAction;
  context: IvrRuntimeContext;
  terminated: boolean;
}> {
  if (!context.currentNodeId) {
    return {
      action: { kind: 'log', message: 'session ended', node: '' },
      context,
      terminated: true,
    };
  }

  const result = await advanceSingleStep(context, input);
  return {
    action: result.action,
    context: result.context,
    terminated: result.terminated,
  };
}

/** Walk past non-prompt nodes until a promptable action or termination. */
export async function walkToPromptableAction(
  context: IvrRuntimeContext,
  input: IvrStepInput = {},
  maxHops = 20
): Promise<{ action: IvrAction | undefined; context: IvrRuntimeContext; terminated: boolean }> {
  if (shouldStopWalk(context)) {
    return { action: undefined, context, terminated: false };
  }

  let state = context;
  let lastAction: IvrAction | undefined;
  const walkInput = stripWalkConsumerInput(input);

  for (let i = 0; i < maxHops; i++) {
    if (!state.currentNodeId) {
      return { action: lastAction, context: state, terminated: true };
    }
    const step = await advanceRuntimeStep(state, walkInput);
    state = step.context;
    lastAction = step.action;
    if (step.terminated) {
      return { action: step.action, context: state, terminated: true };
    }
    if (shouldStopWalk(state)) {
      return { action: step.action, context: state, terminated: false };
    }
    if (isPromptableAction(step.action)) {
      return { action: step.action, context: state, terminated: false };
    }
  }

  return { action: lastAction, context: state, terminated: false };
}

export { shouldAutoWalkAfterAdvance };

export function actionToPromptText(action: IvrAction | undefined): string {
  if (!action) return '';
  if (action.kind === 'play') return action.text;
  if (action.kind === 'flush_play_queue') return action.promptQueue[0]?.text ?? '';
  if (action.kind === 'menu' || action.kind === 'collect_digits' || action.kind === 'collect_verify') return action.prompt;
  if (action.kind === 'visual_menu') return action.title;
  if (action.kind === 'compliance') return action.prompt;
  if (action.kind === 'disconnect' && action.phase === 'hangup') return '';
  return '';
}
