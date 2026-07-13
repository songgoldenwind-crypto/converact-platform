import { VoiceError } from './errors.js';
import type { VoiceCallState, VoiceCallTransition } from './types.js';

export interface VoiceCallTransitionContext {
  occurred_at?: string;
  ringing_at?: string | null;
  answered_at?: string | null;
  ended_at?: string | null;
}

export interface VoiceCallTransitionResult {
  state: VoiceCallState;
  ringing_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  changed: boolean;
}

const TERMINAL_STATES = new Set<VoiceCallState>([
  'completed',
  'cancelled',
  'missed',
  'rejected',
  'failed',
  'timed_out'
]);

const TRANSITIONS: Readonly<Record<VoiceCallState, Partial<Record<VoiceCallTransition, VoiceCallState>>>> = {
  planned: {
    queue: 'queued',
    cancel: 'cancelled',
    miss: 'missed',
    reject: 'rejected',
    fail: 'failed',
    timeout: 'timed_out'
  },
  queued: {
    dial: 'dialing',
    cancel: 'cancelled',
    miss: 'missed',
    reject: 'rejected',
    fail: 'failed',
    timeout: 'timed_out'
  },
  dialing: {
    ring: 'ringing',
    answer: 'active',
    cancel: 'cancelled',
    miss: 'missed',
    reject: 'rejected',
    fail: 'failed',
    timeout: 'timed_out'
  },
  ringing: {
    answer: 'active',
    cancel: 'cancelled',
    miss: 'missed',
    reject: 'rejected',
    fail: 'failed',
    timeout: 'timed_out'
  },
  active: {
    hold: 'held',
    transfer: 'transferring',
    complete: 'completed',
    fail: 'failed'
  },
  held: {
    resume: 'active',
    transfer: 'transferring',
    complete: 'completed',
    fail: 'failed'
  },
  transferring: {
    resume: 'active',
    complete: 'completed',
    fail: 'failed'
  },
  completed: {},
  cancelled: {},
  missed: {},
  rejected: {},
  failed: {},
  timed_out: {}
};

const PROVIDER_STATE_TARGETS: Readonly<Record<string, VoiceCallState>> = {
  queue: 'queued',
  queued: 'queued',
  trying: 'dialing',
  originating: 'dialing',
  dial: 'dialing',
  dialing: 'dialing',
  ring: 'ringing',
  ringing: 'ringing',
  answer: 'active',
  answered: 'active',
  connected: 'active',
  established: 'active',
  active: 'active',
  hold: 'held',
  held: 'held',
  transfer: 'transferring',
  transferring: 'transferring',
  completed: 'completed',
  complete: 'completed',
  ended: 'completed',
  hangup: 'completed',
  hung_up: 'completed',
  disconnected: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  missed: 'missed',
  no_answer: 'missed',
  rejected: 'rejected',
  declined: 'rejected',
  busy: 'rejected',
  failed: 'failed',
  error: 'failed',
  provider_error: 'failed',
  timeout: 'timed_out',
  timed_out: 'timed_out'
};

const PRE_ANSWER_STATES = new Set<VoiceCallState>(['planned', 'queued', 'dialing', 'ringing']);
const PRE_ANSWER_TERMINALS = new Set<VoiceCallState>([
  'cancelled',
  'missed',
  'rejected',
  'timed_out'
]);

export function isVoiceTerminalState(state: VoiceCallState): boolean {
  return TERMINAL_STATES.has(state);
}

export function transitionVoiceCall(
  currentState: VoiceCallState,
  transition: VoiceCallTransition,
  context: VoiceCallTransitionContext = {}
): VoiceCallTransitionResult {
  if (isVoiceTerminalState(currentState)) {
    throw new VoiceError({
      code: 'terminal_call_state',
      details: { state: currentState, transition }
    });
  }

  const nextState = TRANSITIONS[currentState][transition];
  if (!nextState) {
    throw new VoiceError({
      code: 'invalid_call_transition',
      details: { state: currentState, transition }
    });
  }

  const occurredAt = context.occurred_at;
  return {
    state: nextState,
    ringing_at: transition === 'ring'
      ? context.ringing_at ?? occurredAt ?? null
      : context.ringing_at ?? null,
    answered_at: transition === 'answer'
      ? context.answered_at ?? occurredAt ?? null
      : context.answered_at ?? null,
    ended_at: isVoiceTerminalState(nextState)
      ? context.ended_at ?? occurredAt ?? null
      : context.ended_at ?? null,
    changed: true
  };
}

