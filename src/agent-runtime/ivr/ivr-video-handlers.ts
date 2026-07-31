/**
 * Phase C video nodes — avatar_switch, video_play, screen_share.
 */
import { IVR_BRANCH } from './ivr-branch-handles.js';
import { applyBranchRoute } from './ivr-branch-vars.js';
import type { IvrFlowGraph, IvrNodeBase } from './ivr-types.js';
import { requireEdge } from './ivr-types.js';
import type { IvrAction, IvrRuntimeContext, IvrStepInput } from './ivr-executor.js';
import type { AvatarSwitchExecResult } from './ivr-side-effects.js';

export type IvrMediaType = 'voice' | 'video';

export type VideoAdvanceEvent =
  | { kind: 'completed' }
  | { kind: 'skipped' }
  | { kind: 'error'; reason?: string };

export type ScreenShareAdvanceEvent =
  | { kind: 'accepted' }
  | { kind: 'denied' }
  | { kind: 'error'; reason?: string };

export function isVideoSession(mediaType?: IvrMediaType): boolean {
  return mediaType === 'video';
}

export function resolveVideoEventHandle(event: VideoAdvanceEvent): string {
  if (event.kind === 'completed') return IVR_BRANCH.OUT;
  if (event.kind === 'skipped') return IVR_BRANCH.SKIPPED;
  return IVR_BRANCH.ERROR;
}

export function resolveScreenShareEventHandle(event: ScreenShareAdvanceEvent): string {
  if (event.kind === 'accepted') return IVR_BRANCH.OUT;
  if (event.kind === 'denied') return IVR_BRANCH.DENIED;
  return IVR_BRANCH.ERROR;
}

type StepOutcome = {
  action: IvrAction;
  context: IvrRuntimeContext;
  nextNodeId: string | null;
  terminated: boolean;
};

function routeVideoBranch(
  graph: IvrFlowGraph,
  nodeId: string,
  handle: string,
  context: IvrRuntimeContext,
  variables: Record<string, string>,
  logMessage: string
): StepOutcome {
  const edge = requireEdge(graph, nodeId, handle);
  return {
    action: { kind: 'log', message: logMessage, node: nodeId },
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

function routeNonVideoError(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrRuntimeContext,
  variables: Record<string, string>
): StepOutcome {
  variables.video_error = 'voice_session';
  variables.last_error = 'video nodes require mediaType=video';
  return routeVideoBranch(
    graph,
    node.id,
    IVR_BRANCH.ERROR,
    context,
    variables,
    'video gate: voice session'
  );
}

export async function advanceAvatarSwitchStep(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrRuntimeContext,
  action: IvrAction,
  variables: Record<string, string>,
  input: IvrStepInput
): Promise<StepOutcome> {
  if (!isVideoSession(input.mediaType)) {
    return routeNonVideoError(graph, node, context, variables);
  }

  let result: AvatarSwitchExecResult = { status: 'success' };
  if (input.sideEffects?.executeAvatarSwitch) {
    result = await input.sideEffects.executeAvatarSwitch(node.data, variables, input);
  }

  const handle =
    result.status === 'success'
      ? IVR_BRANCH.SUCCESS
      : result.status === 'declined'
        ? IVR_BRANCH.DECLINED
        : IVR_BRANCH.ERROR;

  if (result.status === 'error' && result.reason) {
    variables.last_error = result.reason;
    variables.avatar_switch_error = result.reason;
  }
  if (result.status === 'declined') {
    variables.avatar_switch_result = 'declined';
  }
  if (result.status === 'success') {
    variables.avatar_switch_result = 'success';
  }

  const edge = requireEdge(graph, node.id, handle);
  return {
    action,
    context: {
      ...context,
      variables: applyBranchRoute(variables, node.id, handle, edge.ok ? edge.target : null),
      waiting: undefined,
      currentNodeId: edge.ok ? edge.target : null,
    },
    nextNodeId: edge.ok ? edge.target : null,
    terminated: false,
  };
}

export function advanceVideoPlayStep(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrRuntimeContext,
  action: IvrAction,
  variables: Record<string, string>,
  input: IvrStepInput
): StepOutcome | null {
  if (action.kind !== 'video_play') return null;

  if (context.waiting?.kind === 'video' && context.waiting.nodeId === node.id) {
    if (input.videoEvent) return null;

    const skippable = (node.data.skippable as boolean) ?? false;
    const digit = input.dtmf ?? context.pendingDigits;
    if (skippable && digit === '#') {
      variables.video_result = 'skipped';
      return routeVideoBranch(
        graph,
        node.id,
        IVR_BRANCH.SKIPPED,
        context,
        variables,
        'video skipped'
      );
    }

    return {
      action,
      context: { ...context, variables, currentNodeId: node.id },
      nextNodeId: node.id,
      terminated: false,
    };
  }

  if (!isVideoSession(input.mediaType)) {
    return routeNonVideoError(graph, node, context, variables);
  }

  return {
    action,
    context: {
      ...context,
      variables,
      waiting: {
        kind: 'video',
        nodeId: node.id,
        since: new Date().toISOString(),
      },
      currentNodeId: node.id,
    },
    nextNodeId: node.id,
    terminated: false,
  };
}

export function advanceScreenShareStep(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrRuntimeContext,
  action: IvrAction,
  variables: Record<string, string>,
  input: IvrStepInput
): StepOutcome | null {
  if (action.kind !== 'screen_share') return null;

  if (context.waiting?.kind === 'video' && context.waiting.nodeId === node.id) {
    if (input.screenShareEvent) return null;
    return {
      action,
      context: { ...context, variables, currentNodeId: node.id },
      nextNodeId: node.id,
      terminated: false,
    };
  }

  if (!isVideoSession(input.mediaType)) {
    return routeNonVideoError(graph, node, context, variables);
  }

  return {
    action,
    context: {
      ...context,
      variables,
      waiting: {
        kind: 'video',
        nodeId: node.id,
        since: new Date().toISOString(),
      },
      currentNodeId: node.id,
    },
    nextNodeId: node.id,
    terminated: false,
  };
}
