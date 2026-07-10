/**
 * Flow-level global DTMF shortcuts — consumed before menu/collect handlers.
 */
import type { IvrFlowGraph, IvrNodeBase, GlobalShortcut } from './ivr-types.js';
import type { IvrAction, IvrRuntimeContext, IvrStepInput } from './ivr-executor.js';
import { actionTerminatesSession } from './ivr-executor.js';

export interface GlobalShortcutConsumeResult {
  handled: boolean;
  action?: IvrAction;
  nextNodeId?: string | null;
  replay?: boolean;
  popSubflow?: boolean;
}

export function shouldTryGlobalShortcut(
  context: IvrRuntimeContext,
  node: IvrNodeBase,
  input: IvrStepInput
): boolean {
  const dtmf = input.dtmf ?? context.pendingDigits;
  if (!dtmf) return false;

  const interactive =
    node.type === 'menu' || node.type === 'visual_menu' || node.type === 'collect';
  if (interactive) {
    return (
      context.interaction?.awaiting === true && context.interaction.nodeId === node.id
    );
  }
  return true;
}

export function tryConsumeGlobalShortcut(
  graph: IvrFlowGraph,
  context: IvrRuntimeContext,
  dtmf: string | undefined
): GlobalShortcutConsumeResult {
  if (!dtmf) return { handled: false };

  const shortcuts: GlobalShortcut[] = graph.globalShortcuts ?? [];
  const match = shortcuts.find((s) => s.digit === dtmf);
  if (!match) return { handled: false };

  const nodeId = context.currentNodeId ?? '';

  switch (match.action) {
    case 'transfer_queue':
      return {
        handled: true,
        action: {
          kind: 'queue',
          queueName: match.queueName,
          strategy: 'fifo',
          timeoutSec: 300,
          node: nodeId,
        },
      };
    case 'repeat_last':
      if (!context.lastPromptNodeId) return { handled: false };
      return {
        handled: true,
        nextNodeId: context.lastPromptNodeId,
        replay: true,
      };
    case 'goto_node': {
      const exists = graph.nodes.some((n) => n.id === match.targetNodeId);
      if (!exists) return { handled: false };
      return {
        handled: true,
        nextNodeId: match.targetNodeId,
        popSubflow: match.popSubflow ?? false,
      };
    }
    default:
      return { handled: false };
  }
}

export function applyShortcutResult(
  shortcut: GlobalShortcutConsumeResult,
  context: IvrRuntimeContext,
  variables: Record<string, string>
): {
  action: IvrAction;
  context: IvrRuntimeContext;
  nextNodeId: string | null;
  terminated: boolean;
} {
  const nodeId = context.currentNodeId ?? '';
  const action: IvrAction =
    shortcut.action ?? { kind: 'log', message: 'global shortcut', node: nodeId };

  let flowStack = context.flowStack;
  if (shortcut.popSubflow && flowStack.length > 0) {
    flowStack = flowStack.slice(0, -1);
  }

  const nextNodeId = shortcut.action ? null : (shortcut.nextNodeId ?? null);

  return {
    action,
    context: {
      ...context,
      variables,
      flowStack,
      interaction: undefined,
      pendingDigits: undefined,
      playQueueIndex: shortcut.replay ? undefined : context.playQueueIndex,
      currentNodeId: nextNodeId,
    },
    nextNodeId,
    terminated: shortcut.action ? actionTerminatesSession(shortcut.action) : false,
  };
}