export function mergeProviderCallState(
  currentState: VoiceCallState,
  providerState: string,
  context: VoiceCallTransitionContext = {}
): VoiceCallTransitionResult {
  const normalized = providerState.trim().toLowerCase().replace(/[\s-]+/g, '_');
  let target = PROVIDER_STATE_TARGETS[normalized];
  if (!target) {
    throw new VoiceError({
      code: 'unsupported_provider_call_state',
      status: 422
    });
  }

  if (isVoiceTerminalState(currentState)) {
    const endedAt = context.ended_at
      ?? (target === currentState ? context.occurred_at ?? null : null);
    return unchanged(currentState, context, endedAt);
  }

  if (target === currentState) {
    return unchanged(currentState, context);
  }

  if (target === 'completed' && PRE_ANSWER_STATES.has(currentState)) {
    target = 'cancelled';
  }
  if (PRE_ANSWER_TERMINALS.has(target) && !PRE_ANSWER_STATES.has(currentState)) {
    return unchanged(currentState, context);
  }

  const transitions = pathToState(currentState, target);
  if (transitions.length === 0) {
    return unchanged(currentState, context);
  }

  let result = unchanged(currentState, context);
  for (const transition of transitions) {
    result = transitionVoiceCall(result.state, transition, {
      ...result,
      occurred_at: context.occurred_at
    });
  }
  return result;
}

function pathToState(currentState: VoiceCallState, target: VoiceCallState): VoiceCallTransition[] {
  if (isVoiceTerminalState(target)) {
    const action: Partial<Record<VoiceCallState, VoiceCallTransition>> = {
      completed: 'complete',
      cancelled: 'cancel',
      missed: 'miss',
      rejected: 'reject',
      failed: 'fail',
      timed_out: 'timeout'
    };
    return action[target] ? [action[target]] : [];
  }

  const paths: Partial<Record<VoiceCallState, Partial<Record<VoiceCallState, VoiceCallTransition[]>>>> = {
    planned: {
      queued: ['queue'],
      dialing: ['queue', 'dial'],
      ringing: ['queue', 'dial', 'ring'],
      active: ['queue', 'dial', 'answer'],
      held: ['queue', 'dial', 'answer', 'hold'],
      transferring: ['queue', 'dial', 'answer', 'transfer']
    },
    queued: {
      dialing: ['dial'],
      ringing: ['dial', 'ring'],
      active: ['dial', 'answer'],
      held: ['dial', 'answer', 'hold'],
      transferring: ['dial', 'answer', 'transfer']
    },
    dialing: {
      ringing: ['ring'],
      active: ['answer'],
      held: ['answer', 'hold'],
      transferring: ['answer', 'transfer']
    },
    ringing: {
      active: ['answer'],
      held: ['answer', 'hold'],
      transferring: ['answer', 'transfer']
    },
    active: {
      held: ['hold'],
      transferring: ['transfer']
    },
    held: {
      active: ['resume'],
      transferring: ['transfer']
    },
    transferring: {
      active: ['resume']
    }
  };
  return paths[currentState]?.[target] ?? [];
}

function unchanged(
  state: VoiceCallState,
  context: VoiceCallTransitionContext,
  endedAt: string | null = context.ended_at ?? null
): VoiceCallTransitionResult {
  const changed = endedAt !== (context.ended_at ?? null);
  return {
    state,
    ringing_at: context.ringing_at ?? null,
    answered_at: context.answered_at ?? null,
    ended_at: endedAt,
    changed
  };
}
