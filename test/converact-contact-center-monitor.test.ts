import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContactCenterMonitorService,
  type ContactCenterMonitorSource
} from '../src/agent-runtime/converact/contact-center/index.js';

test('Contact Center monitor derives stable queue estimates and operational alerts', async () => {
  const source: ContactCenterMonitorSource = {
    async load(tenantId, window) {
      assert.equal(tenantId, 'tenant-a');
      assert.deepEqual(window, {
        now: '2026-07-13T09:30:00.000Z',
        day_start: '2026-07-13T00:00:00.000Z',
        day_end: '2026-07-14T00:00:00.000Z'
      });
      return {
        agents: {
          configured: 4, active: 3, offline: 0, available: 1,
          busy: 1, after_call: 1, away: 0, active_voice_count: 2, voice_capacity: 4
        },
        calls: { active_inbound: 2, active_outbound: 1 },
        operations: {
          callbacks_pending: 2, callbacks_failed_today: 1,
          overflows_pending: 1, overflows_failed_today: 2,
          supervisor_requested: 0, supervisor_active: 1
        },
        queues: [{
          queue_id: 'queue-a', queue_name: 'Support', status: 'active',
          routing_strategy: 'longest_idle', max_wait_seconds: 300,
          service_level_seconds: 20, waiting_count: 3, offered_count: 1,
          assigned_count: 0, answered_count: 1, available_agents: 0,
          available_capacity: 0, oldest_wait_seconds: 45, average_handle_seconds: 60,
          answered_today: 8, answered_in_service_level_today: 6,
          abandoned_today: 1, timed_out_today: 1, overflowed_today: 2,
          average_wait_seconds_today: 17, callbacks_pending: 2,
          callbacks_failed_today: 1, overflows_pending: 1, overflows_failed_today: 2
        }]
      };
    }
  };

  const snapshot = await new ContactCenterMonitorService(source, {
    now: () => new Date('2026-07-13T09:30:00.000Z')
  }).snapshot({ tenant_id: 'tenant-a' });

  assert.equal(snapshot.generated_at, '2026-07-13T09:30:00.000Z');
  assert.equal(snapshot.queues[0]?.estimated_wait_seconds, null);
  assert.equal(snapshot.queues[0]?.service_level_percent_today, 50);
  assert.deepEqual(snapshot.alerts.map((alert) => alert.code), [
    'queue_without_capacity', 'service_level_wait', 'callback_failures', 'overflow_failures'
  ]);
  assert.equal(snapshot.alerts.every((alert) => alert.queue_id === 'queue-a'), true);
});

test('Contact Center monitor reports zero wait and a perfect empty-day service level', async () => {
  const source: ContactCenterMonitorSource = {
    async load() {
      return {
        agents: {
          configured: 0, active: 0, offline: 0, available: 0,
          busy: 0, after_call: 0, away: 0, active_voice_count: 0, voice_capacity: 0
        },
        calls: { active_inbound: 0, active_outbound: 0 },
        operations: {
          callbacks_pending: 0, callbacks_failed_today: 0,
          overflows_pending: 0, overflows_failed_today: 0,
          supervisor_requested: 0, supervisor_active: 0
        },
        queues: [{
          queue_id: 'queue-a', queue_name: 'Support', status: 'active',
          routing_strategy: 'longest_idle', max_wait_seconds: 300,
          service_level_seconds: 20, waiting_count: 0, offered_count: 0,
          assigned_count: 0, answered_count: 0, available_agents: 1,
          available_capacity: 1, oldest_wait_seconds: 0, average_handle_seconds: 60,
          answered_today: 0, answered_in_service_level_today: 0,
          abandoned_today: 0, timed_out_today: 0, overflowed_today: 0,
          average_wait_seconds_today: 0, callbacks_pending: 0,
          callbacks_failed_today: 0, overflows_pending: 0, overflows_failed_today: 0
        }]
      };
    }
  };

  const snapshot = await new ContactCenterMonitorService(source).snapshot({ tenant_id: 'tenant-a' });
  assert.equal(snapshot.queues[0]?.estimated_wait_seconds, 0);
  assert.equal(snapshot.queues[0]?.service_level_percent_today, 100);
  assert.deepEqual(snapshot.alerts, []);
});
