import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { IveKitBusinessContext } from '@converact/sdk';

import { installTestDom } from '../test-dom.js';
import { BusinessContextPanel } from './business-context-panel.js';

let closeDom: () => void;
before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });

test('business context panel projects authorization and paged redacted activity', async () => {
  let closed = false;
  const cursors: Array<string | undefined> = [];
  const view = render(<BusinessContextPanel
    context={context()}
    loadTimeline={async (input) => {
      cursors.push(input?.cursor);
      return input?.cursor ? {
        items: [event('evidence:2', 'evidence', 'evidence.video_recording', true)],
        has_more: false, next_cursor: null
      } : {
        items: [event('media_action:1', 'media', 'media.call.end', false)],
        has_more: true, next_cursor: 'cursor-2'
      };
    }}
    onClose={() => { closed = true; }}
  />);
  assert.equal(view.getAllByText('agent').length, 2);
  assert.ok(view.getByText('1 active / 2'));
  assert.ok(view.getByText('host'));
  assert.ok(view.getByText('joined'));
  assert.ok(view.getByText('view_screen, control_mouse_keyboard'));
  assert.ok(view.getByText('agent-controller'));
  assert.doesNotMatch(view.container.textContent || '', /secret|launch_url|rustdesk_id/);
  fireEvent.click(view.getByRole('tab', { name: 'Activity' }));
  await waitFor(() => assert.ok(view.getByText('media.call.end')));
  fireEvent.click(view.getByRole('button', { name: 'Load older' }));
  await waitFor(() => assert.ok(view.getByText('evidence.video_recording')));
  assert.deepEqual(cursors, [undefined, 'cursor-2']);
  assert.doesNotMatch(view.container.textContent || '', /private body|storage_url/);
  fireEvent.click(view.getByTitle('Close authorization summary'));
  assert.equal(closed, true);
});

function context(): IveKitBusinessContext {
  return {
    tenant_id: 'tenant-1', business_ref: { type: 'service_order', id: 'SO-1' },
    viewer: { identity: 'agent-1', system: false },
    capabilities: { chat: true, media: true, remote_assistance: true },
    chat: { count: 1, sessions: [] }, media: { count: 1, calls: [] },
    remote_assistance: { count: 1, sessions: [], devices: [] },
    authorization: {
      chat: [{ session_id: 'chat-1', viewer_role: 'agent', participants: [
        { identity: 'agent-1', display_name: 'Agent', role: 'agent', status: 'active' },
        { identity: 'former-1', display_name: 'Former', role: 'customer', status: 'left' }
      ] }],
      media: [{ call_id: 'call-1', viewer_role: 'host', viewer_status: 'joined', participants: [
        { identity: 'agent-1', display_name: 'Agent', role: 'host', status: 'joined' }
      ] }],
      remote_assistance: [{
        remote_session_id: 'remote-1', viewer_role: 'agent',
        consent: { active: true, scopes: ['view_screen', 'control_mouse_keyboard'], expires_at: null },
        gateway: {
          external_id: 'gateway-1', status: 'active', permissions: ['view_screen'],
          controller: { status: 'owned', owner_identity: 'agent-controller', lease_expires_at: null, version: 3 }
        }
      }]
    }
  };
}

function event(id: string, source: 'media' | 'evidence', eventType: string, evidence: boolean) {
  return {
    id, source, event_type: eventType,
    resource_type: evidence ? 'evidence' as const : 'media_call' as const,
    resource_id: evidence ? 'recording-1' : 'call-1', actor_identity: 'agent-1',
    occurred_at: '2026-07-12T08:00:00.000Z', attributes: {},
    evidence_ref: evidence ? {
      id: 'evidence-2', kind: 'video_recording', checksum: 'a'.repeat(64), retention_until: null
    } : null
  };
}
