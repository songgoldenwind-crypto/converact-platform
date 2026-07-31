import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanup, render } from '@testing-library/react';
import type { IveKitChatSession } from '@converact/sdk';
import { installTestDom } from '../test-dom.js';
import { SessionList } from './session-list.js';

let closeDom: () => void;
before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });

test('session list renders unread, latest message, presence, and closed state', () => {
  const view = render(<SessionList
    sessions={[session('open'), session('closed')]}
    selectedId="session-open"
    query=""
    loading={false}
    onQueryChange={() => undefined}
    onSelect={() => undefined}
  />);
  assert.ok(view.getByLabelText('3 unread'));
  assert.ok(view.getAllByText('customer-1: Need help').length >= 1);
  assert.ok(view.getByLabelText('2 participants online'));
  assert.ok(view.getByText('Closed'));
});

function session(status: 'open' | 'closed'): IveKitChatSession {
  return {
    id: `session-${status}`,
    tenant_id: 'tenant-1',
    business_ref_type: 'service_order',
    business_ref_id: status,
    business_ref: { type: 'service_order', id: status },
    title: `${status} session`,
    status,
    metadata: {},
    created_at: '2026-07-11T08:00:00.000Z',
    updated_at: '2026-07-11T08:00:00.000Z',
    closed_at: status === 'closed' ? '2026-07-11T09:00:00.000Z' : null,
    summary: {
      unread_count: status === 'open' ? 3 : 0,
      online_participant_count: status === 'open' ? 2 : 0,
      last_message: {
        id: `message-${status}`,
        body: 'Need help',
        sender_identity: 'customer-1',
        message_type: 'text',
        created_at: '2026-07-11T08:30:00.000Z',
        deleted: false
      }
    }
  };
}
