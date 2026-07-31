/**
 * Maps OPC IvrAction ↔ RustPBX Step IVR ActionNode (Miuda Step IVR protocol).
 */

import type { IvrAction, IvrStepInput } from './ivr-executor.js';
import type { PromptQueueItem } from './ivr-audio-queue.js';

export interface StepActionNode {
  type: string;
  [key: string]: unknown;
}

export interface StepIvrEvent {
  type: string;
  digit?: string;
  interrupted?: boolean;
  reason?: string;
}

export interface StepIvrRequest {
  session_id: string;
  caller?: string;
  callee?: string;
  direction?: string;
  tenant_id?: string;
  ivr_id?: string;
  variables?: Record<string, string>;
  event?: StepIvrEvent;
}

function promptFields(item: {
  text: string;
  promptType?: 'tts' | 'audio';
  audioUrl?: string;
  interruptible?: boolean;
}): Record<string, unknown> {
  if (item.promptType === 'audio' && item.audioUrl) {
    return {
      file: item.audioUrl,
      ...(item.interruptible ? { interruptible: true } : {}),
    };
  }
  return {
    tts_text: item.text,
    ...(item.interruptible ? { interruptible: true } : {}),
  };
}

function chainPromptQueue(queue: PromptQueueItem[], tail: StepActionNode): StepActionNode {
  let node = tail;
  for (let i = queue.length - 1; i >= 0; i--) {
    const segment = queue[i];
    node = {
      type: 'prompt',
      ...promptFields({
        text: segment.text,
        promptType: segment.promptType,
        audioUrl: segment.audioUrl,
        interruptible: segment.interruptible,
      }),
      next: node,
    };
  }
  return node;
}

function preMenuPromptQueue(queue: PromptQueueItem[] | undefined): PromptQueueItem[] {
  if (!queue?.length) return [];
  if (queue.length === 1) return [];
  return queue.slice(0, -1);
}

function menuTail(action: Extract<IvrAction, { kind: 'menu' }>): StepActionNode {
  return {
    type: 'dtmf_menu',
    ...promptFields({
      text: action.prompt,
      promptType: action.promptType,
      audioUrl: action.audioUrl,
    }),
    timeout_ms: (action.timeoutSec ?? 10) * 1000,
    max_retries: action.maxRetries ?? 3,
  };
}

function collectTail(action: Extract<IvrAction, { kind: 'collect_digits' }>): StepActionNode {
  return {
    type: 'collect_dtmf',
    ...promptFields({
      text: action.prompt,
      promptType: action.promptType,
      audioUrl: action.audioUrl,
    }),
    num_digits: action.maxDigits,
    timeout_ms: (action.timeoutSec ?? 30) * 1000,
    ...(action.endMode === 'hash_key' ? { end_key: '#' } : {}),
    variable: action.storeVar,
  };
}

/** OPC action → RustPBX Step IVR ActionNode. Returns null when IVR should end with no media step. */
export function ivrActionToStepNode(action: IvrAction | undefined | null): StepActionNode | null {
  if (!action) return { type: 'hangup' };

  switch (action.kind) {
    case 'play':
    case 'compliance':
      return {
        type: 'prompt',
        ...promptFields({
          text: action.kind === 'play' ? action.text : action.prompt,
          promptType: action.kind === 'play' ? action.promptType : 'tts',
          audioUrl: action.kind === 'play' ? action.audioUrl : undefined,
          interruptible: action.interruptible,
        }),
      };
    case 'flush_play_queue': {
      if (!action.promptQueue.length) return { type: 'hangup' };
      const last = action.promptQueue[action.promptQueue.length - 1];
      let tail: StepActionNode = {
        type: 'prompt',
        ...promptFields({
          text: last.text,
          promptType: last.promptType,
          audioUrl: last.audioUrl,
          interruptible: last.interruptible,
        }),
      };
      if (action.promptQueue.length > 1) {
        tail = chainPromptQueue(action.promptQueue.slice(0, -1), tail);
      }
      return tail;
    }
    case 'menu': {
      const tail = menuTail(action);
      const preMenu = preMenuPromptQueue(action.promptQueue);
      return preMenu.length ? chainPromptQueue(preMenu, tail) : tail;
    }
    case 'collect_digits': {
      const tail = collectTail(action);
      const preMenu = preMenuPromptQueue(action.promptQueue);
      return preMenu.length ? chainPromptQueue(preMenu, tail) : tail;
    }
    case 'visual_menu':
      return {
        type: 'dtmf_menu',
        tts_text: action.title,
        timeout_ms: 15000,
        max_retries: 3,
      };
    case 'transfer':
      if (action.targetType === 'queue') {
        return { type: 'queue', queue: action.targetValue };
      }
      if (action.targetType === 'sip') {
        return { type: 'voip_bridge', uri: action.targetValue };
      }
      if (action.targetType === 'voicemail') {
        return { type: 'voicemail', extension: action.targetValue };
      }
      return { type: 'transfer', target: action.targetValue };
    case 'queue':
      return { type: 'queue', queue: action.queueName };
    case 'sip':
      return { type: 'voip_bridge', uri: action.sipUri };
    case 'voicemail':
      return { type: 'voicemail', extension: action.mailboxId ?? 'default' };
    case 'disconnect':
      if (action.phase === 'farewell' && action.text) {
        return {
          type: 'play_and_hangup',
          ...promptFields({
            text: action.text,
            promptType: action.promptType,
            audioUrl: action.audioUrl,
          }),
        };
      }
      return { type: 'hangup' };
    case 'log':
    case 'set_var':
      return null;
    default:
      console.warn('[ivr-step] unsupported action kind:', action.kind);
      return { type: 'hangup' };
  }
}

export function stepEventToAdvanceInput(event: StepIvrEvent | undefined): IvrStepInput {
  if (!event?.type || event.type === 'session_start') return {};

  switch (event.type) {
    case 'dtmf':
    case 'dtmf_menu_invalid':
      return event.digit ? { dtmf: event.digit } : {};
    case 'dtmf_timeout':
    case 'dtmf_menu_timeout':
      return { timedOut: true };
    case 'audio_complete':
      return { playCompleted: true };
    case 'input_voice':
      return event.reason ? { speechResult: event.reason } : {};
    default:
      return {};
  }
}

export function isTerminalStepNode(node: StepActionNode | null): boolean {
  if (!node) return true;
  const terminal = new Set([
    'transfer',
    'hangup',
    'queue',
    'voicemail',
    'play_and_hangup',
    'voip_bridge',
    'route_to_agent',
    'jump_ivr',
  ]);
  return terminal.has(node.type);
}
