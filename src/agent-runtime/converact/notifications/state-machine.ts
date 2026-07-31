import { NotificationError } from './errors.js';
import type {
  NotificationDeliveryState,
  NotificationDeliveryTransition
} from './types.js';

const TERMINAL_STATES = new Set<NotificationDeliveryState>([
  'delivered',
  'failed',
  'cancelled',
  'dead_letter'
]);

const TRANSITIONS: Readonly<Record<NotificationDeliveryState, Partial<Record<
  NotificationDeliveryTransition,
  NotificationDeliveryState
>>>> = {
  pending: { claim: 'processing', cancel: 'cancelled' },
  processing: {
    accept: 'accepted',
    deliver: 'delivered',
    retry: 'retry_wait',
    mark_uncertain: 'uncertain',
    fail: 'failed',
    dead_letter: 'dead_letter'
  },
  accepted: {
    deliver: 'delivered',
    retry: 'retry_wait',
    mark_uncertain: 'uncertain',
    fail: 'failed'
  },
  retry_wait: {
    claim: 'processing', reconcile_delivered: 'delivered', reconcile_failed: 'failed', cancel: 'cancelled'
  },
  uncertain: {
    reconcile_delivered: 'delivered',
    reconcile_failed: 'failed',
    retry: 'retry_wait',
    dead_letter: 'dead_letter'
  },
  delivered: {},
  failed: {},
  cancelled: {},
  dead_letter: {}
};

export function isNotificationDeliveryTerminal(state: NotificationDeliveryState): boolean {
  return TERMINAL_STATES.has(state);
}

export function transitionNotificationDelivery(
  state: NotificationDeliveryState,
  transition: NotificationDeliveryTransition
): { state: NotificationDeliveryState; changed: true } {
  if (isNotificationDeliveryTerminal(state)) {
    throw new NotificationError({
      code: 'terminal_delivery_state',
      details: { state, transition }
    });
  }
  const next = TRANSITIONS[state][transition];
  if (!next) {
    throw new NotificationError({
      code: 'invalid_delivery_transition',
      details: { state, transition }
    });
  }
  return { state: next, changed: true };
}
