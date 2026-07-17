import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  NotificationError,
  isNotificationDeliveryTerminal,
  transitionNotificationDelivery,
  type NotificationDeliveryState,
  type NotificationDeliveryTransition
} from '../src/agent-runtime/ivekit/notifications/index.js';

const ALLOWED: ReadonlyArray<{
  from: NotificationDeliveryState;
  transition: NotificationDeliveryTransition;
  to: NotificationDeliveryState;
}> = [
  { from: 'pending', transition: 'claim', to: 'processing' },
  { from: 'pending', transition: 'cancel', to: 'cancelled' },
  { from: 'processing', transition: 'accept', to: 'accepted' },
  { from: 'processing', transition: 'deliver', to: 'delivered' },
  { from: 'processing', transition: 'retry', to: 'retry_wait' },
  { from: 'processing', transition: 'mark_uncertain', to: 'uncertain' },
  { from: 'processing', transition: 'fail', to: 'failed' },
  { from: 'processing', transition: 'dead_letter', to: 'dead_letter' },
  { from: 'retry_wait', transition: 'claim', to: 'processing' },
  { from: 'retry_wait', transition: 'cancel', to: 'cancelled' },
  { from: 'accepted', transition: 'deliver', to: 'delivered' },
  { from: 'accepted', transition: 'retry', to: 'retry_wait' },
  { from: 'accepted', transition: 'mark_uncertain', to: 'uncertain' },
  { from: 'accepted', transition: 'fail', to: 'failed' },
  { from: 'uncertain', transition: 'reconcile_delivered', to: 'delivered' },
  { from: 'uncertain', transition: 'reconcile_failed', to: 'failed' },
  { from: 'uncertain', transition: 'retry', to: 'retry_wait' },
  { from: 'uncertain', transition: 'dead_letter', to: 'dead_letter' }
];

test('notification delivery reducer implements every allowed transition', () => {
  for (const item of ALLOWED) {
    assert.deepEqual(
      transitionNotificationDelivery(item.from, item.transition),
      { state: item.to, changed: true },
      `${item.from} --${item.transition}--> ${item.to}`
    );
  }
});

test('notification delivery reducer rejects invalid and terminal transitions', () => {
  assert.throws(
    () => transitionNotificationDelivery('pending', 'deliver'),
    (error: unknown) => error instanceof NotificationError
      && error.code === 'invalid_delivery_transition'
      && error.retryable === false
  );

  for (const state of ['delivered', 'failed', 'cancelled', 'dead_letter'] as const) {
    assert.equal(isNotificationDeliveryTerminal(state), true);
    assert.throws(
      () => transitionNotificationDelivery(state, 'claim'),
      (error: unknown) => error instanceof NotificationError
        && error.code === 'terminal_delivery_state'
        && error.retryable === false
    );
  }
  assert.equal(isNotificationDeliveryTerminal('accepted'), false);
});
