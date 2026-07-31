import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { cleanup, render } from '@testing-library/react';

import { installTestDom } from '../test-dom.js';
import { initialMediaCallState, mediaCallReducer } from './media-reducer.js';
import { CallHeader } from './call-header.js';

let closeDom: () => void;
before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });
afterEach(() => cleanup());

test('call header shows status and participants but no elapsed time before active', () => {
  const view = render(<CallHeader state={state('ringing')} now={Date.parse('2026-07-11T10:01:06.000Z')} />);
  assert.ok(view.getByText('Support call'));
  assert.ok(view.getByText('Ringing'));
  assert.ok(view.getByText('2 participants'));
  assert.equal(view.queryByLabelText('Call elapsed time'), null);
});

test('call header starts elapsed time only from durable active timestamp', () => {
  const view = render(<CallHeader state={state('active')} now={Date.parse('2026-07-11T10:01:06.000Z')} />);
  assert.equal(view.getByLabelText('Call elapsed time').textContent, '01:00');
});

function state(status: 'ringing' | 'active') {
  let value = mediaCallReducer(initialMediaCallState(), { type: 'call_selected', requestId: 1, callId: 'call-1' });
  value = mediaCallReducer(value, {
    type: 'snapshot_loaded',
    requestId: 1,
    snapshot: {
      call: {
        id: 'call-1', tenant_id: 'tenant-1', room_name: 'room-1', media: 'video', status,
        initiated_by: 'agent-1', business_ref: { type: 'order', id: 'order-1', metadata: {} },
        title: 'Support call', metadata: {}, ring_timeout_seconds: 30, ring_expires_at: null,
        accepted_at: status === 'active' ? '2026-07-11T10:00:05.000Z' : null,
        started_at: status === 'active' ? '2026-07-11T10:00:06.000Z' : null,
        ended_at: null, end_reason: '', created_at: '2026-07-11T10:00:00.000Z', updated_at: '2026-07-11T10:00:06.000Z'
      },
      participants: [
        participant('agent-1', 'host'),
        participant('customer-1', 'participant')
      ]
    }
  });
  return value;
}

function participant(identity: string, role: 'host' | 'participant') {
  return {
    id: identity, tenant_id: 'tenant-1', call_id: 'call-1', identity, role, status: 'accepted' as const,
    display_name: identity, metadata: {}, invited_at: '2026-07-11T10:00:00.000Z', accepted_at: null,
    joined_at: null, left_at: null, updated_at: '2026-07-11T10:00:00.000Z'
  };
}
