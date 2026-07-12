import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { IveKitBusinessContext } from '@opc/ivekit-sdk';

import { installTestDom } from '../test-dom.js';
import { BusinessContextPanel } from './business-context-panel.js';

let closeDom: () => void;
before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });

test('business authorization panel projects roles scopes and control without metadata', () => {
  let closed = false;
  const view = render(<BusinessContextPanel context={context()} onClose={() => { closed = true; }} />);
  assert.equal(view.getAllByText('agent').length, 2);
  assert.ok(view.getByText('1 active / 2'));
  assert.ok(view.getByText('host'));
  assert.ok(view.getByText('joined'));
  assert.ok(view.getByText('view_screen, control_mouse_keyboard'));
  assert.ok(view.getByText('agent-controller'));
  assert.doesNotMatch(view.container.textContent || '', /secret|launch_url|rustdesk_id/);
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
