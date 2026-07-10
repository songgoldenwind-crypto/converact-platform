/**
 * ai_dialogue two-phase advance — first dispatch + waiting, then aiDialogueResult (不一致-5 AI-H3).
 */

import { IVR_BRANCH } from './ivr-branch-handles.js';
import { applyBranchRoute } from './ivr-branch-vars.js';
import { requireEdge, type IvrFlowGraph, type IvrNodeBase } from './ivr-types.js';
import type { IvrAction, IvrRuntimeContext, IvrStepInput } from './ivr-executor.js';
import { startAiDialogue } from './ivr-ai-dialogue-bridge.js';

export type StartAiDialogueFn = (opts: {
  node: IvrNodeBase;
  roomName: string;
  callSessionId: string;
  tenantId: string;
}) => Promise<{ ok: true } | { ok: false; reason: string }>;

export async function advanceAiDialogueStep(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrRuntimeContext,
  variables: Record<string, string>,
  action: IvrAction,
  input: IvrStepInput
): Promise<{
  action: IvrAction;
  context: IvrRuntimeContext;
  nextNodeId: string | null;
  terminated: boolean;
}> {
  if (
    context.waiting?.kind === 'ai_dialogue' &&
    context.waiting.nodeId === node.id &&
    !input.aiDialogueResult
  ) {
    return {
      action,
      context: { ...context, variables, currentNodeId: node.id },
      nextNodeId: node.id,
      terminated: false,
    };
  }

  const startFn: StartAiDialogueFn =
    input.sideEffects?.startAiDialogue ??
    (async (opts) => startAiDialogue(opts));

  const started = await startFn({
    node,
    roomName: input.roomName ?? '',
    callSessionId: input.callSessionId ?? '',
    tenantId: input.tenantId ?? '',
  });

  if (started.ok === false) {
    variables.last_error = started.reason;
    variables.ai_dispatch_error = started.reason;
    const edge = requireEdge(graph, node.id, IVR_BRANCH.ERROR);
    const routed = applyBranchRoute(
      variables,
      node.id,
      IVR_BRANCH.ERROR,
      edge.ok ? edge.target : null
    );
    return {
      action,
      context: {
        ...context,
        variables: routed,
        currentNodeId: edge.ok ? edge.target : null,
      },
      nextNodeId: edge.ok ? edge.target : null,
      terminated: false,
    };
  }

  const d = node.data;
  return {
    action,
    context: {
      ...context,
      variables,
      currentNodeId: node.id,
      waiting: {
        kind: 'ai_dialogue',
        nodeId: node.id,
        since: new Date().toISOString(),
        maxTurns: (d.maxTurns as number) ?? 10,
        timeoutSec: (d.timeoutSec as number) ?? 30,
        agentSpecId: (d.agentSpecId as string) || (d.scriptId as string),
        turnCount: 0,
      },
    },
    nextNodeId: node.id,
    terminated: false,
  };
}
