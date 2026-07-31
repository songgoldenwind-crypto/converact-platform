import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import React, { StrictMode } from 'react';
import type {
  IveKitClient,
  IveKitContactCenterMonitorSnapshot
} from '@opc/ivekit-sdk';

import { installTestDom } from '../test-dom.js';

const closeDom = installTestDom();
const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { QueueMonitorWorkspace } = await import('./queue-monitor-workspace.js');

after(() => { cleanup(); closeDom(); });
afterEach(() => cleanup());

test('Queue Monitor renders operational totals, alerts, filters, and manual refresh', async () => {
  let requests = 0;
  const client = fakeClient(async () => {
    requests += 1;
    return snapshot(requests);
  });
  const view = render(<QueueMonitorWorkspace client={client} pollIntervalMs={60_000} />);

  await waitFor(() => assert.equal(view.getAllByText('Support').length, 2));
  assert.ok(view.getByText('Sales'));
  assert.equal(view.getByTestId('metric-waiting').textContent, '3');
  assert.equal(view.getByTestId('metric-capacity').textContent, '3');
  assert.equal(view.getByTestId('metric-active-calls').textContent, '3');
  assert.ok(view.getByText('No agent capacity'));

  fireEvent.click(view.getByLabelText('Only queues with alerts'));
  assert.equal(view.getAllByText('Support').length, 2);
  assert.equal(view.queryByText('Sales'), null);

  fireEvent.click(view.getByTitle('Refresh queue monitor'));
  await waitFor(() => assert.equal(requests, 2));
  assert.equal(view.getByTestId('metric-waiting').textContent, '4');
});

test('Queue Monitor preserves a useful error state and retries on demand', async () => {
  let requests = 0;
  const client = fakeClient(async () => {
    requests += 1;
    if (requests === 1) throw new Error('monitor unavailable');
    return snapshot(1);
  });
  const view = render(<QueueMonitorWorkspace client={client} pollIntervalMs={60_000} />);

  await waitFor(() => assert.ok(view.getByRole('alert')));
  assert.match(view.getByRole('alert').textContent || '', /monitor unavailable/);
  fireEvent.click(view.getByRole('button', { name: 'Retry' }));
  await waitFor(() => assert.equal(view.getAllByText('Support').length, 2));
  assert.equal(requests, 2);
});

test('Queue Monitor ignores a late snapshot after the authenticated client changes', async () => {
  let resolveOld!: (value: IveKitContactCenterMonitorSnapshot) => void;
  const oldSnapshot = new Promise<IveKitContactCenterMonitorSnapshot>((resolve) => {
    resolveOld = resolve;
  });
  const view = render(<QueueMonitorWorkspace
    client={fakeClient(() => oldSnapshot)}
    pollIntervalMs={60_000}
  />);

  view.rerender(<QueueMonitorWorkspace
    client={fakeClient(async () => snapshot(2))}
    pollIntervalMs={60_000}
  />);
  await waitFor(() => assert.equal(view.getByTestId('metric-waiting').textContent, '4'));

  resolveOld(snapshot(1));
  await Promise.resolve();
  assert.equal(view.getByTestId('metric-waiting').textContent, '4');
});

test('Queue Monitor coalesces the React StrictMode remount request without losing data', async () => {
  let requests = 0;
  const client = fakeClient(async () => {
    requests += 1;
    return snapshot(1);
  });
  const view = render(<StrictMode><QueueMonitorWorkspace
    client={client}
    pollIntervalMs={60_000}
  /></StrictMode>);

  await waitFor(() => assert.equal(view.getByTestId('metric-waiting').textContent, '3'));
  assert.equal(requests, 1);
});

function fakeClient(
  load: () => Promise<IveKitContactCenterMonitorSnapshot>
): IveKitClient {
  return {
    contactCenter: { getMonitorSnapshot: load }
  } as unknown as IveKitClient;
}

function snapshot(revision: number): IveKitContactCenterMonitorSnapshot {
  return {
    generated_at: `2026-07-13T09:30:0${revision}.000Z`,
    agents: {
      configured: 4, active: 3, offline: 0, available: 1, busy: 1,
      after_call: 1, away: 0, active_voice_count: 2, voice_capacity: 5
    },
    calls: { active_inbound: 2, active_outbound: 1 },
    operations: {
      callbacks_pending: 2, callbacks_failed_today: 0,
      overflows_pending: 1, overflows_failed_today: 0,
      supervisor_requested: 0, supervisor_active: 1
    },
    queues: [
      {
        queue_id: 'queue-support', queue_name: 'Support', status: 'active',
        routing_strategy: 'longest_idle', max_wait_seconds: 300,
        service_level_seconds: 20, waiting_count: 2 + revision, offered_count: 1,
        assigned_count: 0, answered_count: 1, available_agents: 0,
        available_capacity: 0, oldest_wait_seconds: 45, average_handle_seconds: 60,
        estimated_wait_seconds: null, answered_today: 8,
        answered_in_service_level_today: 6, abandoned_today: 1,
        timed_out_today: 1, overflowed_today: 0, average_wait_seconds_today: 17,
        service_level_percent_today: 60, callbacks_pending: 2,
        callbacks_failed_today: 0, overflows_pending: 1, overflows_failed_today: 0
      },
      {
        queue_id: 'queue-sales', queue_name: 'Sales', status: 'active',
        routing_strategy: 'round_robin', max_wait_seconds: 180,
        service_level_seconds: 30, waiting_count: 0, offered_count: 0,
        assigned_count: 0, answered_count: 0, available_agents: 1,
        available_capacity: 2, oldest_wait_seconds: 0, average_handle_seconds: 90,
        estimated_wait_seconds: 0, answered_today: 5,
        answered_in_service_level_today: 5, abandoned_today: 0,
        timed_out_today: 0, overflowed_today: 0, average_wait_seconds_today: 8,
        service_level_percent_today: 100, callbacks_pending: 0,
        callbacks_failed_today: 0, overflows_pending: 0, overflows_failed_today: 0
      }
    ],
    alerts: [{
      code: 'queue_without_capacity', severity: 'critical',
      queue_id: 'queue-support', value: 2 + revision
    }]
  };
}
